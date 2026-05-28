const {
  detectCategory,
  normalizeCategorySlug,
  toCategoryObject,
} = require("./categories");
const {
  extractImageUrlsFromText,
  filterPublicImageUrls,
  isLocalMediaPath,
  pickImageForOfferIndex,
  resolveOfferImageForApi,
} = require("./media");
const {
  buildDescriptionDedupeKey,
  normalizeImageUrl,
} = require("./dedupe");

const PLATFORM_MAP = {
  "amazon.com": "amazon",
  "amzn.to": "amazon",
  "amzn.eu": "amazon",
  "amazon.eg": "amazon",
  "aliexpress.com": "aliexpress",
  "s.click.aliexpress.com": "aliexpress",
  "temu.com": "temu",
  "ebay.com": "ebay",
  "noon.com": "noon",
  "shein.com": "shein",
  "jumia.com": "jumia",
  "walmart.com": "walmart",
  "flipkart.com": "flipkart",
  "3rrood.com": "3rrood",
};

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function detectPlatform(url) {
  const host = hostname(url);
  if (!host) return "unknown";

  for (const [domain, platform] of Object.entries(PLATFORM_MAP)) {
    if (host.includes(domain)) return platform;
  }

  const parts = host.split(".");
  return parts.length >= 2 ? parts[parts.length - 2] : host;
}

function stripUrls(text) {
  return text.replace(URL_REGEX, "").trim();
}

/** Same product URL with different affiliate tags → one dedupe key. */
function normalizeOfferLink(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();

    const amazonAsin =
      parsed.pathname.match(
        /\/(?:dp|gp\/product|exec\/obidos\/asin)\/([A-Z0-9]{10})/i
      )?.[1] || parsed.searchParams.get("asin");

    if (amazonAsin || host.includes("amazon.") || host.includes("amzn.")) {
      if (amazonAsin) return `amazon:${amazonAsin.toUpperCase()}`;
    }

    const aliId = parsed.pathname.match(/\/item\/(\d+)\.html/i);
    if (aliId || host.includes("aliexpress.")) {
      if (aliId) return `aliexpress:${aliId[1]}`;
    }

    if (host.includes("noon.com")) {
      const path = parsed.pathname.replace(/\/$/, "").toLowerCase();
      return `noon:${path}`;
    }

    return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const SHORT_LINK_HOSTS =
  /(?:^|\.)amzn\.to$|(?:^|\.)amazn\.im$|shortlink\.|bit\.ly$|t\.co$/i;

function isShortOfferLink(url) {
  if (!url) return false;
  try {
    const host = new URL(url.trim()).hostname.replace(/^www\./i, "").toLowerCase();
    return SHORT_LINK_HOSTS.test(host);
  } catch {
    return false;
  }
}

function extractAsinFromText(text) {
  if (!text) return null;
  const match = text.match(
    /amazon\.[a-z.]+\/(?:dp|gp\/product|exec\/obidos\/asin)\/([A-Z0-9]{10})/i
  );
  return match ? match[1].toUpperCase() : null;
}

const GENERIC_OFFER_NAMES =
  /^(offer|لينك|اشتري|للشراء|link|buy|shop|عرض|خصم|تخفيض)/i;

/** Channel WhatsApp promo — stripped from descriptions and product text. */
const WHATSAPP_PROMO_INLINE = [
  /(?:قناتنا|قناةنا|قنواتنا)\s+على\s+(?:ال)?واتس(?:اب|اب)\s*(?:\([^)]*(?:اضغط|انضمام|للانضمام)[^)]*\))?/gi,
  /\(?\s*اضغط\s+هنا\s+للانضمام\s*\)?/gi,
  /اضغط\s+هنا\s+للانضمام/gi,
];

function isWhatsAppPromoLine(line) {
  const normalized = String(line || "").trim();
  if (!normalized) return false;

  if (
    /(?:قناتنا|قناةنا|قنواتنا)/i.test(normalized) &&
    /واتس/i.test(normalized)
  ) {
    return true;
  }

  if (/اضغط\s+هنا\s+للانضمام/i.test(normalized)) {
    return true;
  }

  return false;
}

