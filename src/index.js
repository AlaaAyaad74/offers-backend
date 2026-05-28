require("dotenv").config();

const express = require("express");
const { connectDb, closeDb } = require("./db");
const {
  createClient,
  listenToChannels,
  startPolling,
  stopPolling,
  getMediaDir,
  listJoinedChannels,
  syncAllChannels,
  isSyncInProgress,
} = require("./telegram");
const {
  listOffers,
  getOffer,
  countOffers,
  countOffersFiltered,
} = require("./store");
const {
  resolvePagination,
  buildPaginationMeta,
} = require("./pagination");
const { startOfferCleanup, stopOfferCleanup } = require("./cleanup");
const { listCategories } = require("./categories");

const app = express();
const port = Number(process.env.PORT) || 3000;

function isTransientNetworkError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("not connected") ||
    message.includes("connection closed") ||
    message.includes("disconnected")
  );
}

function installProcessErrorGuards() {
  process.on("unhandledRejection", (reason) => {
    if (isTransientNetworkError(reason)) {
      console.warn(
        `[runtime] transient rejection ignored: ${
          reason?.message || String(reason)
        }`
      );
      return;
    }
    console.error("[runtime] unhandledRejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    if (isTransientNetworkError(err)) {
      console.warn(`[runtime] transient exception ignored: ${err.message}`);
      return;
    }
    console.error("[runtime] uncaughtException:", err);
    process.exit(1);
  });
}

app.use(express.json());
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});
app.use("/media", express.static(getMediaDir()));

app.get("/health", async (_req, res) => {
  try {
    res.json({ ok: true, offersStored: await countOffers() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/offers", async (req, res) => {
  try {
    const {
      platform,
      channelId,
      limit,
      offset,
      page,
      since,
      startDate,
      endDate,
      afterMessageId,
      dedupe,
      name,
      sort,
      category,
    } = req.query;

    const pagination = resolvePagination({ page, limit, offset });
    const filters = {
      platform,
      channelId,
      since,
      startDate,
      endDate,
      afterMessageId,
      dedupe,
      name,
      sort,
      category,
    };

    const [data, total, totalStored, rawMatching] = await Promise.all([
      listOffers({
        ...filters,
        limit: pagination.limit,
        offset: pagination.offset,
      }),
      countOffersFiltered(filters),
      countOffers(),
      countOffersFiltered({ ...filters, dedupe: false }),
    ]);

    const dedupeEnabled =
      dedupe !== "false" &&
      String(process.env.OFFERS_DEDUPE || "true").toLowerCase() !== "false";

    res.json({
      ...buildPaginationMeta({ total, ...pagination }),
      count: total,
      returned: data.length,
      totalStored,
      deduplicated: dedupeEnabled,
      duplicatesRemoved: dedupeEnabled ? Math.max(rawMatching - total, 0) : 0,
      data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/categories", (_req, res) => {
  res.json({ data: listCategories() });
});

app.get("/channels", async (req, res) => {
  try {
    const { name, search, page, limit, offset } = req.query;
    let channels = await listJoinedChannels(app.locals.telegramClient);

    const term = String(name || search || "")
      .trim()
      .toLowerCase();
    if (term) {
      channels = channels.filter((channel) =>
        String(channel.title || "")
          .toLowerCase()
          .includes(term)
      );
    }

    channels.sort((a, b) =>
      String(a.title || "").localeCompare(String(b.title || ""))
    );

    const pagination = resolvePagination({ page, limit, offset });
    const total = channels.length;
    const data =
      pagination.limit > 0
        ? channels.slice(
            pagination.offset,
            pagination.offset + pagination.limit
          )
        : channels;

    res.json({
      ...buildPaginationMeta({ total, ...pagination }),
      count: total,
      returned: data.length,
      data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/sync", async (req, res) => {
  try {
    if (isSyncInProgress()) {
      return res.status(409).json({ error: "Sync already in progress" });
    }

    const full = String(req.query.full || "").toLowerCase() === "true";
    const limitPerChannel = Number(req.query.limitPerChannel) || undefined;
    const downloadMedia =
      req.query.downloadMedia == null
        ? undefined
        : String(req.query.downloadMedia).toLowerCase() === "true";

    const result = await syncAllChannels(app.locals.telegramClient, {
      limitPerChannel: limitPerChannel > 0 ? limitPerChannel : undefined,
      incremental: !full,
      full,
      downloadMedia,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/offers/:id", async (req, res) => {
  try {
    const offer = await getOffer(req.params.id);
    if (!offer) {
      return res.status(404).json({ error: "Offer not found" });
    }
    return res.json(offer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function main() {
  installProcessErrorGuards();
  await connectDb();

  const client = await createClient();
  app.locals.telegramClient = client;
  listenToChannels(client);

  const shouldSyncOnStart =
    String(process.env.SYNC_ON_START || "").toLowerCase() === "true";

  if (shouldSyncOnStart) {
    console.log("[sync] initial load — recent messages per channel");
    await syncAllChannels(client, { incremental: true }).catch((err) =>
      console.error("[sync] startup failed:", err.message)
    );
  }

  startPolling(client);
  startOfferCleanup();
  console.log("[telegram] listening for channel posts");

  app.listen(port, () => {
    console.log(`[api] http://localhost:${port}`);
    console.log(
      "[api] GET /offers  |  GET /categories  |  GET /channels  |  POST /sync  |  GET /health"
    );
  });

  const shutdown = async (signal) => {
    console.log(`\n[shutdown] ${signal}`);
    stopPolling();
    stopOfferCleanup();
    await client.disconnect();
    await closeDb();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err.message);
  process.exit(1);
});
