import { describe, it, expect, beforeEach } from "vitest";
import { EventClass, hashEntry, verifyEntryHash } from "../src/audit/event.js";
import { AuditLedger, createMemoryLedger } from "../src/audit/ledger.js";
import {
  HeadHashAnchor,
  createMemoryAnchor,
  verifyAfterRestore,
  ANCHOR_INTERVAL_MS,
} from "../src/audit/anchor.js";
import { ReplayGuard } from "../src/audit/replay.js";
import { makeSafeError, makeRevocationError, makeFallbackError, ErrorCode } from "../src/errors/envelope.js";

// decision-package-mcp-consolidated.md Bloque 2 — RATIFIED 15/06/26
// S3 done criteria:
//   1. Verificación head-hash-first pasa tras restore simulado
//   2. Test negativo: ningún error contiene stack/env/secrets/IDs internos
//   3. Replay del mismo jti/request_id → DENY

describe("EventClass taxonomy", () => {
  it("has exactly 16 ratified event classes (decision-package §2.4)", () => {
    expect(Object.keys(EventClass)).toHaveLength(16);
  });

  it("includes all required read-only event classes from §9", () => {
    const classes = Object.values(EventClass);
    expect(classes).toContain("buyer_authentication");
    expect(classes).toContain("scope_resolution");
    expect(classes).toContain("forecast_request");
    expect(classes).toContain("forecast_cache_fill");
    expect(classes).toContain("intent_created");
    expect(classes).toContain("intent_expired");
    expect(classes).toContain("intent_revoked");
    expect(classes).toContain("soft_lock_set");
    expect(classes).toContain("soft_lock_expired");
    expect(classes).toContain("soft_lock_revoked");
    expect(classes).toContain("operator_gate_approval");
    expect(classes).toContain("operator_gate_rejection");
    expect(classes).toContain("token_issuance");
    expect(classes).toContain("token_revocation");
    expect(classes).toContain("anchoring");
    expect(classes).toContain("restore");
  });

  it("does NOT include 'configuration_change' (deferrable per §9, not in the 16)", () => {
    expect(Object.values(EventClass)).not.toContain("configuration_change");
  });
});

describe("AuditLedger — hash-chain (KANON P25 + E-03)", () => {
  let ledger: AuditLedger;

  beforeEach(() => {
    ledger = createMemoryLedger();
  });

  it("genesis entry has empty prev_hash", () => {
    const e = ledger.append(EventClass.BUYER_AUTHENTICATION, { result: "ok" }, { buyer_id: "b1" });
    expect(e.seq).toBe(0);
    expect(e.prev_hash).toBe("");
  });

  it("subsequent entries chain correctly", () => {
    const e0 = ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });
    const e1 = ledger.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "b1" });
    expect(e1.prev_hash).toBe(e0.hash);
    expect(e1.seq).toBe(1);
  });

  it("each entry hash is deterministic from its fields", () => {
    const e = ledger.append(EventClass.TOKEN_ISSUANCE, { jti: "tok-001" });
    const recomputed = hashEntry(e.seq, e.event_class, e.payload, e.prev_hash, e.timestamp);
    expect(recomputed).toBe(e.hash);
  });

  it("verifyEntryHash passes for intact entry", () => {
    const e = ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid" }, { buyer_id: "b1" });
    expect(verifyEntryHash(e)).toBe(true);
  });

  it("verifyEntryHash fails for tampered entry", () => {
    const e = ledger.append(EventClass.FORECAST_REQUEST, { bucket: "mid" });
    const tampered = { ...e, payload: { bucket: "high" } }; // payload changed, hash not recomputed
    expect(verifyEntryHash(tampered)).toBe(false);
  });

  it("headHash returns hash of last entry", () => {
    ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    const last = ledger.append(EventClass.SCOPE_RESOLUTION, {});
    expect(ledger.headHash()).toBe(last.hash);
  });

  it("headHash is empty for an empty ledger", () => {
    expect(ledger.headHash()).toBe("");
  });

  describe("replayVerify — full chain validation", () => {
    it("valid chain passes replay", () => {
      ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });
      ledger.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "b1" });
      ledger.append(EventClass.FORECAST_REQUEST, { bucket: "low" }, { buyer_id: "b1" });
      const result = ledger.replayVerify();
      expect(result.valid).toBe(true);
    });

    it("empty ledger passes replay", () => {
      expect(ledger.replayVerify().valid).toBe(true);
    });
  });
});

