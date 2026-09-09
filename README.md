# Mighty API and PIA candidates

The existing Mighty/weather Function URL is preserved. Candidate intake and moderation run in a separate Lambda and authenticated HTTP API within the same `mighty-api-production` stack. See [candidate deployment and operations](docs/candidates.md). News remains in `county-post-news-api`.

Published and pending candidate corrections use private [candidate change requests](docs/candidate-change-requests.md). The API provides approved-only change-target prefill, narrative-only pending references, revision-checked review, and atomic application without publishing pending originals. Release the backend before enabling the frontend workflow.

# Mighty API

Small Node/TypeScript service that proxies Mighty Networks county feeds/events and National Weather Service county weather data.

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
- `GET /weather?lat={latitude}&lon={longitude}` – normalized current conditions, forecast periods, and active county-zone alerts from the National Weather Service.

Space routes forward to `https://api.mn.co/admin/v1` with your bearer token. The weather route identifies this application to `api.weather.gov`, validates coordinates, caches responses for five minutes, and requires no API key.

## Frontend usage (example Vite)
```ts
const api = import.meta.env.VITE_MIGHTY_API_BASE ?? "http://localhost:4001";

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
- Weather data is provided by the U.S. National Weather Service. Keep the identifying `User-Agent` in `src/lib/weatherClient.ts` current.
- Adjust rate limits, caching, and auth if you expose beyond internal use.

## AWS deployment

This repository is prepared for GitHub → AWS CodePipeline → CodeBuild → CloudFormation/SAM → Lambda Function URL deployment.

Before creating the pipeline:

1. Store `MIGHTY_API_KEY` as JSON in AWS Secrets Manager under the `MIGHTY_API_KEY` key.
2. Push `template.yaml`, `buildspec.yml`, and `package-lock.json` to the deployment branch.
3. Follow [`docs/deployment.md`](docs/deployment.md) to create the artifact bucket, GitHub CodeConnection, CodeBuild project, and CloudFormation deploy stage.

The frontend must receive only the public API URL:

```text
VITE_MIGHTY_API_BASE=https://<function-url-id>.lambda-url.<region>.on.aws
```

Never expose the Mighty token through a `VITE_*` variable.

Set `VITE_MIGHTY_API_BASE` in AWS Amplify and redeploy the frontend. The API itself must also set `CORS_ORIGIN` to the exact Amplify origin (with no trailing slash), otherwise browser requests will be blocked even though `/health` responds successfully.
