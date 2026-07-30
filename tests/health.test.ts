import { describe, it, expect } from "vitest";
import { buildHealthReport } from "../src/health.js";

// v0.8 operability — the /health snapshot surfaces the ledger durability flag (v0.6 E1).

describe("buildHealthReport", () => {
  it("reports ok when persistence is healthy", () => {
    expect(buildHealthReport(true, "0.8.0")).toEqual({
      status: "ok",
      version: "0.8.0",
      persistence_healthy: true,
    });
  });

  it("reports degraded when persistence has failed", () => {
    expect(buildHealthReport(false, "0.8.0")).toEqual({
      status: "degraded",
      version: "0.8.0",
      persistence_healthy: false,
    });
  });

  it("carries no field beyond status/version/persistence_healthy (no leak)", () => {
    expect(Object.keys(buildHealthReport(true, "x")).sort()).toEqual([
      "persistence_healthy",
      "status",
      "version",
    ]);
  });
});
