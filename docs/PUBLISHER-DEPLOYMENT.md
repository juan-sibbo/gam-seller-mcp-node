# Publisher Deployment Guide

This guide walks through deploying your own GAM Seller MCP Node — from zero to a running,
correctly configured node that buyer agents can connect to.

## Prerequisites

- Node.js 22+ (or Docker)
- A Google Ad Manager network (for future live integration — not required for current MVP)
- The four config files described below

## Step 1 — Clone and build

```bash
git clone https://github.com/juan-sibbo/gam-seller-mcp-node.git
cd gam-seller-mcp-node
npm install
npm run build
```

## Step 2 — Configure

Copy the worked example and edit the four JSON files for your publisher:

```bash
cp -r config/examples/pilot-publisher config/
```

### `config/deployment.json` — legal and operational metadata

```json
{
  "node_id_prefix": "your-network-name",
  "dsr_contact": "privacy@yourpublisher.com",
  "controller_model": "publisher-controller-node-processor",
  "controller_name": "Your Publisher Ltd.",
  "retention": { "hot_days": 90, "archive_months": 12 }
}
```

`node_id_prefix` (optional) sets the node's advertised identity: the signed well-known document
reports `node_id` as `<node_id_prefix>-seller-mcp-node`, so each publisher's node is
distinguishable. Omit it to use the shared default id. It must be a DNS-safe slug (lowercase
letters, digits and hyphens; no leading/trailing hyphen).

The node refuses to start unless the legal config is valid: `dsr_contact` must be a concrete
contact (no placeholders), `controller_model` must be `operator-controller` or
`publisher-controller-node-processor`, `controller_name` must be set, and `retention.hot_days` /
`retention.archive_months` must be positive integers. This is intentional — a node without a
valid DSR contact cannot lawfully respond to GDPR requests.

### `config/catalog.json` — product families and buyer access

```json
{
  "families": [
    { "family_id": "display-ros", "label": "Run of Site — Display", "consent_context": null, "legal_basis_provenance": null },
    { "family_id": "video-pre-roll", "label": "Pre-Roll Video", "consent_context": null, "legal_basis_provenance": null }
  ],
  "buyer_access": {
    "wemass-buyer-001": ["display-ros", "video-pre-roll"],
    "agency-buyer-002": ["display-ros"]
  }
}
```

`buyer_access` maps buyer IDs to the family IDs they can see. Buyers not listed get an empty
result (Default-Deny), not an error.

### `config/entitlements.json` — MCP surface grants

```json
{
  "entitlements": [
    { "buyer_id": "wemass-buyer-001", "surface": "PRODUCT_DISCOVERY", "scope": "read" },
    { "buyer_id": "wemass-buyer-001", "surface": "FORECAST",           "scope": "read" },
    { "buyer_id": "agency-buyer-002", "surface": "PRODUCT_DISCOVERY",  "scope": "read" }
  ]
}
```

A buyer must have a `PRODUCT_DISCOVERY` entitlement to call `discover_products`, and a `FORECAST`
entitlement to call `get_forecast`. Missing either returns `AUTH_FAILED`.

### `config/pricing.json` — firm list prices (optional)

```json
{
  "prices": [
    { "family_id": "display-ros",  "currency": "EUR", "list_price": 4.50, "valid_until": "2026-12-31T23:59:59Z" },
    { "family_id": "video-pre-roll","currency": "EUR", "list_price": 18.0, "valid_until": "2026-12-31T23:59:59Z" }
  ]
}
```

Prices are optional. If a family has no price entry, `pricing_options` is omitted from the
`discover_products` response for that family. Expired prices fail closed (omitted), never stale.

## Step 3 — Run

### stdio (for MCP-host clients like Claude Desktop)

```bash
npm start
```

Add to your MCP host config:
```json
{
  "mcpServers": {
    "gam-seller": {
      "command": "node",
      "args": ["/path/to/gam-seller-mcp-node/dist/server.js"]
    }
  }
}
```

### HTTP transport (for remote buyer agents)

```bash
npm run start:http   # binds to 127.0.0.1:3900 by default
```

Environment variables:
```
MCP_HTTP_HOST=0.0.0.0    # change only if you're behind a reverse proxy
MCP_HTTP_PORT=3900
MCP_DATA_DIR=/var/lib/gam-seller/data   # optional: audit ledger, denylist, anchors, pseudonym keys
MCP_KEYS_DIR=/var/lib/gam-seller/keys   # optional: persistent RS256 keypair
```

Persistence paths resolve relative to the installed module by default (not the launch
directory), so the node cannot fail open to a fresh empty state if started from elsewhere.
Point `MCP_DATA_DIR` / `MCP_KEYS_DIR` at a durable, backed-up volume in production.

**Important:** do not expose port 3900 directly to the internet. Put it behind a reverse proxy
(nginx, Caddy) that handles TLS termination. This is a single-instance profile: the rate
limiter, replay guard, and intent store are in-memory per process, so run exactly one instance
(scaling out needs shared state — not yet supported).

