import { describe, it, expect } from "vitest";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { createMemoryAnchor, verifyAfterRestore } from "../src/audit/anchor.js";
import { EventClass } from "../src/audit/event.js";
import { anchorHead } from "../src/server.js";

// Regression: a node that served ANY audited traffic after its last anchor could not restart.
// Boot anchors the head and appends an ANCHORING event (so the head moves past the anchor at
// once), and anchoring then runs only every 60 min. Startup verification required the latest
// anchor to equal the CURRENT head, so the next boot — graceful restart or crash — failed
// head_hash_mismatch. The anchor pins a PREFIX of the chain: entries after it are the legitimate
// unanchored tail (the ratified 60-min exposure window), verified by chain replay.

const verify = (ledger: ReturnType<typeof createMemoryLedger>, anchor: ReturnType<typeof createMemoryAnchor>) =>
  verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor, (seq) => ledger.hashAt(seq));

describe("restart after traffic (anchor pins a prefix, not the head)", () => {
  it("a node that served traffic after its boot anchor restarts clean", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();
    ledger.append(EventClass.TOKEN_ISSUANCE, { jti: "j1" });
    anchorHead(ledger, anchor); // boot: anchor + trailing ANCHORING event
    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" }); // traffic
    ledger.append(EventClass.INTENT_CREATED, {}, { buyer_id: "b1" });

    const result = verify(ledger, anchor);
    expect(result.valid).toBe(true);
    expect(result.replayResult?.valid).toBe(true);
  });

  it("detects a rewritten anchored prefix (recomputed chain)", () => {
    const honest = createMemoryLedger();
    const anchor = createMemoryAnchor();
    honest.append(EventClass.BUYER_AUTHENTICATION, { outcome: "denied" }, { buyer_id: "b1" });
    anchor.anchor(honest.headHash(), honest.headSeq());

    // Operator rewrites history: an internally consistent chain with different content.
    const forged = createMemoryLedger();
    forged.append(EventClass.BUYER_AUTHENTICATION, { outcome: "ok" }, { buyer_id: "b1" });
    forged.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "b1" });

    const result = verify(forged, anchor);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("anchored_prefix_mismatch");
  });

  it("detects truncation below the anchored entry", () => {
    const full = createMemoryLedger();
    const anchor = createMemoryAnchor();
    full.append(EventClass.BUYER_AUTHENTICATION, {});
    full.append(EventClass.SCOPE_RESOLUTION, {});
    anchor.anchor(full.headHash(), full.headSeq()); // anchored seq 1

    const truncated = createMemoryLedger();
    truncated.append(EventClass.BUYER_AUTHENTICATION, {});

    const result = verify(truncated, anchor);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("anchored_entry_missing");
  });
});
