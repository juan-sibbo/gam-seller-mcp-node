import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadDsrState, saveDsrState, validateDsrState } from "../src/policy/dsr-state.js";
import { EntitlementStore, type EntitlementsConfig } from "../src/policy/entitlements.js";
import { AllowedSurface } from "../src/policy/types.js";

// A0 — persistent DSR overlay: DSR overrides (restrict/reinstate/erase) survive a restart,
// stay separate from the operator's entitlements config, and fail closed on corruption.

const CONFIG: EntitlementsConfig = {
  entitlements: [
    { buyer_id: "buyer-a", surfaces: [AllowedSurface.DISCOVERY], scopes: ["gam.readonly"], phase: "phase-1-readonly" },
    { buyer_id: "buyer-b", surfaces: [AllowedSurface.DISCOVERY], scopes: ["gam.readonly"], phase: "phase-1-readonly" },
  ],
};

describe("dsr-state module", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsr-state-"));
    path = join(dir, "dsr-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty overlay when the file is missing (first run)", () => {
    expect(loadDsrState(path)).toEqual({ suppressed: [], restricted: [] });
  });

  it("fails closed on a corrupt overlay file (does not silently drop overrides)", () => {
    writeFileSync(path, "{ this is not json", "utf-8");
    expect(() => loadDsrState(path)).toThrow(/fail-closed/i);
  });

  it("rejects an overlay whose fields are not string arrays", () => {
    expect(() => validateDsrState({ suppressed: "buyer-a", restricted: [] })).toThrow(/suppressed/);
    expect(() => validateDsrState({ suppressed: [], restricted: [1, 2] })).toThrow(/restricted/);
  });

  it("round-trips save -> load", () => {
    const state = { suppressed: ["buyer-a"], restricted: ["buyer-b"] };
    saveDsrState(path, state);
    expect(loadDsrState(path)).toEqual(state);
  });

  it("fails closed on a non-ENOENT read error (does not conflate unreadable with absent)", () => {
    // Reading the directory itself yields EISDIR, not ENOENT — must throw, not return empty.
    expect(() => loadDsrState(dir)).toThrow(/fail-closed/i);
  });

  it("writes atomically with owner-only permissions and leaves no temp file", () => {
    saveDsrState(path, { suppressed: ["buyer-a"], restricted: [] });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("EntitlementStore persistence (DSR overlay)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsr-store-"));
    path = join(dir, "dsr-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists an Art. 18 restriction across a reload", () => {
    const store = new EntitlementStore(CONFIG, path);
    expect(store.suspend("buyer-a")).toBe(true);

    const reloaded = new EntitlementStore(CONFIG, path);
    expect(reloaded.isSuspended("buyer-a")).toBe(true);
    expect(reloaded.get("buyer-a")).toBeUndefined(); // DENY (Default-Deny takes over)
    expect(reloaded.get("buyer-b")).toBeDefined();    // untouched
  });

  it("persists an Art. 18 reinstatement across a reload", () => {
    const store = new EntitlementStore(CONFIG, path);
    store.suspend("buyer-a");
    expect(store.reinstate("buyer-a")).toBe(true);

    const reloaded = new EntitlementStore(CONFIG, path);
    expect(reloaded.isSuspended("buyer-a")).toBe(false);
    expect(reloaded.get("buyer-a")).toBeDefined();
  });

  it("keeps an Art. 17 erasure durable even when the config still grants the buyer", () => {
    const store = new EntitlementStore(CONFIG, path);
    store.remove("buyer-a");

    // Same CONFIG still lists buyer-a, but the erasure overlay must win.
    const reloaded = new EntitlementStore(CONFIG, path);
    expect(reloaded.get("buyer-a")).toBeUndefined();
    expect(reloaded.isSuspended("buyer-a")).toBe(false);
    expect(reloaded.get("buyer-b")).toBeDefined();
  });

  it("applies erasure precedence over restriction when both are present in the overlay", () => {
    saveDsrState(path, { suppressed: ["buyer-a"], restricted: ["buyer-a"] });
    const store = new EntitlementStore(CONFIG, path);
    expect(store.get("buyer-a")).toBeUndefined();
    expect(store.isSuspended("buyer-a")).toBe(false); // erased, not merely suspended
  });

  it("fails closed on construction when the overlay is corrupt", () => {
    writeFileSync(path, "not json at all", "utf-8");
    expect(() => new EntitlementStore(CONFIG, path)).toThrow(/fail-closed/i);
  });

  it("writes no overlay file for an in-memory store (legacy behavior unchanged)", () => {
    const store = new EntitlementStore(CONFIG); // no persistPath
    store.suspend("buyer-a");
    store.remove("buyer-b");
    expect(existsSync(path)).toBe(false);
    expect(store.get("buyer-a")).toBeUndefined();
  });
});
