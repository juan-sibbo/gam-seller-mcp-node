import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Config resolution shared by all four loaders (deployment, catalog, entitlements,
// pricing). Precedence, highest first:
//
//   1. MCP_CONFIG_DIR/<file>   — an operator's real config (npx or containerised),
//                                same idiom as MCP_DATA_DIR / MCP_KEYS_DIR in paths.ts.
//   2. <repoRoot>/config/<file> — config present in a from-source checkout.
//   3. bundled pilot-publisher example — "demo mode": the package ships example config
//                                so `npx gam-seller-mcp-node` boots into a working,
//                                clearly-labelled demo instead of crashing on ENOENT.
//
// If none exists, the primary path is returned unchanged so the caller's readFileSync
// still fails closed with the original ENOENT — the fail-closed contract is preserved
// (a real deployment that points MCP_CONFIG_DIR at a missing file must not silently
// fall back to the demo catalog).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE_DIR = join(repoRoot, "config", "examples", "pilot-publisher");

// Read lazily, not at import time: an operator (or a test) may set MCP_CONFIG_DIR
// after this module is first imported.
function configDir(): string {
  return process.env.MCP_CONFIG_DIR ?? join(repoRoot, "config");
}

const demoFallbacks = new Set<string>();

export function resolveConfigPath(fileName: string): string {
  const primary = join(configDir(), fileName);
  if (existsSync(primary)) {
    return primary;
  }
  const example = join(EXAMPLE_DIR, fileName);
  if (existsSync(example)) {
    demoFallbacks.add(fileName);
    return example;
  }
  return primary;
}

// True once any loader has fallen back to a bundled example — i.e. the node is
// running on demo config, not on operator-provided config.
export function isDemoMode(): boolean {
  return demoFallbacks.size > 0;
}

export function demoFallbackFiles(): readonly string[] {
  return [...demoFallbacks];
}
