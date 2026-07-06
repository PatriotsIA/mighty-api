# Mighty API

Small Node/TypeScript service that proxies Mighty Networks Admin API calls for county spaces (feeds and events).

## Setup
1. Copy `.env.example` to `.env` and fill values:
   - `MIGHTY_API_KEY` – Mighty Networks Admin API token.
   - `MIGHTY_NETWORK_ID` – Your network id or subdomain.
   - `PORT` – Optional (default `4001`).
   - `CORS_ORIGIN` – Comma-separated origins allowed to call this API (use `*` during local dev).
2. Install and run:
   ```bash
   npm install
   npm run dev   # watches with tsx
   # or
   npm run build && npm start
   ```

## Routes
- `GET /health` – service check.
- `GET /spaces` – list spaces (paginate with `?page` and `?per_page`).
- `GET /spaces/:spaceId/feed` – posts for a space (supports `?page` and `?per_page`, defaults 1/25).
- `GET /spaces/:spaceId/events` – events for a space (supports `?page` and `?per_page`).

All routes forward to `https://api.mn.co/admin/v1` with your bearer token and include pagination links from Mighty Networks.

## Frontend usage (example Vite)
```ts
const api = import.meta.env.VITE_MIGHTY_PROXY ?? "http://localhost:4001";

export async function fetchSpaceFeed(spaceId: string) {
  const res = await fetch(`${api}/spaces/${spaceId}/feed?per_page=25`);
  if (!res.ok) throw new Error("Failed to fetch feed");
  return res.json();
}

export async function fetchSpaceEvents(spaceId: string) {
  const res = await fetch(`${api}/spaces/${spaceId}/events?per_page=50`);
  if (!res.ok) throw new Error("Failed to fetch events");
  return res.json();
}
```

## Notes
- This service intentionally keeps the Mighty API key on the server side and exposes only read endpoints the county pages need.
- Adjust rate limits, caching, and auth if you expose beyond internal use.
