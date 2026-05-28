const { getDb } = require("./db");
const { normalizeOfferLink, buildDedupeKey, buildApiOffer } = require("./parser");
const {
  collapseDuplicateOffers,
  extractDescriptionAnchors,
  getMinSubstringLength,
  normalizeImageUrl,
} = require("./dedupe");

/** Public API: return only _id, id, category, channel*, clear, createdAt. */
function toApiOffer(offer) {
  if (!offer) return null;
  return buildApiOffer(offer);
}
const { resolveLimit } = require("./pagination");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function effectiveDateField() {
  return { $ifNull: ["$postedAt", "$createdAt"] };
}

function resolveSortOrder(sort) {
  const dir = String(sort || "desc").toLowerCase() === "asc" ? 1 : -1;
  return { postedAt: dir, messageId: dir, createdAt: dir };
}

const COLLECTION = "offers";
const CHANNEL_STATE = "channel_state";

function dedupeGroupId() {
  return { $ifNull: ["$dedupeKey", dedupeGroupIdLegacy()] };
}

function dedupeGroupIdLegacy() {
  return {
    $cond: [
      {
        $and: [{ $ne: ["$offerLink", null] }, { $ne: ["$offerLink", ""] }],
      },
      { $ifNull: ["$normalizedLink", "$offerLink"] },
      "$id",
    ],
  };
}

function isDedupeEnabled(dedupe) {
  if (dedupe === false || String(dedupe).toLowerCase() === "false") {
    return false;
  }
  return String(process.env.OFFERS_DEDUPE || "true").toLowerCase() !== "false";
}

async function resolveDedupeKeyFromExisting(offer) {
  const collection = getDb().collection(COLLECTION);
  const proposed = buildDedupeKey(offer);
  const minLen = getMinSubstringLength();

  if (offer.normalizedLink) {
    const hit = await collection.findOne(
      {
        normalizedLink: offer.normalizedLink,
        id: { $ne: offer.id },
      },
      { projection: { dedupeKey: 1 } }
    );
    if (hit?.dedupeKey) return hit.dedupeKey;
  }

  const imageKey = normalizeImageUrl(offer.imageUrl);
  if (imageKey) {
    const hit = await collection.findOne(
      {
        $or: [{ imageDedupeKey: imageKey }, { imageUrl: offer.imageUrl }],
        id: { $ne: offer.id },
      },
      { projection: { dedupeKey: 1 } }
    );
    if (hit?.dedupeKey) return hit.dedupeKey;
  }

  const anchors = extractDescriptionAnchors(
    offer.description || offer.rawText || "",
    minLen
  ).slice(0, 10);

  for (const anchor of anchors) {
    const hit = await collection.findOne(
      {
        description: { $regex: escapeRegex(anchor.slice(0, 60)), $options: "i" },
        id: { $ne: offer.id },
      },
      { projection: { dedupeKey: 1 } }
    );
    if (hit?.dedupeKey) return hit.dedupeKey;
  }

  return proposed;
}

async function addOffer(offer) {
  offer.normalizedLink = normalizeOfferLink(offer.offerLink);
  offer.imageDedupeKey = normalizeImageUrl(offer.imageUrl);
  offer.dedupeKey = await resolveDedupeKeyFromExisting(offer);

  await getDb()
    .collection(COLLECTION)
    .updateOne({ id: offer.id }, { $set: offer }, { upsert: true });

  return offer;
}

function applyContentDedupe(rows, dedupeEnabled) {
  const { unique, repeated, duplicatesRemoved } = collapseDuplicateOffers(rows);

  if (dedupeEnabled) {
    return { offers: unique, duplicatesRemoved };
  }

  const repeatedById = new Map(
    repeated.map((entry) => [entry.offer.id, entry])
  );

  const offers = rows.map((row) => {
    const hit = repeatedById.get(row.id);
    if (!hit) {
      return { ...row, _repeated: false, _repeatedReason: null, _repeatedOf: null };
    }
    return {
      ...row,
      _repeated: true,
      _repeatedReason: hit.reason,
      _repeatedOf: hit.matchId,
    };
  });

  return { offers, duplicatesRemoved };
}

function buildDateRangeClause(startDate, endDate) {
  const exprParts = [];

  if (startDate) {
    const start = new Date(startDate);
    if (!Number.isNaN(start.getTime())) {
      exprParts.push({ $gte: [effectiveDateField(), start.toISOString()] });
    }
  }

  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime())) {
      exprParts.push({ $lte: [effectiveDateField(), end.toISOString()] });
    }
  }

  if (exprParts.length === 0) {
    return null;
  }

  if (exprParts.length === 1) {
    return { $expr: exprParts[0] };
  }

  return { $expr: { $and: exprParts } };
}

