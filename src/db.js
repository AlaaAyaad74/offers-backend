const { MongoClient } = require("mongodb");

let client;
let db;

async function connectDb() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error(
      "MONGODB_URI is required. Copy from .env.example (Docker Mongo uses root/changeme)."
    );
  }

  const mongoOptions = {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) || 15000,
  };

  if (String(process.env.MONGODB_TLS_ALLOW_INVALID_CERTIFICATES || "").toLowerCase() === "true") {
    mongoOptions.tlsAllowInvalidCertificates = true;
  }

  if (String(process.env.MONGODB_TLS_ALLOW_INVALID_HOSTNAMES || "").toLowerCase() === "true") {
    mongoOptions.tlsAllowInvalidHostnames = true;
  }

  client = new MongoClient(uri, mongoOptions);

  try {
    await client.connect();
  } catch (err) {
    const message = String(err?.message || err || "");
    throw new Error(
      `MongoDB connection failed: ${message}. Check MONGODB_URI (correct scheme/user/pass/db), URL-encode special chars in password, and ensure your Mongo provider allows connections from Render.`
    );
  }
  db = client.db();

  await db.collection("offers").createIndex({ id: 1 }, { unique: true });
  await db.collection("offers").createIndex({ createdAt: -1 });
  await db.collection("offers").createIndex({ postedAt: -1 });
  await db.collection("offers").createIndex({ platform: 1 });
  await db.collection("offers").createIndex({ category: 1 });
  await db.collection("offers").createIndex({ price: 1 });
  await db.collection("offers").createIndex({ channelId: 1 });
  await db.collection("offers").createIndex({ channelId: 1, messageId: -1 });
  await db.collection("offers").createIndex({ normalizedLink: 1 });
  await db.collection("offers").createIndex({ dedupeKey: 1 });
  await db.collection("offers").createIndex({ imageDedupeKey: 1 });
  await db.collection("channel_state").createIndex({ channelId: 1 }, { unique: true });

  console.log("[mongodb] connected");
  return db;
}

function getDb() {
  if (!db) {
    throw new Error("Database not connected. Run connectDb() first.");
  }
  return db;
}

async function closeDb() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}

module.exports = { connectDb, getDb, closeDb };
