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
  // Optional media-kit description of the family — what a buyer needs to know what it buys.
  formats?: string[];                // creative sizes, e.g. "300x250"
  channel?: MediaChannel;
  properties?: string[];             // sites (domains) the family runs on
}

export type MediaChannel = "display" | "video";
const CHANNELS: ReadonlySet<string> = new Set(["display", "video"]);
const FORMAT_RE = /^\d+x\d+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface MediaKitHint {
  formats: string[];
  channel: MediaChannel;
}

// Media-kit fields are buyer-facing, so a malformed value stops the boot instead of travelling.
function validateMediaKit(f: ProductFamily): void {
  const where = `[catalog] catalog.json family ${f.family_id}`;
  if (f.formats !== undefined && (!Array.isArray(f.formats) || !f.formats.every((x) => typeof x === "string" && FORMAT_RE.test(x)))) {
    throw new Error(`${where}: formats must be sizes like "300x250".`);
  }
  if (f.channel !== undefined && !CHANNELS.has(f.channel)) {
    throw new Error(`${where}: channel must be "display" or "video".`);
  }
  if (f.properties !== undefined && (!Array.isArray(f.properties) || !f.properties.every((x) => typeof x === "string" && DOMAIN_RE.test(x)))) {
    throw new Error(`${where}: properties must be domain names like "example.com".`);
  }
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
    config.families.forEach(validateMediaKit);
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

  // New store where families lacking formats/channel take them from the forecast targeting
  // (gam.json). Values written in catalog.json always win.
  withMediaKitDefaults(hints: ReadonlyMap<string, MediaKitHint>): CatalogStore {
    const families = [...this.families.values()].map((f) => {
      const hint = hints.get(f.family_id);
      if (!hint) return f;
      return { ...f, formats: f.formats ?? hint.formats, channel: f.channel ?? hint.channel };
    });
    const buyer_access = Object.fromEntries([...this.buyerAccess].map(([buyer, ids]) => [buyer, [...ids]]));
    return new CatalogStore({ families, buyer_access });
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
