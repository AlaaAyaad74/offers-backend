const fs = require("fs");

const path = require("path");

const { TelegramClient } = require("telegram");

const { Api } = require("telegram/tl");

const { StringSession } = require("telegram/sessions");

const { NewMessage } = require("telegram/events");

const input = require("input");

const { parseOffersFromMessage } = require("./parser");

const {

  addOffer,

  getChannelCursor,

  updateChannelCursor,

  isChannelSeeded,

} = require("./store");

const {

  extractImageUrlsFromText,

  isDownloadableVisualMedia,

  mediaFileExtension,

  pickImageForOfferIndex,

} = require("./media");



const SESSION_FILE = path.join(__dirname, "..", "data", "session.txt");

const MEDIA_DIR = path.join(__dirname, "..", "data", "media");



function readBooleanEnv(name, defaultValue) {

  const raw = process.env[name];

  if (raw == null || raw === "") return defaultValue;

  return String(raw).toLowerCase() === "true";

}



function readNumberEnv(name, defaultValue) {

  const raw = Number(process.env[name]);

  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;

}



function sleep(ms) {

  return new Promise((resolve) => setTimeout(resolve, ms));

}



function isTransientTelegramError(err) {

  const message = String(err?.message || "").toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("not connected") ||
    message.includes("connection closed") ||
    message.includes("disconnected")
  );

}

function isAuthKeyDuplicatedError(err) {
  const message = String(err?.message || err?.errorMessage || "").toUpperCase();
  return err?.code === 406 || message.includes("AUTH_KEY_DUPLICATED");
}

function explainTelegramConnectError(err) {
  if (isAuthKeyDuplicatedError(err)) {
    return new Error(
      "Telegram AUTH_KEY_DUPLICATED: this session is already in use (often Render + local npm start). " +
        "Stop the other instance, delete data/session.txt, run npm start once to log in again, " +
        "then update TELEGRAM_SESSION on Render. Use only one running instance per session."
    );
  }
  return err;
}



function loadSessionString() {
  const sessionFromEnv = String(process.env.TELEGRAM_SESSION || "").trim();

  if (sessionFromEnv) return sessionFromEnv;

  if (!fs.existsSync(SESSION_FILE)) return "";

  return fs.readFileSync(SESSION_FILE, "utf8").trim();

}



function saveSession(client) {
  if (String(process.env.TELEGRAM_SESSION || "").trim()) return;

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });

  fs.writeFileSync(SESSION_FILE, client.session.save(), "utf8");

}



function getConfig() {

  const apiId = Number(process.env.API_ID);

  const apiHash = process.env.API_HASH;



  if (!apiId || !apiHash) {

    throw new Error(

      "API_ID and API_HASH are required. Copy .env.example to .env and set values from https://my.telegram.org"

    );

  }



  return { apiId, apiHash };

}



function normalizeChannelId(chat) {

  if (!chat?.id) return "unknown";

  const id = String(chat.id);

  if (id.startsWith("-100")) return id;

  return `-100${id}`;

}



function toParserMessage(message, chat) {

  return {

    caption: message.message,

    text: message.message,

    chat: {

      id: normalizeChannelId(chat),

      title: chat?.title,

      username: chat?.username,

    },

    message_id: message.id,

  };

}



function hasContent(message) {

  const text = (message.message || "").trim();

  return Boolean(text || message.media);

}



function isOfferChannel(entity) {

  return entity instanceof Api.Channel && !entity.megagroup;

}



async function listJoinedChannels(client) {

  const seen = new Set();

  const channels = [];



  for (const folder of [0, 1]) {

    const dialogs = await client.getDialogs({ folder, limit: undefined });



    for (const dialog of dialogs) {

      const entity = dialog.entity;

      if (!isOfferChannel(entity)) continue;



      const id = normalizeChannelId(entity);

      if (seen.has(id)) continue;

      seen.add(id);



      channels.push({

        id,

        title: dialog.title || entity.title,

        username: entity.username || null,

      });

    }

  }



  return channels;

}



