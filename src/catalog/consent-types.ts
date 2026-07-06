// ConsentContext — the OPAQUE ENVELOPE for future agent-to-agent consent propagation.
// gdpr-analysis §Q4 + privacy-consent-layer Pilar 3 (E-13a doctrine extended to consent).
//
// No deployed standard for agent-to-agent consent propagation exists (IAB "agentify
// TCF/GPP" is roadmap without spec — foresight §4). Designing a concrete vocabulary
// today would mean inventing a standard. What IS designed today is the SHAPE of the
// envelope, so that adopting whichever spec materializes is an additive change.
//
// HARD RULES:
// 1. In v1 (PATH A, Z3 SIGNED) every consent_context field is null. Always.
//    Populating it requires the PATH B gate — a separate signed governance act.
// 2. The CORE never interprets this envelope. Validation of the consent signal is
//    the ADAPTER layer's job (same place protocol serialization lives) — consistent
//    with the ratified precedence rule (minimization decided by core, vocabulary
//    mapped at adapter).

export interface ConsentContext {
  spec: string;          // e.g. "iab-tcf-agentic/1.0" — whatever standard materializes
  spec_version: string;
  payload: string;       // opaque, base64 — validated at ADAPTER layer, never in core
  received_at: string;   // ISO 8601 — when the signal entered the boundary
  provenance: string;    // who asserted it: "buyer-agent" | "orchestrator" | "cmp-relay"
}

// Legal basis provenance — PATH B only (gdpr-analysis §Q5). Reserved shape.
// The publisher ASSERTS the legal basis; the node transports and audits the assertion,
// it does not legally validate it. framework_version is mandatory because the TCF
// vocabulary moves (corpus documents v2.3 removing legitimate interest for advertising).
export interface LegalBasisProvenance {
  legal_basis: "consent" | "legitimate_interest" | "contract"; // GDPR Art. 6(1)(a)/(f)/(b)
  special_categories: boolean;  // Art. 9 — if true, explicit consent path only
  framework: string;            // e.g. "iab-tcf" — [[verificar versión TCF vigente al activar PATH B]]
  framework_version: string;
  purposes: number[];           // TCF purpose IDs covered by the asserted basis
  provenance: {
    asserted_by: string;        // publisher legal entity making the claim
    asserted_at: string;        // ISO 8601
    audit_ref: string | null;   // optional pointer to publisher-side consent records
  };
}

// v1 guard: throws if a consent field carries anything but null. Used by tests as a
// permanent invariant — populating these fields without the PATH B gate breaks the build.
export function assertConsentFieldsEmpty(entity: {
  consent_context: unknown;
  legal_basis_provenance: unknown;
}): void {
  if (entity.consent_context !== null) {
    throw new Error("Z3/PATH A violation: consent_context must be null in v1 (PATH B requires a separate gate)");
  }
  if (entity.legal_basis_provenance !== null) {
    throw new Error("Z3/PATH A violation: legal_basis_provenance must be null in v1 (PATH B requires a separate gate)");
  }
}
