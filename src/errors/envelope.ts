// Closed enum of 7 error codes — soap-fault-redaction-signoff.md §3, RATIFIED 18/06/26.
// Values are fixed. Do not add codes without a signed governance act.
export const ErrorCode = {
  AUTH_FAILED: "AUTH_FAILED",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAVAILABLE: "UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  DEPRECATED: "DEPRECATED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// Safe buyer-facing error envelope — soap-fault-redaction-signoff.md §2.
// NEVER include: stack traces, env vars, GAM IDs, SOAP faults, quota exact values,
// policy internals, credential internals, upstream error bodies.
export interface SafeErrorEnvelope {
  code: ErrorCode;
  message: string;
  request_id: string;
  contract_version: string;
}

export function makeSafeError(
  code: ErrorCode,
  message: string,
  request_id: string,
  contract_version = "0.1.0"
): SafeErrorEnvelope {
  return { code, message, request_id, contract_version };
}

// Revocation errors surface as AUTH_FAILED — soap-fault-redaction-signoff.md §4 Option A.
// The buyer cannot distinguish revocation from ordinary auth failure (max ocultamiento de estado).
export function makeRevocationError(request_id: string): SafeErrorEnvelope {
  return makeSafeError(ErrorCode.AUTH_FAILED, "Authentication failed.", request_id);
}

// When an internal error cannot produce a safe envelope, use this.
// NEVER propagate the underlying cause buyer-facing.
export function makeFallbackError(request_id: string): SafeErrorEnvelope {
  return makeSafeError(ErrorCode.INTERNAL_ERROR, "An internal error occurred.", request_id);
}
