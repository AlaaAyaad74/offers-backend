const crypto = require("crypto");

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

function getMinSubstringLength() {
  const n = Number(process.env.OFFERS_DEDUPE_MIN_SUBSTRING);
  return n > 0 ? Math.floor(n) : 16;
}

function normalizeDescriptionForDedupe(text) {
  if (!text) return "";

  return String(text)
    .replace(URL_REGEX, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeImageUrl(url) {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;

  if (raw.startsWith("/media/")) {
    return raw.split("?")[0].toLowerCase();
  }

  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return raw.split("?")[0].toLowerCase();
  }
}

/** Word-boundary phrase anchors (min length) for substring duplicate detection. */
function extractDescriptionAnchors(text, minLen = getMinSubstringLength()) {
  const normalized = normalizeDescriptionForDedupe(text);
  if (normalized.length < minLen) return [];

  const anchors = new Set();

  if (normalized.length <= 120) {
    anchors.add(normalized);
  }

  for (const line of String(text || "").split("\n")) {
    const lineNorm = normalizeDescriptionForDedupe(line);
    if (lineNorm.length >= minLen) {
      anchors.add(lineNorm.length > 100 ? lineNorm.slice(0, 100) : lineNorm);
    }
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  let chunk = "";

  for (const word of words) {
    chunk = chunk ? `${chunk} ${word}` : word;
    while (chunk.length >= minLen) {
      anchors.add(chunk.slice(0, 100));
      const space = chunk.indexOf(" ");
      if (space === -1) break;
      chunk = chunk.slice(space + 1).trim();
    }
  }

  return [...anchors].filter((a) => a.length >= minLen);
}

function hashToken(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 20);
}

function buildDescriptionDedupeKey(text, minLen = getMinSubstringLength()) {
  const anchors = extractDescriptionAnchors(text, minLen);
  if (!anchors.length) return null;
  const canonical = anchors.sort((a, b) => a.localeCompare(b))[0];
  return `desc:${hashToken(canonical)}`;
}

function hasSharedDescriptionSubstring(aText, bText, minLen = getMinSubstringLength()) {
  const a = normalizeDescriptionForDedupe(aText);
  const b = normalizeDescriptionForDedupe(bText);
  if (!a || !b || a.length < minLen || b.length < minLen) return false;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  const anchors = extractDescriptionAnchors(shorter, minLen);
  for (const anchor of anchors) {
    if (longer.includes(anchor)) return true;
  }

  return false;
}

function duplicateReason(offerA, offerB, minLen = getMinSubstringLength()) {
  const linkA = offerA.normalizedLink || offerA.offerLink;
  const linkB = offerB.normalizedLink || offerB.offerLink;

  if (linkA && linkB && linkA === linkB) {
    return "link";
  }

  const imageA = normalizeImageUrl(offerA.imageUrl || offerA.clear?.image);
  const imageB = normalizeImageUrl(offerB.imageUrl || offerB.clear?.image);

  if (imageA && imageB && imageA === imageB) {
    return "image";
  }

  const descA = offerA.description || offerA.clear?.description || offerA.rawText;
  const descB = offerB.description || offerB.clear?.description || offerB.rawText;

  if (hasSharedDescriptionSubstring(descA, descB, minLen)) {
    return "description";
  }

  return null;
}

function areDuplicateOffers(offerA, offerB, minLen = getMinSubstringLength()) {
  return duplicateReason(offerA, offerB, minLen) != null;
}

/**
 * Collapse duplicates in sort order; first occurrence wins.
 * Returns { unique, repeated, duplicatesRemoved }.
 */
function collapseDuplicateOffers(offers, { minLen = getMinSubstringLength() } = {}) {
  const unique = [];
  const repeated = [];
  const representatives = [];

  for (const offer of offers) {
    let reason = null;
    let matchId = null;

    for (const rep of representatives) {
      reason = duplicateReason(offer, rep, minLen);
      if (reason) {
        matchId = rep.id;
        break;
      }
    }

    if (reason) {
      repeated.push({
        offer: { ...offer, _repeated: true, _repeatedReason: reason, _repeatedOf: matchId },
        reason,
        matchId,
      });
    } else {
      representatives.push(offer);
      unique.push({ ...offer, _repeated: false, _repeatedReason: null });
    }
  }

  return {
    unique,
    repeated,
    duplicatesRemoved: repeated.length,
  };
}

module.exports = {
  getMinSubstringLength,
  normalizeDescriptionForDedupe,
  normalizeImageUrl,
  extractDescriptionAnchors,
  buildDescriptionDedupeKey,
  hasSharedDescriptionSubstring,
  duplicateReason,
  areDuplicateOffers,
  collapseDuplicateOffers,
  hashToken,
};
