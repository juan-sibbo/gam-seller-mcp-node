// Prometheus metrics registry — operator-facing observability (#8).
//
// Zero external dependencies: the Prometheus text exposition format (0.0.4) is
// trivial to emit by hand, and adding prom-client as a production dependency for
// six series is not justified (KISS / YAGNI).
//
// SECURITY INVARIANT (hard boundary): no label here may ever carry a buyer_id or
// any buyer-derived value. These counters are aggregate, operator-facing signals;
// a per-buyer label would turn the /metrics endpoint into a side channel that
// reveals individual buyer activity — the exact commercial-intelligence leak the
// audit ledger pseudonymizes against. Labels are drawn ONLY from closed enums
// (tool names, outcomes, reasons) defined below.

// Closed enums — the only values any label may ever take.
export const MetricTool = {
  WELL_KNOWN_CAPABILITIES: "well_known_capabilities",
  DISCOVER_PRODUCTS: "discover_products",
  GET_FORECAST: "get_forecast",
  CREATE_INTENT: "create_intent",
  REVOKE_INTENT: "revoke_intent",
} as const;
export type MetricTool = (typeof MetricTool)[keyof typeof MetricTool];

export const ToolOutcome = {
  SUCCESS: "success",
  AUTH_FAILED: "auth_failed",
  RATE_LIMITED: "rate_limited",
  REPLAY_REJECTED: "replay_rejected",
  // A well-formed request the node refuses on its merits (e.g. create_intent over a
  // stale/non-matching firm price). Distinct from AUTH_FAILED: identity was fine.
  INVALID_REQUEST: "invalid_request",
  INTERNAL_ERROR: "internal_error",
} as const;
export type ToolOutcome = (typeof ToolOutcome)[keyof typeof ToolOutcome];

export const AuthFailReason = {
  TOKEN_INVALID: "token_invalid",
  SCOPE_DENIED: "scope_denied",
} as const;
export type AuthFailReason = (typeof AuthFailReason)[keyof typeof AuthFailReason];

// Counter metric definitions: name → { help, label keys (ordered) }.
interface CounterDef {
  help: string;
  labelKeys: readonly string[];
}

const COUNTERS: Record<string, CounterDef> = {
  mcp_tool_calls_total: {
    help: "Total MCP tool calls, partitioned by tool and terminal outcome.",
    labelKeys: ["tool", "outcome"],
  },
  mcp_auth_failures_total: {
    help: "Total authentication/authorization failures, by tool and reason.",
    labelKeys: ["tool", "reason"],
  },
  mcp_rate_limited_total: {
    help: "Total requests rejected by the rate limiter, by tool.",
    labelKeys: ["tool"],
  },
  mcp_replay_rejected_total: {
    help: "Total requests rejected as replays, by tool.",
    labelKeys: ["tool"],
  },
};

// Gauge metric definitions: name → help. Set to an absolute value at scrape time.
const GAUGES: Record<string, string> = {
  mcp_active_sessions: "Currently active HTTP MCP sessions.",
  mcp_audit_ledger_entries_total: "Current number of entries in the audit ledger.",
};

// Escape a label value per the Prometheus text format: backslash, double-quote,
// and newline. Our values come from closed enums so this never actually fires,
// but correctness of the exposition format must not depend on that.
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Build the deterministic series key: metric{k1="v1",k2="v2"} with label keys in
// definition order, so the same label set always maps to the same counter.
function seriesKey(name: string, labelKeys: readonly string[], labels: Record<string, string>): string {
  if (labelKeys.length === 0) return name;
  const parts = labelKeys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`);
  return `${name}{${parts.join(",")}}`;
}

export class MetricsRegistry {
  // series key (metric{labels}) → accumulated count
  private readonly counters = new Map<string, number>();
  // gauge name → last set absolute value
  private readonly gauges = new Map<string, number>();

  // Increment a labelled counter by 1. Unknown metric names are a programming
  // error — throw loudly rather than silently dropping a metric.
  increment(name: keyof typeof COUNTERS | string, labels: Record<string, string> = {}): void {
    const def = COUNTERS[name];
    if (!def) throw new Error(`[metrics] unknown counter: ${name}`);
    const key = seriesKey(name, def.labelKeys, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  // Set a gauge to an absolute value (sessions live, ledger size).
  set(name: keyof typeof GAUGES | string, value: number): void {
    if (!(name in GAUGES)) throw new Error(`[metrics] unknown gauge: ${name}`);
    this.gauges.set(name, value);
  }

  // Render the full registry in Prometheus text exposition format (v0.0.4).
  // Every declared metric emits its # HELP and # TYPE header even with no samples,
  // so scrapers see a stable schema from the first scrape.
  render(): string {
    const lines: string[] = [];

    for (const [name, def] of Object.entries(COUNTERS)) {
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of this.counters) {
        if (key === name || key.startsWith(`${name}{`)) {
          lines.push(`${key} ${value}`);
        }
      }
    }

    for (const [name, help] of Object.entries(GAUGES)) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${this.gauges.get(name) ?? 0}`);
    }

    return lines.join("\n") + "\n";
  }
}
