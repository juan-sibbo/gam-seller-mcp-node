import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { runDsrCli, type DsrToolkitLike } from "../src/dsr/cli.js";
import type { DsrExport, DsrSuppressResult } from "../src/dsr/toolkit.js";

// D6 (DRIFT-REPORT): the DSR toolkit must be operable by a publisher who installed the node
// via npm/Docker — i.e. shipped as a bin. These tests cover the command dispatch (via an
// injected fake toolkit, so no file-backed store is touched) and the packaging contract that
// makes the CLI actually reach an installed user.

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

function fakeExport(buyerId: string): DsrExport {
  return {
    buyer_id: buyerId,
    pseudonym: "pseudo-x",
    generated_at: "2026-08-18T00:00:00.000Z",
    entitlement: null,
    entitlement_suspended: false,
    hot_ledger_entries: [],
    archived_entries: [],
    active_intents: [],
    note: "test fixture",
  };
}

function fakeSuppress(buyerId: string): DsrSuppressResult {
  return {
    buyer_id: buyerId,
    key_shredded: true,
    entitlement_removed: true,
    anonymized_hot_entries: 2,
    anonymized_archived_entries: 1,
    intents_purged: 0,
  };
}

// A toolkit stub whose calls are recorded, so a test can assert both the return code and that
// the CLI dispatched to the right method with the right buyer_id.
function stubToolkit(overrides: Partial<DsrToolkitLike> = {}) {
  return {
    exportBuyer: vi.fn((id: string) => fakeExport(id)),
    restrictBuyer: vi.fn(() => true),
    unrestrictBuyer: vi.fn(() => false),
    suppressBuyer: vi.fn((id: string) => fakeSuppress(id)),
    ...overrides,
  } satisfies DsrToolkitLike;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe("runDsrCli — command dispatch", () => {
  it("export prints the toolkit's export JSON to stdout and returns 0", () => {
    const toolkit = stubToolkit();
    const { out, err, sink } = capture();

    const code = runDsrCli(["export", "buyer-1"], { makeToolkit: () => toolkit, ...sink });

    expect(code).toBe(0);
    expect(toolkit.exportBuyer).toHaveBeenCalledWith("buyer-1");
    expect(JSON.parse(out.join(""))).toMatchObject({ buyer_id: "buyer-1", pseudonym: "pseudo-x" });
    expect(err.join("")).toBe("");
  });

  it("suppress prints the erasure result and reports the crypto-shred on stderr", () => {
    const toolkit = stubToolkit();
    const { out, err, sink } = capture();

    const code = runDsrCli(["suppress", "buyer-1"], { makeToolkit: () => toolkit, ...sink });

    expect(code).toBe(0);
    expect(toolkit.suppressBuyer).toHaveBeenCalledWith("buyer-1");
    expect(JSON.parse(out.join(""))).toMatchObject({ key_shredded: true, entitlement_removed: true });
    // 2 hot + 1 archived = 3 entries anonymized.
    expect(err.join("")).toContain("3 entries now irreversibly anonymous");
  });

  it("restrict reports the applied suspension on stderr and returns 0", () => {
    const toolkit = stubToolkit({ restrictBuyer: vi.fn(() => true) });
    const { err, sink } = capture();

    const code = runDsrCli(["restrict", "buyer-1"], { makeToolkit: () => toolkit, ...sink });

    expect(code).toBe(0);
    expect(err.join("")).toContain("entitlement suspended (Art. 18)");
  });

  it("unrestrict reports a NO-OP when the buyer was not restricted", () => {
    const toolkit = stubToolkit({ unrestrictBuyer: vi.fn(() => false) });
    const { err, sink } = capture();

    const code = runDsrCli(["unrestrict", "buyer-1"], { makeToolkit: () => toolkit, ...sink });

    expect(code).toBe(0);
    expect(err.join("")).toContain("NO-OP");
  });
});

describe("runDsrCli — usage errors fail before touching any store", () => {
  it.each([
    ["no arguments", [] as string[]],
    ["missing buyer_id", ["export"]],
    ["unknown command", ["delete", "buyer-1"]],
  ])("%s → exit 1, prints usage, never builds the toolkit", (_label, argv) => {
    const makeToolkit = vi.fn();
    const { err, sink } = capture();

    const code = runDsrCli(argv, { makeToolkit, ...sink });

    expect(code).toBe(1);
    expect(err.join("")).toContain("Usage: gam-seller-dsr");
    // Deferred wiring: a usage error must not construct the file-backed stores (no disk I/O).
    expect(makeToolkit).not.toHaveBeenCalled();
  });
});

describe("packaging contract — the CLI reaches an installed publisher (D6)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
    bin: Record<string, string>;
    files: string[];
  };

  it("exposes a gam-seller-dsr bin that points into the shipped dist/", () => {
    expect(pkg.bin["gam-seller-dsr"]).toBe("dist/dsr/cli.js");
  });

  it("ships dist/ so the bin is present in the published package", () => {
    expect(pkg.files).toContain("dist");
  });

  it("keeps a shebang on the CLI source so the built bin is executable", () => {
    const src = readFileSync(join(repoRoot, "src", "dsr", "cli.ts"), "utf-8");
    expect(src.startsWith("#!")).toBe(true);
  });
});
