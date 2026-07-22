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

[0.1.0]: https://github.com/juan-sibbo/gam-seller-mcp-node/releases/tag/v0.1.0
