import { describe, it, expect } from "vitest";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { EventClass } from "../src/audit/event.js";
import { recordTokenIssuance, recordTokenRevocation } from "../src/identity/token-audit.js";

// v0.6 hardening (C) — token issuance/revocation must leave an audit trail. Before this,
// the CLIs populated keystore/denylist with no ledger event; a revocation was untraceable.

const BUYER = "test-buyer-001";
const JTI = "jti-abcdef-123";

describe("token-audit — issuance", () => {
  it("emits TOKEN_ISSUANCE correlatable by jti, buyer pseudonymized, token never logged", () => {
    const ledger = createMemoryLedger();
    recordTokenIssuance(ledger, { buyer_id: BUYER, jti: JTI, aud: "seller-mcp-node", exp: 1893456000 });

    const events = ledger.allEntries().filter((e) => e.event_class === EventClass.TOKEN_ISSUANCE);
    expect(events).toHaveLength(1);
    expect(events[0].request_id).toBe(JTI);
    expect(events[0].payload).toEqual({ aud: "seller-mcp-node", exp: 1893456000 });
    // The clear buyer_id never appears — the ledger pseudonymizes it before hashing.
    expect(JSON.stringify(ledger.allEntries())).not.toContain(BUYER);
    expect(events[0].buyer_id).toBeDefined();
    expect(events[0].buyer_id).not.toBe(BUYER);
  });
});

describe("token-audit — revocation", () => {
  it("emits TOKEN_REVOCATION with buyer pseudonymized when the buyer is known", () => {
    const ledger = createMemoryLedger();
    recordTokenRevocation(ledger, { jti: JTI, expires_at_ms: 1893456000000, buyer_id: BUYER });

    const events = ledger.allEntries().filter((e) => e.event_class === EventClass.TOKEN_REVOCATION);
    expect(events).toHaveLength(1);
    expect(events[0].request_id).toBe(JTI);
    expect(events[0].payload.revoked_until).toBe(new Date(1893456000000).toISOString());
    expect(JSON.stringify(ledger.allEntries())).not.toContain(BUYER);
  });

  it("emits TOKEN_REVOCATION with no buyer_id on the --jti path", () => {
    const ledger = createMemoryLedger();
    recordTokenRevocation(ledger, { jti: JTI, expires_at_ms: 1893456000000 });

    const events = ledger.allEntries().filter((e) => e.event_class === EventClass.TOKEN_REVOCATION);
    expect(events).toHaveLength(1);
    expect(events[0].request_id).toBe(JTI);
    // ledger.append drops a falsy buyer_id — the revocation is recorded without one.
    expect(events[0].buyer_id).toBeUndefined();
  });
});
