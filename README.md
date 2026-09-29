# Governed MCP seller control-plane prototype for future GAM integration.

[![npm version](https://img.shields.io/npm/v/gam-seller-mcp-node.svg?logo=npm)](https://www.npmjs.com/package/gam-seller-mcp-node)
[![npm downloads](https://img.shields.io/npm/dm/gam-seller-mcp-node.svg)](https://www.npmjs.com/package/gam-seller-mcp-node)
[![CI](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml/badge.svg)](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-green.svg)](https://modelcontextprotocol.io)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes sell-side ad inventory to buyer-side AI agents: discovery, firm pricing, and a buyer-scoped soft commitment primitive. No writes to an ad server exist. Forecasts can come live from Google Ad Manager (opt-in, read-only `ForecastService` snapshot); the catalog is operator config, and without a GAM connection forecast data is synthetic.

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
  [Domain]      Catalog / ForecastEngine — synthetic, seeded or live GAM forecast snapshot
       │
       ▼
  [Disclosure]  Response checked against the tool's strict schema — undeclared field → withheld
       │
       ▼
  [Audit]       Append-only hash-chained ledger, buyer pseudonymized (HMAC)
       │
       ▼
  Response to buyer
```

Each request-path gate rejects on failure. One honest caveat to the diagram above:

- **`client_request_id`** (the replay-guard deduplication key) is **required by default** on every
  authenticated surface since v0.9.0 — a request without it is rejected, so SEC-GATE-3 cannot be
  bypassed by omission. An operator can explicitly opt out for legacy clients with
  `MCP_REQUIRE_IDEMPOTENCY_KEY=0`, which reopens that bypass.

The rate-limit stage covers **every** authenticated tool — the read surfaces, `create_intent`,
and `revoke_intent` — so no authenticated surface bypasses it.

A corrupted or tampered on-disk ledger is **detected on startup** and the node refuses to serve
(fail-closed on load, plus a chain-integrity verify before the first request) rather than
resetting to an empty chain.

`create_intent` runs the same gates and adds one more before it records anything: the buyer's
`price_ref` must match the family's current firm price, or the request is rejected.

## Quick start

> **Run a full pilot in one command.** `scripts/pilot.sh` brings the node up on your config with
> production guards on, mints a buyer token per entitled buyer, and prints how to drive a buyer
> agent through the whole loop (discover → forecast → commit → revoke) — see
> [`docs/PILOT-QUICKSTART.md`](docs/PILOT-QUICKSTART.md). The reference buyer agent lives at
> [`examples/buyer-client-ts/agent.ts`](examples/buyer-client-ts/agent.ts); hosting behind TLS is a
> filled-in-the-blanks recipe in [`deploy/`](deploy/README.md).

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
forecast.json       # OPTIONAL — seed availability buckets from real numbers (still synthetic-labeled)
gam.json            # OPTIONAL — live GAM forecast (network, service-account key path, family → targeting)
```

**Invalid** config always fails closed: a malformed file stops the node rather than running
with a silently different access policy. **Absent** config (no `config/` and no `MCP_CONFIG_DIR`)
drops to the bundled [`config/examples/pilot-publisher/`](config/examples/pilot-publisher/)
example — demo mode, announced on stderr — so the node is never a broken install, only ever a
real deployment or a clearly-labelled demo.

**Taking a pilot onto real inventory** (short of a live GAM connection) is all configuration —
see [`docs/PUBLISHER-DEPLOYMENT.md`](docs/PUBLISHER-DEPLOYMENT.md):

- **Seed the forecast** with the publisher's own availability, exported once from a GAM report,
  via an optional `forecast.json` (template: [`config/examples/pilot-publisher/forecast.sample.json`](config/examples/pilot-publisher/forecast.sample.json)).
  Buckets become realistic while every result stays `synthetic: true` — pre-loaded is not a live
  read, so no live-GAM claim is made.
- **Connect GAM live** with an optional `gam.json` (template:
  [`config/examples/pilot-publisher/gam.sample.json`](config/examples/pilot-publisher/gam.sample.json))
  and a service account added to the GAM network with a read role that can run forecasts. The
  node asks `ForecastService.getAvailabilityForecast` for every configured family × period at boot
  and every 30 minutes, using **prospective line items that are never saved** — nothing in GAM is
  created, modified or reserved. Buyers are answered from that snapshot as Low/Mid/High buckets
  with `synthetic: false`; raw availability never leaves the node. Precedence:
  `gam.json` > `forecast.json` > synthetic.
- **Close the handoff loop** so a committed intent reaches the publisher's sales rails, via
  `MCP_INTENT_HANDOFF=file` (a local JSONL drop an operator forwarder tails). The handoff makes
  **no outbound call** — forwarding is the operator's process, and a URL value is refused. A
  handoff record is a notification, never a GAM order or inventory hold.
- **Harden for the road**: `MCP_REQUIRE_OPERATOR_CONFIG=1` (refuse to boot on demo config),
  `MCP_ANCHOR_SINK=tsa` (anchor the
  audit trail to a third party).

**Network egress — declared and bounded, not deny-all.** Buyer request handling makes no outbound
network calls. The live GAM forecast (`gam.json`) calls Google's OAuth token endpoint and the Ad
Manager SOAP API for the configured network, at boot and on the 30-minute refresh cycle — never
inside a buyer request, so buyers cannot generate load on the publisher's GAM. Optional audit anchoring can generate operator-configured egress outside the buyer
request path (at boot and on the periodic anchor cycle): the TSA backend (`MCP_ANCHOR_SINK=tsa`)
submits the ledger head hash to the configured RFC 3161 authority; the S3 backend
(`MCP_ANCHOR_SINK=s3`) writes the anchor record to the configured Object Lock bucket; a custom
sink module (`MCP_ANCHOR_SINK=<module>`) runs operator-supplied code. The default local anchor
backend performs no external network call. Destinations come only from operator configuration —
no buyer input can choose one. This surface is pinned by
[`tests/egress-surface.test.ts`](tests/egress-surface.test.ts): a new outbound capability fails CI
until it is declared on purpose.

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
The persistence layer is hardened for restarts (append-only, atomic writes, durable rotation
state, fail-closed load), and the head-hash anchor is append-only with selectable external WORM
backends (RFC 3161 timestamping / S3 Object Lock) — see [Known limitations](#current-status)
for the residual (a live write-once destination is an operator infra act).

**GAM connection — forecast only**: the live adapter
([`src/forecast/gam-source.ts`](src/forecast/gam-source.ts)) reads availability from GAM's
ForecastService when `gam.json` is present. Catalog families and their GAM targeting (ad units,
sizes, environment) are still mapped by hand in config, and prices remain static list prices.
Without `gam.json` the forecast is synthetic (or seeded) and says so (`synthetic: true`). See the
[open issues](https://github.com/juan-sibbo/gam-seller-mcp-node/issues) for the roadmap.

**Known limitations** — dated status. Closed rows are kept on purpose: a limitations list that
changes state over time is both a proof of honesty and a proof of progress.

| Limitation | Anchor | Status | Closed by |
|---|---|---|---|
| Attribution (`buyer_id` / `request_id`) is stored per entry but sits **outside** the chain's tamper-evidence hash | `audit/event.ts` | Design decision, not a defect — traceability vs. erasability ([ADR-4](docs/adr/ADR-4.md)) | — |
| Head-hash anchor rewrote its whole file each write (`writeFileSync`) — not append-only, no external WORM | `audit/anchor.ts` | ✅ **Closed** 2026-08-23 — append-only JSONL + injectable `AnchorSink`; selectable `tsa` (RFC 3161) and `s3` (S3 Object Lock) backends via `MCP_ANCHOR_SINK` | [#92](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/92) [#94](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/94) [#95](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/95) |
| External WORM anchoring needs the operator to point at a live write-once destination (a TSA URL, or a locked bucket) — the node ships the backends, not the destination | `audit/anchor-tsa.ts`, `audit/anchor-s3.ts` | **Open** — deployment boundary (infra act) | — |
| `client_request_id` (replay guard) was optional; omitting it bypassed SEC-GATE-3 | `src/server.ts` | **Closed** in v0.9.0 — required by default on every authenticated surface (fail-closed); `MCP_REQUIRE_IDEMPOTENCY_KEY=0` is an explicit operator opt-out | [#82](https://github.com/juan-sibbo/gam-seller-mcp-node/issues/82) |
| No TLS in transit (a reverse proxy is expected to terminate) | — | **Open** — deployment boundary | — |
| `revoke_intent` is not covered by the rate-limit stage | `src/server.ts` | ✅ **Closed** 2026-08-18 — now behind the rate-limit gate like every authenticated surface | [#80](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/80) |
| GDPR DSR CLI (`scripts/dsr.ts`, …) not shipped in the npm package | `package.json` `files` | ✅ **Closed** 2026-08 — ships as the `gam-seller-dsr` bin | [#78](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/78) |
| Ledger loaded fail-open — a corrupt file reset to an empty chain | `audit/ledger.ts` | ✅ **Closed** 2026-08-07 | [#65](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/65) |
| Chain integrity not verified before serving on startup | `src/server.ts` | ✅ **Closed** 2026-08-07 | [#65](https://github.com/juan-sibbo/gam-seller-mcp-node/pull/65) |

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module map and data-flow diagrams.

Key modules:

| Module | Role |
|--------|------|
| `src/server.ts` | MCP tool definitions + request pipeline |
| `src/policy/` | Default-Deny engine, entitlement store, surface allowlist/denylist, per-tool disclosure schemas |
| `src/identity/` | RS256 key management, token issuance/validation, revocation denylist |
| `src/audit/` | Hash-chained ledger, HMAC pseudonymization, append-only head-hash anchoring with selectable WORM backends (`anchor-tsa.ts`, `anchor-s3.ts`) |
| `src/pricing/` | Firm list price store, expiry-aware (fail-closed on stale prices) |
| `src/forecast/` | Bucket engine + sources: synthetic, seeded, live GAM snapshot |
| `src/gam/` | Service-account OAuth + minimal Ad Manager SOAP client (read-only) |
| `src/dsr/` | GDPR Art. 15/17/18/20 data-subject-rights toolkit (also shipped as the `gam-seller-dsr` bin) |
| `src/catalog/` | Product family store, per-buyer access grants |

## Security model

**Default-Deny.** Every request is denied unless an explicit entitlement says otherwise — there
is no "allow by default" path in the code.

**Two gates: who may call a tool, and what it may return.** The policy layer works on surface
*labels*: each authenticated tool declares one allowed surface when it is registered, and exact
pricing, deal IDs, raw availability numbers, cross-buyer state, real inventory holds (soft-lock)
and any ad-server write are permanently on the denylist. That label check does not look at the
response, so it cannot on its own stop a tool under an allowed label from returning something it
shouldn't. The **disclosure gate** does: every authenticated tool must declare a strict response
schema (`src/policy/disclosure.ts`), and a response carrying any undeclared field is withheld and
replaced by a generic `INTERNAL_ERROR` (counted on `mcp_disclosure_rejected_total`). A new tool
cannot be registered without that schema, so adding a buyer-visible field means changing it in one
reviewable file. The one permitted write is a buyer's own commitment (`create_intent` /
`revoke_intent`), which required an explicit amendment to the surface allowlist and stays
buyer-scoped.

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
| Control what leaves toward third parties, and with what traceability | Buyer-facing disclosure allowlist (SEC-GATE-*): exact pricing, deal IDs and raw availability are permanently blocked from responses. Network egress allowlist: the only outbound connections are the operator-opted audit anchors and the operator-opted GAM forecast refresh (see *Network egress* above), pinned by CI |
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

**Distribution note.** The DSR toolkit ships in the npm package as the `gam-seller-dsr` bin, so
export / restriction / erasure can be run without a checkout. The token-management scripts
(`scripts/issue-buyer-token.ts`, `scripts/revoke-token.ts`) remain source-only — publishers who
need them must clone the repository.

## Roadmap

See the [open issues](https://github.com/juan-sibbo/gam-seller-mcp-node/issues) for the full
roadmap. Highlights:

- **GAM inventory mapping** — derive family targeting from GAM ad units/placements instead of hand-written `gam.json`
- **Buyer agent SDKs** — Python and TypeScript client libraries for the MCP buyer flow
- **OpenRTB 3.0 taxonomy** — align `family_id` scheme with IAB standards
- **Well-known observability properties** — expose `data_source` / `anchor_store` / `deployment_mode` so a buyer agent can distinguish demo from production programmatically

(The Prometheus `/metrics` endpoint is already shipped — loopback-only, opt-in.)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues tagged
[`good first issue`](https://github.com/juan-sibbo/gam-seller-mcp-node/issues?q=label%3A%22good+first+issue%22)
are a good starting point.

## License

MIT — see [LICENSE](LICENSE).