function buildFilter({
  platform,
  channelId,
  since,
  startDate,
  endDate,
  afterMessageId,
  name,
  category,
} = {}) {
  const clauses = [];

  if (platform) {
    clauses.push({
      platform: { $regex: new RegExp(`^${escapeRegex(platform)}$`, "i") },
    });
  }

  if (channelId) {
    clauses.push({ channelId: String(channelId) });
  }

  const rangeStart = startDate || since;
  const dateClause = buildDateRangeClause(rangeStart, endDate);
  if (dateClause) {
    clauses.push(dateClause);
  }

  if (afterMessageId) {
    const minId = Number(afterMessageId);
    if (minId > 0) {
      clauses.push({ messageId: { $gt: minId } });
    }
  }

  if (name) {
    const term = String(name).trim();
    if (term) {
      clauses.push({ name: { $regex: escapeRegex(term), $options: "i" } });
    }
  }

  if (category) {
    clauses.push({
      category: { $regex: new RegExp(`^${escapeRegex(category)}$`, "i") },
    });
  }

  if (clauses.length === 0) {
    return {};
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return { $and: clauses };
}

async function countOffersFiltered(filters = {}) {
  const { dedupe, ...queryFilters } = filters;
  const filter = buildFilter(queryFilters);

  if (!isDedupeEnabled(dedupe)) {
    return getDb().collection(COLLECTION).countDocuments(filter);
  }

  const scanLimit = Number(process.env.OFFERS_DEDUPE_SCAN_LIMIT) || 10000;
  const rows = await getDb()
    .collection(COLLECTION)
    .find(filter)
    .sort(resolveSortOrder(queryFilters.sort))
    .limit(scanLimit)
    .toArray();

  const { offers } = applyContentDedupe(rows, true);
  return offers.length;
}

async function listOffers(filters = {}) {
  const { limit, offset = 0, dedupe, sort, ...queryFilters } = filters;
  const filter = buildFilter(queryFilters);
  const max = resolveLimit(limit);
  const skip = Math.max(Number(offset) || 0, 0);
  const sortOrder = resolveSortOrder(sort);

  const dedupeEnabled = isDedupeEnabled(dedupe);
  const scanLimit = Number(process.env.OFFERS_DEDUPE_SCAN_LIMIT) || 10000;

  let rows;

  if (dedupeEnabled) {
    const pipeline = [
      { $match: filter },
      { $sort: sortOrder },
      { $group: { _id: dedupeGroupId(), doc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$doc" } },
      { $sort: sortOrder },
      { $limit: scanLimit },
    ];
    rows = await getDb().collection(COLLECTION).aggregate(pipeline).toArray();
  } else {
    let cursor = getDb()
      .collection(COLLECTION)
      .find(filter)
      .sort(sortOrder)
      .limit(scanLimit);
    rows = await cursor.toArray();
  }

  const { offers } = applyContentDedupe(rows, dedupeEnabled);
  const page = offers.slice(skip, max > 0 ? skip + max : undefined);
  return page.map(toApiOffer);
}

async function getOffer(id) {
  const offer = await getDb().collection(COLLECTION).findOne({ id });
  return toApiOffer(offer);
}

async function countOffers() {
  return getDb().collection(COLLECTION).countDocuments();
}

async function getChannelCursor(channelId) {
  const state = await getDb()
    .collection(CHANNEL_STATE)
    .findOne({ channelId: String(channelId) });

  if (state?.lastMessageId > 0) {
    return state.lastMessageId;
  }

  const doc = await getDb()
    .collection(COLLECTION)
    .find({ channelId: String(channelId) })
    .sort({ messageId: -1 })
    .limit(1)
    .project({ messageId: 1 })
    .next();

  return doc?.messageId ?? 0;
}

async function updateChannelCursor(channelId, lastMessageId, { fullSyncDone } = {}) {
  const id = String(channelId);
  const update = {
    $set: {
      channelId: id,
      syncedAt: new Date().toISOString(),
    },
    $max: { lastMessageId: Number(lastMessageId) || 0 },
  };

  if (fullSyncDone) {
    update.$set.fullSyncDone = true;
  }

  await getDb()
    .collection(CHANNEL_STATE)
    .updateOne({ channelId: id }, update, { upsert: true });
}

async function isChannelSeeded(channelId) {
  const cursor = await getChannelCursor(channelId);
  return cursor > 0;
}

function resolveRetentionDays() {
  const days = Number(process.env.OFFERS_RETENTION_DAYS);
  return days > 0 ? days : 5;
}

function buildExpiredOffersFilter(cutoffIso) {
  return {
    $expr: {
      $lt: [effectiveDateField(), cutoffIso],
    },
  };
}

async function deleteExpiredOffers() {
  const retentionDays = resolveRetentionDays();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();
  const filter = buildExpiredOffersFilter(cutoffIso);

  const collection = getDb().collection(COLLECTION);
  const expired = await collection
    .find(filter)
    .project({ imageUrl: 1 })
    .toArray();

  if (expired.length === 0) {
    return {
      deleted: 0,
      retentionDays,
      cutoff: cutoffIso,
      imageUrls: [],
    };
  }

  const result = await collection.deleteMany(filter);

  return {
    deleted: result.deletedCount,
    retentionDays,
    cutoff: cutoffIso,
    imageUrls: expired.map((offer) => offer.imageUrl).filter(Boolean),
  };
}

module.exports = {
  addOffer,
  listOffers,
  getOffer,
  countOffers,
  countOffersFiltered,
  getChannelCursor,
  updateChannelCursor,
  isChannelSeeded,
  deleteExpiredOffers,
  resolveRetentionDays,
};
