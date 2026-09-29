# Hosting recipe — the node on a server, behind TLS

Everything here is **configuration**. It turns "put the node on a server" into filling in two
values (a domain and your config path). No node code changes; no credentials beyond your own
config and TLS (which Caddy obtains automatically).

## What you get

```
Buyer agent ──HTTPS──▶ Caddy (:443, auto-cert) ──HTTP──▶ seller-mcp-node (:3900, internal only)
```

- **Caddy** terminates TLS with an automatically-issued, auto-renewing certificate for your
  `DOMAIN` (closes the "no TLS in transit" deployment-boundary item, issue #86).
- **The node** runs with the production guards on: real operator config required
  (`MCP_REQUIRE_OPERATOR_CONFIG=1`), idempotency key required (`MCP_REQUIRE_IDEMPOTENCY_KEY=1`),
  audit anchoring to a third-party WORM (`MCP_ANCHOR_SINK`), and the handoff loop closed
  (`MCP_INTENT_HANDOFF=file`). It is never published to the host — only Caddy is.

## Steps

```bash
cp deploy/.env.example deploy/.env
# 1. point a DNS A/AAAA record for DOMAIN at this server's public IP
# 2. edit deploy/.env — set DOMAIN and CONFIG_DIR (your real config dir)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
```

Verify:

```bash
curl https://$DOMAIN/health
curl https://$DOMAIN/.well-known/seller-mcp-capabilities
```

Mint a buyer token and hand it to a buyer agent. Operator commands write the node's state, so
they run with the node **stopped** (a live node owns the state and refuses them — exit 3):

```bash
C="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env"
$C stop seller-mcp-node
$C run --rm --no-deps seller-mcp-node gam-seller-admin issue-token <buyer_id>   # token on stdout
$C start seller-mcp-node
```

The same pattern serves `gam-seller-admin revoke-token <token>` and
`gam-seller-admin dsr <export|restrict|unrestrict|suppress> <buyer_id>`. Keep the stop short: the
node is unavailable to buyers while it is stopped.

## What is still on the human side

- **DNS + a host/VM** with ports 80/443 reachable (any cloud VM, or a CDN/edge that forwards to it).
- **Your real config** (`deployment/catalog/entitlements/pricing[/forecast].json`).
- **The GAM last mile** — a service account for live avails. Until then the node runs on
  seeded/synthetic forecasts and makes no ad-server writes. See
  [`../docs/PUBLISHER-DEPLOYMENT.md`](../docs/PUBLISHER-DEPLOYMENT.md#the-last-mile--live-gam).
