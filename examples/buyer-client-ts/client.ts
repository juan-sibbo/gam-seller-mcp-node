// Minimal TypeScript buyer client for the GAM Seller MCP Node — a worked example of the
// buyer-side flow (issue #5, seed). It wraps the official MCP SDK client + StreamableHTTP
// transport, so it speaks the real protocol rather than hand-rolled HTTP.
//
// Scope: this is an EXAMPLE, not a published package. It shows an AI buyer agent (or its
// author) how to (1) read the RS256-signed capability document, (2) discover product families,
// (3) pull a coarse availability forecast, and (4) place + withdraw a firm buying intent (the
// commit loop) — all subject to the node's Default-Deny gate. A firm intent is the sole write
// surface: a soft, TTL'd commitment, never a GAM order or inventory hold.
//
// Out of scope here (by design, tracked for the full SDK #5): buyer token minting (obtain
// one from the node operator via scripts/issue-buyer-token.ts), JWS signature verification
// against the node's JWKS, retries/backoff, and a Python twin.
//
// v0.4 Bloque A: the buyer's identity is derived from its bearer token's `sub` — there is
// no buyer_id argument. Pass the token at construction (default for every call) or per call.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_PATH = "/mcp";

export interface PrivacyPosture {
  end_user_personal_data: "none" | "pseudonymous" | "identified";
  audience_segmentation: string;
  jurisdiction: string[];
  regulatory_alignment_declared: string[];
  [key: string]: unknown;
}

export interface Capabilities {
  node_id: string;
  version: string;
  posture: string;
  capability_families: string[];
  privacy_posture: PrivacyPosture;
  [key: string]: unknown;
}

export interface PricingOptions {
  list_price: number;
  currency: string;
  valid_until: string;
}

export interface ProductFamily {
  family_id: string;
  pricing_options?: PricingOptions;
  [key: string]: unknown;
}

export interface ForecastResult {
  family_id: string;
  period: string;
  bucket: string;
  synthetic: boolean;
}

export interface IntentResult {
  intent_id: string;
  status: string;
  firm_price: number;
  expires_at: string;
  request_id: string;
}

export interface RevokeResult {
  intent_id: string;
  status: string;
  request_id: string;
}

export interface CallOptions {
  /** Buyer bearer JWT (RS256, aud=seller-mcp-node). Overrides the client's default token.
   *  Required by the node — identity is derived from token.sub. */
  token?: string;
  /** Idempotency key for the node's replay detection (SEC-GATE-3). */
  clientRequestId?: string;
}

// Thrown when the node denies a call (Default-Deny). `code` mirrors the node's safe error
// envelope (e.g. "AUTH_FAILED", "RATE_LIMITED").
export class BuyerAccessError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "BuyerAccessError";
  }
}

export interface BuyerClientInfo {
  name?: string;
  version?: string;
  /** Default buyer bearer JWT (aud=seller-mcp-node) sent on every call unless a call
   *  supplies its own. The node derives the buyer identity from this token's sub. */
  token?: string;
}

export class SellerMcpBuyerClient {
  private readonly client: Client;
  private readonly endpoint: URL;
  private readonly defaultToken?: string;
  private connected = false;

  constructor(baseUrl: string, info: BuyerClientInfo = {}) {
    this.endpoint = new URL(MCP_PATH, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    this.defaultToken = info.token;
    this.client = new Client({
      name: info.name ?? "seller-mcp-buyer-client",
      version: info.version ?? "0.1.0",
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(new StreamableHTTPClientTransport(this.endpoint));
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  // Public trust anchor: the RS256-signed capability document, readable before any request.
  // Returns the decoded payload — a buyer agent can reason over posture/capabilities up front.
  // (Signature verification against the node's JWKS is left to the full SDK; see file header.)
  async capabilities(): Promise<Capabilities> {
    const text = await this.callToolText("well_known_capabilities", {});
    return decodeJwsPayload<Capabilities>(text);
  }

  async discoverProducts(opts: CallOptions = {}): Promise<ProductFamily[]> {
    const text = await this.callToolText("discover_products", argsFrom(opts, this.defaultToken));
    return (JSON.parse(text) as { families: ProductFamily[] }).families;
  }

  async getForecast(
    familyId: string,
    period: string,
    opts: CallOptions = {}
  ): Promise<ForecastResult> {
    const text = await this.callToolText("get_forecast", {
      family_id: familyId,
      period,
      ...argsFrom(opts, this.defaultToken),
    });
    return JSON.parse(text) as ForecastResult;
  }

  // Register a firm buying intent at the family's CURRENT firm price (the sole write surface —
  // a soft, TTL'd commitment, NOT a GAM order or inventory hold). `priceRef` must match the firm
  // price the node advertises; a mismatch/stale price is rejected as INVALID_REQUEST. Pass a fresh
  // `clientRequestId` per call: the node's replay guard is idempotent on it, and a deployment with
  // MCP_REQUIRE_IDEMPOTENCY_KEY=1 requires it.
  async createIntent(
    familyId: string,
    period: string,
    priceRef: number,
    opts: CallOptions = {}
  ): Promise<IntentResult> {
    const text = await this.callToolText("create_intent", {
      family_id: familyId,
      period,
      price_ref: priceRef,
      ...argsFrom(opts, this.defaultToken),
    });
    return JSON.parse(text) as IntentResult;
  }

  // Withdraw one of your OWN active intents by id. Buyer-scoped: revoking anything that is not your
  // own active intent returns the same generic INVALID_REQUEST (you cannot probe others' intents).
  async revokeIntent(intentId: string, opts: CallOptions = {}): Promise<RevokeResult> {
    const text = await this.callToolText("revoke_intent", {
      intent_id: intentId,
      ...argsFrom(opts, this.defaultToken),
    });
    return JSON.parse(text) as RevokeResult;
  }

  // Calls a tool and returns its first text content, converting a Default-Deny error result
  // into a typed BuyerAccessError.
  private async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.connected) await this.connect();
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) {
      const code = safeErrorCode(text);
      throw new BuyerAccessError(code, `Node denied "${name}" (${code})`);
    }
    return text;
  }
}

function argsFrom(opts: CallOptions, defaultToken?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const token = opts.token ?? defaultToken;
  if (token) out["token"] = token;
  if (opts.clientRequestId) out["client_request_id"] = opts.clientRequestId;
  return out;
}

function safeErrorCode(text: string): string {
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === "string" ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

// The well-known tool returns a JWS compact string (header.payload.signature). Decode the
// base64url payload segment. This does NOT verify the signature — see capabilities().
export function decodeJwsPayload<T>(jws: string): T {
  const parts = jws.trim().split(".");
  if (parts.length !== 3) {
    throw new Error(`expected a JWS compact string (3 segments), got ${parts.length}`);
  }
  const json = Buffer.from(parts[1]!, "base64url").toString("utf-8");
  return JSON.parse(json) as T;
}
