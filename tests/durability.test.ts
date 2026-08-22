import { describe, it, expect, vi, afterEach } from "vitest";
import { DurabilityHealth } from "../src/durability.js";

// Unit tests for the shared durability-health signal (issue #51). Every file-backed store
// delegates its save()-failure handling here, so this covers the flip logic for all of them.

describe("DurabilityHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts healthy", () => {
    const d = new DurabilityHealth("intent", "intent store");
    expect(d.isHealthy()).toBe(true);
  });

  it("flips to unhealthy on a degraded persist, without throwing", () => {
    const d = new DurabilityHealth("denylist", "denylist");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => d.markDegraded(new Error("EACCES: permission denied"))).not.toThrow();

    expect(d.isHealthy()).toBe(false);
    // The failure is surfaced at ERROR severity with the subsystem tag and the cause.
    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain("[denylist] ERROR");
    expect(line).toContain("durability DEGRADED");
    expect(line).toContain("EACCES: permission denied");
  });

  it("recovers to healthy once a later persist succeeds", () => {
    const d = new DurabilityHealth("anchor", "anchor");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    d.markDegraded(new Error("ENOSPC"));
    expect(d.isHealthy()).toBe(false);

    d.markHealthy();
    expect(d.isHealthy()).toBe(true);
  });

  it("stringifies a non-Error cause instead of crashing", () => {
    const d = new DurabilityHealth("pseudonym", "key store");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    d.markDegraded("disk on fire");

    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain("disk on fire");
    expect(d.isHealthy()).toBe(false);
  });
});
