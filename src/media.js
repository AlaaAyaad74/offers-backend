const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

const IMAGE_URL_REGEX =
  /https?:\/\/[^\s<>"')\]]+\.(?:jpg|jpeg|png|webp|gif|avif|bmp)(?:\?[^\s<>"')\]]*)?/gi;

const IMAGE_HOST_REGEX =
  /https?:\/\/(?:[a-z0-9-]+\.)?(?:media-amazon|images-amazon|m\.media-amazon|ssl-images-amazon|i\.imgur|telegra\.ph|cdn\.shopify|cloudfront\.net)[^\s<>"')\]]*/gi;

const IMAGE_MIME_PREFIX = /^image\//i;

const VISUAL_MEDIA_TYPES = new Set([
  "MessageMediaPhoto",
  "MessageMediaDocument",
  "MessageMediaWebPage",
]);

function isImageMime(mimeType) {
  return IMAGE_MIME_PREFIX.test(String(mimeType || ""));
}

function isImageDocumentMedia(media) {
  if (!media || media.className !== "MessageMediaDocument") return false;
  const doc = media.document;
  if (!doc || typeof doc !== "object") return false;
  return isImageMime(doc.mimeType);
}

/** Whether Telegram attached media can be saved as a product image. */
function isDownloadableVisualMedia(message) {
  if (!message?.media) return false;

  const type = message.media.className;
  if (VISUAL_MEDIA_TYPES.has(type)) {
    if (type === "MessageMediaDocument") {
      return isImageDocumentMedia(message.media);
    }
    return true;
  }

  if (message.photo) return true;
  if (message.document && isImageMime(message.document.mimeType)) return true;

  const preview = message.webPreview;
  if (preview?.photo || (preview?.document && isImageMime(preview.document.mimeType))) {
    return true;
  }

  return false;
}

function mediaFileExtension(message) {
  const doc = message.document || message.media?.document;
  if (doc && typeof doc === "object" && doc.mimeType) {
    if (doc.mimeType.includes("png")) return ".png";
    if (doc.mimeType.includes("webp")) return ".webp";
    if (doc.mimeType.includes("gif")) return ".gif";
  }
  return ".jpg";
}

/** Direct image URLs embedded in caption/text (CDN, telegra.ph, etc.). */
function extractImageUrlsFromText(text) {
  if (!text) return [];

  const found = new Set();

  for (const pattern of [IMAGE_URL_REGEX, IMAGE_HOST_REGEX]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const url = String(match[0]).replace(/[.,;:!?)]+$/, "");
      if (url.length > 12) found.add(url);
    }
  }

  for (const url of text.match(URL_REGEX) || []) {
    if (/\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(url)) {
      found.add(url);
    }
    if (/media-amazon|images-amazon|telegra\.ph\/file\//i.test(url)) {
      found.add(url);
    }
  }

  return [...found];
}

function pickImageForOfferIndex(imageUrls, index) {
  if (!imageUrls?.length) return null;
  return imageUrls[index] ?? imageUrls[0] ?? null;
}

function isLocalMediaPath(url) {
  return typeof url === "string" && url.startsWith("/media/");
}

/** Turn /media/... into https://your-api.onrender.com/media/... for frontends on another origin. */
function toPublicAssetUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (/^https?:\/\//i.test(url)) return url;

  const base = String(
    process.env.PUBLIC_API_URL || process.env.API_BASE_URL || ""
  ).replace(/\/$/, "");
  if (!base) return url;

  if (url.startsWith("/")) return `${base}${url}`;
  return `${base}/${url}`;
}

module.exports = {
  extractImageUrlsFromText,
  isDownloadableVisualMedia,
  isImageMime,
  isImageDocumentMedia,
  isLocalMediaPath,
  toPublicAssetUrl,
  mediaFileExtension,
  pickImageForOfferIndex,
};
