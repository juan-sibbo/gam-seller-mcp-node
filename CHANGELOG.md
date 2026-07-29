# Changelog

## [0.1.0] — 2026-07-22

First tagged release. Everything below was developed iteratively and is now stable enough
to version.

### Core request pipeline

- **MCP server skeleton + Default-Deny policy engine.** Three tools (`well_known_capabilities`,
  `discover_products`, `get_forecast`) behind a fixed allow/deny surface list. A bug in any
  gate fails closed, not open.
- **RS256 identity layer.** Token issuance and validation, fail-closed revocation denylist,
  persistent key pair across restarts (tokens survive a reboot).
- **Signed well-known capability document.** RS256-signed trust anchor served at the canonical
  `/.well-known/seller-mcp-capabilities` route; cacheable (max-age=3600).
- **Replay detection (SEC-GATE-3).** Optional `client_request_id` deduplication before auth,
  so a replayed request never reaches token validation.

### Audit and data protection

- **Hash-chained audit ledger.** Append-only, pseudonymized (HMAC-SHA256 buyer IDs), with
  periodic external head-hash anchoring. Tamper-evident rather than just append-only.
- **GDPR/consent hardening.** Data-subject-rights toolkit (export, restrict, erase — Art.
  15/17/18/20). Deployment-level legal configuration (DSR contact, retention window) that
  must be valid for the node to start.

### Inventory and pricing

- **Synthetic catalog + per-buyer access grants.** Product family discovery driven by
  `config/catalog.json`; buyers see only families they're entitled to.
- **Firm list price surface (SEC-GATE-13 bisturí).** `pricing_options` attached to
  discovered families when a non-expired price exists in `config/pricing.json`. Fail-closed
  on missing or stale `valid_until` — an expired price is never served.
- **Bucketized forecast.** Low / Mid / High availability per family and period. Currently
  synthetic; GAM ForecastService adapter seam in place.
- **Per-buyer rate limiting.** N=1 / T=30s, configurable.

### Transport and deployment

- **HTTP transport.** StreamableHTTP on 127.0.0.1:3900 alongside the default stdio transport.
- **Docker packaging.** Multi-stage build, non-root runtime, healthcheck, persistent volumes
  for keys and audit data.
- **Worked publisher example.** `config/examples/pilot-publisher/` — swap three JSON files
  to deploy for a different publisher with no code changes.

### Testing

- Unit tests for all modules (policy, pricing, identity, audit, catalog, forecast, DSR).
- Integration tests over real in-memory MCP transports.
- HTTP transport tests over an ephemeral-port server.
- End-to-end buyer-agent session tests (D9).
- External Python interop probe — exercises the HTTP transport with no shared Node.js code.
- CI via GitHub Actions on every push.

### Community

- CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md.
- Issue templates: bug report, feature request, publisher integration.
- PR template with security-impact checklist.
- docs/BUYER-AGENT-GUIDE.md and docs/PUBLISHER-DEPLOYMENT.md.

## Unreleased

- Nothing yet.

## [0.2.0] — 2026-07-27

Second release. The theme is **making the privacy posture real at runtime**: the retention and
minimization commitments the node advertises in its well-known document are now enforced
automatically, not merely documented. Plus observability and a source-agnostic forecast core.

### Data protection and GDPR

- **Automatic ledger retention (A3).** The hot → archive → purge lifecycle is now enforced on a
  schedule (startup catch-up + periodic tick), not just defined. Previously `rotate()`/`purge()`
  existed but were never called, so the audit ledger grew without bound. Head-hash anchors still
  survive purge indefinitely — a hash without its ledger is not personal data.
- **Pseudonym keystore retention (crypto-shred by inactivity).** The per-buyer pseudonym keys —
  the one place a raw `buyer_id` still persisted in clear — now expire on the same A3 horizon. An
  inactive buyer's key is destroyed, making its ledger entries irreversibly anonymous without
  breaking the hash-chain; a re-appearing buyer gets a fresh, unlinkable key. The keystore gains a
  `last_used_at` stamp and migrates the previous on-disk format transparently.

### Observability

- **Prometheus metrics endpoint.** `/metrics` exposes request, auth, and policy counters for
  scraping.

### Forecast

- **Source-agnostic forecast engine.** `ForecastEngine` now takes an injectable `ForecastSource`.
  The default `SyntheticForecastSource` preserves the deterministic bucketing; a `GamForecastSource`
  stub is present but throws until a real GAM credential is authorized — so the `synthetic: true`
  invariant stays honest by construction.

### Dependencies and toolchain

- jose 5 → 6 (migrated off the removed `KeyLike` type to the global `CryptoKey`, and generate
  extractable RS256 keys so JWK persistence keeps working), zod 3 → 4, @types/node 18 → 26.
- GitHub Actions bumped: checkout v7, setup-node v7, setup-python v7. Dependabot configured for
  weekly npm + Actions updates.
- Repo hygiene: package.json metadata, `.nvmrc` (Node 22), `.editorconfig`.

### Testing

- Added integration coverage that `pricing_options` is absent when every configured price is expired.

## [0.3.0] — 2026-07-28

Third release. The theme is **making data-subject rights enforceable across restarts, not
just implementable**: an Art. 17 erasure or an Art. 18 restriction now survives a process
restart and a later config redeploy — plus a typed buyer client so integrators have a worked
starting point.

