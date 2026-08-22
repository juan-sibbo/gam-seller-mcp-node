# Governed MCP seller control-plane prototype for future GAM integration.

[![npm version](https://img.shields.io/npm/v/gam-seller-mcp-node.svg?logo=npm)](https://www.npmjs.com/package/gam-seller-mcp-node)
[![npm downloads](https://img.shields.io/npm/dm/gam-seller-mcp-node.svg)](https://www.npmjs.com/package/gam-seller-mcp-node)
[![CI](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml/badge.svg)](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-green.svg)](https://modelcontextprotocol.io)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes sell-side ad inventory to buyer-side AI agents: discovery, firm pricing, and a buyer-scoped soft commitment primitive. No writes to an ad server exist. The Google Ad Manager adapter is not yet connected; catalog and forecast data are synthetic.

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
    │       Records a firm, time-boxed buying intent — rejected if the price is stale or
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

Each request-path gate rejects on failure. Two honest caveats to the diagram above:

- **Rate limit** currently covers the read surfaces and `create_intent`; extending it to
  `revoke_intent`, so *every* authenticated tool is throttled, is in review (see the
  limitations table under [Current status](#current-status)).
- **`client_request_id`** (the replay-guard deduplication key) is optional; a request that omits
  it bypasses SEC-GATE-3.

A corrupted or tampered on-disk ledger is **detected on startup** and the node refuses to serve
(fail-closed on load, plus a chain-integrity verify before the first request) rather than
resetting to an empty chain.

`create_intent` runs the same gates and adds one more before it records anything: the buyer's
`price_ref` must match the family's current firm price, or the request is rejected.

## Quick start

### Install in an MCP client (via npx)

Add the server to your MCP client (Claude Desktop, Claude Code, Cursor, …):

```jsonc
{
  "mcpServers": {
    "gam-seller": {
      "command": "npx",
      "args": ["-y", "gam-seller-mcp-node"]
    }
  }
}
```

Or run it directly (stdio transport — the default for MCP clients):

```bash
npx -y gam-seller-mcp-node
```

> **Demo mode.** With no config of your own, the node boots on a bundled
> `pilot-publisher` example (illustrative catalog, prices and forecasts) and says so
> on stderr — it starts instead of failing, so you can try the tools immediately.
> Because buyer surfaces always require a token (there is no anonymous path, even in
> demo), the node **prints a ready-to-use demo buyer token** on startup: copy it and pass
> it as the `token` argument to `discover_products` / `get_forecast` to see the example
> families, prices and forecasts.
>
> For a real deployment, point `MCP_CONFIG_DIR` at a directory holding your own
> `deployment.json`, `catalog.json`, `entitlements.json` and `pricing.json`:
>
> ```bash
> MCP_CONFIG_DIR=/etc/gam-seller/config npx -y gam-seller-mcp-node
> ```

### From source

```bash
git clone https://github.com/juan-sibbo/gam-seller-mcp-node.git
cd gam-seller-mcp-node
npm install
npm run build
npm run start:http   # HTTP transport on 127.0.0.1:3900
```

Run the full buyer-agent walkthrough (scripted demo) — the five native tools driven over a real
in-process MCP transport, ending in the governed refusals (fail-closed auth, Default-Deny,
fail-closed pricing) and a verified audit chain:

```bash
npm run demo          # or: npx tsx demo/run-demo.ts
```

### With Docker

```bash
docker compose up
```

The node starts on `127.0.0.1:3900`. The well-known document is at
`/.well-known/seller-mcp-capabilities`. Persistent volumes for keys and audit data are
pre-configured in `docker-compose.yml`.

### Configure for your publisher

Four JSON files drive all publisher-specific behaviour — no code changes needed. Place them
in `config/` (from-source) or in the directory named by `MCP_CONFIG_DIR` (npx/containerised):

```
deployment.json     # DSR contact, controller model, data retention window
catalog.json        # product families + per-buyer access grants
entitlements.json   # which buyers are entitled to which MCP surfaces
pricing.json        # firm list prices per family (fail-closed on expiry)
```

**Invalid** config always fails closed: a malformed file stops the node rather than running
with a silently different access policy. **Absent** config (no `config/` and no `MCP_CONFIG_DIR`)
drops to the bundled [`config/examples/pilot-publisher/`](config/examples/pilot-publisher/)
example — demo mode, announced on stderr — so the node is never a broken install, only ever a
real deployment or a clearly-labelled demo.

## Why not just use the GAM API directly?

| Approach | Data exposure | Writability | Auditability | AI-agent friendly |
|----------|--------------|-------------|--------------|-------------------|
| Raw GAM API | Everything in the account | Full CRUD | Logging only | Poor (SOAP/REST, no MCP) |
| OpenRTB bid requests | User-level data, floor prices | Bid-only | None | Poor |
| **This server** | Coarse families + bucket forecasts | Buyer's own soft commitment only (no GAM writes) | Hash-chained ledger | Native MCP |

## Current status

Working prototype. The full request pipeline (auth → policy → rate-limit → domain → audit),
the buyer-scoped commitment primitive (`create_intent` / `revoke_intent`, with TTL expiry),
the audit ledger, GDPR data-subject-rights toolkit, Docker packaging, HTTP transport,
and a live interop probe (Python buyer agent simulation) are all implemented and tested.

**Not yet wired**: a live Google Ad Manager connection. The catalog and forecast data are
synthetic, loaded from local config. The GAM ForecastService SOAP adapter interface exists
([`src/forecast/source.ts`](src/forecast/source.ts)) as a stub — it throws on any call until a
service account is provisioned (DP-AB-01 §5.2). See the
[open issues](https://github.com/juan-sibbo/gam-seller-mcp-node/issues) for the roadmap.

**Known limitations** — dated status. Closed rows are kept on purpose: a limitations list that
changes state over time is both a proof of honesty and a proof of progress.

| Limitation | Anchor | Status | Closed by |
|---|---|---|---|
| Attribution (`buyer_id` / `request_id`) is stored per entry but sits **outside** the chain's tamper-evidence hash | `audit/event.ts` | Design decision, not a defect — traceability vs. erasability ([ADR-4](docs/adr/ADR-4.md)) | — |
| Head-hash anchor is a local, rewritable `writeFileSync` — no cloud WORM / Object Lock | `audit/anchor.ts` | **Open** — needs a real deployment target | deployment boundary |
| `client_request_id` (replay guard) is optional; omitting it bypasses SEC-GATE-3 | `src/server.ts` | **Open** | — |
| No TLS in transit (a reverse proxy is expected to terminate) | — | **Open** — deployment boundary | — |
| `revoke_intent` is not covered by the rate-limit stage | `src/server.ts` | **In review** | [#80](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/80) |
| GDPR DSR CLI (`scripts/dsr.ts`, …) not shipped in the npm package | `package.json` `files` | **In review** | [#78](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/78) |
| Ledger loaded fail-open — a corrupt file reset to an empty chain | `audit/ledger.ts` | ✅ **Closed** 2026-08-07 | [#65](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/65) |
| Chain integrity not verified before serving on startup | `src/server.ts` | ✅ **Closed** 2026-08-07 | [#65](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/65) |

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module map and data-flow diagrams.

Key modules:

| Module | Role |
|--------|------|
| `src/server.ts` | MCP tool definitions + request pipeline |
| `src/policy/` | Default-Deny engine, entitlement store, surface allowlist/denylist |
| `src/identity/` | RS256 key management, token issuance/validation, revocation denylist |
| `src/audit/` | Hash-chained ledger, HMAC pseudonymization, local-file head-hash anchoring |
| `src/pricing/` | Firm list price store, expiry-aware (fail-closed on stale prices) |
| `src/forecast/` | Bucket engine + GAM adapter seam (synthetic today) |
| `src/dsr/` | GDPR Art. 15/17/18/20 data-subject-rights toolkit (source only) |
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
Buyer `buyer_id` values are pseudonymized (HMAC-SHA256) before entering the chain. Note that
`buyer_id` and `request_id`, while stored in each audit entry, are not included in the
hash-chain's canonical input (`audit/event.ts:50`); those fields are not covered by the
chain's tamper-evidence guarantee.

**Privacy by construction.** Responses carry only inventory-level data (product family, coarse
bucket). User-level attributes don't exist in any response path.

See [`docs/DESIGN-PRINCIPLES.md`](docs/DESIGN-PRINCIPLES.md) for the full reasoning.

## Regulatory posture

The AEPD (Spain's data protection authority) published guidelines on agentic AI systems in
February 2026. The four recommendations most relevant to an ad-inventory node map directly to
existing design decisions:

| AEPD recommendation | This node |
|---------------------|-----------|
| Protection by design and by default | Default-Deny: every surface denied unless an explicit entitlement grants access |
| Record and document agent actions | Append-only hash-chained audit ledger; every allow/deny recorded before the response is sent |
| Control what leaves toward third parties, and with what traceability | Structural egress allowlist (SEC-GATE-*); exact pricing, deal IDs and raw availability permanently blocked |
| Govern agent memory with purpose and retention rules | DSR toolkit (Arts. 15/17/18/20); configurable retention window enforced on the audit ledger |

This alignment is declared machine-readably in the signed well-known document
(`/.well-known/seller-mcp-capabilities`) under `privacy_posture.regulatory_alignment_declared`:
`["GDPR", "AEPD-orientaciones-IA-agentica-2026"]`. A buyer agent or auditor can verify it
cryptographically without trusting this README.

The node does not make legal determinations — whether a given processing has a legitimate basis,
whether consent is valid, whether a particular treatment is permitted. Those judgements belong to
the controller (the broadcaster). The node provides the mechanisms; the controller applies the
criteria. This boundary is what keeps the node's design stable regardless of how the EU Data Act
negotiations resolve.

## Machine-readable trust anchor

The `/.well-known/seller-mcp-capabilities` endpoint returns an RS256-signed JWT. A buyer agent
reads and verifies this document before the first authenticated request. The `privacy_posture`
block inside it is machine-readable and cryptographically bound to the node's keypair:

| Property | Current value | Meaning |
|----------|--------------|---------|
| `end_user_personal_data` | `"none"` | No end-user personal data in any response path |
| `audience_segmentation` | `"not_offered_v1"` | No audience targeting surfaces |
| `tc_string_consumption` | `"none"` | Node does not consume TC strings (server-to-server, PATH A) |
| `device_storage_access` | `"none"` | No device storage access (ePrivacy N/A) |
| `jurisdiction` | `["ES", "EU"]` | Declared operating jurisdiction |
| `regulatory_alignment_declared` | `["GDPR", "AEPD-orientaciones-IA-agentica-2026"]` | Declared alignment |
| `dsr_contact` | from `deployment.json` | Contact for data-subject requests |
| `controller_model` | from `deployment.json` | Publisher's declared controller role |
| `audit_retention` | from `deployment.json` | Hot/archive retention windows in days/months |

**Not yet in the well-known document** (properties that remain implicit):

- Whether the catalog and forecast data are synthetic or live (`data_source`)
- Whether head-hash anchoring uses a local file or cloud Object Lock (`anchor_store`)
- Whether the node is in demo mode or serving a real publisher config (`deployment_mode`)

These properties would allow a buyer agent to programmatically distinguish a demo deployment from a
production one, and a locally-anchored node from one with external tamper-evidence. They are not
present in the current version.

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

**Distribution note.** The DSR CLI scripts (`scripts/dsr.ts`, `scripts/issue-buyer-token.ts`,
`scripts/revoke-token.ts`) are present in the source repository but are not included in the
npm package distribution. Publishers deploying via `npx` or Docker must clone the repository
to access the DSR CLI.

## Roadmap

See the [open issues](https://github.com/juan-sibbo/gam-seller-mcp-node/issues) for the full
roadmap. Highlights:

- **Real GAM adapter** — wire `getAvailabilityForecast` via the ForecastService SOAP API
- **Buyer agent SDKs** — Python and TypeScript client libraries for the MCP buyer flow
- **OpenRTB 3.0 taxonomy** — align `family_id` scheme with IAB standards
- **Prometheus metrics** — observability endpoint for production deployments

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues tagged
[`good first issue`](https://github.com/juan-sibbo/gam-seller-mcp-node/issues?q=label%3A%22good+first+issue%22)
are a good starting point.

## License

MIT — see [LICENSE](LICENSE).
