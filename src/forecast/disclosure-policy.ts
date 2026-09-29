import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { operatorConfigDir } from "../config/resolve.js";

// Publisher disclosure policy — turns a forecast estimate into the commercial availability a buyer
// may see:
//
//     forecast estimate (GAM availableUnits, seeded or synthetic units)   ← never leaves the node
//            ↓  haircut        (optional safety margin, publisher's choice)
//            ↓  floor to a step of the publisher's ladder (e.g. 1-2-5: …, 1M, 2M, 5M, 10M, …)
//            ↓  below min_quantity → 0
//     commercial availability                                              ← the only number a buyer sees
//
// The ladder SIZE is policy. The existence of a ladder is architecture: every buyer-facing answer
// is computed from the quantized value only, so no sequence of questions ("can you do 2.6M?
// 2.7M?") reveals more than the step the value falls in. Disabling quantization would turn the
// availability check into an oracle for the exact forecast — so it cannot be configured away.

export interface DisclosurePolicy {
  // Mantissas per decade, ascending, each in [1, 10), always including 1. [1, 2, 5] → 1k 2k 5k 10k…
  ladder: number[];
  // Fraction of the estimate offered, (0, 1]. 1 = no safety margin.
  haircut: number;
  // Below this (after haircut) the answer is 0 / unavailable. Hides the long tail of tiny avails.
  minQuantity: number;
}

export const DEFAULT_DISCLOSURE_POLICY: DisclosurePolicy = { ladder: [1, 2, 5], haircut: 1, minQuantity: 1000 };

// Largest ladder step <= the estimate after haircut, or 0 below minQuantity.
export function quantizeAvailability(estimate: number, policy: DisclosurePolicy): number {
  if (!Number.isFinite(estimate) || estimate <= 0) return 0;
  const offered = Math.floor(estimate * policy.haircut);
  if (offered < policy.minQuantity || offered < 1) return 0;
  // Integer decade from the digit count avoids log10 rounding at exact powers of ten.
  const decade = 10 ** (String(offered).length - 1);
  let step = decade; // ladder always contains 1
  for (const m of policy.ladder) {
    const candidate = Math.round(m * decade);
    if (candidate <= offered) step = candidate;
  }
  return step;
}

// True when n is a value quantizeAvailability can produce under this policy (0 or a ladder step).
export function isDisclosableQuantity(n: number, policy: DisclosurePolicy): boolean {
  return n === 0 || quantizeAvailability(n, { ...policy, haircut: 1, minQuantity: 0 }) === n;
}

// Parses the optional `disclosure` block of gam.json / forecast.json. Fail-closed on anything odd.
export function parseDisclosurePolicy(raw: unknown, where: string): DisclosurePolicy {
  if (raw === undefined) return DEFAULT_DISCLOSURE_POLICY;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`[disclosure] ${where}: "disclosure" must be an object.`);
  }
  const r = raw as { ladder?: unknown; haircut?: unknown; min_quantity?: unknown };

  const ladder = r.ladder ?? DEFAULT_DISCLOSURE_POLICY.ladder;
  if (
    !Array.isArray(ladder) ||
    ladder.length === 0 ||
    !ladder.every((m) => typeof m === "number" && Number.isFinite(m) && m >= 1 && m < 10) ||
    ladder[0] !== 1 ||
    !ladder.every((m, i) => i === 0 || m > (ladder[i - 1] as number))
  ) {
    throw new Error(
      `[disclosure] ${where}: disclosure.ladder must be ascending mantissas in [1, 10) starting at 1, e.g. [1, 2, 5].`
    );
  }

  const haircut = r.haircut ?? DEFAULT_DISCLOSURE_POLICY.haircut;
  if (typeof haircut !== "number" || !Number.isFinite(haircut) || haircut <= 0 || haircut > 1) {
    throw new Error(`[disclosure] ${where}: disclosure.haircut must be a number in (0, 1].`);
  }

  const minQuantity = r.min_quantity ?? DEFAULT_DISCLOSURE_POLICY.minQuantity;
  if (typeof minQuantity !== "number" || !Number.isInteger(minQuantity) || minQuantity < 0) {
    throw new Error(`[disclosure] ${where}: disclosure.min_quantity must be an integer >= 0.`);
  }

  return { ladder: ladder as number[], haircut, minQuantity };
}

// The policy lives next to the data it governs: the `disclosure` block of config/gam.json when the
// live GAM source is configured, else of config/forecast.json, else the default. Opt-in files, the
// same config dir the forecast loaders read (no demo-example fallback).
export function loadDisclosurePolicyFromFile(configDir: string = operatorConfigDir()): DisclosurePolicy {
  for (const file of ["gam.json", "forecast.json"]) {
    const path = join(configDir, file);
    if (existsSync(path)) {
      const cfg = JSON.parse(readFileSync(path, "utf-8")) as { disclosure?: unknown };
      return parseDisclosurePolicy(cfg.disclosure, file);
    }
  }
  return DEFAULT_DISCLOSURE_POLICY;
}
