import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir, hostname } from "os";
import { join } from "path";
import { OwnerLease, OwnerLeaseHeldError, withOwnerLease, LEASE_STALE_MS } from "../src/owner-lease.js";

let dir: string;
let path: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-lease-"));
  path = join(dir, ".owner.lease");
  clock = Date.parse("2026-09-30T10:00:00Z");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("OwnerLease", () => {
  it("grants the lease when the state directory has no owner", () => {
    const lease = new OwnerLease({ path, now });
    const record = lease.acquire("server");
    expect(record.kind).toBe("server");
    expect(lease.holds()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).holder_id).toBe(record.holder_id);
  });

  it("refuses a second owner while the first is alive, naming the holder", () => {
    new OwnerLease({ path, now }).acquire("server");
    clock += 5_000;
    const contender = new OwnerLease({ path, now });
    expect(() => contender.acquire("cli")).toThrow(OwnerLeaseHeldError);
    try {
      contender.acquire("cli");
    } catch (err) {
      expect((err as OwnerLeaseHeldError).holder.kind).toBe("server");
      expect((err as Error).message).toMatch(/Stop the node/);
    }
    expect(contender.holds()).toBe(false);
  });

  it("frees the state directory on release so the next owner can take it", () => {
    const first = new OwnerLease({ path, now });
    first.acquire("cli");
    first.release();
    expect(existsSync(path)).toBe(false);
    expect(new OwnerLease({ path, now }).acquire("server").kind).toBe("server");
  });

  it("takes over a lease whose holder stopped heartbeating (crashed node restarts unaided)", () => {
    const crashed = new OwnerLease({ path, now });
    crashed.acquire("server");
    clock += LEASE_STALE_MS + 1;
    const restarted = new OwnerLease({ path, now });
    expect(restarted.acquire("server").kind).toBe("server");
    // The crashed holder can no longer renew: its lease was replaced.
    expect(crashed.renew()).toBe(false);
  });

  it("keeps a live holder's lease as long as it heartbeats", () => {
    const owner = new OwnerLease({ path, now });
    owner.acquire("server");
    for (let i = 0; i < 10; i++) {
      clock += LEASE_STALE_MS / 2;
      expect(owner.renew()).toBe(true);
    }
    expect(() => new OwnerLease({ path, now }).acquire("cli")).toThrow(OwnerLeaseHeldError);
  });

  it("never deletes another holder's lease on release", () => {
    const stale = new OwnerLease({ path, now });
    stale.acquire("server");
    clock += LEASE_STALE_MS + 1;
    const current = new OwnerLease({ path, now });
    const record = current.acquire("server");
    stale.release();
    expect(JSON.parse(readFileSync(path, "utf-8")).holder_id).toBe(record.holder_id);
  });

  it("takes over at once a lease left by a dead predecessor with our pid (container restart)", () => {
    // Same pid + host, but not held by any live instance in this process: the node restarted in
    // the same container (pid 1 again). No need to wait LEASE_STALE_MS.
    writeFileSync(
      path,
      JSON.stringify({ holder_id: "previous-boot", kind: "server", pid: process.pid, host: hostname(),
        acquired_at: new Date(clock - 1000).toISOString(), heartbeat_at: new Date(clock - 1000).toISOString() })
    );
    expect(new OwnerLease({ path, now }).acquire("server").kind).toBe("server");
  });

  it("still refuses a live lease from another pid on the same host", () => {
    writeFileSync(
      path,
      JSON.stringify({ holder_id: "other-proc", kind: "server", pid: process.pid + 1, host: hostname(),
        acquired_at: new Date(clock).toISOString(), heartbeat_at: new Date(clock).toISOString() })
    );
    expect(() => new OwnerLease({ path, now }).acquire("cli")).toThrow(OwnerLeaseHeldError);
  });

  it("treats a corrupt lease file as stale instead of blocking forever", () => {
    writeFileSync(path, "{not json");
    expect(new OwnerLease({ path, now }).acquire("server").kind).toBe("server");
  });
});

describe("withOwnerLease", () => {
  it("runs the command as owner and always releases, even when it throws", async () => {
    await expect(withOwnerLease(() => { throw new Error("boom"); }, { path })).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
    expect(await withOwnerLease(() => 42, { path })).toBe(42);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to run the command at all while the node owns the state", async () => {
    new OwnerLease({ path }).acquire("server");
    let ran = false;
    await expect(withOwnerLease(() => { ran = true; }, { path })).rejects.toThrow(OwnerLeaseHeldError);
    expect(ran).toBe(false);
  });
});
