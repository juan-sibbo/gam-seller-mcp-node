# Pilot quickstart — a real buyer/seller test in one command

This is the fastest path from a clone to a **live pilot**: a running node on your inventory
config, a buyer token, and a buyer agent driving the full loop (discover → forecast → commit →
revoke) over the real MCP protocol — with governed refusals and a tamper-evident audit trail.

Everything here is **configuration**. It needs no credentials and no live GAM. The only human
inputs are your own config values and, for the very last mile, a GAM service account (below).

## Option A — one command

```bash
# Bundled demo config (a dry run, clearly labelled demo):
scripts/pilot.sh

# Your real inventory (recommended):
MCP_CONFIG_DIR=/path/to/your/config scripts/pilot.sh
```

`scripts/pilot.sh` builds the node, applies the production guards (`MCP_REQUIRE_OPERATOR_CONFIG`,
`MCP_REQUIRE_IDEMPOTENCY_KEY`, an audit anchor, and the handoff file drop), **mints a buyer token
for every entitled buyer**, prints them, and runs the node in the foreground. It then tells you
the exact command to drive a buyer agent. Ctrl-C stops it.

In a second terminal, run the buyer agent it printed:

```bash
npx tsx examples/buyer-client-ts/agent.ts "<token>" http://127.0.0.1:3900
```

You should see the five tools exercised end to end, and a JSON line appended to
`.pilot/data/intent-handoff.jsonl` for each commit — the artifact your sales rails pick up.

## Option B — manual steps

```bash
npm install && npm run build

# 1. Point at your real config (or omit for the bundled demo)
export MCP_CONFIG_DIR=/path/to/your/config
export MCP_REQUIRE_OPERATOR_CONFIG=1     # refuse to boot on demo config
export MCP_REQUIRE_IDEMPOTENCY_KEY=1     # every call must carry an idempotency key
export MCP_ANCHOR_SINK=tsa               # anchor the audit trail to a third party (or "file")
export MCP_INTENT_HANDOFF=file           # close the handoff loop

# 2. Mint a token for an entitled buyer (identity = the token's sub)
TOKEN=$(npx tsx scripts/issue-buyer-token.ts your-buyer-001)

# 3. Start the node (HTTP), then drive the agent from another shell
node dist/server.js --http &
npx tsx examples/buyer-client-ts/agent.ts "$TOKEN" http://127.0.0.1:3900
```

## Driving it with an LLM buyer agent (MCP host)

The reference agent above is deterministic (great as a smoke test). An **LLM** buyer agent makes
the same five tool calls. Register the node as an MCP server in any MCP host (Claude Desktop,
Claude Code, …):

```json
{
  "mcpServers": {
    "gam-seller": { "command": "node", "args": ["/abs/path/to/gam-seller-mcp-node/dist/server.js"] }
  }
}
```

Give the agent a buyer token (from `scripts/issue-buyer-token.ts`) and instruct it to pass that
token as the `token` argument on each call — identity is derived from the token's `sub`, never a
free-text argument, so the agent can only ever act as itself. Unentitled or tokenless calls are
refused by Default-Deny.

## Make it more real (all configuration)

- **Seed the forecast** with your real availability (a one-time GAM report export) via
  `config/forecast.json` — buckets become realistic while staying labelled `synthetic`
  (pre-loaded ≠ live). Template:
  [`../config/examples/pilot-publisher/forecast.sample.json`](../config/examples/pilot-publisher/forecast.sample.json).
- **Host it on a server** behind TLS with the [`deploy/`](../deploy/README.md) recipe (Caddy +
  Docker). Buyer agents then connect to `https://your-domain/mcp`.
- Full reference for every config file and env var: [`PUBLISHER-DEPLOYMENT.md`](PUBLISHER-DEPLOYMENT.md).

## What is still on the human side

The prototype is off the test track — the only remaining inputs are yours:

1. **Real config values** — your product families, firm prices, buyer IDs and entitlements
   (`catalog.json` / `pricing.json` / `entitlements.json`), and your DSR contact (`deployment.json`).
2. **A host** — a VM/server (or CDN/edge in front of one) with a domain and ports 80/443, per
   [`deploy/`](../deploy/README.md).
3. **The GAM last mile** — a **service account with the ForecastService scope** to replace the
   seeded/synthetic forecast with live avails (issue #4, DP-AB-01 §5.2). The `GamForecastSource`
   seam already exists; provisioning the credential flips it from seeded-synthetic to live with no
   other code change. Until then the node is honest by construction (`synthetic: true`, and no
   ad-server write path exists). See
   [PUBLISHER-DEPLOYMENT.md → The last mile](PUBLISHER-DEPLOYMENT.md#the-last-mile--live-gam).
