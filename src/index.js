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
const host = process.env.HOST || "0.0.0.0";

app.locals.dbReady = false;
app.locals.telegramReady = false;
app.locals.ready = false;
app.locals.startupPhase = "init";
app.locals.startupError = null;
app.locals.telegramError = null;
app.locals.telegramClient = null;

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
  const payload = {
    ok: true,
    ready: app.locals.dbReady && app.locals.telegramReady,
    dbReady: app.locals.dbReady,
    telegramReady: app.locals.telegramReady,
    phase: app.locals.startupPhase,
    error: app.locals.startupError,
    telegramError: app.locals.telegramError,
  };

  if (!app.locals.dbReady) {
    return res.status(200).json({ ...payload, status: "starting" });
  }

  try {
    return res.status(200).json({
      ...payload,
      status: app.locals.telegramReady ? "live" : "degraded",
      offersStored: await countOffers(),
    });
  } catch (err) {
    return res.status(503).json({ ...payload, ok: false, error: err.message });
  }
});

function routeNeedsTelegram(path, method) {
  return path === "/channels" || (path === "/sync" && method === "POST");
}

app.use((req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/media")) return next();

  if (!app.locals.dbReady) {
    return res.status(503).json({
      error: "Database not ready yet",
      phase: app.locals.startupPhase,
      detail: app.locals.startupError,
    });
  }

  if (routeNeedsTelegram(req.path, req.method) && !app.locals.telegramReady) {
    return res.status(503).json({
      error: "Telegram not ready yet",
      phase: app.locals.startupPhase,
      detail: app.locals.telegramError || app.locals.startupError,
    });
  }

  return next();
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

async function bootstrapMongo() {
  app.locals.startupPhase = "mongodb";
  console.log("[startup] connecting MongoDB");
  await connectDb();
  app.locals.dbReady = true;
  startOfferCleanup();
  console.log("[startup] MongoDB ready — /offers available");
}

async function bootstrapTelegram() {
  app.locals.startupPhase = "telegram";
  console.log("[startup] connecting Telegram");

  const timeoutMs =
    Number(process.env.TELEGRAM_CONNECT_TIMEOUT_MS) || 90_000;
  const client = await Promise.race([
    createClient(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Telegram connect timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);

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
  app.locals.telegramReady = true;
  app.locals.ready = true;
  app.locals.startupPhase = "live";
  console.log("[telegram] listening for channel posts");
  return client;
}

async function main() {
  installProcessErrorGuards();

  const server = app.listen(port, host, () => {
    console.log(`[api] listening on http://${host}:${port}`);
    console.log(
      "[api] GET /offers  |  GET /categories  |  GET /channels  |  POST /sync  |  GET /health"
    );
  });

  let client;
  try {
    await bootstrapMongo();
    bootstrapTelegram()
      .then((connectedClient) => {
        client = connectedClient;
      })
      .catch((err) => {
        app.locals.telegramError = err?.message || String(err);
        app.locals.startupError = app.locals.telegramError;
        app.locals.startupPhase = "telegram_failed";
        console.error("[startup] Telegram failed:", app.locals.telegramError);
        console.error(
          "[startup] API stays up for /offers; fix TELEGRAM_SESSION and restart."
        );
      });
  } catch (err) {
    app.locals.startupError = err?.message || String(err);
    app.locals.startupPhase = "mongodb_failed";
    console.error("[startup] MongoDB failed:", app.locals.startupError);
  }

  const shutdown = async (signal) => {
    console.log(`\n[shutdown] ${signal}`);
    server.close();
    stopPolling();
    stopOfferCleanup();
    if (client) await client.disconnect();
    await closeDb();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err?.stack || err?.message || err);
  process.exit(1);
});
