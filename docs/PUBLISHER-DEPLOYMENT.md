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
  "controller_model": "sole_controller",
  "data_retention_days": 90
}
```

The node will refuse to start if `dsr_contact` is empty or `data_retention_days` is out of range.
This is intentional: a node without a valid DSR contact cannot lawfully respond to GDPR requests.

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
```

**Important:** do not expose port 3900 directly to the internet. Put it behind a reverse proxy
(nginx, Caddy) that handles TLS termination.

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

## Rotating keys

RS256 keys are stored in `keys/node.private.jwk.json` (gitignored). To rotate:

1. Stop the node
2. Delete `keys/node.private.jwk.json`
3. Restart — a new key pair is generated automatically
4. Outstanding tokens signed with the old key will fail validation; re-issue tokens to buyers

## GDPR / data-subject requests

The node's DSR toolkit handles Art. 15/17/18/20 requests for buyer audit data:

```typescript
import { DsrToolkit } from "./src/dsr/toolkit.js";
// export, restrict, erase a buyer's pseudonymized audit records
```

See [`src/dsr/toolkit.ts`](../src/dsr/toolkit.ts) for the API.

## Troubleshooting

**Node refuses to start with "invalid deployment config"**
Check `config/deployment.json` — `dsr_contact` must be a non-empty string and
`data_retention_days` must be between 30 and 3650.

**All buyers get AUTH_FAILED**
Check `config/entitlements.json` — the buyer must have an entry for the surface they're calling
(`PRODUCT_DISCOVERY` for `discover_products`, `FORECAST` for `get_forecast`).

**discover_products returns an empty families array**
The buyer is entitled to the surface but has no families in `config/catalog.json`'s `buyer_access`
map. Add the buyer → family mappings.

**pricing_options missing from discover_products**
Either the family has no entry in `config/pricing.json`, or the `valid_until` date has passed.
Update the pricing config and restart the node.
