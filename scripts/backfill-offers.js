require("dotenv").config();

const { connectDb, closeDb, getDb } = require("../src/db");
const { enrichStoredOffer } = require("../src/parser");
const { normalizeImageUrl } = require("../src/dedupe");

async function main() {
  await connectDb();
  const collection = getDb().collection("offers");
  const cursor = collection.find({});
  let updated = 0;

  while (await cursor.hasNext()) {
    const offer = await cursor.next();
    const enriched = enrichStoredOffer(offer);

    const fields = {
      description: enriched.description,
      price: enriched.price,
      currency: enriched.currency,
      salePercent: enriched.salePercent,
      imageUrl: enriched.imageUrl,
      imageDedupeKey: normalizeImageUrl(enriched.imageUrl),
      offerLink: enriched.offerLink,
      platform: enriched.platform,
      category: enriched.category,
      normalizedLink: enriched.normalizedLink,
      dedupeKey: enriched.dedupeKey,
      clear: enriched.clear,
    };

    const unchanged = Object.entries(fields).every(
      ([key, value]) => JSON.stringify(offer[key]) === JSON.stringify(value)
    );
    if (unchanged) continue;

    await collection.updateOne({ id: offer.id }, { $set: fields });
    updated += 1;
  }

  console.log(`[backfill] updated ${updated} offer(s)`);
  await closeDb();
}

main().catch((err) => {
  console.error("[backfill] failed:", err.message);
  process.exit(1);
});