async function saveMessageVisualMedia(client, message, chat, { mediaIndex = 0 } = {}) {

  const chatId = normalizeChannelId(chat) || "unknown";

  const ext = mediaFileExtension(message);

  const suffix = mediaIndex > 0 ? `_${mediaIndex}` : "";

  const filename = `${chatId}_${message.id}${suffix}${ext}`;

  const filepath = path.join(MEDIA_DIR, filename);

  const publicPath = `/media/${filename}`;



  if (fs.existsSync(filepath)) {

    return publicPath;

  }



  let buffer = null;
  const maxAttempts = readNumberEnv("TELEGRAM_DOWNLOAD_ATTEMPTS", 3);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      buffer = await client.downloadMedia(message, {});
      break;
    } catch (err) {
      const shouldRetry = isTransientTelegramError(err) && attempt < maxAttempts;
      if (!shouldRetry) throw err;
      await sleep(250 * attempt);
    }
  }

  if (!buffer || buffer.length === 0) return null;



  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  fs.writeFileSync(filepath, buffer);

  return publicPath;

}



/**

 * Collect all image sources for a channel post: downloaded file + URLs in text.

 */

async function extractMessageImages(client, message, chat, { downloadMedia = true } = {}) {

  const text = (message.message || "").trim();

  const textUrls = extractImageUrlsFromText(text);

  const imageUrls = [...textUrls];



  if (downloadMedia && isDownloadableVisualMedia(message)) {

    try {

      const localPath = await saveMessageVisualMedia(client, message, chat);

      if (localPath) {

        imageUrls.unshift(localPath);

      }

    } catch (err) {

      console.error(

        `[media] ${normalizeChannelId(chat)} #${message.id}:`,

        err.message

      );

    }

  }



  return [...new Set(imageUrls)];

}



async function processChannelMessage(client, message, chat, { downloadMedia = true } = {}) {

  if (!hasContent(message)) return [];



  const mediaType = message.media?.className || null;

  const imageUrls = await extractMessageImages(client, message, chat, {

    downloadMedia,

  });



  const postedAt = message.date

    ? new Date(message.date * 1000).toISOString()

    : null;



  const offers = parseOffersFromMessage(toParserMessage(message, chat), {

    imageUrls,

    mediaType,

    postedAt,

  });



  for (const offer of offers) {

    await addOffer(offer);

  }



  return offers;

}



async function fetchMessagesSince(client, entity, channelId, { sinceId, limit, downloadMedia }) {

  const chat = await client.getEntity(entity);

  let scanned = 0;

  let saved = 0;

  let maxId = sinceId || 0;



  const iterOptions = { minId: sinceId || 0 };

  if (limit && limit > 0) {

    iterOptions.limit = limit;

  }



  for await (const message of client.iterMessages(chat, iterOptions)) {

    if (message.id <= sinceId) continue;



    scanned += 1;

    maxId = Math.max(maxId, message.id);

    const offers = await processChannelMessage(client, message, chat, { downloadMedia });

    saved += offers.length;

  }



  if (maxId > sinceId) {

    await updateChannelCursor(channelId, maxId);

  }



  return { channelId, title: chat.title, scanned, saved, latestId: maxId };

}



let syncInProgress = false;



function mediaDownloadEnabled(flagName, defaultValue = true) {

  return readBooleanEnv(flagName, defaultValue);

}



