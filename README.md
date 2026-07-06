# GAM Seller MCP Node

[![CI](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml/badge.svg)](https://github.com/juan-sibbo/gam-seller-mcp-node/actions/workflows/ci.yml)

A governed, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes ad-inventory discovery from the sell side (Google Ad Manager and similar systems) to
buyer-side agents — without ever touching the ad server itself, and without a buyer agent ever
being able to create, modify, or transact anything.

Buyer agents get three tools:

- `well_known_capabilities` — a signed, publicly cacheable document describing what this node
  can do and its privacy posture. This is the trust anchor a buyer checks before anything else.
- `discover_products` — coarse product families (e.g. "Pre-Roll Video") a given buyer is
  entitled to see. No raw inventory, no pricing, no IDs internal to the ad server.
- `get_forecast` — a bucketized (Low / Mid / High) availability forecast for a family and
  period. No exact numbers, ever.

## Why it's built this way

Ad servers hold commercially sensitive and sometimes personal data. A seller who wants to expose
inventory discovery to AI buyer-agents without opening a door into their ad server needs three
guarantees, enforced in code rather than by policy document:

1. **Default-Deny.** Every request is denied unless an explicit entitlement says otherwise.
   There is no "allow by default" path.
2. **Nothing sensitive crosses the boundary.** A fixed allowlist of response surfaces exists;
   everything else (exact pricing, deal IDs, raw availability, order/media-buy operations) is on
   a permanent denylist that cannot be reached from any tool, now or by future extension.
3. **Every decision is auditable and tamper-evident.** Every allow/deny is written to an
   append-only, hash-chained ledger with external anchoring, so a compromised or malicious
   operator can't quietly rewrite history.

See [`docs/DESIGN-PRINCIPLES.md`](docs/DESIGN-PRINCIPLES.md) for the reasoning behind each of
these, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the modules fit together.

## Status

Early, working MVP. The core request pipeline (auth → policy → rate-limit → domain logic →
audit), the audit ledger, and a GDPR data-subject-rights toolkit are implemented and tested.
There is currently **no live connection to Google Ad Manager** — the catalog and forecast data
are synthetic, loaded from local config. Wiring a real GAM-backed adapter behind the same
policy boundary is the next major milestone, not yet built.

## Running it

```bash
npm install
npm run build
npm start            # stdio transport (default, for MCP-host clients)
npm run start:http   # HTTP transport on 127.0.0.1:3900
```

```bash
npm test             # full suite (vitest)
npx tsx demo/run-demo.ts   # scripted walkthrough of all three tools + the audit trail
```

### Configuring for a deployment

Catalog and legal/DSR settings are driven by JSON files under `config/`, no code changes needed:

```
config/deployment.json     # DSR contact, controller model, retention window
config/catalog.json        # product families + which buyers can see which families
config/entitlements.json   # which buyers are entitled to which surfaces/scopes
```

All three fail closed: an invalid or missing file stops the node from starting rather than
running with a silently different access set than intended.

## Data protection

This node treats buyer identity as pseudonymous by design: raw `buyer_id` values never enter the
audit ledger, only an HMAC pseudonym. A `dsr/toolkit.ts` implements export, restriction, and
erasure of a buyer's data (GDPR Art. 15/17/18/20) against exactly what this node stores — nothing
more, since it stores nothing about end users, only B2B buyer organizations.

## License

MIT — see [LICENSE](LICENSE).
