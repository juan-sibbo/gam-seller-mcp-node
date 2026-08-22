# Governance Contract

The **sovereign-governance guarantees** this node makes — stated once, in plain terms, for an
operator, a publisher's legal team, or a public-procurement auditor. Each guarantee is enforced
in code and pinned by a single conformance suite (`tests/governance-contract.test.ts`), so
weakening any one **breaks the build on purpose** rather than drifting silently.

These guarantees are **substrate-agnostic**: they define what a *governed* agentic sell-side
deployment must uphold. They certify this node today; they can equally certify a third-party
engine (e.g. an open-source sales agent) operated **under this governance layer**.

| # | Guarantee (what we promise) | Why it matters to a public entity | Enforced by |
|---|---|---|---|
| **G1** | **No auto-execution.** A buyer agent can discover, price, and register a *soft, buyer-scoped intent* — but the node can **never** create an ad-server order, hold inventory, or mutate a deal. The commitment is a handoff artifact; a **human** on the publisher side executes. | A public entity cannot delegate to an external agent the decision of *what is sold*. The human-in-the-loop is a legal/institutional **requirement**, not a limitation. | `order_create`, `deal_create`, `media_buy`, `inventory_reserve`, `deal_mutate` are on the **denylist**, which prevails over any valid token (`src/policy/types.ts`). |
| **G2** | **Audience-blind.** The node never infers, stores, or transmits audience segments. Consent / legal-basis fields exist only as a **reserved, forced-null envelope shape** — the node would *transport and audit* a publisher-asserted signal if a real standard materialized, but it **never invents a vocabulary and never reinterprets** the publisher's basis. | Sidesteps the DSA Art. 26(3) landmine (no profiling on special categories, not even by inference) at the architecture level. | `assertConsentFieldsEmpty` throws on any non-null value (`src/catalog/consent-types.ts`); `cross_buyer_state` denied. |
| **G3** | **List-price-only.** Only the publisher's **firm, published list price** is exposed — never exact per-impression pricing, floors, or CPM curves. Expired prices fail closed (omitted, never stale). | The publisher keeps price sovereignty; no auction, no leakage of commercial floors. | `exact_pricing`, `raw_avails` denied; pricing gate fails closed on expiry. |
| **G4** | **No raw ad-server exposure.** No GAM IDs, objects, admin surfaces, SOAP faults, or credential internals ever cross the boundary. | Protects the publisher's ad-server topology and commercial data from an external agent. | `gam_ids`, `gam_objects`, `gam_admin`, `soap_faults`, `credential_internals` denied. |
| **G5** | **Closed allowlist, Default-Deny.** The set of authorized surfaces is frozen; anything not explicitly allowed is denied. Adding a surface requires a **signed governance amendment** (and updating the conformance suite). | An identifiable, auditable, bounded surface — exactly what a procurement/liability regime needs from a third party. | `AllowedSurface` ∩ `DeniedSurface` = ∅; the allowed set is frozen in `tests/governance-contract.test.ts`. |

**Auditability underpins all of the above:** every allow/deny decision is appended to a
hash-chained, buyer-pseudonymized ledger whose integrity is verified on startup — so the record
of *what was offered, committed, and refused* survives inspection.

## What this is NOT
- It is **not** a consent-propagation framework. No deployed standard for agent-to-agent consent
  exists; the node **defers to TCF/GPP** and, at most, would *declare* a consent requirement — it
  does not carry or reinterpret legal basis (see `src/catalog/consent-types.ts` header).
- It is **not** an execution layer. AdCP operates at the campaign/deal layer and cedes to OpenRTB
  at execution; this node is a **governed discovery + quotation surface with a human handoff**.

## For operators
This contract is the thing an operator *sells*: a deployment that a regulated public entity can
adopt because it provably keeps the human in charge, stays audience-blind, protects price and
ad-server sovereignty, and records everything — under a bounded, amendable, signed surface.
