# Telegram Offers API

Simple Node.js service that collects product offers from Telegram channels and exposes them over a REST API.

Uses your **Telegram account** (`API_ID` + `API_HASH` from [my.telegram.org](https://my.telegram.org/apps)) — **no bot required**.

Each offer includes:

- Product name
- Category (auto-detected from text: electronics, fashion, beauty, home, …)
- Price (parsed from message when present)
- Sale percent (when text mentions a discount, e.g. `50% off` or `خصم 30%`)
- Description (cleaned — URLs and price/discount lines removed when parsed)
- Image URL (local `/media/...` path)
- Offer link
- Platform (amazon, aliexpress, etc.)
- **API fields** (only these are returned from `GET /offers`): `_id`, `id`, `category`, `channelId`, `channelTitle`, `clear`, `createdAt`
- **`category`**: `{ value, label, labelAr }` — slug in `value` (e.g. `electronics`); use for `GET /offers?category=electronics`
- **`clear`**: `image`, `buyLink`, `description`, `price`, `currency`, `salePercent`, `platform`, `category` — product card fields; `category` matches the top-level object

If a post contains JSON (raw or in a ` ```json ` block), those fields are merged in when present.

## Setup

1. Get `API_ID` and `API_HASH` from [my.telegram.org/apps](https://my.telegram.org/apps).
2. Join the offer channel(s) with the **same Telegram account** you use to log in.
3. Install dependencies:

```bash
npm install
```

4. Configure environment:

```bash
cp .env.example .env
# Edit .env: API_ID, API_HASH, PORT
```

5. Start the server (first run asks for phone + login code):

```bash
npm start
```

On first start you enter your phone number and the code Telegram sends you. The session is saved to `data/session.txt` so you are not asked again.

## Telegram post format (simple)

```
Wireless Earbuds Pro
50% off today. Free shipping.

https://www.amazon.com/dp/B0XXXXXXX
```

- **Line 1** → product name  
- **Other lines** → description  
- **URL** → offer link (platform is detected from the domain)  
- **Photo** → product image (saved under `/media/…` when `DOWNLOAD_MEDIA_ON_SYNC=true`)
- **Image document / link preview** → also saved (not only `MessageMediaPhoto`)
- **Image URL in text** → used when present (Amazon CDN, `telegra.ph`, etc.)

### Fix missing images on existing offers

```bash
# Re-download Telegram media + parse image URLs from text
npm run backfill-media

# Optional: limit how many to process
npm run backfill-media -- 200

# Re-parse text/JSON fields only (no Telegram download)
npm run backfill-offers
```

## All offer channels, all messages

This account is meant for **offer channels only**. Every post from every joined **broadcast channel** is saved — text, photos, links, or mixed. Nothing is skipped because a URL is missing.

On startup (`SYNC_ON_START=true` by default) the app scans **all** joined channels and pulls **full history** (set `SYNC_LIMIT_PER_CHANNEL` only if you want a cap).

```bash
# Channels your account joined
curl http://localhost:3000/channels

# Re-sync full history from all channels
curl -X POST http://localhost:3000/sync
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service status + stored offer count |
| GET | `/channels` | Joined broadcast channels — `name` search, `page`, `limit` (50/page default) |
| POST | `/sync` | Fetch past channel messages (`?limitPerChannel=100`) |
| GET | `/offers` | List offers (paginated, 50/page) — `name`, `startDate`, `endDate`, `sort=asc\|desc`, `page` |
| GET | `/offers/:id` | Single offer by id (`channelId_messageId`) |
| GET | `/categories` | All product categories (`value`, `label`, `labelAr`) |
| GET | `/media/:file` | Downloaded channel photos |

### Query parameters (`GET /offers`)

| Param | Description |
|-------|-------------|
| `name` | Case-insensitive search in offer name |
| `category` | Filter by category (`electronics`, `fashion`, `beauty`, `home`, etc.) |
| `startDate` | Lower bound (ISO date) on posted/created date |
| `endDate` | Upper bound (ISO date) on posted/created date |
| `since` | Alias for `startDate` (backward compatible) |
| `sort` | `asc` or `desc` by date (default: `desc`) |
| `page` | Page number (default: `1`) |
| `limit` | Items per page (default: `50`) |
| `offset` | Skip N items (alternative to `page`) |
| `platform` | Filter by platform |
| `channelId` | Filter by channel |
| `dedupe` | `false` to return all rows; duplicates get `repeated: true` (default: deduplicated) |

Duplicates are detected when any of these match:

- Same offer/buy link (normalized, including Amazon ASIN)
- Same image URL (`/media/…` or external CDN)
- Shared description substring (min length `OFFERS_DEDUPE_MIN_SUBSTRING`, default **16**)

Response fields on each offer: `repeated`, `repeatedReason` (`link` \| `image` \| `description`), `repeatedOf` (id of the first offer in the group).

### Example response

```json
{
  "page": 1,
  "pageSize": 50,
  "limit": 50,
  "offset": 0,
  "total": 120,
  "totalPages": 3,
  "hasNext": true,
  "hasPrev": false,
  "count": 120,
  "returned": 50,
  "totalStored": 120,
  "deduplicated": true,
  "duplicatesRemoved": 0,
  "data": [
    {
      "_id": "6a142a52d19a6981cd9c5535",
      "id": "-1001234567890_42",
      "category": {
        "value": "electronics",
        "label": "Electronics",
        "labelAr": "إلكترونيات"
      },
      "channelId": "-1001234567890",
      "channelTitle": "Daily Deals",
      "clear": {
        "image": "/media/-1001234567890_42.jpg",
        "buyLink": "https://www.amazon.com/dp/B0XXXXXXX",
        "description": "Free shipping.",
        "price": 299.99,
        "currency": "EGP",
        "salePercent": 50,
        "platform": "amazon",
        "category": {
          "value": "electronics",
          "label": "Electronics",
          "labelAr": "إلكترونيات"
        }
      },
      "createdAt": "2026-05-23T12:00:00.000Z"
    }
  ]
}
```

## Notes

- Saves **every** channel message (offer account → every post is an offer).
- Live + history: new posts while running; `POST /sync` or `SYNC_ON_START` for backfill.
- Your account must be a **member** of the channel (public channels: join them in Telegram first).
- Data is stored in **MongoDB** (persists across restarts).
- Offers older than **5 days** are deleted automatically (`OFFERS_RETENTION_DAYS`, cleanup every hour).
- Do not commit `data/session.txt` — it is your account session.
- For production, run with Docker Compose or add backups for MongoDB.

## Docker Compose

Runs the API + MongoDB together:

```bash
cp .env.example .env
# set API_ID and API_HASH in .env

docker compose up -d --build
```

### Local vs Production database

- **Local (Docker):** keep `MONGODB_URI` pointing to the compose Mongo service:

```env
MONGODB_URI=mongodb://root:changeme@mongodb:27017/telegram_offers?authSource=admin
```

- **Production (Atlas):** set `MONGODB_URI` in your production environment to Atlas URI, for example:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/telegram_offers?retryWrites=true&w=majority
```

The app reads `MONGODB_URI` from environment. No code change is needed between local and production.

First-time Telegram login (interactive):

```bash
docker compose run --rm -it api npm start
```

After login, session is saved in the `app_data` volume. Then run normally:

```bash
docker compose up -d
```

API: `http://localhost:3000`  
MongoDB: `localhost:27017` (user/password from `.env`: `MONGO_ROOT_USER` / `MONGO_ROOT_PASSWORD`)
