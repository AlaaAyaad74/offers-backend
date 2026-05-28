require("dotenv").config();

const { MongoClient } = require("mongodb");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required in .env");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  const offers = await db.collection("offers").drop().catch(() => null);
  const state = await db.collection("channel_state").drop().catch(() => null);

  console.log("[reset] dropped offers collection:", offers !== null);
  console.log("[reset] dropped channel_state collection:", state !== null);
  console.log("[reset] database is empty — restart with: npm start");

  await client.close();
}

main().catch((err) => {
  console.error("[reset] failed:", err.message);
  process.exit(1);
});
