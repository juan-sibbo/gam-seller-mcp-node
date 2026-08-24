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

// Env flag by which an operator declares "this is a real deployment": when set, the node must
// NOT boot on the bundled demo example. Truthy = 1 / true / yes.
export const REQUIRE_OPERATOR_CONFIG_ENV = "MCP_REQUIRE_OPERATOR_CONFIG";

// Fail-closed production guard (PLAN-AGOSTO Fase 0 — "atomic deploy boundary, fails closed").
// Without config a deployment silently falls back to the demo example, which is right for
// dev/`npx` but WRONG for a real deployment: it would serve demo entitlements (real access to
// example families) unknowingly. When MCP_REQUIRE_OPERATOR_CONFIG is set, any demo fallback is a
// fatal boot error — refusing to start beats serving example config in production. Off by default
// so the one-paste demo keeps working. Params are injectable for testing.
export function assertOperatorConfigWhenRequired(
  env: NodeJS.ProcessEnv = process.env,
  demo: boolean = isDemoMode(),
  fallbacks: readonly string[] = demoFallbackFiles()
): void {
  const required = ["1", "true", "yes"].includes((env[REQUIRE_OPERATOR_CONFIG_ENV] ?? "").trim().toLowerCase());
  if (required && demo) {
    throw new Error(
      `[config] FATAL: ${REQUIRE_OPERATOR_CONFIG_ENV} is set but the node fell back to the bundled ` +
        `demo example for: ${fallbacks.join(", ")}. Refusing to start a real deployment on demo ` +
        `config. Provide real config (e.g. via MCP_CONFIG_DIR) for every file, or unset the flag ` +
        `for dev/demo use.`
    );
  }
}

// Env flag: require a client-supplied idempotency key (client_request_id) on every authenticated
// request. `client_request_id` drives SEC-GATE-3 (replay detection); it is OPTIONAL by default for
// back-compat, which means a request that simply omits it bypasses replay detection entirely
// (issue #82). When this flag is set, an authenticated request WITHOUT a client_request_id is
// rejected — so the replay gate cannot be bypassed by omission. Off by default (back-compat);
// a real deployment opts in, same posture as MCP_REQUIRE_OPERATOR_CONFIG. Truthy = 1 / true / yes.
export const REQUIRE_IDEMPOTENCY_KEY_ENV = "MCP_REQUIRE_IDEMPOTENCY_KEY";

export function requiresIdempotencyKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes"].includes((env[REQUIRE_IDEMPOTENCY_KEY_ENV] ?? "").trim().toLowerCase());
}
