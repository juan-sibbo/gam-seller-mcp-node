# Privacy & data-handling posture

**EU-governed seller node, audience-blind by design.**

This node is a *transaction loop* for selling inventory (discovery, catalog,
forecast, actionable pricing, commitment), not a data endpoint. Its core is
**audience-blind by design**: it operates without end-user advertising
identifiers or audience membership.

## What the core does *not* handle

- No cookies, MAIDs, PPIDs, `eids`, hashed emails, or audience members enter the core.
- No end-user consent string or per-user privacy context in the core loop;
  consent fields are structurally empty and enforced by a build invariant
  (see `assertConsentFieldsEmpty`).
- No CRM/CDP access from the model; no end-user identifiers in logs.
- Buyer identity is limited to commercial identity, mandate and authorization.
- Forecasts are aggregate; prices carry provenance.

If a change were to introduce end-user data into the core, the build/contract
tests fail on purpose.

## Scope of this note

These are **design properties of the implementation**, not a compliance
certification or legal advice. Operators remain responsible, under the law
applicable to their deployment (e.g. GDPR, ePrivacy, the AI Act), for their own
data-protection assessment, contracts and consent handling.
