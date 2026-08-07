import { describe, it, expect } from "vitest";
import { buildHealthReport } from "../src/health.js";

// v0.8 operability — /health surfaces persistence durability across all 5 disk-backed stores.
// Issue #51: extended from ledger-only (E1) to all stores.

const ALL_OK = { ledger: true, anchor: true, pseudonym: true, retention: true, denylist: true };

describe("buildHealthReport", () => {
  it("reports ok when all stores are healthy", () => {
    expect(buildHealthReport(ALL_OK, "0.8.0")).toEqual({
      status: "ok",
      version: "0.8.0",
      persistence_healthy: true,
      stores: ALL_OK,
    });
  });

  it("reports degraded when any store has failed", () => {
    const stores = { ...ALL_OK, ledger: false };
    const report = buildHealthReport(stores, "0.8.0");
    expect(report.status).toBe("degraded");
    expect(report.persistence_healthy).toBe(false);
    expect(report.stores.ledger).toBe(false);
  });

  it("degraded on anchor failure", () => {
    const report = buildHealthReport({ ...ALL_OK, anchor: false }, "0.9.0");
    expect(report.status).toBe("degraded");
    expect(report.persistence_healthy).toBe(false);
    expect(report.stores.anchor).toBe(false);
  });

  it("degraded on pseudonym failure — crypto-shredding durability at risk", () => {
    const report = buildHealthReport({ ...ALL_OK, pseudonym: false }, "0.9.0");
    expect(report.status).toBe("degraded");
    expect(report.stores.pseudonym).toBe(false);
  });

  it("degraded on retention failure", () => {
    const report = buildHealthReport({ ...ALL_OK, retention: false }, "0.9.0");
    expect(report.status).toBe("degraded");
    expect(report.stores.retention).toBe(false);
  });

  it("degraded on denylist failure — token revocation durability at risk", () => {
    const report = buildHealthReport({ ...ALL_OK, denylist: false }, "0.9.0");
    expect(report.status).toBe("degraded");
    expect(report.stores.denylist).toBe(false);
  });

  it("carries no field beyond status/version/persistence_healthy/stores (no leak)", () => {
    expect(Object.keys(buildHealthReport(ALL_OK, "x")).sort()).toEqual([
      "persistence_healthy",
      "status",
      "stores",
      "version",
    ]);
  });

  it("stores block contains exactly the 5 expected store keys", () => {
    const { stores } = buildHealthReport(ALL_OK, "x");
    expect(Object.keys(stores).sort()).toEqual([
      "anchor",
      "denylist",
      "ledger",
      "pseudonym",
      "retention",
    ]);
  });
});
