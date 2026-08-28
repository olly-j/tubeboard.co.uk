# TubeBoard Website And Notification Service

This repository includes the Node.js service that serves the public website
and the notification backends required by the iOS app. Product work is tracked
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
- `POST /api/disruption-alerts/registrations`
- `DELETE /api/disruption-alerts/registrations`
- `GET /healthz`
- `GET /status`
- `GET /api/status/v1`
- `GET /api/status/v2`
- `GET /train/v1#<public-selection>`
- `GET /.well-known/apple-app-site-association`

The TB-077 train-sharing fallback is a static, no-sign-in page. Its versioned
public selection is carried only in the URL fragment and is parsed locally by
the page; the server receives only `/train/v1`. The page makes no API request,
stores no journey history, exposes no entitlement or identity, and fails
closed for malformed, unsupported or expired input. The AASA file associates
only `/train/v1` with `5B8YD7QXWZ.OllyJ.My-Train-Times`.

The token endpoint stores records in `data/live-activities.json` locally and
`/data/live-activities.json` on Fly.io. Push tokens are never returned by the
API, and the data directory is ignored by git. The versioned request contract
and fixture are under `contracts/`.

Registration abuse controls combine the random install identifier and request
IP only inside a keyed, per-process HMAC. The in-memory buckets are evicted
after the 60-second rate-limit window by one shared, unreferenced expiry timer,
and neither the raw association nor the HMAC key is persisted or logged.

The Live Activity v1 registration contract remains backward compatible with clients that
predate explicit `selectionMode`: an omitted mode is treated as the original
all-platform station selection. Service logs never include the client-supplied
Live Activity identifier. Its line allowlist includes the 11 Underground and
six named London Overground lines. The pre-existing Elizabeth registration gap
is unchanged and remains owned by the app's separate contract-correction work.

When an app-selected duration elapses, the worker completes the existing
pause-then-end transition before generic maximum-lifetime expiry, including
when the ten-minute pause grace crosses the eight-hour ceiling. Existing APNs
backoff, permanent-error cleanup and inactive-record retention remain the
bounded failure and cleanup policy.

The Premium disruption-alert endpoint accepts both versioned registration
contracts. Contract v1 remains Underground-only for installed v1.1 clients;
contract v2 adds Liberty, Lioness, Mildmay, Suffragette, Weaver and Windrush
without changing the endpoint, stored preference shape or Premium rules. It
validates the StoreKit 2 transaction
JWS with Apple's pinned App Store Server Library and bundled official Apple G2
and G3 root certificates. The signed transaction is discarded after
verification. The service stores a SHA-256 digest of the random install ID,
the APNs token encrypted with AES-256-GCM, selected lines, severity, quiet
hours/time zone, resumed-service preference, app/build/APNs environment, and
minimal product/expiry verification metadata. It does not receive location,
favourites, account details, payment details, or notification-open analytics.

The alert worker polls one combined Tube and Overground TfL line-status
endpoint once per minute. A
change must appear in two consecutive responses before it is eligible for a
push. Severe-only, quiet-hour, line-selection and recovery preferences are
applied before enqueueing; APNs collapse identifiers limit obsolete alerts.
Permanent invalid-token responses delete the registration immediately.
Opt-out deletes immediately, expired Premium access deletes at its recorded
expiry, and other inactive records expire after 90 days. The separate
`/data/disruption-alerts.json` file uses the existing persistent volume.
Static serving is allow-listed to the public pages, assets and versioned
contract schemas, including disruption-alert v1 and v2; server source,
dependencies, fixtures and certificates are not public routes.

`GET /healthz` returns only non-sensitive release evidence:

- service version;
- Live Activity contract version;
- disruption-alert contract version and worker-enabled state;
- deployed source revision.

`GET /status` is a server-rendered, no-sign-in support page. Its versioned JSON
sources preserve v1's 11-line/23-request projection at `GET /api/status/v1`
and add the 17-line/35-request response at `GET /api/status/v2`; each follows
its matching `contracts/tubeboard-status-vN.schema.json` and separates official
TfL disruption from TubeBoard representative arrival-data health. The monitor runs only when
`TUBEBOARD_STATUS_MONITOR_ENABLED=true`; Fly uses a five-minute cycle, at most
35 sequential TfL requests per cycle (one combined status request plus two
representative arrival probes for each of 17 lines), three unhealthy windows
to degrade and two healthy windows to recover. That is 10,080 requests per day
at the configured cadence, up from 6,624, with no new runtime or dependency.
Results older than 15 minutes become unknown.
Any TfL `429` response aborts the remaining station sweep immediately and
honours the bounded retry delay so the shared app key is not amplified.
When TfL returns more than one valid official status for a line, a disruption
takes precedence over Good Service. Once a snapshot is stale, both official
and TubeBoard per-line truth become unknown, and each response retains exactly
its published versioned schema shape.
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
- `DISRUPTION_ALERT_ENCRYPTION_KEY` containing exactly 32 private bytes as 64
  hex characters or base64;
- `APP_STORE_APP_ID=6779771046`.

The service selects the APNs production or sandbox host from the app payload.
TestFlight uses production APNs with Sandbox StoreKit transactions; those two
environments are intentionally separate fields.

The official Apple G2/G3 roots are versioned under `certificates/`. Review the
[Apple PKI](https://www.apple.com/certificateauthority/) before each release
that changes purchase verification and at least annually. Replace or add roots
only from Apple, record their SHA-256 fingerprints, and run the complete local
test suite before deployment.

The App Store Server Library is Apple's MIT-licensed Node package pinned at
`3.1.0`; the lockfile pins its transitive graph. It adds no third-party service
or recurring cost. `npm audit --omit=dev` and the production container's
`npm ci --omit=dev --ignore-scripts` are release evidence. Reassess license,
maintenance, privacy, supported Node compatibility, vulnerabilities and
removal options before changing the version. Removal requires replacing its
certificate-chain, signature, app, environment, product, expiry and revocation
checks with evidence at least as strong; client-supplied Premium booleans are
never an acceptable substitute.

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
The script discovers Homebrew's keg-only `flyctl`; `FLYCTL_BIN` can point to an
alternative executable when needed.

Run one machine only for launch. Multiple machines would duplicate workers and
could send duplicate APNs updates. Deploy backward-compatible server support
before distributing a client that depends on it. If a future change requires
an incompatible data migration, add a versioned endpoint and tested rollback
rather than modifying the live contract in place.

## iOS Endpoint

Set the app bundle `Config.plist` value to:

```xml
<key>LiveActivityTokenEndpointURL</key>
<string>https://tubeboard.co.uk/api/live-activities/tokens</string>
```

Set `DisruptionAlertRegistrationEndpointURL` to:

```text
https://tubeboard.co.uk/api/disruption-alerts/registrations
```