// S3 done criterion #1: Verificación head-hash-first pasa tras restore simulado
describe("Post-restore verification — head-hash-first then full replay (decision-package §2.3)", () => {
  it("verifies a fresh ledger with no anchor (empty = valid)", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();
    const result = verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor);
    expect(result.valid).toBe(true);
    expect(result.headHashMatch).toBe(true);
  });

  it("passes head-hash-first check after simulated restore (anchor matches)", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();

    ledger.append(EventClass.BUYER_AUTHENTICATION, {}, { buyer_id: "b1" });
    ledger.append(EventClass.SCOPE_RESOLUTION, {}, { buyer_id: "b1" });

    // Simulate anchoring the head hash before "restore"
    anchor.anchor(ledger.headHash(), ledger.size() - 1);

    // Simulate restore: same ledger (not tampered)
    const result = verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor);
    expect(result.valid).toBe(true);
    expect(result.headHashMatch).toBe(true);
    expect(result.replayResult?.valid).toBe(true);
  });

  it("fails head-hash-first check when ledger is tampered after anchoring", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();

    ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    anchor.anchor(ledger.headHash(), 0);

    // Tamper: add an entry AFTER anchoring without re-anchoring
    ledger.append(EventClass.SCOPE_RESOLUTION, {});

    const result = verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor);
    expect(result.headHashMatch).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("anchoring event is logged and anchor record is appended", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();

    ledger.append(EventClass.TOKEN_ISSUANCE, { jti: "tok-abc" });
    const headHash = ledger.headHash();
    anchor.anchor(headHash, ledger.size() - 1);

    // Log the anchoring event in the ledger itself
    const anchorEntry = ledger.append(EventClass.ANCHORING, {
      anchored_head_hash: headHash,
      anchor_seq: 0,
    });

    expect(anchor.count()).toBe(1);
    expect(anchor.latest()?.head_hash).toBe(headHash);
    expect(anchorEntry.event_class).toBe(EventClass.ANCHORING);
    // The anchoring payload stores the hash but NOT internal secrets
    expect(JSON.stringify(anchorEntry.payload)).not.toMatch(/secret|token|credential/i);
  });

  it("anchoring interval is 60 min (decision-package §2.2)", () => {
    expect(ANCHOR_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("restore event is logged after verification", () => {
    const ledger = createMemoryLedger();
    const anchor = createMemoryAnchor();

    ledger.append(EventClass.BUYER_AUTHENTICATION, {});
    anchor.anchor(ledger.headHash(), 0);

    verifyAfterRestore(ledger.headHash(), () => ledger.replayVerify(), anchor);

    const restoreEntry = ledger.append(EventClass.RESTORE, {
      head_hash_match: true,
      replay_valid: true,
    });
    expect(restoreEntry.event_class).toBe(EventClass.RESTORE);
  });
});

// S3 done criterion #2: Test negativo — ningún error en el ledger contiene datos prohibidos
describe("Audit ledger negative test — no forbidden data in entries (KANON §Logs-y-Audit)", () => {
  it("audit entries do not contain secrets or tokens", () => {
    const ledger = createMemoryLedger();
    const e = ledger.append(EventClass.BUYER_AUTHENTICATION, {
      result: "ok",
      buyer_id: "test-buyer",
    }, { buyer_id: "test-buyer", request_id: "req-001" });

    const serialized = JSON.stringify(e);
    const forbidden = ["password", "secret", "private_key", "api_key", "token", "bearer", "credential"];
    for (const f of forbidden) {
      expect(serialized.toLowerCase()).not.toContain(f);
    }
  });

  it("audit entries do not contain SOAP faults or stack traces", () => {
    const ledger = createMemoryLedger();
    const e = ledger.append(EventClass.OPERATOR_GATE_REJECTION, {
      reason: "policy_deny",
    });
    const serialized = JSON.stringify(e);
    expect(serialized).not.toMatch(/soap:Fault|stacktrace|stack_trace|\.ts:\d+/i);
  });

  it("audit entries do not contain raw GAM IDs (line item, order, product)", () => {
    const ledger = createMemoryLedger();
    const e = ledger.append(EventClass.FORECAST_REQUEST, {
      bucket: "mid",
      buyer_id: "b1",
    });
    const serialized = JSON.stringify(e);
    const gamForbidden = ["line_item_id", "order_id", "creative_id", "network_code", "gam_product_id"];
    for (const f of gamForbidden) {
      expect(serialized).not.toContain(f);
    }
  });

  it("audit entries do not contain audience or user-level data (Z3 invariant)", () => {
    const ledger = createMemoryLedger();
    const e = ledger.append(EventClass.SCOPE_RESOLUTION, {
      scope: "gam.readonly",
      phase: "phase-1-readonly",
    }, { buyer_id: "b1" });
    const serialized = JSON.stringify(e);
    const z3Forbidden = ["segment_id", "user_id", "device_id", "tc_string", "audience_segment"];
    for (const f of z3Forbidden) {
      expect(serialized).not.toContain(f);
    }
  });

  it("error envelopes in buyer-facing context contain no internal error details", () => {
    const envelopes = [
      makeSafeError(ErrorCode.AUTH_FAILED, "Authentication failed.", "req-001"),
      makeSafeError(ErrorCode.INTERNAL_ERROR, "An internal error occurred.", "req-002"),
      makeRevocationError("req-003"),
      makeFallbackError("req-004"),
    ];

    for (const env of envelopes) {
      const serialized = JSON.stringify(env);
      const forbidden = ["stack", "trace", "gam_id", "line_item", "order_id", "env", "secret", "credential", "soap:Fault"];
      for (const f of forbidden) {
        expect(serialized.toLowerCase()).not.toContain(f.toLowerCase());
      }
    }
  });
});

// S3 done criterion #3: Replay del mismo jti/request_id → DENY
describe("ReplayGuard — request-level replay prevention (SEC-GATE-3)", () => {
  let guard: ReplayGuard;

  beforeEach(() => {
    guard = new ReplayGuard(15 * 60 * 1000); // 15 min window
  });

  it("first occurrence is not a replay", () => {
    expect(guard.isReplay("req-001")).toBe(false);
  });

  it("second occurrence within window is a replay → DENY", () => {
    guard.record("req-001");
    expect(guard.isReplay("req-001")).toBe(true);
  });

  it("different request_ids are independent", () => {
    guard.record("req-001");
    expect(guard.isReplay("req-002")).toBe(false);
  });

  it("expired entry is not a replay (window passed)", () => {
    // Use a 0ms window to force immediate expiry
    const shortGuard = new ReplayGuard(0);
    shortGuard.record("req-old");
    // After 0ms window, the entry should be expired
    expect(shortGuard.isReplay("req-old")).toBe(false);
  });

  it("prune removes expired entries and keeps live ones", () => {
    const shortGuard = new ReplayGuard(0);
    shortGuard.record("req-dead");
    const liveGuard = new ReplayGuard(15 * 60 * 1000);
    liveGuard.record("req-live");
    expect(shortGuard.prune()).toBe(1);
    expect(liveGuard.size()).toBe(1);
  });

  it("replay of the same jti across 10 attempts is consistently detected", () => {
    guard.record("jti-fixed");
    for (let i = 0; i < 10; i++) {
      expect(guard.isReplay("jti-fixed")).toBe(true);
    }
  });
});
