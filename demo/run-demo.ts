// Demo runner — S5 GAM Seller MCP Node
// Executes the full demo flow (Escenas 1–4-bis) against live components.
// No MCP transport needed — imports services directly for a clean console output.
// Run: npx tsx demo/run-demo.ts

import { generateDevKeyPair } from "../src/identity/jwk.js";
import { TokenIssuer } from "../src/identity/issuer.js";
import { TokenValidator } from "../src/identity/validator.js";
import { Denylist } from "../src/identity/denylist.js";
import { WellKnownService } from "../src/discovery/well-known.js";
import { TEST_DEPLOYMENT_CONFIG } from "../src/config/deployment.js";
import { CatalogStore, TEST_CATALOG_CONFIG } from "../src/catalog/store.js";
import { ForecastEngine } from "../src/forecast/engine.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { EntitlementStore, TEST_ENTITLEMENTS_DEMO_CONFIG } from "../src/policy/entitlements.js";
import { AllowedSurface } from "../src/policy/types.js";
import { RateLimiter } from "../src/rate-limiter/limiter.js";
import { createMemoryLedger } from "../src/audit/ledger.js";
import { createMemoryAnchor } from "../src/audit/anchor.js";
import { EventClass } from "../src/audit/event.js";
import { randomUUID } from "crypto";

const BUYER_ID = "pilot-buyer-001";
const SEP = "─".repeat(60);

function section(title: string) {
  process.stdout.write(`\n${SEP}\n${title}\n${SEP}\n`);
}

function out(label: string, value: unknown) {
  process.stdout.write(`  ${label}\n`);
  if (value !== undefined) {
    process.stdout.write(JSON.stringify(value, null, 2).split("\n").map((l) => `    ${l}`).join("\n") + "\n");
  }
}

async function runDemo() {
  process.stdout.write("\n🎬  GAM Seller MCP Node — Demo S5\n");
  process.stdout.write("    Datos: 100% sintéticos · synthetic: true\n");

  // Setup
  const keyPair = await generateDevKeyPair();
  const denylist = new Denylist(null);
  const issuer = new TokenIssuer(keyPair.privateKey);
  const validator = new TokenValidator(keyPair.publicKey, denylist);
  const wellKnown = new WellKnownService(keyPair.privateKey, keyPair.publicKey, TEST_DEPLOYMENT_CONFIG);
  const catalog = new CatalogStore(TEST_CATALOG_CONFIG);
  const forecast = new ForecastEngine();
  const policy = new PolicyEngine(new EntitlementStore(TEST_ENTITLEMENTS_DEMO_CONFIG));
  const rateLimiter = new RateLimiter();
  const ledger = createMemoryLedger();
  const anchor = createMemoryAnchor();

  // ── ESCENA 1: Well-known ───────────────────────────────────────
  section("ESCENA 1 — Descubrimiento: /.well-known/seller-mcp-capabilities");
  const signedDoc = await wellKnown.sign();
  const doc = await wellKnown.verify(signedDoc);
  out("[WELL-KNOWN] Documento firmado RS256 verificado ✓", {
    node_id: doc.node_id,
    version: doc.version,
    posture: doc.posture,
    capability_families: doc.capability_families,
    privacy_posture: doc.privacy_posture,
  });

  // ── ESCENA 2: Auth ─────────────────────────────────────────────
  section("ESCENA 2 — Autenticación y scoping");
  const { token, claims } = await issuer.issue();
  const validation = await validator.validate(token);
  ledger.append(EventClass.TOKEN_ISSUANCE, { jti: claims.jti, scope: claims.scope });
  ledger.append(EventClass.BUYER_AUTHENTICATION, { outcome: validation.valid ? "allow" : "deny" }, { buyer_id: BUYER_ID });
  out("[AUTH] Token RS256 emitido + validado ✓", {
    jti: claims.jti,
    scope: claims.scope,
    ttl_seconds: claims.exp - claims.iat,
    valid: validation.valid,
  });

  const req_id_policy = randomUUID();
  const decision = policy.decide({
    buyer_id: BUYER_ID,
    surface: AllowedSurface.PRODUCT_DISCOVERY,
    scope: "gam.readonly",
    phase: "phase-1-readonly",
    request_id: req_id_policy,
  });
  ledger.append(
    EventClass.SCOPE_RESOLUTION,
    { outcome: decision.outcome, surface: decision.surface },
    { buyer_id: BUYER_ID, request_id: req_id_policy }
  );
  out(`[POLICY] buyer_id: ${BUYER_ID}`, {
    outcome: decision.outcome,
    surface: decision.surface,
    phase: decision.phase,
  });

  // ── ESCENA 3: Catálogo ─────────────────────────────────────────
  section("ESCENA 3 — Catálogo curado");
  rateLimiter.check(BUYER_ID); // consume quota
  const families = catalog.discover(BUYER_ID);
  out(`[DISCOVER] ${families.length} familias para ${BUYER_ID}`, families);

  // ── ESCENA 4: Forecast ─────────────────────────────────────────
  section("ESCENA 4 — Feasibility bucketizado (sintético)");
  for (const f of families) {
    // Fresh limiter per family — demo shows all families without rate-limit interference.
    // In production, a single limiter instance per buyer_id enforces N=1/T=30s.
    const forecastLimiter = new RateLimiter();
    forecastLimiter.check(BUYER_ID);
    const result = forecast.forecast(f.family_id, "Q4-2026");
    ledger.append(
      EventClass.FORECAST_REQUEST,
      { family_id: f.family_id, period: "Q4-2026", bucket: result.bucket, synthetic: true },
      { buyer_id: BUYER_ID }
    );
    out(`[FORECAST] ${f.family_id} · Q4-2026`, {
      bucket: result.bucket,
      bucket_label: result.bucket_label,
      ttl_seconds: result.ttl_seconds,
      synthetic: result.synthetic,
    });
  }

  // ── ESCENA 4-bis: Privacy posture pitch ────────────────────────
  section("ESCENA 4-bis — Cumplimiento EU por diseño");
  out("[PRIVACY POSTURE] Declaración firmada (machine-readable)", doc.privacy_posture);
  process.stdout.write("\n  Claim: diseñado sobre doctrina AEPD/GDPR.\n");
  process.stdout.write("  Pendiente de dictamen legal formal.\n");

  // ── ESCENA 5: Audit trail ──────────────────────────────────────
  section("ESCENA 5 — Audit log encadenado e inmutable");
  const headHash = ledger.headHash();
  anchor.anchor(headHash, ledger.headSeq());
  const replay = ledger.replayVerify();
  out(`[AUDIT] ${ledger.size()} eventos registrados en esta sesión`, ledger.allEntries().map((e) => ({
    seq: e.seq,
    event: e.event_class,
    buyer: e.buyer_id, // seudónimo HMAC — el buyer_id crudo nunca entra en el ledger
  })));
  out("[AUDIT] Verificación de cadena (hash-chain + anclaje externo)", {
    chain_valid: replay.valid,
    head_hash: headHash.slice(0, 16) + "…",
    anchored: anchor.count() === 1,
  });
  process.stdout.write("\n  Cada paso queda encadenado (SHA-256) y anclado externamente.\n");
  process.stdout.write("  Manipular un evento rompe la cadena — y se detecta en replay.\n");

  // ── Fin ────────────────────────────────────────────────────────
  section("FIN — Suite en verde, G5 firmado");
  process.stdout.write("  Próximo paso: contacto con el publisher piloto\n\n");
}

runDemo().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
