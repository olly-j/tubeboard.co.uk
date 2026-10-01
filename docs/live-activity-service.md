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

Both registration stores serialize complete changes and publish them only after
atomically replacing their existing JSON file. A storage failure leaves the
last committed state intact and reports an error; later requests can retry
after the filesystem recovers. Alert opt-out removes the registration and its
pending queue entries in the same persisted change. Temporary replacements use
restricted permissions and are cleaned up on failure where the filesystem
allows it. The existing single-process, single-volume ownership still applies.

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

The public `/train/v1` uninstalled-recipient fallback validates the existing
version 1 and version 2 shared-train fragments entirely in the browser; it
rejects unknown versions and fields and never sends the fragment to the
service. Its App Store handoff is shown for iPhone, conventional iPad user
agents, and iPadOS Safari's desktop user agent only when touch capability
confirms an iPad. Non-touch desktop browsers retain the browser-only message.
When JavaScript is unavailable, the static page cannot validate the fragment
but provides a clearly scoped iPhone/iPad App Store next step. No cookie,
analytics, account, recipient-tracking or server-side journey state is added.

When an app-selected duration elapses, the worker completes the existing
pause-then-end transition before generic maximum-lifetime expiry, including
when the ten-minute pause grace crosses the eight-hour ceiling. Existing APNs
backoff, permanent-error cleanup and inactive-record retention remain the
bounded failure and cleanup policy.

TB-115 in service `1.4.4` gives each notification worker one active cycle and
at most one pending rerun. Startup, interval and Live Activity rollover triggers
share that owner, so slow I/O cannot start a second delivery cycle for the same
worker. The existing 90-second Live Activity and 60-second disruption-alert
cadences remain unchanged. Each TfL/APNs request has an absolute 15-second
deadline covering connection, headers and the complete response body; body
progress does not extend it. APNs streams and their dedicated sessions are
disposed on completion, failure or cancellation. Requests remain sequential
within a cycle, so total cycle time still depends on the number of due records.

`SIGTERM` and `SIGINT` cancel notification requests and owned timers immediately,
stop the status monitor, and allow HTTP handlers and persistence to drain for
up to five seconds. A graceful drain exits successfully; an exceeded deadline
closes remaining HTTP connections and exits with failure. An unfinished push
is not acknowledged or charged a retry merely because shutdown cancelled it.
Transport deadlines retain the existing retry/backoff and permanent-error
rules. TB-114's recoverable durable writes are included; registration formats,
encryption, retention and APNs environment selection are unchanged. This is
source behavior until an authorized deployment reports the exact reviewed
revision in `/healthz`. Rollback uses the previous recorded healthy source and
the same persistent volume, without a data migration or volume replacement.

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

## Website-only scheduled price publication (TB-016, 22 September 2026)

The owner authorized immediate publication of the Lifetime price schedule,
not deployment of the separately held service 1.4.4 changes. The guarded
`scripts/deploy-website-only.py` route therefore overlays **only** `index.html`
and `support.html` on the exact existing production image. It derives those
pages from the verified deployed source and applies only the reviewed price
replacement, preserving any other newer website/assets work on main.

Before mutation it requires clean, reviewed current-main source, matching live
HTML and backend revision, the exact image digest and single machine, the
existing encrypted volume, passing repository tests, and an unchanged machine
configuration after image construction. The build is build-only first. Actual
publication requires `--confirm-production`; only the image changes. Full
configuration, live page hashes and backend health must match after update.
It never reads user records, changes secrets, publishes service 1.4.4, or
changes worker/retention configuration. The private receipt retains the old
immutable image for rollback and the distinct website source revision.

The owner subsequently requested concise public copy: **£31.99 one-off** on
Home and **lifetime is £31.99** on Support, without old prices or dates.
The existing Apple price schedule remains unchanged. The guarded deployment
also accepts the exact earlier scheduled-price overlay, and refuses any
unrelated live-content change. Website copy is distinct from StoreKit pricing.
The original full-service deployment procedure and its separate approval
remain unchanged.

The first publication exposed a flyctl image-parser defect: a digest-pinned
image was expanded into a double-digest identifier and rejected before any
machine update. The already-built image was safely applied through Fly's
Machines API with the exact current instance version and full unchanged
configuration except image. The permanent adapter follows that successful
path; it never rebuilds or silently retries an ambiguous update. Production
readback on 22 September confirmed both pricing HTML hashes, unchanged backend
1.4.2 and identical environment, services, machine sizing and encrypted volume.

### Optional station-board-v2 contract (source prepared, deployment pending)

New clients opt in using `contentStateContract: "station-board-v2"` on the existing token endpoint. The separate v2 registration schema requires this value and an exact station/line membership from the public app catalogue. It supports the 11 Underground lines, Elizabeth, the six named Overground lines and DLR. The existing district-circle combined app board remains outside system-surface registration. The v1 schema, 17-line allowlist, content state and worker behavior remain unchanged for installed clients without negotiation. The health response advertises contentStateContracts, and a successful v2 token response explicitly acknowledges contentStateContract. Clients must confirm capability before registering with an older deployment that might ignore unknown fields; the unchanged v1 acknowledgement remains {ok:true}. Unknown contracts fail validation. A negotiated activity never downgrades on token renewal or older registrations.

