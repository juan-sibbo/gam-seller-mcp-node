// Runnable quickstart for SellerMcpBuyerClient.
//
//   1. start the node:   npm run build && node dist/server.js --http
//   2. mint a buyer token: npx tsx scripts/issue-buyer-token.ts pilot-buyer-001
//   3. run this demo:    npx tsx examples/buyer-client-ts/demo.ts <token> [base_url]
//
// v0.4 Bloque A: the buyer's identity is derived from its bearer token's sub — there is
// no buyer_id argument. Mint a token for an entitled buyer (e.g. pilot-buyer-001, entitled
// in the worked pilot-publisher config); mint one for an unknown buyer to see Default-Deny.
// Default base_url = http://127.0.0.1:3900.

import { SellerMcpBuyerClient, BuyerAccessError } from "./client.js";

async function main(): Promise<void> {
  const token = process.argv[2];
  const baseUrl = process.argv[3] ?? "http://127.0.0.1:3900";
  if (!token) {
    console.error("Usage: npx tsx examples/buyer-client-ts/demo.ts <token> [base_url]");
    console.error("Mint a token with: npx tsx scripts/issue-buyer-token.ts <buyer_id>");
    process.exit(1);
  }

  const buyer = new SellerMcpBuyerClient(baseUrl, { name: "buyer-client-demo", token });
  try {
    await buyer.connect();

    const caps = await buyer.capabilities();
    console.log(`node: ${caps.node_id}   posture: ${caps.posture}`);
    console.log(
      `privacy: end_user_personal_data=${caps.privacy_posture.end_user_personal_data}, ` +
        `jurisdiction=${caps.privacy_posture.jurisdiction?.join("/")}`
    );
    console.log(`capability families: ${caps.capability_families.join(", ")}`);

    const families = await buyer.discoverProducts();
    console.log(`\ndiscover_products -> ${families.length} family(ies):`);
    for (const f of families) {
      const price = f.pricing_options ? `  — list ${f.pricing_options.list_price} ${f.pricing_options.currency}` : "";
      console.log(`  · ${f.family_id}${price}`);
    }

    if (families.length > 0) {
      const period = "Q4-2026";
      const forecast = await buyer.getForecast(families[0]!.family_id, period);
      console.log(
        `\nget_forecast(${forecast.family_id}, ${period}) -> bucket=${forecast.bucket} (synthetic=${forecast.synthetic})`
      );
    }
  } catch (err) {
    if (err instanceof BuyerAccessError) {
      console.error(`\nDefault-Deny: the node refused access — code=${err.code}`);
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
