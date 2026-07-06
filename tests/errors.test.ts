import { describe, it, expect } from "vitest";
import {
  ErrorCode,
  makeSafeError,
  makeRevocationError,
  makeFallbackError,
  type SafeErrorEnvelope,
} from "../src/errors/envelope.js";

// soap-fault-redaction-signoff.md §2 + §3 + §4 — ratified 18/06/26
describe("SafeErrorEnvelope", () => {
  describe("enum completeness", () => {
    it("has exactly 7 codes", () => {
      expect(Object.keys(ErrorCode)).toHaveLength(7);
    });

    it("includes all ratified codes", () => {
      const codes = Object.values(ErrorCode);
      expect(codes).toContain("AUTH_FAILED");
      expect(codes).toContain("NOT_FOUND");
      expect(codes).toContain("RATE_LIMITED");
      expect(codes).toContain("INVALID_REQUEST");
      expect(codes).toContain("UNAVAILABLE");
      expect(codes).toContain("INTERNAL_ERROR");
      expect(codes).toContain("DEPRECATED");
    });
  });

  describe("makeSafeError", () => {
    it("produces envelope with correct shape", () => {
      const env = makeSafeError(ErrorCode.AUTH_FAILED, "Authentication failed.", "req-001");
      expect(env.code).toBe("AUTH_FAILED");
      expect(env.message).toBe("Authentication failed.");
      expect(env.request_id).toBe("req-001");
      expect(env.contract_version).toBe("0.1.0");
    });

    it("never leaks internal fields (stack traces, env, GAM IDs etc.)", () => {
      const env = makeSafeError(ErrorCode.INTERNAL_ERROR, "An internal error occurred.", "req-002");
      const keys = Object.keys(env);
      const forbidden = ["stack", "trace", "env", "secret", "gam_id", "line_item", "order_id", "cause", "debug"];
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
    });

    it("envelope has exactly 4 fields", () => {
      const env = makeSafeError(ErrorCode.NOT_FOUND, "Not found.", "req-003");
      expect(Object.keys(env)).toHaveLength(4);
    });
  });

  describe("makeRevocationError — §4 Option A (AUTH_FAILED)", () => {
    it("uses AUTH_FAILED for revocation (indistinguishable from auth failure)", () => {
      const env = makeRevocationError("req-rev-001");
      // Revocation must NOT surface a distinct code — soap-fault-redaction-signoff.md §4
      expect(env.code).toBe("AUTH_FAILED");
    });

    it("does not leak that the token was revoked specifically", () => {
      const env = makeRevocationError("req-rev-001");
      expect(env.message).not.toMatch(/revok/i);
      expect(env.message).not.toMatch(/denylist/i);
      expect(env.message).not.toMatch(/blocked/i);
    });
  });

  describe("makeFallbackError", () => {
    it("uses INTERNAL_ERROR for unknown cases", () => {
      const env = makeFallbackError("req-fb-001");
      expect(env.code).toBe("INTERNAL_ERROR");
    });
  });

  describe("safe serialization — Z3 invariant check", () => {
    // Z3: no buyer-facing response contains user-level attributes.
    // Error envelopes must not contain audience segments, device IDs, TC Strings.
    it("error envelope contains no audience or user-level fields", () => {
      const env: SafeErrorEnvelope = makeSafeError(ErrorCode.RATE_LIMITED, "Too many requests, retry later.", "req-z3");
      const serialized = JSON.stringify(env);
      const z3Forbidden = ["audience", "segment", "device_id", "user_id", "tc_string", "consent_string", "gdpr_applies", "user_agent"];
      for (const field of z3Forbidden) {
        expect(serialized).not.toContain(field);
      }
    });
  });
});
