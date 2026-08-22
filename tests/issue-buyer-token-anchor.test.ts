import { describe, it, expect } from "vitest";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { createMemoryAnchor, verifyAfterRestore } from "../src/audit/anchor.js";
import { recordTokenIssuance } from "../src/identity/token-audit.js";

// Regression for #73. The token-issuer CLI (scripts/issue-buyer-token.ts) writes a
// TOKEN_ISSUANCE event to the persistent ledger. If it does not anchor the new head, the
// server's fail-closed startup verify rejects the non-empty, un-anchored ledger with
// `no_anchor_but_non_empty_ledger` and refuses to boot. The CLI must anchor the head (directly,
// no trailing ANCHORING event) so `latestAnchor.head_hash === ledger.headHash()` and
// verifyAfterRestore passes on the next startup.

describe("issue-buyer-token anchoring (regression #73)", () => {
  const claims = { buyer_id: "pilot-buyer-001", jti: "jti-1", aud: "seller-mcp-node", exp: 1893456000 };

  it("reproduces the bug: a recorded issuance with NO anchor fails startup verify", () => {
    const ledger = createMemoryLedger();
    recordTokenIssuance(ledger, claims);
    const anchor = createMemoryAnchor(); // empty — as if the CLI never anchored
    const result = verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("no_anchor_but_non_empty_ledger");
  });

  it("the fix: anchoring the head after the issuance makes startup verify clean", () => {
    const ledger = createMemoryLedger();
    recordTokenIssuance(ledger, claims);
    const anchor = createMemoryAnchor();
    anchor.anchor(ledger.headHash(), ledger.headSeq()); // exactly what the CLI now does
    const result = verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor);
    expect(result.valid).toBe(true);
    expect(result.headHashMatch).toBe(true);
  });
});