function stripWhatsAppPromoText(text) {
  if (!text) return "";

  let result = String(text);
  for (const pattern of WHATSAPP_PROMO_INLINE) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, " ");
  }

  return result
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNameForDedupe(name) {
  let normalized = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/السعر\s*[:：]?\s*[\d.,]+/gi, "")
    .replace(/بسعر\s*[\d.,]+/gi, "")
    .replace(/[\d.,]+\s*(?:جنيه|ج\.?|egp|usd|\$|sar|ريال)/gi, "")
    .replace(/[!🔥⚡️👇🏻👇]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length < 12) return null;
  if (GENERIC_OFFER_NAMES.test(normalized)) return null;
  if (/^(?:جنيه|فقط|عرض|لقط)/i.test(normalized)) return null;
  return normalized.slice(0, 120);
}

function pickProductTitle(offer) {
  const lines = String(offer.description || offer.rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/https?:\/\//i.test(line)) continue;
    if (/^(لقط|متنساش|تابعنا|⚡️|اشتري|للشراء|لينك)/i.test(line)) continue;
    if (isWhatsAppPromoLine(line)) continue;

    const cleaned = stripUrls(line)
      .replace(/بسعر\s*[\d.,]+/gi, "")
      .replace(/[\d.,]+\s*(?:جنيه|ج\.?|egp)/gi, "")
      .replace(/[!🔥⚡️👇🏻👇]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    if (cleaned.length >= 15) {
      return cleaned.slice(0, 120);
    }
  }

  return null;
}

/** Stable key so the same product appears once in API responses. */
function buildDedupeKey(offer) {
  const text = `${offer.description || ""}\n${offer.rawText || ""}\n${offer.offerLink || ""}`;
  const asinFromText = extractAsinFromText(text);
  if (asinFromText) {
    return `amazon:${asinFromText}`;
  }

  const normalizedLink =
    offer.normalizedLink || normalizeOfferLink(offer.offerLink);

  if (normalizedLink && /^(amazon:|aliexpress:|noon:)/.test(normalizedLink)) {
    return normalizedLink;
  }

  if (
    normalizedLink &&
    offer.offerLink &&
    !isShortOfferLink(offer.offerLink)
  ) {
    return normalizedLink;
  }

  const imageKey = normalizeImageUrl(offer.imageUrl);
  if (imageKey) {
    return `img:${imageKey}`;
  }

  const descKey = buildDescriptionDedupeKey(
    offer.description || offer.rawText || offer.name || ""
  );
  if (descKey) {
    return descKey;
  }

  const nameKey =
    normalizeNameForDedupe(offer.name) || pickProductTitle(offer);
  const platform = offer.platform || "unknown";

  if (nameKey && offer.price != null) {
    return `${platform}:name:${nameKey}:${offer.price}`;
  }

  if (nameKey) {
    return `${platform}:name:${nameKey}`;
  }

  if (normalizedLink && offer.offerLink) {
    return normalizedLink;
  }

  return offer.id;
}

function findNameForUrl(text, url) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const urlLineIndex = lines.findIndex((line) => line.includes(url));

  if (urlLineIndex > 0) {
    for (let i = urlLineIndex - 1; i >= 0; i -= 1) {
      const candidate = stripUrls(lines[i]);
      if (candidate) return candidate;
    }
  }

  if (urlLineIndex >= 0) {
    return stripUrls(lines[urlLineIndex]) || text.slice(0, 80);
  }

  return text.slice(0, 80);
}

const PRICE_PATTERNS = [
  /السعر\s*الآن\s*[:：]?\s*([\d.,]+)/i,
  /السعر\s*[:：]\s*([\d.,]+)/i,
  /بسعر\s*([\d.,]+)/i,
  /(?:^|\s)بـ\s*([\d.,]+)\s*(?:جنيه|ج\.?|EGP)/i,
  /سعر\s*([\d.,]+)\s*(?:جنيه|ج\.?|EGP)?/i,
  /([\d.,]+)\s*(?:جنيه\s*مصري|جنيه|EGP|ج\.?)(?:\s|$|[!،,.])/i,
  /(?:USD|\$)\s*([\d.,]+)/i,
  /([\d.,]+)\s*USD/i,
  /(?:SAR|ريال)\s*([\d.,]+)/i,
  /([\d.,]+)\s*(?:SAR|ريال)/i,
];

