# Changelog

This changelog groups work by feature, in the order it landed. It starts from this repo's first
public commit; earlier history was developed in a private monorepo and is summarized here for
context rather than replayed commit-by-commit.

## Unreleased

- Nothing yet.

## Built so far (pre-1.0, summarized)

- **MCP server skeleton + Default-Deny policy engine.** The three tools (`well_known_capabilities`,
  `discover_products`, `get_forecast`) and the fixed allow/deny surface list.
- **RS256 identity layer.** Token issuance and validation, plus a fail-closed revocation
  (denylist) mechanism, and a signed well-known capability document exposing the node's privacy
  posture.
- **Audit hash-chain.** Append-only, pseudonymized ledger with periodic external anchoring and a
  replay-verification path, so the ledger is tamper-evident rather than just append-only.
- **Synthetic catalog + rate limiting.** Per-buyer product family discovery and a per-buyer
  request rate limit, backed by local config rather than a live ad-server connection.
- **Bucketized forecast.** Deterministic, synthetic Low/Mid/High availability forecasts per
  product family and period.
- **GDPR/consent hardening.** Data-subject-rights toolkit (export, restrict, erase — Art.
  15/17/18/20), a reserved-but-unused consent-context field guarded against accidental use, and
  deployment-level legal configuration (DSR contact, controller model, retention window) that
  must be valid for the node to start at all.
- **Server-side wiring and tests.** End-to-end integration tests exercising the full
  auth → policy → rate-limit → domain → audit pipeline.
- **HTTP transport.** StreamableHTTP transport alongside stdio, persistent RS256 keys across
  restarts, and the well-known document served at its canonical route.
- **Docker packaging.** Multi-stage build, non-root runtime, healthcheck against the well-known
  endpoint, and persistent volumes for keys and audit data.
