# TypeScript buyer client (example)

A minimal, typed client for the buyer side of the GAM Seller MCP Node. It wraps the official
[MCP SDK](https://modelcontextprotocol.io) `Client` + StreamableHTTP transport, so it speaks the
real protocol — the same handshake an AI buyer agent would use.

> **Scope.** This is a worked example, not a published package. It's the seed of the full buyer
> SDK ([#5](https://github.com/juan-sibbo/gam-seller-mcp-node/issues/5)); a Python twin, JWS
> signature verification, and retries/backoff are tracked there.

## What it does

Three read-only calls, all subject to the node's Default-Deny gate:

| Method | MCP tool | Returns |
|---|---|---|
| `capabilities()` | `well_known_capabilities` | Decoded RS256-signed capability document (node id, posture, privacy posture) |
| `discoverProducts()` | `discover_products` | Product families the buyer is entitled to (with firm list price when set) |
| `getForecast(familyId, period)` | `get_forecast` | Coarse Low/Mid/High availability bucket (synthetic in demo mode) |

The buyer's identity is derived from its bearer token's `sub` (v0.4 Bloque A) — there is no
`buyer_id` argument. A denied call throws a typed `BuyerAccessError` carrying the node's error
`code` (e.g. `AUTH_FAILED`).

## Quickstart

```bash
# 1. Start the node (HTTP transport on 127.0.0.1:3900)
npm run build && node dist/server.js --http

# 2. Mint a buyer token (identity = the token's sub)
TOKEN=$(npx tsx scripts/issue-buyer-token.ts pilot-buyer-001 2>/dev/null)

# 3. In another shell, run the demo
npx tsx examples/buyer-client-ts/demo.ts "$TOKEN"                         # defaults to localhost:3900
npx tsx examples/buyer-client-ts/demo.ts "$TOKEN" http://127.0.0.1:3900
# A token minted for an unknown buyer → Default-Deny (AUTH_FAILED)
```

## Usage

```ts
import { SellerMcpBuyerClient, BuyerAccessError } from "./client.js";

// The token (aud=seller-mcp-node) carries the buyer identity; mint it with
// scripts/issue-buyer-token.ts. Set it once on the client, or per call via { token }.
const buyer = new SellerMcpBuyerClient("http://127.0.0.1:3900", { name: "my-buyer-agent", token });
await buyer.connect();

const caps = await buyer.capabilities();
// caps.privacy_posture.end_user_personal_data === "none"  (audience-blind by design)

try {
  const families = await buyer.discoverProducts();
  const forecast = await buyer.getForecast(families[0].family_id, "Q4-2026");
  console.log(forecast.bucket); // "low" | "mid" | "high"
} catch (err) {
  if (err instanceof BuyerAccessError) {
    console.error(`denied: ${err.code}`);
  }
} finally {
  await buyer.close();
}
```

## Notes

- The buyer `token` (bearer JWT, `aud=seller-mcp-node`) is **required** — identity is derived
  from its `sub`. Set it on the client or pass `{ token }` per call. `clientRequestId`
  (replay-detection idempotency key) remains optional.
- `capabilities()` decodes the JWS payload but does **not** verify its signature. A production
  buyer agent should verify it against the node's JWKS before trusting the posture; that belongs
  to the full SDK.
