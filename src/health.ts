// Operator health snapshot — v0.8 operability. Served at GET /health for orchestrators,
// load balancers, and uptime checks. Deliberately NON-SENSITIVE: it carries only the node
// version and an aggregate durability signal — never buyer data, counts, or commercial
// intelligence (so it is safe to expose even when the node is bound off-loopback, unlike
// /metrics). "degraded" surfaces the persistence-health flag across all disk-backed stores
// (v0.6 E1 extended to all stores in #51): the process is still live and serving, but a
// disk write has failed and audit/revocation durability is at risk — something to alert on,
// not a reason to drop traffic.

export interface StoreHealth {
  ledger: boolean;
  anchor: boolean;
  pseudonym: boolean;
  retention: boolean;
  denylist: boolean;
}

export interface HealthReport {
  status: "ok" | "degraded";
  version: string;
  persistence_healthy: boolean; // aggregate — backward compat for existing clients
  stores: StoreHealth;
}

export function buildHealthReport(stores: StoreHealth, version: string): HealthReport {
  const persistence_healthy = Object.values(stores).every(Boolean);
  return {
    status: persistence_healthy ? "ok" : "degraded",
    version,
    persistence_healthy,
    stores,
  };
}
