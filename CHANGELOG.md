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

[0.3.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.3.0
[0.2.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.2.0
[0.1.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.1.0