### Data protection and GDPR

- **Persistent DSR overlay.** Erasures (Art. 17) and restrictions (Art. 18) are now recorded in
  a durable overlay, kept deliberately separate from `config/entitlements.json` so a config
  redeploy can never silently re-grant an erased buyer or lift a restriction. The overlay is
  re-applied on boot and **fails closed on a corrupt file** — the node refuses to start rather
  than silently re-expose an erased buyer. Previously restrict/reinstate/erase mutated an
  in-memory map that died with the process, so a right exercised via the CLI evaporated on the
  next restart.
- **Operable DSR CLI on real state.** `scripts/dsr.ts` exposes `export`, `restrict`,
  `unrestrict`, and `suppress` (Art. 15/20, 18, 17), reading the real `config/entitlements.json`
  and persisting every mutation to the overlay — so `export` reflects a buyer's actual grants and
  each action survives a restart. `suppress` crypto-shreds the buyer's pseudonym key and reports
  how many ledger entries become irreversibly anonymous.
- **Hardened DSR persistence path.** Pre-release audit fixes: the entitlement erasure is persisted
  to the durable overlay *before* the pseudonym key is shredded (crash-safe ordering), and
  affected-entry counts are taken while the pseudonym is still computable.

### Examples

- **Typed TypeScript buyer client + quickstart.** `examples/buyer-client-ts/` — a worked, typed
  client and demo showing how a buyer agent connects over the transport and calls the read-only
  tools. Seed of the buyer SDK.

## [0.4.0] — 2026-07-29

Fourth release. The theme is **identity — closing the impersonation hole**: a buyer's
identity is now bound to its bearer token and can no longer be asserted as free input. This
is the first of the two Tier-0 "engine" blockers; the second — a minimal commitment
primitive (`create_intent`) — is re-sequenced to **v0.5** because it needs an owner allowlist
amendment (new `INTENT` surface) before it can land.

### Identity — buyer→node binding (BREAKING)

- **Buyer identity is now derived from the token, never from input.** `discover_products` and
  `get_forecast` no longer accept a `buyer_id` argument; the request's identity is the `sub` of
  a validated buyer bearer token (`aud=seller-mcp-node`). This closes the pre-v0.4 impersonation
  hole where the token was optional and `buyer_id` arrived as free input, so any caller could act
  as any buyer. **Breaking:** the buyer contract version moves `0.1.0 → 0.2.0`.
- **A dedicated buyer audience axis.** The validator guarding buyer surfaces accepts only buyer
  tokens (`aud=seller-mcp-node`), separate from the Domain-2 node↔adapter axis — a Domain-2 token
  is rejected on a buyer surface.
- **Token issuance and revocation CLIs.** `scripts/issue-buyer-token.ts <buyer_id>` mints a buyer
  token signed with the node's persistent key; `scripts/revoke-token.ts <token>` adds its `jti` to
  the durable denylist (which prevails over a valid signature).
- **`require_auth` enforcement (fail-closed).** New deployment flag, defaults to `true`. Because
  identity is derived solely from the token, there is no anonymous path — a deployment that sets
  `require_auth:false` refuses to boot rather than pretend to honor it.
- **Example buyer client + guide updated** to the token-only contract (identity via `token`, no
  `buyer_id`).

## [0.5.0] — 2026-07-29

Fifth release. The theme is **commitment — the engine reaches B**: an authenticated buyer can
now turn a firm offer into a recorded, per-buyer commitment. This closes the second and last
Tier-0 "engine" blocker. With identity (v0.4) and commitment (this release) in place, the core
seller-agent loop — authenticate → discover with price → commit — no longer has a broken part.

### Commitment primitive — `create_intent`

- **New `create_intent` tool.** An authenticated buyer registers a firm intent over a product
  family at its current firm price, with a TTL. It is **not** a GAM order nor a real inventory
  hold (`SOFT_LOCK_*` stays deferred to the future GAM tier) — it is the A′-compatible handoff
  artifact the classic direct-deal rails pick up. Zero GAM. Additive: existing tools are
  unchanged, so the buyer contract version stays `0.2.0`.
- **Identity from the token only.** Like the read tools, the committing buyer is the `sub` of a
  validated buyer token; there is no `buyer_id` input to spoof.
- **Fail-closed on a stale offer.** The intent is refused (generic `INVALID_REQUEST`) if the
  firm price is unknown, expired, or does not match the buyer's `price_ref` — a commitment is
  never recorded over a stale or misquoted offer, and neither the real price nor the family's
  existence leaks.
- **Per-buyer, never cross-buyer.** Intents are write-your-own and read-your-own; a buyer can
  never read or affect another buyer's intent (`cross_buyer_state` stays denied). The intent's
  TTL is capped at the firm price's own validity.
- **Auditable and minimized.** A valid commitment emits the already-ratified `INTENT_CREATED`
  event; the payload carries no exact price and the ledger pseudonymizes the buyer.
- **Idempotent writes.** A replayed `client_request_id` never records a second commitment.
- **Governance.** The new `INTENT` surface was added to the adapter-boundary allowlist by a
  ratified amendment (owner+security, 2026-07-29); the denylist is unchanged and still prevails.

[0.5.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.5.0
[0.4.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.4.0
[0.3.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.3.0
[0.2.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.1.0
