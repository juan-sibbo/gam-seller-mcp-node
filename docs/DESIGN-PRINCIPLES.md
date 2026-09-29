# Design principles

## Default-Deny, not default-allow with exceptions

Every buyer request is denied unless an explicit entitlement says otherwise. The policy engine
has no "allow" branch that runs before entitlements are checked — the check order is fixed:
surface denylist → entitlement exists → surface covered → scope → phase. A bug that skips a
check fails closed, not open.

## A permanent, structural denylist

Certain response categories — exact pricing, deal IDs, raw availability numbers, anything that
would let a buyer create or modify an order — are not "not implemented yet," they are on a fixed
denylist that the policy engine consults on every request. That denylist works on the surface
label each tool declares, not on what the tool returns — so it is paired with a **disclosure
gate**: every authenticated tool declares a strict response schema, and any response carrying an
undeclared field is withheld before it leaves the node. A new tool cannot be registered without
one, so widening what a buyer sees is always an explicit, reviewable change to
`src/policy/disclosure.ts`.

## Errors don't leak state

A denied request and a failed authentication return the identical generic error. Internal
details (why exactly something was denied, whether a token was revoked vs. simply invalid,
stack traces, quota values) never reach the buyer-facing response — they only ever go to the
audit ledger, which the buyer cannot read.

## Audit first, trust nothing about the operator

Every allow/deny decision is written to an append-only, hash-chained ledger, and the buyer
identifier is pseudonymized (HMAC) *before* it's hashed into the chain — so even a full ledger
dump doesn't expose raw buyer identity, and the chain integrity doesn't depend on that identity
staying secret. The chain's head hash is periodically anchored outside the ledger file itself, so
tampering with the file in place is detectable.

## Privacy by construction, not by policy

The catalog and forecast responses never carry audience or user-level attributes — only
inventory-level data (product family, coarse availability bucket). A "consent context" field
exists in the type system as a reserved, always-null placeholder: the intent is that if
audience-aware features are ever added, they arrive through an explicit, separately-gated
extension — not by quietly filling in a field that already exists.

## No ad-server writes is a boundary, not a milestone

There's no plan to "eventually" let this node write to an ad server. Order creation, media buys,
inventory reservation and anything that mutates the ad server are on the permanent surface
denylist — a design boundary, not a temporary MVP limitation. The node's only write is a buyer's
own soft commitment (`create_intent` / `revoke_intent`): a time-boxed, buyer-scoped record at the
current firm price that a human on the publisher side acts on. It was added to the allowlist by an
explicit amendment and can never become a GAM order or an inventory hold. A future GAM-connected
write path, if it ever exists, would be a separate, explicitly-gated component — not an extension
of this server.

## Config over code for deployment-specific data

Anything that varies by publisher or deployment (which product families exist, legal/DSR
contact info, retention windows) lives in JSON config, not in code, so operating a new
deployment doesn't require a code change or a redeploy of logic.