V2 pushes retain the established content-state fields and Apple reference-epoch Date numbers. Each row additionally carries `timeEvidence` (`reportedIncomingArrival`, `throughArrivalPrediction`, `estimatedDeparture`, `scheduledDeparture`, or `destinationOnly`), optional `via`, `reportedPlatform`, original `expiresAt` and `isCached:false`. Destination-only rows have no clock. A planned clock always stays scheduled, uses whole minutes and becomes Due at the existing minute boundary; strict elapsed departure and source expiry remove the row. Neither zero, legacy DepartTime, downstream arrivals nor record disappearance establishes a departure.

Selected-station Unified arrivals are classified individually using validated endpoint IDs and names. Explicit ordered repeated-stop evidence can retain a through service. Contradictory endpoints are withheld; source-local platform alternatives are collapsed without inventing a boarding platform or clock. Elizabeth and all six Overground lines retain the qualified ArrivalDepartures adapter, preferring its explicit estimated departure clock and allowing an explicitly scheduled on-time row. Delayed rows without an estimate, ambiguous alternatives and unsupported statuses are withheld. Tube/DLR use one bounded Journey request per admitted selected board, validating its own first transport leg, exact origin/line, explicit scheduled clock, route and current leg disruption fields. The queried endpoint does not supply the service destination. Line-wide at-station facts independently support destination/via/reported platform only when both provider clocks and HTTP freshness qualify.

Source caches hold only typed facts for the already registered board and scoped rejection markers; no network-wide vehicle tracking or additional personal/location data is stored. HTTP Date/Age use the larger apparent age and never renew clocks from an old response. Source contexts merge by their original observations; transient failures retain only original unexpired content. Publication rejection applies only to publication plans; current selected-station or whole-line closure rejection applies to publication and Journey planned sources. All outgoing scheduled clocks, including scheduled rail rows, are withheld under applicable fresh closure evidence. Qualified predicted rail and arrival observations retain their own separate capabilities. Original closure checks retain their own scope, freshness and applicable period; a newer qualified open observation clears only its same scope. Platform/direction eligibility precedes source choice. Eligible publication plans take priority over bounded Journey alternatives; otherwise Journey remains useful. Qualified selected rail replaces overlapping through-arrival interpretation only within the actual eligible board scope. Distinct rows within the chosen source remain distinct. Compact surfaces order eligible outgoing clocks before incoming arrivals, then apply the three-row limit.

The existing SerialWorker owns both 90-second source admissions and cache-only boundary timers. Minute/Due, strict elapsed and original source-expiry boundaries recompute the saved board without TfL reads; restart restores the same persisted contexts. A cache-only trigger cannot admit v1 or v2 feed requests. Cache/markers commit atomically before sending, and the delivered transition is acknowledged only after APNs succeeds. The APNs stale-date follows original row expiry, rather than gaining five minutes at each push. Duration, backoff, permanent-token failure, environment and 24-hour retention behavior are retained. The existing absolute 15-second transport deadlines cover all new requests. A missing HTTP Age may trigger one bounded same-URL readback within an admitted refresh; it never qualifies missing freshness evidence.

The optional bounded plannedContextSeed carries original client-qualified publication or Journey plans, separately preserving per-row originating serviceDay/profile/fingerprint/weekdays/serviceMinute, ordered calls and exact departure dates. Publication source identity is distinct from an itinerary response digest. Calendar ambiguities, unknown destinations/routes/via, physical platform/live-clock fields and an arbitrary publication URL are rejected. An explicit via must name one selected-line station. Full publication plans require it in the complete calls (Northern Bank/Charing Cross must exactly match the path, other current publication adapters report no via). A bounded Journey leg may alight before its reported destination/via; its original ordered prefix stays unchanged and no stop is appended. Unsupported or contradictory via seed data is withheld rather than reinterpreted. At most two sources/32 rows each and 24KiB are admitted within the unchanged 32KiB endpoint limit. Original expiry is capped by 600/120 seconds and London midnight. The service attempts independent publication HEAD validation at the exact official URL before unrelated endpoints within an admitted refresh. A verified matching SHA corroborates publication identity; a verified changed SHA immediately rejects older timetable context, even when other endpoints are offline. If HEAD is unavailable or the current read admission has not elapsed, original client-qualified context may remain only until its original TTL. No fresh publication pass is claimed, and original observations, clocks and expiry are never renewed. A matching HEAD does not qualify rows/profiles. Optional original closureEvidence uses the shared lineStatus/stationDisruptions scopes and cannot clear a newer independently observed closure. The server does not adopt or self-qualify the app's bundled publication/profile proof. Its Journey context is explicitly bounded and may omit other branches, later departures or a line whose own leg fields do not qualify. Missing sources remain coverage gaps. Source-capture replays and deterministic worker tests are separate from current operational, physical-station and real-device APNs acceptance. Deployment, app negotiation, physical expiry/render evidence and rollout approval remain integration-owner gates.
