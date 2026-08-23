import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HeadHashAnchor, type AnchorSink, type AnchorRecord } from "../src/audit/anchor.js";

// C-08 — the head-hash anchor is the external tamper-evidence for the ledger. Its whole value
// against T-1 (an operator who rewrites the ledger) rests on the anchor being APPEND-ONLY and,
// in production, living in a write-once destination. The pre-fix save() rewrote the entire file
// on every anchor (a JSON array re-serialized), contradicting its own "append-only" doc comment
// and giving a programmatic path that rewrites anchor history. These tests pin: (1) genuine
// append-only bytes on disk, (2) an injectable sink so a cloud WORM store (S3 Object Lock /
// GCS Bucket Lock) is operator config, not a code change, (3) legacy-format migration,
// (4) tolerance of a torn trailing append.

describe("HeadHashAnchor — append-only persistence + WORM sink seam (C-08)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-append-"));
    path = join(dir, "anchor-records.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is genuinely append-only: a new anchor never rewrites the bytes of prior records", () => {
    const anchor = new HeadHashAnchor(path);
    anchor.anchor("hashA", 0);
    const afterA = readFileSync(path, "utf-8");
    anchor.anchor("hashB", 1);
    const afterB = readFileSync(path, "utf-8");
    // The file after the second anchor must be the first file plus appended bytes — the prefix is
    // byte-identical, proving prior records were never rewritten (the C-08 immutability property).
    expect(afterB.startsWith(afterA)).toBe(true);
    expect(afterB.length).toBeGreaterThan(afterA.length);
  });

  it("round-trips every record across a reload", () => {
    const anchor = new HeadHashAnchor(path);
    anchor.anchor("h0", 0);
    anchor.anchor("h1", 1);
    anchor.anchor("h2", 2);

    const reloaded = new HeadHashAnchor(path);
    expect(reloaded.count()).toBe(3);
    expect(reloaded.latest()?.head_hash).toBe("h2");
    expect(reloaded.all().map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  it("accepts an injectable sink — the seam for a cloud WORM store — routing appends to it", () => {
    const appended: AnchorRecord[] = [];
    const sink: AnchorSink = {
      append: (r) => appended.push(r),
      readAll: () => [],
      isHealthy: () => true,
    };
    const anchor = new HeadHashAnchor(sink);
    anchor.anchor("h1", 5);
    expect(appended).toHaveLength(1);
    expect(appended[0].head_hash).toBe("h1");
    expect(anchor.latest()?.seq).toBe(5);
    expect(anchor.isPersistenceHealthy()).toBe(true);
  });

  it("migrates a legacy JSON-array anchor file to append-only JSONL on load", () => {
    const legacy = [{ seq: 0, head_hash: "old", timestamp: new Date().toISOString() }];
    writeFileSync(path, JSON.stringify(legacy, null, 2), "utf-8");

    const anchor = new HeadHashAnchor(path);
    expect(anchor.count()).toBe(1);
    expect(anchor.latest()?.head_hash).toBe("old");

    // A further anchor must append cleanly (the file is JSONL now, not a JSON array).
    anchor.anchor("new", 1);
    const reloaded = new HeadHashAnchor(path);
    expect(reloaded.count()).toBe(2);
    expect(reloaded.latest()?.head_hash).toBe("new");
  });

  it("tolerates a torn trailing line (interrupted append) by returning the valid prefix", () => {
    const anchor = new HeadHashAnchor(path);
    anchor.anchor("h1", 0);
    appendFileSync(path, '{"seq":1,"head_hash":"tor'); // simulate a crash mid-append

    const reloaded = new HeadHashAnchor(path);
    expect(reloaded.count()).toBe(1);
    expect(reloaded.latest()?.head_hash).toBe("h1");
  });
});
