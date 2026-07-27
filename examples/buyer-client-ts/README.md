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
| `discoverProducts(buyerId)` | `discover_products` | Product families the buyer is entitled to (with firm list price when set) |
| `getForecast(buyerId, familyId, period)` | `get_forecast` | Coarse Low/Mid/High availability bucket (synthetic in demo mode) |

A denied call throws a typed `BuyerAccessError` carrying the node's error `code`
(e.g. `AUTH_FAILED`).

## Quickstart

```bash
# 1. Start the node (HTTP transport on 127.0.0.1:3900)
npm run build && node dist/server.js --http

# 2. In another shell, run the demo
npx tsx examples/buyer-client-ts/demo.ts                         # defaults: localhost, pilot-buyer-001
npx tsx examples/buyer-client-ts/demo.ts http://127.0.0.1:3900 pilot-buyer-001
npx tsx examples/buyer-client-ts/demo.ts http://127.0.0.1:3900 unknown-buyer   # → Default-Deny
```

## Usage

```ts
import { SellerMcpBuyerClient, BuyerAccessError } from "./client.js";

const buyer = new SellerMcpBuyerClient("http://127.0.0.1:3900", { name: "my-buyer-agent" });
await buyer.connect();

const caps = await buyer.capabilities();
// caps.privacy_posture.end_user_personal_data === "none"  (audience-blind by design)

try {
  const families = await buyer.discoverProducts("pilot-buyer-001");
  const forecast = await buyer.getForecast("pilot-buyer-001", families[0].family_id, "Q4-2026");
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

- The `token` (Domain-2 JWT) and `clientRequestId` (replay-detection idempotency key) arguments
  are optional on every call — dev deployments accept entitled buyers without a token.
- `capabilities()` decodes the JWS payload but does **not** verify its signature. A production
  buyer agent should verify it against the node's JWKS before trusting the posture; that belongs
  to the full SDK.
