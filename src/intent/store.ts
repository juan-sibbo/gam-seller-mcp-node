import { randomUUID } from "crypto";

// In-memory store of buyer commitments — v0.5 Bloque B (plan-core-v04 §3).
// An Intent records that an AUTHENTICATED buyer expressed firm intent over a product
// at its current firm price, with a TTL. It is NOT a GAM order nor a real inventory
// hold (SOFT_LOCK_* is deferred to Tier 2) — it is the A′-compatible handoff artifact
// the classic rails pick up.
//
// Per-buyer boundary (hard rule): an intent is write-your-own + read-your-own state.
// get() is buyer-scoped, so a buyer can never read or affect another buyer's intent —
// this is the store-level enforcement of the cross_buyer_state denylist (policy/types.ts).

export type IntentStatus = "active" | "expired" | "revoked";

export interface Intent {
  intent_id: string;
  buyer_id: string;
  family_id: string;
  period: string;
  firm_price: number;
  currency: string;
  status: IntentStatus;
  created_at: string; // ISO 8601
  expires_at: string; // ISO 8601
}

export interface CreateIntentInput {
  buyer_id: string;
  family_id: string;
  period: string;
  firm_price: number;
  currency: string;
  // ISO 8601 instant the underlying firm price goes stale. The intent must NOT outlive
  // the offer it pins, so expires_at is capped at this instant (fail-closed on staleness).
  price_valid_until: string;
  now?: Date; // injectable for testing
}

// Default commitment lifetime — aligns with the replay window and buyer token TTL.
// The effective expiry is min(now + this, price_valid_until): an intent can never
// outlive the firm price it commits to.
export const DEFAULT_INTENT_TTL_MS = 15 * 60 * 1000;

export class IntentStore {
  private readonly byId = new Map<string, Intent>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_INTENT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  create(input: CreateIntentInput): Intent {
    const now = input.now ?? new Date();
    // Cap the TTL at the firm price's own validity — never commit past a stale offer.
    const ttlExpiry = now.getTime() + this.ttlMs;
    const priceExpiry = Date.parse(input.price_valid_until);
    const expiresAt = new Date(Math.min(ttlExpiry, priceExpiry));

    const intent: Intent = {
      intent_id: randomUUID(),
      buyer_id: input.buyer_id,
      family_id: input.family_id,
      period: input.period,
      firm_price: input.firm_price,
      currency: input.currency,
      status: "active",
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    this.byId.set(intent.intent_id, intent);
    return intent;
  }

  // Buyer-scoped read. Returns the intent ONLY if it belongs to the asking buyer —
  // a cross-buyer read resolves to undefined (never leak another buyer's state).
  get(intent_id: string, buyer_id: string): Intent | undefined {
    const intent = this.byId.get(intent_id);
    if (!intent || intent.buyer_id !== buyer_id) return undefined;
    return intent;
  }

  size(): number {
    return this.byId.size;
  }
}
