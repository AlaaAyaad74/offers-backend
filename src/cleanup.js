const fs = require("fs/promises");
const path = require("path");
const { deleteExpiredOffers, resolveRetentionDays } = require("./store");
const { getMediaDir } = require("./telegram");

let cleanupTimer;
let cleanupRunning = false;

async function deleteOfferMedia(imageUrls) {
  const mediaDir = getMediaDir();

  for (const imageUrl of imageUrls) {
    if (!imageUrl || !imageUrl.startsWith("/media/")) {
      continue;
    }

    const filePath = path.join(mediaDir, path.basename(imageUrl));
    await fs.unlink(filePath).catch(() => null);
  }
}

async function runCleanup() {
  if (cleanupRunning) {
    return null;
  }

  cleanupRunning = true;
  try {
    const result = await deleteExpiredOffers();

    if (result.imageUrls.length > 0) {
      await deleteOfferMedia(result.imageUrls);
    }

    if (result.deleted > 0) {
      console.log(
        `[cleanup] removed ${result.deleted} offer(s) older than ${result.retentionDays} days`
      );
    }

    return result;
  } catch (err) {
    console.error("[cleanup] error:", err.message);
    return null;
  } finally {
    cleanupRunning = false;
  }
}

function startOfferCleanup() {
  const enabled =
    String(process.env.OFFERS_CLEANUP_ENABLED ?? "true").toLowerCase() !==
    "false";

  if (!enabled) {
    console.log("[cleanup] disabled");
    return;
  }

  const intervalSec = Number(process.env.OFFERS_CLEANUP_INTERVAL_SEC) || 3600;
  const retentionDays = resolveRetentionDays();

  console.log(
    `[cleanup] offers older than ${retentionDays} days are removed every ${intervalSec}s`
  );

  runCleanup();
  cleanupTimer = setInterval(runCleanup, intervalSec * 1000);
}

function stopOfferCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}

module.exports = {
  startOfferCleanup,
  stopOfferCleanup,
  runCleanup,
};
