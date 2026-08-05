import { readFileSync } from "fs";
import { resolveConfigPath } from "../config/resolve.js";

// Product family schema — privacy-consent-layer §3 (Pilar 3).
// consent_context and legal_basis_provenance are reserved empty fields in v1.
// They exist in the schema but are not interpreted; the values must remain null.
export interface ProductFamily {
  family_id: string;
  label: string;
  consent_context: null;
  legal_basis_provenance: null;
}

interface CatalogConfig {
  families: ProductFamily[];
  buyer_access: Record<string, string[]>;
}

// CatalogStore — read-only, synthetic, zero GAM (S4 scope).
// discover() returns only the families the buyer_id is entitled to see.
// Absence from buyer_access = empty result (not an error — Default-Deny posture).
export class CatalogStore {
  private readonly families: Map<string, ProductFamily>;
  private readonly buyerAccess: Map<string, ReadonlySet<string>>;

  constructor(config: CatalogConfig) {
    this.families = new Map(config.families.map((f) => [f.family_id, f]));
    this.buyerAccess = new Map(
      Object.entries(config.buyer_access).map(([buyerId, ids]) => [
        buyerId,
        new Set(ids),
      ])
    );
  }

  discover(buyer_id: string): ProductFamily[] {
    const allowed = this.buyerAccess.get(buyer_id);
    if (!allowed) return [];
    return Array.from(allowed)
      .map((id) => this.families.get(id))
      .filter((f): f is ProductFamily => f !== undefined);
  }

  familyCount(): number {
    return this.families.size;
  }
}

export function loadCatalogFromFile(configPath?: string): CatalogStore {
  const path = configPath ?? resolveConfigPath("catalog.json");
  const raw = readFileSync(path, "utf-8");
  return new CatalogStore(JSON.parse(raw) as CatalogConfig);
}

// Test fixture — used in tests without disk I/O.
export const TEST_CATALOG_CONFIG: CatalogConfig = {
  families: [
    { family_id: "display-ros", label: "Run of Site — Display", consent_context: null, legal_basis_provenance: null },
    { family_id: "video-pre-roll", label: "Pre-Roll Video", consent_context: null, legal_basis_provenance: null },
    { family_id: "branded-content", label: "Branded Content Placements", consent_context: null, legal_basis_provenance: null },
  ],
  buyer_access: {
    "test-buyer-001": ["display-ros", "video-pre-roll"],
    "pilot-buyer-001": ["display-ros", "branded-content"],
  },
};
