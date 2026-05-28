const buckets = new Map();

function readTtlSeconds(name, fallbackSeconds) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallbackSeconds;
}

function getCached(key, ttlSeconds, loader) {
  if (ttlSeconds <= 0) {
    return loader();
  }

  const now = Date.now();
  const hit = buckets.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const valuePromise = Promise.resolve().then(loader);
  buckets.set(key, {
    value: valuePromise,
    expiresAt: now + ttlSeconds * 1000,
  });

  valuePromise.catch(() => buckets.delete(key));
  return valuePromise;
}

function clearResponseCache() {
  buckets.clear();
}

module.exports = { getCached, readTtlSeconds, clearResponseCache };
