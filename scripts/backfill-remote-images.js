require("dotenv").config();

process.env.STORE_MEDIA_LOCALLY = "false";
process.env.DOWNLOAD_MEDIA_ON_SYNC = "false";
process.env.DOWNLOAD_MEDIA_ON_POLL = "false";

const { connectDb, closeDb, getDb } = require("../src/db");
const { createClient } = require("../src/telegram");
const {
  extractRemoteImageUrlsFromMessage,
  buildMediaProxyUrl,
  pickImageForOfferIndex,
  offerHasTelegramVisualMedia,
} = require("../src/media");
const { enrichStoredOffer } = require("../src/parser");
const { clearResponseCache } = require("../src/responseCache");

async function main() {
  const limit = Number(process.argv[2]) || 0;

  await connectDb();
  const client = await createClient();
  const collection = getDb().collection("offers");

  let cursor = collection.find({
    $or: [
      { imageUrl: { $regex: "^/media/" } },
      { imageUrl: null },
      { imageUrl: "" },
      { "clear.image": null },
    ],
  });
  if (limit > 0) cursor = cursor.limit(limit);

  const offers = await cursor.toArray();
  console.log(`[backfill-remote] ${offers.length} offer(s) to fix`);

  let updated = 0;
  let skipped = 0;

  for (const offer of offers) {
    let imageUrl = null;

    try {
      const entity = await client.getEntity(offer.channelId);
      const messages = await client.getMessages(entity, { ids: [offer.messageId] });
      const message = messages?.[0];
      if (message) {
        const urls = extractRemoteImageUrlsFromMessage(message);
        imageUrl = pickImageForOfferIndex(urls, offer.offerIndex || 0);
      }
    } catch (err) {
      console.warn(`[backfill-remote] ${offer.id}: ${err.message}`);
    }

    if (!imageUrl && offerHasTelegramVisualMedia(offer)) {
      const ext =
        String(offer.imageUrl || "").match(/\.[a-z0-9]+$/i)?.[0] || ".jpg";
      imageUrl = buildMediaProxyUrl(
        offer.channelId,
        offer.messageId,
        ext,
        offer.offerIndex || 0
      );
    }

    const enriched = enrichStoredOffer({
      ...offer,
      imageUrl: imageUrl || offer.imageUrl,
    });

    if (!enriched.clear?.image) {
      skipped += 1;
      continue;
    }

    await collection.updateOne(
      { id: offer.id },
      { $set: { imageUrl: enriched.imageUrl, clear: enriched.clear } }
    );
    updated += 1;
    console.log(`[backfill-remote] ${offer.id} → ${enriched.clear.image}`);
  }

  clearResponseCache();
  console.log(`[backfill-remote] updated ${updated}, skipped ${skipped}`);
  await client.disconnect();
  await closeDb();
}

main().catch((err) => {
  console.error("[backfill-remote] failed:", err.message);
  process.exit(1);
});
