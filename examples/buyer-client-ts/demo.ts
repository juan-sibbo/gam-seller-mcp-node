// Runnable quickstart for SellerMcpBuyerClient.
//
//   1. start the node:   npm run build && node dist/server.js --http
//   2. run this demo:    npx tsx examples/buyer-client-ts/demo.ts [base_url] [buyer_id]
//
// Defaults: base_url = http://127.0.0.1:3900, buyer_id = pilot-buyer-001 (entitled in the
// worked pilot-publisher config). Pass an unknown buyer_id to see the Default-Deny gate.

import { SellerMcpBuyerClient, BuyerAccessError } from "./client.js";

async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? "http://127.0.0.1:3900";
  const buyerId = process.argv[3] ?? "pilot-buyer-001";

  const buyer = new SellerMcpBuyerClient(baseUrl, { name: "buyer-client-demo" });
  try {
    await buyer.connect();

    const caps = await buyer.capabilities();
    console.log(`node: ${caps.node_id}   posture: ${caps.posture}`);
    console.log(
      `privacy: end_user_personal_data=${caps.privacy_posture.end_user_personal_data}, ` +
        `jurisdiction=${caps.privacy_posture.jurisdiction?.join("/")}`
    );
    console.log(`capability families: ${caps.capability_families.join(", ")}`);

    const families = await buyer.discoverProducts(buyerId);
    console.log(`\ndiscover_products(${buyerId}) -> ${families.length} family(ies):`);
    for (const f of families) {
      const price = f.pricing_options ? `  — list ${f.pricing_options.list_price} ${f.pricing_options.currency}` : "";
      console.log(`  · ${f.family_id}${price}`);
    }

    if (families.length > 0) {
      const period = "Q4-2026";
      const forecast = await buyer.getForecast(buyerId, families[0]!.family_id, period);
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