function parsePriceAmount(raw) {
  const amount = parseFloat(String(raw).replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function detectCurrency(text, matchedLine = "") {
  const sample = `${text} ${matchedLine}`;
  if (/(?:USD|\$)/i.test(sample)) return "USD";
  if (/(?:SAR|ريال)/i.test(sample)) return "SAR";
  if (/(?:AED|درهم)/i.test(sample)) return "AED";
  return "EGP";
}

function extractPrice(text) {
  if (!text) return null;

  for (const pattern of PRICE_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    const amount = parsePriceAmount(match[1]);
    if (amount !== null) {
      return {
        amount,
        currency: detectCurrency(text, match[0]),
      };
    }
  }

  return null;
}

const SALE_PERCENT_PATTERNS = [
  /(?:خصم|تخفيض|off|discount)\s*[:：]?\s*(\d{1,3})\s*%/i,
  /(\d{1,3})\s*%\s*(?:off|خصم|تخفيض|discount)/i,
  /(\d{1,3})\s*%\s*(?:today|اليوم|limited|لفترة)?/i,
  /save\s*(\d{1,3})\s*%/i,
  /وفر\s*(\d{1,3})\s*%/i,
];

function parseSalePercentValue(raw) {
  if (raw == null || raw === "") return null;
  const text = String(raw).trim();
  const match = text.match(/(\d{1,3})\s*%?/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return value > 0 && value <= 100 ? value : null;
}

function extractSalePercent(text) {
  if (!text) return null;

  for (const pattern of SALE_PERCENT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = parseSalePercentValue(match[1]);
    if (value !== null) return value;
  }

  return null;
}

function pickJsonField(obj, keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  return null;
}

function normalizeJsonOfferFields(obj) {
  if (!obj || typeof obj !== "object") return null;

  const record = Array.isArray(obj) ? obj[0] : obj;
  if (!record || typeof record !== "object") return null;

  const nested =
    record.product || record.offer || record.data || record.item || null;
  const source =
    nested && typeof nested === "object" ? { ...record, ...nested } : record;

  const priceRaw = pickJsonField(source, [
    "price",
    "amount",
    "cost",
    "salePrice",
    "sale_price",
  ]);
  const priceInfo =
    typeof priceRaw === "number"
      ? { amount: priceRaw, currency: null }
      : extractPrice(String(priceRaw || ""));

  const platformRaw = pickJsonField(source, [
    "platform",
    "platform_that_produce_offer",
    "store",
    "shop",
    "marketplace",
  ]);

  return {
    image: pickJsonField(source, [
      "image",
      "imageUrl",
      "image_url",
      "img",
      "photo",
      "thumbnail",
    ]),
    buyLink: pickJsonField(source, [
      "buyLink",
      "buy_link",
      "buylink",
      "link",
      "url",
      "offerLink",
      "offer_link",
    ]),
    description: pickJsonField(source, [
      "description",
      "desc",
      "text",
      "caption",
      "title",
      "name",
    ]),
    price: priceInfo?.amount ?? parsePriceAmount(priceRaw),
    currency: pickJsonField(source, ["currency"]) || priceInfo?.currency || null,
    salePercent: parseSalePercentValue(
      pickJsonField(source, [
        "salePercent",
        "sale_percent",
        "salePercentage",
        "discount",
        "discountPercent",
        "discount_percent",
        "off",
      ])
    ),
    platform: platformRaw ? String(platformRaw).toLowerCase().trim() : null,
    category: pickJsonField(source, [
      "category",
      "productCategory",
      "product_category",
      "type",
    ]),
  };
}

function tryExtractFromJson(text) {
  if (!text || !/[{[]/.test(text)) return null;

  const candidates = [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      const normalized = normalizeJsonOfferFields(parsed);
      if (normalized) return normalized;
    } catch {
      // try next candidate
    }
  }

  return null;
}

function cleanDescription(text, { offerLink, price, salePercent } = {}) {
  if (!text) return "";

  const stripped = stripWhatsAppPromoText(text);

  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (isWhatsAppPromoLine(line)) return false;
      if (URL_REGEX.test(line) && stripUrls(line) === "") return false;
      if (offerLink && line.includes(offerLink)) return false;
      if (price != null && PRICE_PATTERNS.some((pattern) => pattern.test(line))) {
        return false;
      }
      if (
        salePercent != null &&
        SALE_PERCENT_PATTERNS.some((pattern) => pattern.test(line))
      ) {
        return false;
      }
      if (/^(لقط|متنساش|تابعنا|اشتري|للشراء|لينك|link|buy|shop)/i.test(line)) {
        return false;
      }
      return true;
    })
    .map((line) => stripWhatsAppPromoText(stripUrls(line)).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const cleaned = lines.join("\n").trim();
  const fallback = stripWhatsAppPromoText(
    stripUrls(stripped).replace(/\s+/g, " ").trim()
  );
  return cleaned || fallback;
}

/** Nested product fields stored on the offer document. */
function buildClearPayload(offer) {
  const buyLink = offer.offerLink || null;
  const imageUrl = resolveOfferImageForApi(offer);
  const category = toCategoryObject(offer.category);

  return {
    image: imageUrl || null,
    buyLink,
    description: offer.description || null,
    price: offer.price ?? null,
    currency: offer.currency ?? null,
    salePercent: offer.salePercent ?? null,
    platform: offer.platform || "unknown",
    category,
  };
}

/** API response shape — only these fields are returned from GET /offers. */
function buildApiOffer(offer) {
  const category = toCategoryObject(offer.category);

  return {
    _id: offer._id != null ? String(offer._id) : null,
    id: offer.id || null,
    category,
    channelId: offer.channelId || null,
    channelTitle: offer.channelTitle || null,
    clear: buildClearPayload(offer),
    createdAt: offer.createdAt || offer.postedAt || null,
    repeated: Boolean(offer._repeated),
    repeatedReason: offer._repeatedReason || null,
    repeatedOf: offer._repeatedOf || null,
  };
}

function resolveOfferImageUrl({ imageUrls, imageUrl, jsonImage, text, index }) {
  if (jsonImage && /^https?:\/\//i.test(jsonImage)) return jsonImage;

  const publicList = filterPublicImageUrls(imageUrls);
  const fromList = pickImageForOfferIndex(publicList, index);
  if (fromList) return fromList;

  if (imageUrl && !isLocalMediaPath(imageUrl)) return imageUrl;

  const fromText = pickImageForOfferIndex(extractImageUrlsFromText(text), index);
  return fromText || null;
}

function buildOffer(
  msg,
  { imageUrls, imageUrl, mediaType, postedAt, offerLink, name, index = 0 } = {}
) {
  const text = (msg.caption || msg.text || "").trim();
  const jsonData = tryExtractFromJson(text);
  const priceInfo = extractPrice(text);
  let salePercent = extractSalePercent(text);

  let resolvedOfferLink = offerLink ?? jsonData?.buyLink ?? null;
  let resolvedImageUrl = resolveOfferImageUrl({
    imageUrls,
    imageUrl,
    jsonImage: jsonData?.image,
    text,
    index,
  });
  let price = priceInfo?.amount ?? null;
  let currency = priceInfo?.currency ?? null;

  if (jsonData) {
    if (jsonData.buyLink) resolvedOfferLink = jsonData.buyLink;
    if (jsonData.image) resolvedImageUrl = jsonData.image;
    if (jsonData.price != null) price = jsonData.price;
    if (jsonData.currency) currency = jsonData.currency;
    if (jsonData.salePercent != null) salePercent = jsonData.salePercent;
  }

  const platform = jsonData?.platform
    ? jsonData.platform
    : resolvedOfferLink
      ? detectPlatform(resolvedOfferLink)
      : "unknown";

  const suffix = index > 0 ? `_${index}` : "";
  const resolvedName = stripWhatsAppPromoText(
    name ||
      (jsonData?.description
        ? String(jsonData.description).slice(0, 80)
        : null) ||
      text.slice(0, 80) ||
      "Offer"
  ) || "Offer";

  const description = cleanDescription(
    jsonData?.description ? String(jsonData.description) : text,
    { offerLink: resolvedOfferLink, price, salePercent }
  );

  const categorySlug = jsonData?.category
    ? normalizeCategorySlug(jsonData.category)
    : detectCategory(`${resolvedName}\n${text}`);

  const offer = {
    id: `${msg.chat.id}_${msg.message_id}${suffix}`,
    name: resolvedName,
    description,
    rawText: text,
    category: categorySlug,
    price,
    currency,
    salePercent: salePercent ?? null,
    imageUrl: resolvedImageUrl || null,
    mediaType: mediaType || null,
    offerLink: resolvedOfferLink,
    platform,
    channelId: String(msg.chat.id),
    channelTitle: msg.chat.title || msg.chat.username || "unknown",
    messageId: msg.message_id,
    offerIndex: index,
    postedAt: postedAt || null,
    createdAt: new Date().toISOString(),
  };

  offer.normalizedLink = normalizeOfferLink(offer.offerLink);
  offer.dedupeKey = buildDedupeKey(offer);
  offer.clear = buildClearPayload(offer);
  return offer;
}

/** Recompute parsed fields for a stored offer (backfill / migrations). */
function enrichStoredOffer(offer) {
  const text = offer.rawText || offer.description || "";
  const jsonData = tryExtractFromJson(text);
  const priceInfo = extractPrice(text);
  let salePercent = extractSalePercent(text);

  let offerLink = offer.offerLink ?? jsonData?.buyLink ?? null;
  let imageUrl =
    offer.imageUrl ||
    jsonData?.image ||
    pickImageForOfferIndex(extractImageUrlsFromText(text), offer.offerIndex || 0) ||
    null;
  let price = priceInfo?.amount ?? offer.price ?? null;
  let currency = priceInfo?.currency ?? offer.currency ?? null;

  if (jsonData) {
    if (jsonData.buyLink) offerLink = jsonData.buyLink;
    if (jsonData.image) imageUrl = jsonData.image;
    if (jsonData.price != null) price = jsonData.price;
    if (jsonData.currency) currency = jsonData.currency;
    if (jsonData.salePercent != null) salePercent = jsonData.salePercent;
  }

  const platform = jsonData?.platform
    ? jsonData.platform
    : offerLink
      ? detectPlatform(offerLink)
      : offer.platform || "unknown";

  const description = cleanDescription(
    jsonData?.description ? String(jsonData.description) : text,
    { offerLink, price, salePercent }
  );

  const categorySlug = jsonData?.category
    ? normalizeCategorySlug(jsonData.category)
    : detectCategory(`${offer.name || ""}\n${text}`);

  const enriched = {
    ...offer,
    description,
    price,
    currency,
    salePercent: salePercent ?? null,
    imageUrl: imageUrl || null,
    offerLink,
    platform,
    category: categorySlug,
  };

  enriched.imageUrl = resolveOfferImageForApi(enriched);
  enriched.normalizedLink = normalizeOfferLink(enriched.offerLink);
  enriched.dedupeKey = buildDedupeKey(enriched);
  enriched.clear = buildClearPayload(enriched);
  return enriched;
}

/** One Telegram post may contain several product links — return one offer per link. */
function parseOffersFromMessage(msg, { imageUrls, imageUrl, mediaType, postedAt } = {}) {
  const text = (msg.caption || msg.text || "").trim();
  const urls = [...new Set(text.match(URL_REGEX) || [])];
  const allImages =
    imageUrls?.length > 0
      ? imageUrls
      : imageUrl
        ? [imageUrl]
        : extractImageUrlsFromText(text);

  if (urls.length === 0) {
    return [
      buildOffer(msg, {
        imageUrls: allImages,
        imageUrl: allImages[0] || null,
        mediaType,
        postedAt,
        offerLink: null,
        name: text.slice(0, 80) || "Offer",
      }),
    ];
  }

  return urls.map((url, index) =>
    buildOffer(msg, {
      imageUrls: allImages,
      imageUrl: pickImageForOfferIndex(allImages, index),
      mediaType,
      postedAt,
      offerLink: url,
      name: findNameForUrl(text, url),
      index,
    })
  );
}

function parseOfferFromMessage(msg, options) {
  return parseOffersFromMessage(msg, options)[0];
}

module.exports = {
  parseOffersFromMessage,
  parseOfferFromMessage,
  detectPlatform,
  normalizeOfferLink,
  buildDedupeKey,
  extractPrice,
  extractSalePercent,
  tryExtractFromJson,
  cleanDescription,
  stripWhatsAppPromoText,
  isWhatsAppPromoLine,
  buildClearPayload,
  buildApiOffer,
  enrichStoredOffer,
  detectCategory,
  toCategoryObject,
  resolveOfferImageUrl,
  URL_REGEX,
};
