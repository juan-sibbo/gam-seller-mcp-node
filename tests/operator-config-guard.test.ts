import { describe, it, expect } from "vitest";
import {
  assertOperatorConfigWhenRequired,
  REQUIRE_OPERATOR_CONFIG_ENV,
} from "../src/config/resolve.js";

// C-02 — atomic deploy boundary (PLAN-AGOSTO Fase 0, "fails closed"). When the operator declares a
// real deployment via MCP_REQUIRE_OPERATOR_CONFIG, any fall back to the bundled demo example must
// be a FATAL boot error — a real node must never serve example config unknowingly. Off by default.
// The guard takes injectable demo/fallbacks so this is deterministic without touching the FS.

const on = { [REQUIRE_OPERATOR_CONFIG_ENV]: "1" };
const off = {};

describe("assertOperatorConfigWhenRequired — atomic deploy boundary (C-02)", () => {
  it("throws when the flag is set AND the node fell back to demo config", () => {
    expect(() => assertOperatorConfigWhenRequired(on, true, ["entitlements.json"])).toThrow(
      /Refusing to start a real deployment on demo config/i
    );
  });

  it("names the offending files in the error", () => {
    expect(() => assertOperatorConfigWhenRequired(on, true, ["entitlements.json", "pricing.json"])).toThrow(
      /entitlements\.json, pricing\.json/
    );
  });

  it("does NOT throw when the flag is set but no demo fallback happened (real config present)", () => {
    expect(() => assertOperatorConfigWhenRequired(on, false, [])).not.toThrow();
  });

  it("does NOT throw when demo fallback happened but the flag is unset (dev/demo default)", () => {
    expect(() => assertOperatorConfigWhenRequired(off, true, ["catalog.json"])).not.toThrow();
  });

  it("accepts truthy spellings (true / yes / case-insensitive) and ignores others", () => {
    for (const v of ["true", "YES", "1", "True"]) {
      expect(() => assertOperatorConfigWhenRequired({ [REQUIRE_OPERATOR_CONFIG_ENV]: v }, true, ["x.json"])).toThrow();
    }
    for (const v of ["0", "false", "", "off"]) {
      expect(() => assertOperatorConfigWhenRequired({ [REQUIRE_OPERATOR_CONFIG_ENV]: v }, true, ["x.json"])).not.toThrow();
    }
  });
});