### Docker

```bash
docker compose up
```

Edit `docker-compose.yml` to bind-mount your config files:

```yaml
volumes:
  - ./my-config/deployment.json:/app/config/deployment.json:ro
  - ./my-config/catalog.json:/app/config/catalog.json:ro
  - ./my-config/entitlements.json:/app/config/entitlements.json:ro
  - ./my-config/pricing.json:/app/config/pricing.json:ro
  - gam-seller-keys:/app/keys
  - gam-seller-audit:/app/data
```

## Step 4 — Verify

```bash
# Check the well-known document (no auth needed)
curl http://127.0.0.1:3900/.well-known/seller-mcp-capabilities

# Run the external Python probe
python3 sandbox/buyer-agent-probe.py http://127.0.0.1:3900
```

Expected probe output:
```
1. GET well-known trust anchor …
  OK  status 200
  OK  Cache-Control present ('max-age=3600')
  OK  body is JWS compact (3 dot-separated parts)
...
=== PROBE PASSED: all assertions green ===
```

## Health & monitoring

**`GET /health`** — a non-sensitive readiness snapshot for load balancers, orchestrators, and
uptime checks. Public by design (an off-host probe must reach it); it carries only the node
version and an aggregate durability signal — never buyer data or counts.

```bash
curl http://127.0.0.1:3900/health
# {"status":"ok","version":"0.8.0","persistence_healthy":true}
```

It always returns `200` while the process can answer (liveness). Watch the body:
`status:"degraded"` / `persistence_healthy:false` means a disk write to the audit ledger has
failed — the node is still serving, but audit durability is at risk. **Alert on it** (and check
disk / the `MCP_DATA_DIR` volume); it is not a reason to drop traffic.

**`GET /metrics`** — Prometheus exposition, **loopback-only** (403 off-host) and only present
when metrics are enabled. Scrape it from a local agent; never expose it off-host.

## Rotating keys

RS256 keys are stored in `keys/node.private.jwk.json` (gitignored). To rotate:

1. Stop the node
2. Delete `keys/node.private.jwk.json`
3. Restart — a new key pair is generated automatically
4. Outstanding tokens signed with the old key will fail validation; re-issue tokens to buyers

## GDPR / data-subject requests

The node ships a **DSR operator CLI** (`gam-seller-dsr`) that handles Art. 15/17/18/20 requests
for buyer audit data. It operates on the same file-backed stores the server persists (paths
honor `MCP_DATA_DIR`), so an erasure is reflected by the node on its next restart — it is not a
separate copy of the data.

```bash
# Installed via npm (the bin is on PATH after `npm i -g gam-seller-mcp-node`),
# or run without a global install straight from the package:
npx --package gam-seller-mcp-node gam-seller-dsr export <buyer_id>     # Art. 15/20 — portable JSON to stdout
npx --package gam-seller-mcp-node gam-seller-dsr suppress <buyer_id>   # Art. 17 — crypto-shred + erase entitlement
npx --package gam-seller-mcp-node gam-seller-dsr restrict <buyer_id>   # Art. 18 — suspend entitlement (record kept)
npx --package gam-seller-mcp-node gam-seller-dsr unrestrict <buyer_id> # Art. 18 — lift a restriction
```

In a Docker deployment, invoke the same bin against the node's data volume so it acts on the
live state:

```bash
docker run --rm -v mcp-data:/app/data --entrypoint gam-seller-dsr <image> suppress <buyer_id>
```

To drive the toolkit programmatically from an installed package, import it from the built
distribution (not `src/`, which is not shipped):

```typescript
import { DsrToolkit } from "gam-seller-mcp-node/dist/dsr/toolkit.js";
// export, restrict, erase a buyer's pseudonymized audit records
```

See [`src/dsr/toolkit.ts`](../src/dsr/toolkit.ts) for the API and [`src/dsr/cli.ts`](../src/dsr/cli.ts)
for the CLI that wraps it.

## Troubleshooting

**Node refuses to start with "invalid deployment config"**
Check `config/deployment.json` — `dsr_contact` must be a concrete non-empty contact,
`controller_model` must be `operator-controller` or `publisher-controller-node-processor`,
`controller_name` must be set, and `retention.hot_days` / `retention.archive_months` must be
positive integers. An optional `node_id_prefix` must be a DNS-safe slug.

**All buyers get AUTH_FAILED**
Check `config/entitlements.json` — the buyer must have an entry for the surface they're calling
(`PRODUCT_DISCOVERY` for `discover_products`, `FORECAST` for `get_forecast`).

**discover_products returns an empty families array**
The buyer is entitled to the surface but has no families in `config/catalog.json`'s `buyer_access`
map. Add the buyer → family mappings.

**pricing_options missing from discover_products**
Either the family has no entry in `config/pricing.json`, or the `valid_until` date has passed.
Update the pricing config and restart the node.
