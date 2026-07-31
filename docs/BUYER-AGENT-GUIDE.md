# Buyer Agent Integration Guide

This guide explains how to write a buyer agent that uses a GAM Seller MCP Node to discover
sell-side ad inventory and commit to it.

## The buyer session

A well-behaved buyer agent follows this sequence:

```
1. GET /.well-known/seller-mcp-capabilities   ← verify trust anchor before connecting
2. MCP initialize + notifications/initialized ← establish session
3. tools/call well_known_capabilities         ← confirm node identity and privacy posture
4. tools/call discover_products               ← list product families + firm prices
5. tools/call get_forecast (per family)       ← get coarse availability for planning
6. tools/call create_intent                   ← commit to a family at its firm price (optional)
7. tools/call revoke_intent                   ← withdraw a commitment you made (optional)
```

Steps 1–5 are read-only. Steps 6–7 are the only writes a buyer can make, and they only ever
affect that buyer's own commitments — never the ad server, never another buyer. Steps 1 and 3 are
both trust checks — step 1 uses HTTP before the MCP session exists, step 3 uses the MCP tool within
the session. A cautious agent does both.

## TypeScript example (MCP SDK)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-buyer-agent", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(
  new URL("http://seller-node.example.com/mcp")
);
await client.connect(transport);

// 1. Get the trust anchor (verify before trusting any other response)
const wk = await client.callTool({ name: "well_known_capabilities", arguments: {} });
const jwsPayload = JSON.parse(
  Buffer.from(wk.content[0].text.split(".")[1], "base64url").toString("utf-8")
);
console.log("node_id:", jwsPayload.node_id);
console.log("privacy_posture:", jwsPayload.privacy_posture);
// Verify: privacy_posture.end_user_personal_data must be "none"

// Your identity is derived from a buyer bearer token (aud=seller-mcp-node) issued to you
// by the node operator (scripts/issue-buyer-token.ts). There is NO buyer_id argument —
// the node reads your identity from the token's `sub`, so you cannot act as another buyer.
const token = process.env.SELLER_MCP_BUYER_TOKEN;  // provisioned out of band

// 2. Discover available product families
const disc = await client.callTool({
  name: "discover_products",
  arguments: { token },
});
const { families } = JSON.parse(disc.content[0].text);
// families: [{ family_id, label, pricing_options? }, ...]

// 3. Get forecast for each family
for (const family of families) {
  const fc = await client.callTool({
    name: "get_forecast",
    arguments: {
      token,
      family_id: family.family_id,
      period: "2026-Q4",
    },
  });
  const { bucket } = JSON.parse(fc.content[0].text);
  console.log(`${family.label}: ${bucket}`);  // "low" | "mid" | "high"
}

// 4. Commit to a family at its firm price (optional — this is the only write you can make).
//    price_ref MUST equal the family's current list_price, or the node rejects it (fail-closed).
const chosen = families.find((f) => f.pricing_options);
if (chosen) {
  const created = await client.callTool({
    name: "create_intent",
    arguments: {
      token,
      family_id: chosen.family_id,
      period: "2026-Q4",
      price_ref: chosen.pricing_options.list_price,
      client_request_id: crypto.randomUUID(),  // idempotency
    },
  });
  const { intent_id, expires_at } = JSON.parse(created.content[0].text);
  console.log(`intent ${intent_id} valid until ${expires_at}`);

  // 5. Change your mind? Withdraw your own intent (optional).
  await client.callTool({
    name: "revoke_intent",
    arguments: { token, intent_id, client_request_id: crypto.randomUUID() },
  });
}

await client.close();
```

## Python example (requests, no MCP SDK)

See [`sandbox/buyer-agent-probe.py`](../sandbox/buyer-agent-probe.py) for a complete
external probe that exercises the HTTP transport using only Python's `requests` library,
with no shared code with the server. It serves as both a reference implementation and a
CI interop check.

## Understanding the response shapes

### `well_known_capabilities`

Returns a **JWS compact serialization** (three dot-separated segments: header.payload.signature).
Decode the middle segment (base64url) to get the capability document:

```json
{
  "node_id": "gam-seller-mcp-...",
  "version": "0.2.0",
  "posture": "audience_blind",
  "capability_families": ["display-ros", "video-pre-roll", "branded-content"],
  "privacy_posture": {
    "end_user_personal_data": "none",
    "audience_segmentation": "not_offered_v1"
  },
  "issued_at": "2026-07-22T..."
}
```

### `discover_products`

```json
{
  "families": [
    {
      "family_id": "display-ros",
      "label": "Run of Site — Display",
      "consent_context": null,
      "legal_basis_provenance": null,
      "pricing_options": {
        "list_price": 4.5,
        "currency": "EUR",
        "valid_until": "2026-12-31T23:59:59Z"
      }
    }
  ],
  "request_id": "..."
}
```

`pricing_options` appears only when the publisher has configured a firm list price for the family
and the price has not expired. Absent `pricing_options` means "no published price" — not "free."

### `get_forecast`

```json
{
  "family_id": "display-ros",
  "period": "2026-Q4",
  "bucket": "mid",
  "synthetic": true,
  "request_id": "..."
}
```

`bucket` is one of `"low"`, `"mid"`, or `"high"`. `synthetic: true` means the data is not from
a live GAM connection — the real adapter is in progress.

### `create_intent`

```json
{
  "intent_id": "int_...",
  "status": "active",
  "firm_price": 4.5,
  "expires_at": "2026-07-31T12:15:00Z",
  "request_id": "..."
}
```

Records a firm, time-boxed buying intent over a family at its current firm price. `expires_at` is
capped at the price's own `valid_until` — an intent never outlives the offer it pins. This is **not**
a GAM order or an inventory hold; it is the handoff artifact the classic sales rails pick up.
Fail-closed: if `price_ref` does not match the family's current firm price (or the price has expired),
the call returns `INVALID_REQUEST` — with the same generic envelope, so neither the real price nor the
family's existence leaks.

### `revoke_intent`

```json
{
  "intent_id": "int_...",
  "status": "revoked",
  "request_id": "..."
}
```

Withdraws one of **your own** active intents. Revoking an unknown id, another buyer's intent, or an
already-terminal one returns the same generic `INVALID_REQUEST` — you cannot probe others' intents.

## Error responses

All errors return `isError: true` and a JSON body:

```json
{ "code": "AUTH_FAILED", "request_id": "..." }
```

Possible codes:

| Code | Meaning |
|------|---------|
| `AUTH_FAILED` | Missing/invalid/revoked token, or the token's buyer is not entitled |
| `RATE_LIMITED` | Exceeded N=1/T=30s per buyer (identity from token.sub) |
| `INVALID_REQUEST` | Replay detected (duplicate client_request_id); or a stale/mismatched `price_ref` on `create_intent`; or a `revoke_intent` that matches none of your own active intents |

Error responses are deliberately opaque: `AUTH_FAILED` covers all denial reasons to prevent
probing for entitlement structure.

## Replay protection

To use the replay-detection feature, include a `client_request_id` in your tool call arguments:

```typescript
await client.callTool({
  name: "discover_products",
  arguments: {
    token,
    client_request_id: crypto.randomUUID(),  // unique per call
  },
});
```

A repeated `client_request_id` returns `INVALID_REQUEST`. Omitting it disables deduplication
(backwards-compatible behaviour).
