import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { operatorConfigDir } from "../config/resolve.js";

// Publisher disclosure policy — how the forecast estimate is presented to a buyer as commercial
// availability:
//
//     forecast estimate (GAM availableUnits, seeded or synthetic units)
//            ↓  haircut        (optional safety margin, publisher's choice)
//            ↓  round down     (default: 2 significant figures — 2,784,312 → 2,700,000)
//            ↓  below min_quantity → 0 (optional)
//     commercial availability  ← what check_availability reports
//
// The default rounding is about honesty, not secrecy: a forecast has no unit-level precision, so
// reporting 2,784,312 would suggest an accuracy it does not have. Rounding DOWN means the node never
// offers more than the forecast. A publisher that prefers to show coarser figures can opt into a
// ladder of steps (e.g. 1-2-5) — a commercial choice, not a system constraint.

export interface DisclosurePolicy {
  // Significant figures kept when rounding down (ignored when `ladder` is set).
  significantFigures: number;
  // Optional coarser presentation: mantissas per decade, ascending, in [1, 10), starting at 1.
  // [1, 2, 5] → 1k 2k 5k 10k…
  ladder?: number[];
  // Fraction of the estimate offered, (0, 1]. 1 = no safety margin.
  haircut: number;
  // Below this (after haircut) the answer is 0 / unavailable. 0 = report every volume.
  minQuantity: number;
}

export const DEFAULT_DISCLOSURE_POLICY: DisclosurePolicy = { significantFigures: 2, haircut: 1, minQuantity: 0 };

// Commercial availability for an estimate under the policy: haircut, then round down.
export function quantizeAvailability(estimate: number, policy: DisclosurePolicy): number {
  if (!Number.isFinite(estimate) || estimate <= 0) return 0;
  const offered = Math.floor(estimate * policy.haircut);
  if (offered < 1 || offered < policy.minQuantity) return 0;
  // Integer decade from the digit count avoids log10 rounding at exact powers of ten.
  const digits = String(offered).length;
  if (policy.ladder) {
    const decade = 10 ** (digits - 1);
    let step = decade; // ladder always contains 1
    for (const m of policy.ladder) {
      const candidate = Math.round(m * decade);
      if (candidate <= offered) step = candidate;
    }
    return step;
  }
  const unit = 10 ** Math.max(0, digits - policy.significantFigures);
  return Math.floor(offered / unit) * unit;
}

// Parses the optional `disclosure` block of gam.json / forecast.json. Fail-closed on anything odd.
export function parseDisclosurePolicy(raw: unknown, where: string): DisclosurePolicy {
  if (raw === undefined) return DEFAULT_DISCLOSURE_POLICY;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`[disclosure] ${where}: "disclosure" must be an object.`);
  }
  const r = raw as { significant_figures?: unknown; ladder?: unknown; haircut?: unknown; min_quantity?: unknown };

  if (r.ladder !== undefined && r.significant_figures !== undefined) {
    throw new Error(`[disclosure] ${where}: set either disclosure.significant_figures or disclosure.ladder, not both.`);
  }

  const significantFigures = r.significant_figures ?? DEFAULT_DISCLOSURE_POLICY.significantFigures;
  if (typeof significantFigures !== "number" || !Number.isInteger(significantFigures) || significantFigures < 1 || significantFigures > 6) {
    throw new Error(`[disclosure] ${where}: disclosure.significant_figures must be an integer from 1 to 6.`);
  }

  const ladder = r.ladder;
  if (
    ladder !== undefined &&
    (!Array.isArray(ladder) ||
      ladder.length === 0 ||
      !ladder.every((m) => typeof m === "number" && Number.isFinite(m) && m >= 1 && m < 10) ||
      ladder[0] !== 1 ||
      !ladder.every((m, i) => i === 0 || m > (ladder[i - 1] as number)))
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

  return { significantFigures, haircut, minQuantity, ...(ladder ? { ladder: ladder as number[] } : {}) };
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
