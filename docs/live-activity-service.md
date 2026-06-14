# TubeBoard Live Activity Web Service

This repository now includes a small Node.js service that serves the static website from `03-Website` and adds the Live Activity backend required by the iOS app.

## Run Locally

```sh
npm start
```

For local endpoint testing without the one-minute worker:

```sh
npm run dev
```

The service listens on `http://localhost:4173` by default.

## Endpoints

- `POST /api/live-activities/tokens`
- `POST /api/live-activities/end`
- `GET /healthz`

The token endpoint stores records in `data/live-activities.json` by default. Push tokens are never returned by the API, and the `data/` directory is ignored by git.

## Required Production Configuration

Copy `.env.example` into the production environment and set:

- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_AUTH_KEY_PATH` or `APNS_AUTH_KEY`
- `APNS_BUNDLE_ID=OllyJ.My-Train-Times`
- `TFL_APP_KEY` if using a TfL app key

The service selects the APNs production or sandbox host from the `environment` value uploaded by the app.

## Deployment Note

GitHub Pages cannot run API endpoints or scheduled workers. Deploy this service on a Node-capable host, then point `https://tubeboard.co.uk` at that runtime or route `/api/live-activities/*` to it through a reverse proxy.

## iOS Endpoint

Set the app bundle `Config.plist` value to:

```xml
<key>LiveActivityTokenEndpointURL</key>
<string>https://tubeboard.co.uk/api/live-activities/tokens</string>
```
