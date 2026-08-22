import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IntentStore, DEFAULT_INTENT_TTL_MS } from "../src/intent/store.js";

// C-12 — the intent store must write intents.json ATOMICALLY (temp file + rename), like the
// ledger (persistence-hardening.test.ts). A bare writeFileSync can leave a torn intents.json on
// a crash / ENOSPC mid-write; load() is fail-closed on a corrupt file, so a torn write turns
// into a node that refuses to restart. tmp+rename makes the target flip atomically: the reader
// always sees either the old file or the new one, never a partial one.

const VALID_INPUT = {
  buyer_id: "buyer-1",
  family_id: "fam-1",
  period: "2026-Q4",
  firm_price: 5,
  currency: "EUR",
  price_valid_until: new Date(Date.now() + 3_600_000).toISOString(),
};

describe("IntentStore — atomic persistence (C-12)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intent-atomic-"));
    path = join(dir, "intents.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes via a temp file — blocking the .tmp path makes save() fail-closed (proves atomic writer)", () => {
    const store = new IntentStore(DEFAULT_INTENT_TTL_MS, path);
    store.create(VALID_INPUT);
    expect(store.isPersistenceHealthy()).toBe(true);

    // Block the atomic writer: a DIRECTORY at `${path}.tmp` cannot be written as a file. A bare
    // writeFileSync(target) ignores this and succeeds (→ RED); an atomic tmp+rename writer hits
    // the blocked temp path and surfaces the failure (→ GREEN). Same trick as the ledger test.
    mkdirSync(`${path}.tmp`);
    store.create(VALID_INPUT); // triggers a save that must route through the (blocked) temp file
    expect(store.isPersistenceHealthy()).toBe(false);
  });

  it("a failed persist leaves the previously-committed intents.json intact (target untouched)", () => {
    const s1 = new IntentStore(DEFAULT_INTENT_TTL_MS, path);
    const first = s1.create(VALID_INPUT); // commits a valid file
    mkdirSync(`${path}.tmp`); // block the next atomic write
    s1.create(VALID_INPUT); // save fails on the temp write; the committed target must be untouched
    expect(s1.isPersistenceHealthy()).toBe(false);

    // A fresh load still sees the first (committed) intent — the target was never partially written.
    const s2 = new IntentStore(DEFAULT_INTENT_TTL_MS, path);
    expect(s2.get(first.intent_id, first.buyer_id)).toBeDefined();
  });
});
