import type { AccessTokenProvider, FetchLike } from "./auth.js";

// Minimal SOAP client for the Ad Manager API. Google ships no official Node client (the API is
// SOAP-only; official libraries are Java/PHP/Python/.NET/Ruby), and the node needs exactly two
// read operations, so envelopes are built by hand. Element order follows the XSD sequence as
// emitted by the official Python client (googleads/zeep) — SOAP rejects out-of-order elements.
//
// EGRESS (declared in tests/egress-surface.test.ts): POSTs to the fixed Ad Manager endpoint for
// the operator-configured network. Triggered only by the forecast refresh cycle, never by a buyer
// request; the buyer cannot influence host, service, method or network.

export const GAM_API_BASE = "https://ads.google.com/apis/ads/publisher";
export const DEFAULT_GAM_API_VERSION = "v202608";

export interface GamSoapConfig {
  networkCode: string;
  apiVersion: string;
  applicationName: string;
}

// Thrown for HTTP errors and SOAP faults. The message is for the operator log; it must never be
// forwarded to a buyer (soap-fault-redaction-signoff.md — the server maps it to UNAVAILABLE).
export class GamApiError extends Error {}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Text of the first <tag>…</tag> (namespace prefix tolerated). The responses parsed here are flat,
// fixed-shape Google payloads, so a targeted extractor is enough — no general XML parser needed.
export function firstTagText(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}>([^<]*)</(?:[\\w-]+:)?${tag}>`));
  return match?.[1];
}

export class GamSoapClient {
  constructor(
    private readonly config: GamSoapConfig,
    private readonly tokens: AccessTokenProvider,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  get networkCode(): string {
    return this.config.networkCode;
  }

  // Sends `<method>{bodyXml}</method>` to `service` and returns the raw response envelope.
  async call(service: string, method: string, bodyXml: string): Promise<string> {
    const ns = `https://www.google.com/apis/ads/publisher/${this.config.apiVersion}`;
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soapenv:Header><RequestHeader xmlns="${ns}">` +
      `<networkCode>${xmlEscape(this.config.networkCode)}</networkCode>` +
      `<applicationName>${xmlEscape(this.config.applicationName)}</applicationName>` +
      `</RequestHeader></soapenv:Header>` +
      `<soapenv:Body><${method} xmlns="${ns}">${bodyXml}</${method}></soapenv:Body>` +
      `</soapenv:Envelope>`;

    const token = await this.tokens.getAccessToken();
    const res = await this.fetchImpl(`${GAM_API_BASE}/${this.config.apiVersion}/${service}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '""',
        Authorization: `Bearer ${token}`,
      },
      body: envelope,
    });
    const text = await res.text();
    const fault = firstTagText(text, "faultstring");
    if (fault !== undefined) {
      throw new GamApiError(`[gam] ${service}.${method} SOAP fault: ${fault}`);
    }
    if (!res.ok) {
      throw new GamApiError(`[gam] ${service}.${method} failed (HTTP ${res.status}).`);
    }
    return text;
  }
}
