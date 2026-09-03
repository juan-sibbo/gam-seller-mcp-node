import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { dataPath } from "../config/paths.js";
import { DurabilityHealth } from "../durability.js";

// Intent handoff sink — the seam that turns create_intent from a merely-recorded artifact into a
// CLOSED loop: when a buyer commits, the publisher's classic sales rails must actually RECEIVE the
// intent to act on it. This is the operator-selectable delivery of the A′ handoff artifact
// (plan-core-v04 §3). A handoff record is NOT a GAM order nor an inventory hold (SOFT_LOCK_* stays
// deferred to Tier 2), so it crosses no ad-server-write line — the node's core invariant holds.
//
// DELIVERY IS LOCAL-FIRST, BY DESIGN. The node writes the handoff to a local file drop; forwarding
// it onward (webhook, CRM, email) is an OPERATOR-OWNED process reading that drop — never an outbound
// call from the node itself. This preserves the SSRF/egress deny-all posture the node is audited
// for (tests/catalog.test.ts "no fetch/got/axios in src/"): the node makes no network egress on
// behalf of a request, and no buyer-supplied value is ever used as a URL. It is also the more
// publisher-sovereign design — the publisher owns the forwarding, not the node.
//
// Recipient is the publisher's OWN first-party sales system, so the file-drop payload MAY carry the
// raw buyer_id and firm_price (the publisher's own data, staying on the publisher's own host). This
// is deliberately NOT the audit ledger, which stays minimized + pseudonymized (KANON §Logs-y-Audit):
// the ledger is the tamper-evident record of record; the handoff drop is an operational delivery.
//
// Selected at deploy time by MCP_INTENT_HANDOFF (mirrors MCP_ANCHOR_SINK):
//   unset   → NullHandoffSink  (no delivery; create_intent behaves EXACTLY as before)
//   "file"  → FileHandoffSink  (JSONL appended to MCP_INTENT_HANDOFF_FILE, default
//                               data/intent-handoff.jsonl — an operator forwarder tails this)
//
// Delivery is FIRE-AND-FORGET off the request path (server.ts): a slow or failing sink must never
// delay the buyer's response nor fail the commit (the ledger already holds the record of record).
// Failures are surfaced (stderr + metric), never silently swallowed.

export interface HandoffRecord {
  intent_id: string;
  buyer_id: string;
  family_id: string;
  period: string;
  firm_price: number;
  currency: string;
  created_at: string;
  expires_at: string;
}

export interface HandoffSink {
  emit(record: HandoffRecord): Promise<void>;
  // Short human label for boot logging and diagnostics ("null" | "file").
  readonly kind: string;
}

// Default: deliver nothing. create_intent is unchanged when no handoff is configured.
export class NullHandoffSink implements HandoffSink {
  readonly kind = "null";
  async emit(): Promise<void> {
    /* no-op */
  }
}

// Append one JSON object per line to a local file the publisher's sales ops tails, imports, or
// forwards. Local write only — no network egress (SSRF deny-all).
export class FileHandoffSink implements HandoffSink {
  readonly kind = "file";
  private readonly durability = new DurabilityHealth("intent-handoff", "intent handoff file");
  constructor(private readonly path: string) {}
  async emit(record: HandoffRecord): Promise<void> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(record) + "\n", "utf-8");
      this.durability.markHealthy();
    } catch (err) {
      // Mark degraded AND rethrow: the caller's fire-and-forget wrapper logs + counts the failure.
      this.durability.markDegraded(err);
      throw err;
    }
  }
  isHealthy(): boolean {
    return this.durability.isHealthy();
  }
}

// Never echo credentials a caller might have embedded in a value (user:pass@host).
function redact(value: string): string {
  return value.replace(/\/\/[^@/]+@/, "//***@");
}

export const INTENT_HANDOFF_ENV = "MCP_INTENT_HANDOFF";
export const INTENT_HANDOFF_FILE_ENV = "MCP_INTENT_HANDOFF_FILE";
export const DEFAULT_HANDOFF_FILE = "intent-handoff.jsonl";

// Operator-selectable sink, chosen at deploy time. Fail-closed on a misconfigured value: a typo'd
// destination must stop the boot, not silently drop every handoff (same posture as the anchor sink).
// A URL is rejected on purpose: the node does not make outbound calls — point a webhook/CRM
// forwarder at the file drop instead (see docs/PUBLISHER-DEPLOYMENT.md).
export function resolveHandoffSink(env: NodeJS.ProcessEnv = process.env): HandoffSink {
  const raw = env[INTENT_HANDOFF_ENV]?.trim();
  if (!raw) return new NullHandoffSink();
  if (raw.toLowerCase() === "file") {
    return new FileHandoffSink(env[INTENT_HANDOFF_FILE_ENV]?.trim() || dataPath(DEFAULT_HANDOFF_FILE));
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(
      `[handoff] ${INTENT_HANDOFF_ENV}="${redact(raw)}": the node makes no outbound calls ` +
        `(SSRF/egress deny-all). Use "file" and point your own webhook/CRM forwarder at the ` +
        `file drop (${DEFAULT_HANDOFF_FILE}).`
    );
  }
  throw new Error(`[handoff] ${INTENT_HANDOFF_ENV}="${raw}": use "file" or unset it.`);
}
