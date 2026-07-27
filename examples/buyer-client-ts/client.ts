// Minimal TypeScript buyer client for the GAM Seller MCP Node — a worked example of the
// buyer-side flow (issue #5, seed). It wraps the official MCP SDK client + StreamableHTTP
// transport, so it speaks the real protocol rather than hand-rolled HTTP.
//
// Scope: this is an EXAMPLE, not a published package. It shows an AI buyer agent (or its
// author) how to (1) read the RS256-signed capability document, (2) discover product
// families, and (3) pull a coarse availability forecast — all read-only, all subject to the
// node's Default-Deny gate.
//
// Out of scope here (by design, tracked for the full SDK #5): Domain-2 JWT minting (the
// `token` argument is optional; dev deployments accept entitled buyers without it), JWS
// signature verification against the node's JWKS, retries/backoff, and a Python twin.

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

export interface CallOptions {
  /** Domain-2 inter-service JWT (RS256). Optional for dev deployments. */
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
}

export class SellerMcpBuyerClient {
  private readonly client: Client;
  private readonly endpoint: URL;
  private connected = false;

  constructor(baseUrl: string, info: BuyerClientInfo = {}) {
    this.endpoint = new URL(MCP_PATH, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
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

  async discoverProducts(buyerId: string, opts: CallOptions = {}): Promise<ProductFamily[]> {
    const text = await this.callToolText("discover_products", { buyer_id: buyerId, ...argsFrom(opts) });
    return (JSON.parse(text) as { families: ProductFamily[] }).families;
  }

  async getForecast(
    buyerId: string,
    familyId: string,
    period: string,
    opts: CallOptions = {}
  ): Promise<ForecastResult> {
    const text = await this.callToolText("get_forecast", {
      buyer_id: buyerId,
      family_id: familyId,
      period,
      ...argsFrom(opts),
    });
    return JSON.parse(text) as ForecastResult;
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

function argsFrom(opts: CallOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts.token) out["token"] = opts.token;
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
