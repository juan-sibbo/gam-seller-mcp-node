import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

// Persistence path resolution — v0.6 hardening (E2).
//
// The store paths used to be CWD-relative ("./data/…", "./keys/…"). That fails OPEN: start
// the process from another directory and every store resolves to a different place — a fresh
// empty ledger/denylist/keystore, or writes landing where nobody reads them. For a node whose
// whole value is a durable, tamper-evident audit trail, silently reading an empty ledger
// because of the launch directory is exactly the kind of fail-open this project forbids.
//
// Anchoring to import.meta.url makes the locations deterministic wherever the process is
// launched from (same idiom the catalog/pricing loaders already use for ../../config). This
// module sits at src/config, so ../.. is the repo root for both tsx (src) and the built dist.
// An optional MCP_DATA_DIR / MCP_KEYS_DIR env override lets a deployment relocate state
// (e.g. onto a mounted volume) without touching code.

const moduleDir = dirname(fileURLToPath(import.meta.url)); // src/config or dist/config
const repoRoot = join(moduleDir, "..", "..");

export const DATA_DIR = process.env.MCP_DATA_DIR ?? join(repoRoot, "data");
export const KEYS_DIR = process.env.MCP_KEYS_DIR ?? join(repoRoot, "keys");

export const dataPath = (name: string): string => join(DATA_DIR, name);
export const keysPath = (name: string): string => join(KEYS_DIR, name);

// The node's package version, resolved from package.json at the repo root and memoized.
// Used by the /health snapshot so operators can see which release is running. Fails soft to
// "unknown" — a health endpoint must never crash on a missing/unreadable manifest.
let cachedVersion: string | undefined;
export function packageVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { version?: string };
      cachedVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      cachedVersion = "unknown";
    }
  }
  return cachedVersion;
}
