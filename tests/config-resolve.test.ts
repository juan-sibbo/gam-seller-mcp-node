import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Config resolution precedence + demo-mode fallback (src/config/resolve.ts).
// The module carries process-level state (which files fell back) and reads
// MCP_CONFIG_DIR lazily, so each case re-imports it fresh via vi.resetModules.

const EXAMPLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "examples",
  "pilot-publisher"
);

function freshResolve() {
  vi.resetModules();
  return import("../src/config/resolve.js");
}

describe("resolveConfigPath — precedence & demo fallback", () => {
  let tmp: string;
  const savedEnv = process.env.MCP_CONFIG_DIR;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-config-"));
    process.env.MCP_CONFIG_DIR = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.MCP_CONFIG_DIR;
    else process.env.MCP_CONFIG_DIR = savedEnv;
  });

  it("uses the operator's MCP_CONFIG_DIR file when present (not demo)", async () => {
    const operatorFile = join(tmp, "catalog.json");
    writeFileSync(operatorFile, "{}");
    const { resolveConfigPath, isDemoMode } = await freshResolve();

    expect(resolveConfigPath("catalog.json")).toBe(operatorFile);
    expect(isDemoMode()).toBe(false);
  });

  it("returns the primary path (fail-closed) when MCP_CONFIG_DIR is set and file is absent", async () => {
    // MCP_CONFIG_DIR is set (tmp is empty) but catalog.json is missing.
    // Must NOT fall back to demo example — partial config + real MCP_CONFIG_DIR is
    // worse than a startup failure (demo entitlements alongside real deployment config).
    const { resolveConfigPath, isDemoMode } = await freshResolve();

    expect(resolveConfigPath("catalog.json")).toBe(join(tmp, "catalog.json"));
    expect(isDemoMode()).toBe(false);
  });

  it("returns the primary path (fail-closed) when neither config nor example exists", async () => {
    const { resolveConfigPath, isDemoMode } = await freshResolve();

    expect(resolveConfigPath("no-such-file.json")).toBe(
      join(tmp, "no-such-file.json")
    );
    expect(isDemoMode()).toBe(false);
  });

  it("falls back to the bundled example (demo mode) when MCP_CONFIG_DIR is NOT set and no config/ file exists", async () => {
    // Without MCP_CONFIG_DIR the node falls through to the bundled example.
    delete process.env.MCP_CONFIG_DIR;
    const { resolveConfigPath, isDemoMode, demoFallbackFiles } = await freshResolve();

    expect(resolveConfigPath("catalog.json")).toBe(join(EXAMPLE_DIR, "catalog.json"));
    expect(isDemoMode()).toBe(true);
    expect(demoFallbackFiles()).toContain("catalog.json");
  });
});
