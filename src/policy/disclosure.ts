import { z } from "zod";
import { ErrorCode } from "../errors/envelope.js";
import { FORECAST_BUCKET } from "../forecast/engine.js";

// Buyer-facing disclosure schemas — the egress gate for every authenticated tool.
//
// The policy denylist (types.ts) decides on a surface LABEL that each tool declares when it is
// registered; it never inspects what the handler returns. A new tool registered under an allowed
// label (e.g. product_discovery) could therefore return a raw config object — GAM ids, floors,
// deal refs — and the denylist would not notice. These schemas close that gap: guardedTool
// requires one per tool and validates the handler's response against it BEFORE it leaves the
// node. Every object is `.strict()`, so any key not declared here fails the check and the buyer
// receives a generic INTERNAL_ERROR instead of the payload.
//
// Adding a field to a buyer response therefore means adding it HERE, in one reviewable place.

const reservedNull = z.null(); // Pilar 3 reserved fields — always null in v1.

const pricingOptions = z
  .object({
    list_price: z.number(),
    currency: z.string(),
    valid_until: z.string(),
  })
  .strict();

const buyerFacingFamily = z
  .object({
    family_id: z.string(),
    label: z.string(),
    consent_context: reservedNull,
    legal_basis_provenance: reservedNull,
    pricing_options: pricingOptions.optional(),
  })
  .strict();

export const DiscoverProductsDisclosure = z
  .object({
    families: z.array(buyerFacingFamily),
    request_id: z.string(),
  })
  .strict();

export const ForecastDisclosure = z
  .object({
    family_id: z.string(),
    period: z.string(),
    bucket: z.enum(Object.values(FORECAST_BUCKET) as [string, ...string[]]),
    bucket_label: z.string(),
    ttl_seconds: z.number(),
    synthetic: z.literal(true),
    consent_context: reservedNull,
    legal_basis_provenance: reservedNull,
    request_id: z.string(),
  })
  .strict();

export const CreateIntentDisclosure = z
  .object({
    intent_id: z.string(),
    status: z.enum(["active", "expired", "revoked"]),
    firm_price: z.number(),
    expires_at: z.string(),
    request_id: z.string(),
  })
  .strict();

export const RevokeIntentDisclosure = z
  .object({
    intent_id: z.string(),
    status: z.enum(["active", "expired", "revoked"]),
    request_id: z.string(),
  })
  .strict();

// Error responses are checked too: a handler returning isError must still emit only the safe
// envelope (soap-fault-redaction-signoff §2) — never an upstream fault body.
export const SafeErrorDisclosure = z
  .object({
    code: z.enum(Object.values(ErrorCode) as [string, ...string[]]),
    message: z.string(),
    request_id: z.string(),
    contract_version: z.string(),
  })
  .strict();

export type Disclosure = z.ZodType;

// Returns true when every text block of a tool result parses as JSON and matches the schema
// (the success schema, or the safe error envelope when isError is set).
export function conformsToDisclosure(
  result: { content: Array<{ type: "text"; text: string }>; isError?: boolean },
  success: Disclosure
): boolean {
  const schema = result.isError ? SafeErrorDisclosure : success;
  if (result.content.length === 0) return false;
  return result.content.every((block) => {
    try {
      return schema.safeParse(JSON.parse(block.text)).success;
    } catch {
      return false;
    }
  });
}
