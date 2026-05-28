require("dotenv").config();

const { connectDb, closeDb, getDb } = require("../src/db");
const { createClient } = require("../src/telegram");
const {
  extractMessageImages,
  normalizeChannelId,
} = require("../src/telegram");
const { enrichStoredOffer } = require("../src/parser");
const { pickImageForOfferIndex } = require("../src/media");

async function main() {
  const limit = Number(process.argv[2]) || 0;

  await connectDb();
  const client = await createClient();

  const query = {
    $or: [
      { imageUrl: null },
      { imageUrl: "" },
      { imageUrl: { $exists: false } },
    ],
  };

  let cursor = getDb().collection("offers").find(query).sort({ postedAt: -1, createdAt: -1 });
  if (limit > 0) cursor = cursor.limit(limit);

  const offers = await cursor.toArray();
  console.log(`[backfill-media] ${offers.length} offer(s) without image`);

  let updated = 0;
  let skipped = 0;

  for (const offer of offers) {
    const messageId = offer.messageId;
    const channelId = offer.channelId;

    if (!messageId || !channelId) {
      skipped += 1;
      continue;
    }

    try {
      const entity = await client.getEntity(channelId);
      const messages = await client.getMessages(entity, { ids: [messageId] });
      const message = messages?.[0];

      if (!message) {
        skipped += 1;
        continue;
      }

      const chat = {
        id: normalizeChannelId(entity),
        title: entity.title,
        username: entity.username,
      };

      const imageUrls = await extractMessageImages(client, message, chat, {
        downloadMedia: true,
      });

      if (!imageUrls.length) {
        const enriched = enrichStoredOffer(offer);
        if (enriched.imageUrl && enriched.imageUrl !== offer.imageUrl) {
          await getDb()
            .collection("offers")
            .updateOne(
              { id: offer.id },
              { $set: { imageUrl: enriched.imageUrl, clear: enriched.clear } }
            );
          updated += 1;
        } else {
          skipped += 1;
        }
        continue;
      }

      const imageUrl = pickImageForOfferIndex(imageUrls, offer.offerIndex || 0);
      const enriched = enrichStoredOffer({ ...offer, imageUrl });

      await getDb()
        .collection("offers")
        .updateOne(
          { id: offer.id },
          {
            $set: {
              imageUrl: enriched.imageUrl,
              clear: enriched.clear,
            },
          }
        );

      updated += 1;
      console.log(`[backfill-media] ${offer.id} → ${enriched.imageUrl}`);
    } catch (err) {
      console.error(`[backfill-media] ${offer.id}:`, err.message);
      skipped += 1;
    }
  }

  console.log(
    `[backfill-media] done — updated ${updated}, skipped ${skipped}, total ${offers.length}`
  );

  await client.disconnect();
  await closeDb();
}

main().catch((err) => {
  console.error("[backfill-media] failed:", err.message);
  process.exit(1);
});
