import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";

// Persistent DSR overlay — a durable record of the GDPR legal overrides applied on top of
// the operator's entitlements config. Kept DELIBERATELY SEPARATE from config/entitlements.json
// so that a config redeploy can never silently undo an Art. 17 erasure or an Art. 18 restriction
// (the operator's intended grants and the data subject's exercised rights are different things).
//
//   suppressed → Art. 17 erasure: the entitlement is removed and MUST stay removed, even if a
//                later config re-grants the same buyer_id. Stored as a ONE-WAY HASH of the buyer_id,
//                never the raw id (#83): erasure must forget the identity, and enforcing "stay
//                erased" only needs to RECOGNISE the same id if it reappears (hash the incoming id,
//                check membership) — not retain it.
//   restricted → Art. 18 restriction: the entitlement is suspended (DENY without delete), and is
//                reinstated only by an explicit operator act. Kept as the raw buyer_id — a
//                restriction is a reversible, temporary limitation (not an erasure), and reinstating
//                the specific grant requires knowing who is restricted.
//
// Without this overlay, DsrToolkit's suspend/reinstate/remove mutate an in-memory Map that dies
// with the process — so an operator running the DSR CLI would exercise a right that evaporates on
// the next restart. Persisting the overlay is what makes those rights actually enforced at runtime.

// On-disk schema version. v1 = `suppressed` holds SHA-256 hashes of buyer_ids (not raw). A legacy
// overlay (no version) held raw ids in `suppressed`; it is migrated to hashes on first load (#83).
export const DSR_STATE_SCHEMA_VERSION = 1;

export interface DsrState {
  schema_version?: number;
  suppressed: string[];
  restricted: string[];
}

// One-way hash of a buyer_id for the suppression (erasure) list. Deterministic (the same id always
// hashes the same, so a re-appearing erased buyer is recognised and denied) and stable (independent
// of the shreddable per-buyer ledger pseudonym key, so it survives the Art. 17 crypto-shred).
export function hashBuyerId(buyer_id: string): string {
  return createHash("sha256").update(buyer_id, "utf8").digest("hex");
}

export const DEV_DSR_STATE_PATH = dataPath("dsr-state.json");

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
  } catch (err) {
    // ONLY a genuinely missing file is a legitimate first run. Any other read error
    // (EACCES permission denied, EISDIR, I/O) on a pre-existing overlay must fail closed —
    // returning an empty overlay would silently drop every persisted erasure/restriction and
    // re-expose the affected buyers. Do not conflate "absent" with "unreadable".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyDsrState();
    }
    throw new Error(
      `[dsr-state] Cannot read DSR overlay at ${path} ` +
        `(${(err as NodeJS.ErrnoException).code ?? "unknown"}) — refusing to start (fail-closed)`
    );
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
  const version = o["schema_version"];
  if (version !== undefined && typeof version !== "number") {
    throw new Error(`[dsr-state] ${source}: "schema_version" must be a number`);
  }
  return {
    schema_version: version as number | undefined,
    suppressed: [...o["suppressed"]],
    restricted: [...o["restricted"]],
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function saveDsrState(path: string, state: DsrState): void {
  // Atomic write: a crash (SIGKILL, power loss) mid-write must never leave a torn file that
  // fails the node closed on the next boot. Write to a sibling temp file, then rename —
  // rename is atomic on POSIX within the same filesystem, so a reader always sees either the
  // old or the new complete file. Owner-only permissions: `restricted` holds raw buyer_ids
  // (`suppressed` is hashed — #83).
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}