async function syncAllChannels(client, { limitPerChannel, incremental, full, downloadMedia } = {}) {

  if (syncInProgress) {

    throw new Error("Sync already in progress");

  }



  const saveMedia =

    downloadMedia ?? mediaDownloadEnabled("DOWNLOAD_MEDIA_ON_SYNC", true);



  syncInProgress = true;

  const startedAt = Date.now();

  const results = [];



  try {

    const channels = await listJoinedChannels(client);

  const mode = full ? "full history" : incremental ? "new only" : "recent batch";

    console.log(`[sync] ${channels.length} channel(s) — ${mode}${saveMedia ? " + media" : ""}`);



    for (const channel of channels) {

      try {

        const entity = await client.getEntity(channel.id);

        const cursor = await getChannelCursor(channel.id);



        let sinceId = cursor;

        let limit = limitPerChannel;



        if (full) {

          sinceId = 0;

          limit = undefined;

        } else if (incremental && cursor > 0) {

          sinceId = cursor;

          limit = limit || Number(process.env.POLL_BATCH_SIZE) || 20;

        } else {

          sinceId = 0;

          limit = limit || Number(process.env.SYNC_RECENT_PER_CHANNEL) || 100;

        }



        const result = await fetchMessagesSince(client, entity, channel.id, {

          sinceId,

          limit,

          downloadMedia: saveMedia,

        });



        if (full && result.latestId > 0) {

          await updateChannelCursor(channel.id, result.latestId, { fullSyncDone: true });

        }



        results.push(result);

        console.log(`[sync] ${result.title}: +${result.saved} offers`);

      } catch (err) {

        console.error(`[sync] failed ${channel.title}:`, err.message);

        results.push({ channelId: channel.id, title: channel.title, error: err.message });

      }

    }



    const saved = results.reduce((n, r) => n + (r.saved || 0), 0);

    const scanned = results.reduce((n, r) => n + (r.scanned || 0), 0);



    return {

      channels: channels.length,

      scanned,

      saved,

      durationMs: Date.now() - startedAt,

      results,

    };

  } finally {

    syncInProgress = false;

  }

}



function isSyncInProgress() {

  return syncInProgress;

}



async function createClient() {

  const { apiId, apiHash } = getConfig();

  const session = new StringSession(loadSessionString());

  const client = new TelegramClient(session, apiId, apiHash, {

    connectionRetries: readNumberEnv("TELEGRAM_CONNECTION_RETRIES", 20),

    reconnectRetries: readNumberEnv("TELEGRAM_RECONNECT_RETRIES", 20),

    requestRetries: readNumberEnv("TELEGRAM_REQUEST_RETRIES", 10),

    downloadRetries: readNumberEnv("TELEGRAM_DOWNLOAD_RETRIES", 10),

    retryDelay: readNumberEnv("TELEGRAM_RETRY_DELAY_MS", 1500),

    autoReconnect: readBooleanEnv("TELEGRAM_AUTO_RECONNECT", true),

    useWSS: readBooleanEnv("TELEGRAM_USE_WSS", true),

  });

  client.setLogLevel(process.env.TELEGRAM_LOG_LEVEL || "warn");

  client.onError = async (error) => {

    if (isTransientTelegramError(error)) {

      console.warn(`[telegram] transient network issue: ${error.message}`);

      return;

    }

    if (isAuthKeyDuplicatedError(error)) {
      console.error(
        "[telegram] AUTH_KEY_DUPLICATED — stop Render (or local dev), reset session, use one instance only."
      );
      return;
    }

    console.error("[telegram] client error:", error.message);

  };



  try {
    await client.connect();
  } catch (err) {
    throw explainTelegramConnectError(err);
  }



  if (!(await client.isUserAuthorized())) {
    const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);

    if (!isInteractiveTerminal) {
      throw new Error(
        "Telegram session is missing. In non-interactive environments (like Render), set TELEGRAM_SESSION to a previously saved StringSession."
      );
    }

    console.log("[telegram] First run: log in with your Telegram account.");



    await client.start({

      phoneNumber: async () =>

        input.text("Phone (with country code, e.g. +201234567890): "),

      password: async () =>

        input.text("2FA password (leave empty if you do not use 2FA): "),

      phoneCode: async () => input.text("Code from Telegram app/SMS: "),

      onError: (err) => console.error("[telegram] login error:", err),

    });



    saveSession(client);

    console.log("[telegram] Session saved to data/session.txt");

  }



  await client.getMe();

  return client;

}



