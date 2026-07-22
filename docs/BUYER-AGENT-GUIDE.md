# Buyer Agent Integration Guide

This guide explains how to write a buyer agent that uses a GAM Seller MCP Node to discover
sell-side ad inventory.

## The three-step session

A well-behaved buyer agent follows this sequence:

```
1. GET /.well-known/seller-mcp-capabilities   ← verify trust anchor before connecting
2. MCP initialize + notifications/initialized ← establish session
3. tools/call well_known_capabilities         ← confirm node identity and privacy posture
4. tools/call discover_products               ← list available product families
5. tools/call get_forecast (per family)       ← get coarse availability for planning
```

Steps 1 and 3 are both trust checks — step 1 uses HTTP before the MCP session exists,
step 3 uses the MCP tool within the session. A cautious agent does both.

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

// 2. Discover available product families
const disc = await client.callTool({
  name: "discover_products",
  arguments: { buyer_id: "my-org-buyer-id" },
});
const { families } = JSON.parse(disc.content[0].text);
// families: [{ family_id, label, pricing_options? }, ...]

// 3. Get forecast for each family
for (const family of families) {
  const fc = await client.callTool({
    name: "get_forecast",
    arguments: {
      buyer_id: "my-org-buyer-id",
      family_id: family.family_id,
      period: "2026-Q4",
    },
  });
  const { bucket } = JSON.parse(fc.content[0].text);
  console.log(`${family.label}: ${bucket}`);  // "low" | "mid" | "high"
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
  "version": "0.1.0",
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

## Error responses

All errors return `isError: true` and a JSON body:

```json
{ "code": "AUTH_FAILED", "request_id": "..." }
```

Possible codes:

| Code | Meaning |
|------|---------|
| `AUTH_FAILED` | Not entitled, token invalid, or buyer unknown |
| `RATE_LIMITED` | Exceeded N=1/T=30s per buyer_id |
| `INVALID_REQUEST` | Replay detected (duplicate client_request_id) |

Error responses are deliberately opaque: `AUTH_FAILED` covers all denial reasons to prevent
probing for entitlement structure.

## Replay protection

To use the replay-detection feature, include a `client_request_id` in your tool call arguments:

```typescript
await client.callTool({
  name: "discover_products",
  arguments: {
    buyer_id: "my-org-buyer-id",
    client_request_id: crypto.randomUUID(),  // unique per call
  },
});
```

A repeated `client_request_id` returns `INVALID_REQUEST`. Omitting it disables deduplication
(backwards-compatible behaviour).
