import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// Persistent DSR overlay — a durable record of the GDPR legal overrides applied on top of
// the operator's entitlements config. Kept DELIBERATELY SEPARATE from config/entitlements.json
// so that a config redeploy can never silently undo an Art. 17 erasure or an Art. 18 restriction
// (the operator's intended grants and the data subject's exercised rights are different things).
//
//   suppressed → Art. 17 erasure: the entitlement is removed and MUST stay removed, even if a
//                later config re-grants the same buyer_id.
//   restricted → Art. 18 restriction: the entitlement is suspended (DENY without delete), and
//                is reinstated only by an explicit operator act.
//
// Without this overlay, DsrToolkit's suspend/reinstate/remove mutate an in-memory Map that dies
// with the process — so an operator running the DSR CLI would exercise a right that evaporates on
// the next restart. Persisting the overlay is what makes those rights actually enforced at runtime.
export interface DsrState {
  suppressed: string[];
  restricted: string[];
}

export const DEV_DSR_STATE_PATH = "./data/dsr-state.json";

export function emptyDsrState(): DsrState {
  return { suppressed: [], restricted: [] };
}

// Fail-closed: a present-but-corrupt overlay must NOT be treated as "no overrides" — doing so
// would silently re-expose an erased or restricted buyer. Throw and refuse to start instead.
// A MISSING file is a legitimate first-run state and yields an empty overlay.
export function loadDsrState(path: string): DsrState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return emptyDsrState(); // first run — no overrides yet
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[dsr-state] Corrupt DSR overlay at ${path} — refusing to start (fail-closed). ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return validateDsrState(parsed, path);
}

export function validateDsrState(raw: unknown, source = "<memory>"): DsrState {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`[dsr-state] ${source}: not an object`);
  }
  const o = raw as Record<string, unknown>;
  if (!isStringArray(o["suppressed"])) {
    throw new Error(`[dsr-state] ${source}: "suppressed" must be an array of strings`);
  }
  if (!isStringArray(o["restricted"])) {
    throw new Error(`[dsr-state] ${source}: "restricted" must be an array of strings`);
  }
  return { suppressed: [...o["suppressed"]], restricted: [...o["restricted"]] };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function saveDsrState(path: string, state: DsrState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}