async function pollRecentMessages(client) {

  if (syncInProgress) return 0;



  const channels = await listJoinedChannels(client);

  let saved = 0;

  const downloadMedia = mediaDownloadEnabled("DOWNLOAD_MEDIA_ON_POLL", true);

  const pollLimit = Number(process.env.POLL_BATCH_SIZE) || 20;



  for (const channel of channels) {

    try {

      const entity = await client.getEntity(channel.id);
      const seeded = await isChannelSeeded(channel.id);
      const cursor = await getChannelCursor(channel.id);

      const result = await fetchMessagesSince(client, entity, channel.id, {
        sinceId: seeded ? cursor : 0,
        limit: seeded
          ? pollLimit
          : Number(process.env.SYNC_RECENT_PER_CHANNEL) || 100,
        downloadMedia,
      });



      saved += result.saved;

      for (let i = 0; i < result.saved; i += 1) {

        // logged inside sync when saved > 0

      }

      if (result.saved > 0) {

        console.log(`[poll] ${result.title}: +${result.saved} new offer(s)`);

      }

    } catch (err) {

      console.error(`[poll] ${channel.title}:`, err.message);

    }

  }



  return saved;

}



let pollTimer;

let pollRunning = false;



function startPolling(client) {

  const intervalSec = Number(process.env.POLL_INTERVAL_SEC) || 30;



  const run = async () => {

    if (pollRunning || syncInProgress) return;

    pollRunning = true;

    try {

      await pollRecentMessages(client);

    } catch (err) {

      console.error("[poll] error:", err.message);

    } finally {

      pollRunning = false;

    }

  };



  pollTimer = setInterval(run, intervalSec * 1000);
  run().catch((err) => console.error("[poll] initial run failed:", err.message));

  console.log(
    `[poll] every ${intervalSec}s — new messages only (runs immediately on start)`
  );
}



function stopPolling() {

  if (pollTimer) {

    clearInterval(pollTimer);

    pollTimer = undefined;

  }

}



function listenToChannels(client) {

  client.addEventHandler(

    async (event) => {

      try {

        if (syncInProgress) return;



        const message = event.message;

        if (!message?.isChannel) return;



        const chat = await message.getChat();

        if (!chat || !isOfferChannel(chat)) return;



        const channelId = normalizeChannelId(chat);

        const cursor = await getChannelCursor(channelId);

        if (message.id <= cursor) return;



        const offers = await processChannelMessage(client, message, chat, {

          downloadMedia: true,

        });



        await updateChannelCursor(channelId, message.id);

        if (offers.length > 0) {
          console.log(
            `[live] ${offers[0].channelTitle}: #${message.id} (+${offers.length})`
          );
        }

      } catch (err) {

        console.error("[live] handler error:", err.message);

      }

    },

    new NewMessage({ incoming: true })

  );

}



function getMediaDir() {

  return MEDIA_DIR;

}

/** Re-download a channel photo from Telegram when missing on disk (e.g. after Render redeploy). */
async function ensureMediaFile(client, filename) {
  const safeName = path.basename(String(filename || ""));
  if (!safeName) return null;

  const filepath = path.join(MEDIA_DIR, safeName);
  if (fs.existsSync(filepath)) return filepath;

  const match = safeName.match(/^(-100\d+)_(\d+)(?:_(\d+))?\.[a-z0-9]+$/i);
  if (!match) return null;

  const channelId = match[1];
  const messageId = Number(match[2]);
  const mediaIndex = match[3] ? Number(match[3]) : 0;

  const entity = await client.getEntity(channelId);
  const messages = await client.getMessages(entity, { ids: [messageId] });
  const message = messages?.[0];
  if (!message) return null;

  const chat = await message.getChat();
  await saveMessageVisualMedia(client, message, chat, { mediaIndex });

  return fs.existsSync(filepath) ? filepath : null;
}



module.exports = {

  createClient,

  listenToChannels,

  startPolling,

  stopPolling,

  pollRecentMessages,

  getMediaDir,
  ensureMediaFile,

  listJoinedChannels,

  syncAllChannels,

  isSyncInProgress,

  extractMessageImages,

  processChannelMessage,

  normalizeChannelId,

};


