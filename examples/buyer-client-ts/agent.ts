// Reference buyer AGENT — the full commit loop over the REAL MCP HTTP transport.
//
// Where demo.ts stops at the read-only calls, this drives the whole buyer journey a pilot cares
// about: read the trust anchor → discover → forecast → COMMIT (create_intent) → withdraw
// (revoke_intent). It is deliberately a plain, deterministic agent (no LLM) so it doubles as a
// smoke test of a live deployment; an LLM-driven agent makes the same five tool calls (see
// docs/PILOT-QUICKSTART.md for wiring the node into an MCP host).
//
//   1. start the node:     npm run build && node dist/server.js --http
//   2. mint a buyer token: npx tsx scripts/issue-buyer-token.ts <entitled-buyer-id>
//   3. run this agent:     npx tsx examples/buyer-client-ts/agent.ts <token> [base_url]
//
// The buyer must be entitled to the INTENT surface (and have catalog access + a firm price) for
// the commit loop to complete; otherwise the node answers Default-Deny and the agent reports it.

import { randomUUID } from "node:crypto";
import { SellerMcpBuyerClient, BuyerAccessError, type ProductFamily } from "./client.js";

const PERIOD = process.env.PILOT_PERIOD ?? "Q4-2026";

function log(step: string, detail: string): void {
  console.log(`  ${step.padEnd(16)} ${detail}`);
}

async function main(): Promise<void> {
  const token = process.argv[2];
  const baseUrl = process.argv[3] ?? "http://127.0.0.1:3900";
  if (!token) {
    console.error("Usage: npx tsx examples/buyer-client-ts/agent.ts <token> [base_url]");
    console.error("Mint a token with: npx tsx scripts/issue-buyer-token.ts <buyer_id>");
    process.exit(1);
  }

  console.log(`\n🛒  Buyer agent — full commit loop over ${baseUrl}\n`);
  const buyer = new SellerMcpBuyerClient(baseUrl, { name: "reference-buyer-agent", token });

  try {
    await buyer.connect();

    // 1 · Trust anchor — reason over posture BEFORE transacting (audience-blind by design).
    const caps = await buyer.capabilities();
    log("capabilities", `${caps.node_id} · posture=${caps.posture} · personal_data=${caps.privacy_posture.end_user_personal_data}`);

    // 2 · Discover — what can this buyer buy, and at what firm price?
    // A fresh idempotency key per call: harmless normally, and REQUIRED when the node runs with
    // MCP_REQUIRE_IDEMPOTENCY_KEY=1 (the production posture) — every authenticated call must carry
    // a client_request_id or it is refused, so a correct buyer agent always sends one.
    const families = await buyer.discoverProducts({ clientRequestId: randomUUID() });
    log("discover", `${families.length} family(ies): ${families.map((f) => f.family_id).join(", ") || "(none)"}`);

    // Pick the first family that carries a firm price — that's the only one we can commit to.
    const priced: ProductFamily | undefined = families.find((f) => f.pricing_options !== undefined);
    if (!priced || !priced.pricing_options) {
      log("result", "no family has a firm price for this buyer — nothing to commit to. Stopping (not an error).");
      return;
    }
    const firmPrice = priced.pricing_options.list_price;

    // 3 · Forecast — coarse availability bucket for the chosen family.
    const forecast = await buyer.getForecast(priced.family_id, PERIOD, { clientRequestId: randomUUID() });
    log("forecast", `${priced.family_id} · ${PERIOD} -> bucket=${forecast.bucket} (synthetic=${forecast.synthetic})`);

    // 4 · Commit — a firm, time-boxed intent at the firm price. Fresh idempotency key per call.
    const created = await buyer.createIntent(priced.family_id, PERIOD, firmPrice, { clientRequestId: randomUUID() });
    log("create_intent", `intent_id=${created.intent_id.slice(0, 8)}… firm_price=${created.firm_price} expires=${created.expires_at}`);

    // 5 · Withdraw — a buyer can always revoke its own commitment.
    const revoked = await buyer.revokeIntent(created.intent_id, { clientRequestId: randomUUID() });
    log("revoke_intent", `intent_id=${revoked.intent_id.slice(0, 8)}… status=${revoked.status}`);

    console.log("\n✅  Full loop complete: discover → forecast → commit → revoke. Handoff drop written on commit.\n");
  } catch (err) {
    if (err instanceof BuyerAccessError) {
      console.error(`\n⛔  Default-Deny: the node refused a call — code=${err.code}`);
      console.error("    (Check the buyer's entitlements: INTENT surface + catalog access + a matching firm price.)");
      process.exitCode = 2;
    } else {
      throw err;
    }
  } finally {
    await buyer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
