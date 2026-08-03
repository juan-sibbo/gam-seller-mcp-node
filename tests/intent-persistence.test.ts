import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IntentStore, createMemoryIntentStore } from "../src/intent/store.js";

// Issue #50 — the intent store must be durable: a committed intent (which produced a durable
// INTENT_CREATED) has to stay revocable and TTL-auditable across a restart, or the audit chain
// ends with a dangling INTENT_CREATED and no terminal event. Same file-backed, fail-closed
// pattern as the denylist / DSR overlay.

const FAMILY = "display-es-sports";
const PERIOD = "Q4-2026";
const FIRM_PRICE = 4.2;
// Far-future price validity so the intent's expiry is governed by the TTL, not the price.
const PRICE_VALID_UNTIL = "2099-12-31T23:59:59Z";

function baseInput(buyer_id: string, now?: Date) {
  return {
    buyer_id,
    family_id: FAMILY,
    period: PERIOD,
    firm_price: FIRM_PRICE,
    currency: "EUR",
    price_valid_until: PRICE_VALID_UNTIL,
    now,
  };
}

describe("IntentStore persistence (issue #50)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intent-store-"));
    path = join(dir, "intents.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty store when the file is missing (first boot)", () => {
    const store = new IntentStore(undefined, path);
    expect(store.size()).toBe(0);
    expect(existsSync(path)).toBe(false); // no write until something is stored
  });

  it("survives a restart: a committed intent is still readable by its owner", () => {
    const first = new IntentStore(undefined, path);
    const intent = first.create(baseInput("buyer-A"));

    // Simulate a restart: a brand-new instance backed by the same file.
    const reloaded = new IntentStore(undefined, path);
    expect(reloaded.size()).toBe(1);
    expect(reloaded.get(intent.intent_id, "buyer-A")?.intent_id).toBe(intent.intent_id);
    // Cross-buyer isolation is preserved across the reload.
    expect(reloaded.get(intent.intent_id, "buyer-B")).toBeUndefined();
  });

  it("keeps a reloaded intent revocable (the v0.7 revoke handle stays valid across restart)", () => {
    const first = new IntentStore(undefined, path);
    const intent = first.create(baseInput("buyer-A"));

    const reloaded = new IntentStore(undefined, path);
    const revoked = reloaded.revoke(intent.intent_id, "buyer-A");
    expect(revoked?.status).toBe("revoked");

    // The revoke is itself durable: a third instance no longer sees the intent.
    const afterRevoke = new IntentStore(undefined, path);
    expect(afterRevoke.get(intent.intent_id, "buyer-A")).toBeUndefined();
    expect(afterRevoke.size()).toBe(0);
  });

  it("reloads an intent that lapsed during downtime so the boot sweep can expire it", () => {
    // Create an intent with a tiny TTL in the past — it is written while still "active".
    const past = new Date("2020-01-01T00:00:00Z");
    const first = new IntentStore(1, path); // 1ms TTL
    const intent = first.create(baseInput("buyer-A", past));

    // Restart: the lapsed-but-active intent is reloaded AS-IS...
    const reloaded = new IntentStore(1, path);
    expect(reloaded.size()).toBe(1);
    // ...and the (boot) sweep emits it exactly once as expired, then evicts it.
    const expired = reloaded.sweepExpired(new Date());
    expect(expired.map((i) => i.intent_id)).toEqual([intent.intent_id]);
    expect(expired[0].status).toBe("expired");
    expect(reloaded.size()).toBe(0);

    // The eviction is persisted — nothing dangling for the next boot.
    const afterSweep = new IntentStore(1, path);
    expect(afterSweep.size()).toBe(0);
  });

  it("persists only live intents — terminal ones are evicted from the file", () => {
    const store = new IntentStore(undefined, path);
    const a = store.create(baseInput("buyer-A"));
    store.create(baseInput("buyer-B"));
    store.revoke(a.intent_id, "buyer-A");

    const file = JSON.parse(readFileSync(path, "utf-8"));
    expect(file.intents.map((i: { buyer_id: string }) => i.buyer_id)).toEqual(["buyer-B"]);
  });

  it("fails closed on a corrupt store file (does not silently drop live commitments)", () => {
    writeFileSync(path, "{ this is not json", "utf-8");
    expect(() => new IntentStore(undefined, path)).toThrow(/fail-closed/i);
  });

  it("fails closed when the intents array is missing", () => {
    writeFileSync(path, JSON.stringify({ notIntents: [] }), "utf-8");
    expect(() => new IntentStore(undefined, path)).toThrow(/fail-closed/i);
  });

  it("writes nothing to disk in memory-only mode", () => {
    const store = createMemoryIntentStore();
    store.create(baseInput("buyer-A"));
    expect(existsSync(path)).toBe(false);
    expect(store.size()).toBe(1);
  });
});
