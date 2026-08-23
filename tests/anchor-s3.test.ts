import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  S3ObjectLockAnchorSink,
  createS3AnchorSinkFromEnv,
  DEFAULT_S3_RETENTION_DAYS,
  type S3ObjectPutter,
} from "../src/audit/anchor-s3.js";
import type { AnchorRecord } from "../src/audit/anchor.js";

// C-08 — S3 Object Lock sink. No AWS here: the sink depends only on an abstract S3ObjectPutter,
// which the tests fake. Verifies local-first append, reconcile PUTs with Object Lock retention,
// idempotency, fail-and-requeue, manifest persistence, and fail-closed env config.

const HASH = "b".repeat(64);
const rec = (seq: number): AnchorRecord => ({ seq, head_hash: HASH, timestamp: new Date().toISOString() });

interface Put {
  key: string;
  body: string;
  retainUntil: Date;
}

function fakePutter(behavior?: () => void): { putter: S3ObjectPutter; puts: Put[] } {
  const puts: Put[] = [];
  const putter: S3ObjectPutter = {
    async put(key, body, retainUntil) {
      behavior?.();
      puts.push({ key, body, retainUntil });
    },
  };
  return { putter, puts };
}

describe("S3 Object Lock anchor sink (C-08)", () => {
  let dir: string;
  let recordsPath: string;
  let manifestPath: string;
  const NOW = new Date("2026-08-23T12:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-s3-"));
    recordsPath = join(dir, "records.json");
    manifestPath = join(dir, "manifest.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("append is local-first: the record is durable/readable before any S3 PUT", () => {
    const { putter, puts } = fakePutter();
    const sink = new S3ObjectLockAnchorSink({ putter, recordsPath, manifestPath });
    sink.append(rec(0));
    expect(sink.readAll().map((r) => r.seq)).toEqual([0]);
    expect(puts).toHaveLength(0);
    expect(sink.isHealthy()).toBe(true);
  });

  it("reconcile PUTs each record under Object Lock retention, idempotently", async () => {
    const { putter, puts } = fakePutter();
    const sink = new S3ObjectLockAnchorSink({ putter, recordsPath, manifestPath, now: () => NOW });
    sink.append(rec(0));
    await sink.reconcile();

    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe(`anchors/0-${HASH}.json`);
    expect(JSON.parse(puts[0].body).seq).toBe(0);
    // retain-until = now + default retention window
    const expected = new Date(NOW.getTime() + DEFAULT_S3_RETENTION_DAYS * 86_400_000);
    expect(puts[0].retainUntil.toISOString()).toBe(expected.toISOString());
    expect(sink.isHealthy()).toBe(true);

    // Idempotent: a second reconcile does not re-PUT an already-locked object.
    await sink.reconcile();
    expect(puts).toHaveLength(1);
  });

  it("honors a custom key prefix and retention window", async () => {
    const { putter, puts } = fakePutter();
    const sink = new S3ObjectLockAnchorSink({
      putter,
      recordsPath,
      manifestPath,
      keyPrefix: "ledger-anchors/",
      retentionDays: 30,
      now: () => NOW,
    });
    sink.append(rec(7));
    await sink.reconcile();
    expect(puts[0].key).toBe(`ledger-anchors/7-${HASH}.json`);
    expect(puts[0].retainUntil.toISOString()).toBe(new Date(NOW.getTime() + 30 * 86_400_000).toISOString());
  });

  it("a PUT failure flips health and re-queues; a later success stores it", async () => {
    let fail = true;
    const { putter, puts } = fakePutter(() => {
      if (fail) throw new Error("S3 unavailable");
    });
    const sink = new S3ObjectLockAnchorSink({ putter, recordsPath, manifestPath });
    sink.append(rec(0));
    await sink.reconcile();
    expect(sink.isHealthy()).toBe(false);
    expect(puts).toHaveLength(0);

    fail = false;
    await sink.reconcile();
    expect(sink.isHealthy()).toBe(true);
    expect(puts).toHaveLength(1);
  });

  it("does not re-PUT records already locked in a previous run (manifest survives reload)", async () => {
    const first = fakePutter();
    const s1 = new S3ObjectLockAnchorSink({ putter: first.putter, recordsPath, manifestPath, now: () => NOW });
    s1.append(rec(0));
    await s1.reconcile();
    expect(first.puts).toHaveLength(1);

    const second = fakePutter();
    const s2 = new S3ObjectLockAnchorSink({ putter: second.putter, recordsPath, manifestPath });
    expect(s2.readAll().map((r) => r.seq)).toEqual([0]);
    await s2.reconcile();
    expect(second.puts).toHaveLength(0); // already locked → no re-PUT
  });

  it("createS3AnchorSinkFromEnv fails closed when MCP_S3_BUCKET is absent", async () => {
    await expect(createS3AnchorSinkFromEnv({})).rejects.toThrow(/requires MCP_S3_BUCKET/i);
  });
});
