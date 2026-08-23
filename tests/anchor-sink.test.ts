import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveAnchorSink, ANCHOR_SINK_ENV } from "../src/audit/anchor-sink.js";
import { DEV_ANCHOR_PATH, type AnchorSink } from "../src/audit/anchor.js";

// C-08 — the anchor destination is operator-selectable via MCP_ANCHOR_SINK. Default is the local
// append-only file; a module specifier loads a custom AnchorSink (the bring-your-own WORM seam
// that TSA / S3 backends plug into later). Misconfiguration fails closed (no silent fallback).

describe("resolveAnchorSink — MCP_ANCHOR_SINK selection (C-08)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-sink-"));
  });

  it("defaults to the append-only local file when unset", async () => {
    expect(await resolveAnchorSink({})).toBe(DEV_ANCHOR_PATH);
  });

  it('treats "file" (any case) as the local file sink', async () => {
    expect(await resolveAnchorSink({ [ANCHOR_SINK_ENV]: "file" })).toBe(DEV_ANCHOR_PATH);
    expect(await resolveAnchorSink({ [ANCHOR_SINK_ENV]: "FILE" })).toBe(DEV_ANCHOR_PATH);
  });

  it("loads a custom sink from a module that default-exports a factory", async () => {
    const modPath = join(dir, "custom-sink.mjs");
    writeFileSync(
      modPath,
      `export default (env) => ({
         _env: env,
         append() {},
         readAll() { return []; },
         isHealthy() { return true; },
       });`,
      "utf-8"
    );
    const sink = (await resolveAnchorSink({ [ANCHOR_SINK_ENV]: modPath })) as AnchorSink;
    expect(typeof sink).toBe("object");
    expect(typeof sink.append).toBe("function");
    expect(sink.readAll()).toEqual([]);
    expect(sink.isHealthy()).toBe(true);
  });

  it("loads a custom sink exported as createAnchorSink", async () => {
    const modPath = join(dir, "named-sink.mjs");
    writeFileSync(
      modPath,
      `export function createAnchorSink() {
         return { append() {}, readAll() { return []; }, isHealthy() { return true; } };
       }`,
      "utf-8"
    );
    const sink = (await resolveAnchorSink({ [ANCHOR_SINK_ENV]: modPath })) as AnchorSink;
    expect(typeof sink.append).toBe("function");
  });

  it("fails closed when the module cannot be loaded (no silent fallback to file)", async () => {
    await expect(
      resolveAnchorSink({ [ANCHOR_SINK_ENV]: join(dir, "does-not-exist.mjs") })
    ).rejects.toThrow(/could not load the anchor sink module/i);
  });

  it("fails closed when the module does not export a valid AnchorSink", async () => {
    const modPath = join(dir, "bad-sink.mjs");
    writeFileSync(modPath, `export default { not: "a sink" };`, "utf-8");
    await expect(resolveAnchorSink({ [ANCHOR_SINK_ENV]: modPath })).rejects.toThrow(
      /did not export a valid AnchorSink/i
    );
  });
});
