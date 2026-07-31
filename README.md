# GAM Seller MCP Node

[![CI](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml/badge.svg)](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-green.svg)](https://modelcontextprotocol.io)

**AI buyer agents are about to participate in programmatic advertising. When they do, they need a governed interface to sell-side inventory — one that cannot be tricked into revealing sensitive data, and that cannot execute transactions it shouldn't.**

This is that interface.

A governed [Model Context Protocol](https://modelcontextprotocol.io) server that exposes sell-side ad inventory (Google Ad Manager and compatible systems) to buyer-side AI agents: discovery, firm pricing, and a soft **commitment** primitive. It performs **no writes to the ad server** — the only mutation it allows is a buyer's own soft commitment (a revocable, TTL-bound intent), never a GAM order or an inventory hold. No raw ad-server access. No sensitive data in responses. Every decision audited.

---

## What problem does this solve?

Sell-side ad inventory (availability, pricing, product structure) lives inside ad servers that hold commercially sensitive and sometimes personal data. Giving an AI buyer agent direct API access to GAM or a similar system creates three risks:

| Risk | Without this project | With this project |
|------|---------------------|-------------------|
| Data over-exposure | Agent can read raw avails, deal IDs, exact floor prices | Only coarse buckets and pre-declared families |
| Accidental writes | Agent SDK can create orders, modify line items | No ad-server writes exist; the only write is a buyer's own soft commitment, which can never become a GAM order or an inventory hold |
| No accountability | API calls are logged but not auditable | Hash-chained audit ledger; every allow/deny recorded |

## How it works

A buyer agent connects via MCP and gets five tools — three read-only, plus a buyer-scoped
commitment primitive (create/revoke) that is the sole write surface:

```
Buyer agent
    │
    ├── well_known_capabilities   ← Signed trust anchor. Check this first.
    │       Returns: RS256-signed capability document, node identity, privacy posture.
    │
    ├── discover_products         ← What can I buy here, and at what firm price?
    │       Returns: product families the buyer is entitled to see (e.g. "Pre-Roll Video"),
    │               each with its firm list price when the publisher has configured one.
    │       Never returns: deal IDs, internal IDs, raw inventory, exact per-impression pricing.
    │
    ├── get_forecast              ← How available is this family next quarter?
    │       Returns: Low / Mid / High availability bucket.
    │       Never returns: exact impression counts, CPM curves, floor prices.
    │
    ├── create_intent             ← Commit to a product at its current firm price (with TTL).
    │       Records a firm, time-boxed buying intent — fail-closed if the price is stale or
    │       mismatched. NOT a GAM order and NOT an inventory hold; it is the handoff artifact
    │       the classic sales rails pick up. Buyer-scoped: you can only ever commit as yourself.
    │
    └── revoke_intent             ← Withdraw one of your own active intents by id.
```

Every call flows through the same pipeline before any domain logic runs:

```
  Buyer request
       │
       ▼
  [SEC-GATE-3]  Replay detection — deduplicate client_request_id
       │
       ▼
  [Auth]        RS256 token validation → identity confirmed or AUTH_FAILED
       │
       ▼
  [Policy]      Surface denylist → entitlement check → scope check (Default-Deny)
       │
       ▼
  [Rate limit]  N=1 / T=30s per buyer_id
       │
       ▼
  [Domain]      Catalog / ForecastEngine — synthetic today, real GAM adapter in progress
       │
       ▼
  [Audit]       Append-only hash-chained ledger, buyer pseudonymized (HMAC)
       │
       ▼
  Response to buyer
```

A bug in any gate fails **closed**, not open.

`create_intent` runs the same gates and adds one more before it records anything: the buyer's
`price_ref` must match the family's current firm price, or the request is rejected — fail-closed on
a stale or mismatched offer, so an intent can never pin a price the publisher is no longer offering.

## Quick start

```bash
git clone https://github.com/juan-sibbo/gam-seller-mcp-node.git
cd gam-seller-mcp-node
npm install
npm run build
npm run start:http   # HTTP transport on 127.0.0.1:3900
```

Run the full buyer-agent walkthrough (scripted demo):

```bash
npx tsx demo/run-demo.ts
```

### With Docker

```bash
docker compose up
```

The node starts on `127.0.0.1:3900`. The well-known document is at
`/.well-known/seller-mcp-capabilities`. Persistent volumes for keys and audit data are
pre-configured in `docker-compose.yml`.

### Configure for your publisher

Four JSON files under `config/` drive all publisher-specific behaviour — no code changes needed:

```
config/deployment.json     # DSR contact, controller model, data retention window
config/catalog.json        # product families + per-buyer access grants
config/entitlements.json   # which buyers are entitled to which MCP surfaces
config/pricing.json        # firm list prices per family (optional; fail-closed on expiry)
```

All four fail closed on startup: invalid or missing config stops the node rather than running
with a silently different access policy. See
[`config/examples/pilot-publisher/`](config/examples/pilot-publisher/) for a worked example.

## Why not just use the GAM API directly?

| Approach | Data exposure | Writability | Auditability | AI-agent friendly |
|----------|--------------|-------------|--------------|-------------------|
| Raw GAM API | Everything in the account | Full CRUD | Logging only | Poor (SOAP/REST, no MCP) |
| OpenRTB bid requests | User-level data, floor prices | Bid-only | None | Poor |
| **This server** | Coarse families + bucket forecasts | Buyer's own soft commitment only (no GAM writes) | Hash-chained ledger | Native MCP |

## Current status

Working MVP. The full request pipeline (auth → policy → rate-limit → domain → audit),
the buyer-scoped commitment primitive (`create_intent` / `revoke_intent`, with TTL expiry),
the audit ledger, GDPR data-subject-rights toolkit, Docker packaging, HTTP transport,
and a live interop probe (Python buyer agent simulation) are all implemented and tested.

**Not yet wired**: a live Google Ad Manager connection. The catalog and forecast data are
synthetic, loaded from local config. The GAM ForecastService SOAP adapter interface exists
([`src/forecast/source.ts`](src/forecast/source.ts)) and is the next major milestone.
See the [open issues](https://github.com/juan-sibbo/gam-seller-mcp-node/issues) for the roadmap.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full module map and data-flow diagrams.

Key modules:

| Module | Role |
|--------|------|
| `src/server.ts` | MCP tool definitions + request pipeline |
| `src/policy/` | Default-Deny engine, entitlement store, surface allowlist/denylist |
| `src/identity/` | RS256 key management, token issuance/validation, revocation denylist |
| `src/audit/` | Hash-chained ledger, HMAC pseudonymization, external anchoring |
| `src/pricing/` | Firm list price store, expiry-aware (fail-closed on stale prices) |
| `src/forecast/` | Bucket engine + GAM adapter seam (synthetic today) |
| `src/dsr/` | GDPR Art. 15/17/18/20 data-subject-rights toolkit |
| `src/catalog/` | Product family store, per-buyer access grants |

## Security model

**Default-Deny.** Every request is denied unless an explicit entitlement says otherwise — there
is no "allow by default" path in the code.

**Structural allow/denylist (SEC-GATE-*).** Response surfaces are governed by a fixed list enforced
at the policy layer, independent of which tool was called. Exact pricing, deal IDs, raw availability
numbers, cross-buyer state, real inventory holds (soft-lock), and any ad-server write are permanently
denied. The one permitted write is a buyer's own commitment (`create_intent` / `revoke_intent`),
which required an explicit amendment to the surface allowlist and stays buyer-scoped. Adding a new
tool in the future cannot bypass this.

**Opaque errors.** A denied request, a failed authentication, and a revoked token all return the
same generic `AUTH_FAILED` code. Internal reasons never reach the buyer.

**Audit-first.** Every allow/deny is written to the ledger before the response is sent.
Buyer `buyer_id` values are pseudonymized (HMAC-SHA256) before entering the chain.

**Privacy by construction.** Responses carry only inventory-level data (product family, coarse
bucket). User-level attributes don't exist in any response path.

See [`docs/DESIGN-PRINCIPLES.md`](docs/DESIGN-PRINCIPLES.md) for the full reasoning.

## Testing

```bash
npm test                              # full suite (vitest)
python3 sandbox/buyer-agent-probe.py  # external Python interop probe (no shared code with server)
```

The test suite includes:
- **Unit tests** for each module (policy, pricing, identity, audit, catalog, forecast, DSR)
- **Integration tests** over real in-memory MCP transports (`tests/server.test.ts`)
- **HTTP transport tests** over a real ephemeral-port HTTP server (`tests/http.test.ts`)
- **End-to-end session tests** simulating a full buyer-agent session (`tests/buyer-agent-session.test.ts`)
- **External Python probe** that exercises the HTTP transport without any shared Node.js code

CI runs on every push via GitHub Actions.

## Data protection

Raw `buyer_id` values never enter the audit ledger — only an HMAC pseudonym. The
[`src/dsr/toolkit.ts`](src/dsr/toolkit.ts) implements export, restriction, and erasure of a
buyer's audit data (GDPR Art. 15/17/18/20). The node stores nothing about end users; the DSR
scope is exactly what it records — B2B buyer organization pseudonyms and their request events.

## Roadmap

See the [open issues](https://github.com/juan-sibbo/gam-seller-mcp-node/issues) for the full
roadmap. Highlights:

- **Real GAM adapter** — wire `getAvailabilityForecast` via the ForecastService SOAP API
- **Buyer agent SDKs** — Python and TypeScript client libraries for the MCP buyer flow
- **Multi-publisher federation** — let buyer agents discover across multiple seller nodes
- **OIDC buyer authentication** — replace manual entitlements with federated identity
- **OpenRTB 3.0 taxonomy** — align `family_id` scheme with IAB standards
- **Prometheus metrics** — observability endpoint for production deployments

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues tagged
[`good first issue`](https://github.com/juan-sibbo/gam-seller-mcp-node/issues?q=label%3A%22good+first+issue%22)
are a good starting point.

## License

MIT — see [LICENSE](LICENSE).
