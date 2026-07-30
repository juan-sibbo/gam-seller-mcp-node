// Operator health snapshot — v0.8 operability. Served at GET /health for orchestrators,
// load balancers, and uptime checks. Deliberately NON-SENSITIVE: it carries only the node
// version and an aggregate durability signal — never buyer data, counts, or commercial
// intelligence (so it is safe to expose even when the node is bound off-loopback, unlike
// /metrics). "degraded" surfaces the ledger persistence-health flag (v0.6 E1): the process
// is still live and serving, but a disk write has failed and audit durability is at risk —
// something to alert on, not a reason to drop traffic.

export interface HealthReport {
  status: "ok" | "degraded";
  version: string;
  persistence_healthy: boolean;
}

export function buildHealthReport(persistenceHealthy: boolean, version: string): HealthReport {
  return {
    status: persistenceHealthy ? "ok" : "degraded",
    version,
    persistence_healthy: persistenceHealthy,
  };
}
