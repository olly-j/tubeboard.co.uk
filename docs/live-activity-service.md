# TubeBoard Live Activity Web Service

This repository includes the Node.js service that serves the public website
and the Live Activity backend required by the iOS app. Product work is tracked
centrally through a `TB-NNN` Issue in `olly-j/My-Train-Times`; this repository
is authoritative for implementation, tests, and Fly deployment history.

## Run Locally

```sh
npm start
```

For local endpoint testing without the one-minute worker:

```sh
npm run dev
```

The service listens on `http://localhost:4173` locally by default. On Fly.io, `fly.toml` sets `PORT=8080`.

## Endpoints

- `POST /api/live-activities/tokens`
- `POST /api/live-activities/end`
- `GET /healthz`
- `GET /status`
- `GET /api/status/v1`

The token endpoint stores records in `data/live-activities.json` locally and
`/data/live-activities.json` on Fly.io. Push tokens are never returned by the
API, and the data directory is ignored by git. The versioned request contract
and fixture are under `contracts/`.

`GET /healthz` returns only non-sensitive release evidence:

- service version;
- Live Activity contract version;
- deployed source revision.

`GET /status` is a server-rendered, no-sign-in support page. Its versioned JSON
source, `GET /api/status/v1`, follows
`contracts/tubeboard-status-v1.schema.json` and separates official TfL disruption from
TubeBoard representative arrival-data health. The monitor runs only when
`TUBEBOARD_STATUS_MONITOR_ENABLED=true`; Fly uses a five-minute cycle, at most
23 sequential TfL requests per cycle, three unhealthy windows to degrade and
two healthy windows to recover. Results older than 15 minutes become unknown.
No raw TfL payload, status-page query, station, device or user data is stored.
Set `TUBEBOARD_STATUS_NOTICE` to a bounded public incident message or disable
the monitor to return checker state to unknown without affecting Live
Activities. Manual full sweeps remain outside production under TB-037.

## Required Production Configuration

Copy `.env.example` into the production environment and set:

- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_AUTH_KEY_PATH` or `APNS_AUTH_KEY`
- `APNS_BUNDLE_ID=OllyJ.My-Train-Times`
- `TFL_APP_KEY` if using a TfL app key

The service selects the APNs production or sandbox host from the `environment` value uploaded by the app.

## Deployment

GitHub Pages cannot run API endpoints or scheduled workers. Deploy this service on a Node-capable host such as Fly.io, then point `https://tubeboard.co.uk` at that runtime or route `/api/live-activities/*` to it through a reverse proxy.

The volume already exists. Do not recreate, delete, replace, or copy it during
normal work. A merge is not a deployment. After explicit owner authorization,
deploy only from clean `main` using:

```sh
scripts/deploy-production.sh --confirm-production
```

The script confirms `main == origin/main`, runs all checks, validates
`fly.toml`, passes the source SHA into the image, deploys, then refuses success
unless production `/healthz` reports that exact revision. Record the Fly
release and health result in the central Issue. Roll back by redeploying the
last recorded healthy source revision; preserve the mounted volume.

Run one machine only for launch. Multiple machines would duplicate the minute
worker and send duplicate APNs updates.

## iOS Endpoint

Set the app bundle `Config.plist` value to:

```xml
<key>LiveActivityTokenEndpointURL</key>
<string>https://tubeboard.co.uk/api/live-activities/tokens</string>
```
