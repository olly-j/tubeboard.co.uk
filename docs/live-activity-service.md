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
- `GET`/`HEAD /api/timetable-publications/v1/{publicationSHA256}`
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

New clients opt in using `contentStateContract: "station-board-v2"` on the existing token endpoint. The separate v2 registration schema requires this value and an exact station/line membership from the public app catalogue. It supports the 11 Underground lines, Elizabeth, the six named Overground lines and DLR. The existing district-circle combined app board remains outside system-surface registration. The v1 schema, 17-line allowlist, content state and worker behavior remain unchanged for installed clients without negotiation. The health response advertises contentStateContracts, plannedPresentationVersion:2 and the optional timetablePublicationAuthorityVersion:1. Authority1 registration requires presentation2; malformed or unsupported capability values fail validation. New publication-aware consumers require the advertised literal capabilities and an acknowledgement with ok:true and the accepted typed contract/capabilities. The acknowledgement describes retained accepted state, including an ignored older request; it does not echo unaccepted request capabilities. New consumers register the optional literal capability 2 only after this advertisement and require ok:true, the typed contract and capability 2 in the acknowledgement. The acknowledgement reflects the accepted stored registration, not an ignored request. Older v2 absence remains supported. Clients must confirm capability before registering with an older deployment that might ignore unknown fields; the unchanged v1 acknowledgement remains {ok:true}. Unknown contracts fail validation. An older registration cannot change a negotiated activity. At equal token observations capability absence wins; selected-tuple conflicts are not adopted. A strictly newer registration may change the compatible presentation capability. An equal original token/selection tuple may gain authority1 from absence, but cannot downgrade it; an older observation cannot change it. Async source retention, push dispatch and acknowledgement recheck the original registration tuple without logging it. Typed delivery-failure callbacks also compare the publication generation inside their queued storage mutation, so a newer publication cannot be backed off or deactivated by an obsolete failure.

V2 pushes retain the established content-state fields and Apple reference-epoch Date numbers. Each row additionally carries `timeEvidence` (`reportedIncomingArrival`, `throughArrivalPrediction`, `estimatedDeparture`, `scheduledDeparture`, or `destinationOnly`), optional `via`, `reportedPlatform`, original `expiresAt` and `isCached:false`. Capability2 original outgoing scheduled rows carry optional `plannedSourceID` (`timetable`, `journey-planner` or `rail-departures`). Older v2 receives only already-eligible single-context compact rows, without the rail tag or new availability overlay; incompatible masked raw rows never cross that boundary. Legacy absence remains compatible. Destination-only rows have no clock. A planned clock always stays scheduled, uses whole minutes and becomes Due at the existing minute boundary; strict elapsed departure/estimated incoming arrival and source expiry remove the row. Incoming rail requires its own estimatedTimeOfArrival; scheduledTimeOfArrival stays metadata and is never promoted to a prediction. Neither zero, legacy DepartTime, downstream arrivals nor record disappearance establishes a departure.

Selected-station Unified arrivals are classified individually using validated endpoint IDs and names. Explicit ordered repeated-stop evidence can retain a through service. Contradictory endpoints are withheld; source-local platform alternatives are collapsed without inventing a boarding platform or clock. Elizabeth and all six Overground lines retain the qualified ArrivalDepartures adapter, preferring its explicit estimated departure clock and allowing an explicitly scheduled on-time row. Delayed rows without an estimate, ambiguous alternatives and unsupported statuses are withheld. All19 lines use at most one bounded Journey request per admitted selected board, alongside the independently qualified feed on the seven rail lines, validating its own first transport leg, exact origin/line, explicit scheduled clock, route and current leg disruption fields. The queried endpoint does not supply the service destination. Line-wide at-station facts independently support destination/via/reported platform only when both provider clocks and HTTP freshness qualify.

Source caches hold only typed facts for the already registered board and scoped rejection markers; no network-wide vehicle tracking or additional personal/location data is stored. HTTP Date/Age use the larger apparent age and never renew clocks from an old response. Source contexts merge by their original observations; transient failures retain only original unexpired content. Publication/calendar/profile rejection applies only to publication plans. Original scoped availability masks scheduled context without installing a permanent closure rejection or deleting raw source rows. All outgoing scheduled clocks, including scheduled rail rows, are withheld under applicable fresh closure evidence. Qualified predicted rail and arrival observations retain their own separate capabilities. Original availability checks retain exact disjoint windows, source scope and HTTP expiry. A fresh strictly newer same-scope ordinary observation supersedes protected history; a newer clock-only restriction never establishes an open board or clears an independent full closure/barrier; an expired open or closed response cannot erase independently retained active or pending evidence. Announced windows beginning before original authority expiry plus 600 seconds retain bounded planned eligibility through that original cutoff. After authority expires this is an eligibility barrier, never a fresh physical closure claim. Scheduled own clocks intersecting an announced interval are also masked before activation, while useful preclosure clocks remain visible. Independent nonredundant proofs are bounded to eight per selected board; unrepresentable overflow withholds planned context using an original scoped observation/expiry rather than truncating windows or inventing continuous closure. Platform/direction eligibility precedes source choice. Eligible publication plans take priority over bounded Journey alternatives. That chosen context competes with scheduled rail by its first useful original clock, with a stable context tie; this is source choice, never train matching or a completeness claim. Qualified selected rail replaces overlapping through-arrival interpretation only within the actual eligible board scope. Distinct rows within the chosen source remain distinct. Compact surfaces order eligible outgoing clocks before incoming arrivals, then apply the three-row limit. A capability2 Activity carries at most nine original rows: up to three per original planned context and three independently qualified nonplanned rows. If more than nine candidates exist, active compact plans and useful nonplanned rows take priority, then deterministic original alternatives fill remaining slots, with optional plannedAvailability. Within each context currently eligible rows take priority over masked backups. Both original planned contexts remain separately tagged even without availability, so expiry or a known gap can recover useful original alternatives without a new source read. The shared renderer must apply original expiry and exact availability before choosing one tagged planned source (publication over Journey within that family, then first useful clock against scheduled rail) and before its three-row display limit. It must never concatenate overlapping planned contexts; live and legacy capabilities remain independent. Bounded transport is not coverage of omitted alternatives. Complete content-state availability is bounded to 3500 bytes, with an actual 4096-byte APNs envelope guard; overflow drops planned context and keeps useful live/untimed rows. Original availability starts, ends, authority expiry and eligibility cutoffs drive cache-only boundary pushes, including dormant future activation, without admitting extra HTTP reads.

The existing SerialWorker owns both 90-second source admissions and cache-only boundary timers. Minute/Due, strict elapsed and original source-expiry boundaries recompute the saved board without TfL reads; restart restores the same persisted contexts. A cache-only trigger cannot admit v1 or v2 feed requests. Cache/markers commit atomically before sending, and the delivered transition is acknowledged only after APNs succeeds. The APNs stale-date follows original row expiry, rather than gaining five minutes at each push. Duration, backoff, permanent-token failure, environment and 24-hour retention behavior are retained. The existing absolute 15-second transport deadlines cover all new requests. A missing HTTP Age may trigger one bounded same-URL readback within an admitted refresh; it never qualifies missing freshness evidence.

The optional bounded plannedContextSeed carries original client-qualified publication or Journey plans, separately preserving per-row originating serviceDay/profile/fingerprint/weekdays/serviceMinute, ordered calls and exact departure dates. Publication source identity is distinct from an itinerary response digest. Calendar ambiguities, unknown destinations/routes/via, physical platform/live-clock fields and an arbitrary publication URL are rejected. An explicit via must name one selected-line station. Full publication plans require it in the complete calls (Northern Bank/Charing Cross must exactly match the path, other current publication adapters report no via). A bounded Journey leg may alight before its reported destination/via; its original ordered prefix stays unchanged and no stop is appended. Unsupported or contradictory via seed data is withheld rather than reinterpreted. At most two sources/32 rows each and 24KiB are admitted within the unchanged 32KiB endpoint limit. Original expiry is capped by 600/120 seconds and London midnight. The service attempts independent publication HEAD validation at the exact official URL before unrelated endpoints within an admitted refresh. A verified matching SHA corroborates publication identity; a verified changed SHA immediately rejects older timetable context, even when other endpoints are offline. If HEAD is unavailable or the current read admission has not elapsed, original client-qualified context may remain only until its original TTL. This HEAD-only path never renews original observations, clocks or expiry, and a matching HEAD does not qualify rows/profiles. Authority1 can renew a context only through the separate complete raw timetable qualification described below. Optional original closureEvidence carries up to eight shared lineStatus/stationDisruptions proofs, explicit optional closureWindows or legacy single periods plannedUnavailable and strict optional scheduledClockOnly. Fresh/expired original eligibility is validated without renewal; a client seed cannot clear newer independent scoped evidence. Raw admitted scheduled rows remain separate from their temporary availability mask. Known named nonclosure statuses (Good Service, Minor Delays, Severe Delays, Reduced Service) qualify planning applicability only; Part Closure, Bus Service, unknown labels and directional/affected-route restrictions do not become whole-board open or closed proof. A seed remains original client qualification: its claimed proof reference cannot create server authority. Authority1 seeds bind the exact publication ZIP, reviewed proof revision/body and independent original HEAD observation; declared publication directions and each row's originating service-day/profile must match that reviewed local body. Well-shaped obsolete publication plans are omitted at their source while independent Journey/live/arrival context and normal registration acknowledgement remain available; malformed wire fails validation. Clients without authority1 retain legacy seed behavior and cannot submit adopted-reference or scoped-direction seeds. Bounded Journey own-leg disruption guards are unchanged. Its Journey context is explicitly bounded and may omit other branches, later departures or a line whose own leg fields do not qualify. Missing sources remain coverage gaps. Source-capture replays and deterministic worker tests are separate from current operational, physical-station and real-device APNs acceptance. Deployment, app negotiation, physical expiry/render evidence and rollout approval remain integration-owner gates.

ServiceClosed20 is distinct from physical station closure. An originally fresh exact parent-line/mode response with literal validity and fully validated outgoing-origin entire sections restricts scheduled own clocks inside those periods. Unsupported relevant scope remains conservative clock-only unavailable; malformed/unverifiable authority cannot qualify a new planned read or become open evidence. Predicted live clocks and untimed facts remain independent. Line/status and selected station controls finish before the one Journey query. Only this read's fresh complete exact terminal clock-only authority, with every still-relevant period represented, may move that query past the connected restriction containing actual dispatch. Overlap/adjacency are respected; disjoint later gaps are not skipped. The query clock/searchCriteria differ from actual HTTP dispatch/completion clocks, which alone govern original expiry and London midnight. Expired, partial or persisted-only authority cannot authorize a shift. No second query, new target, reopening or first-operating-train claim follows an empty result.

### Original-clock timetable renewal and negative authority

During an admitted 90-second refresh, an authority1/presentation2 board may read
its exact selected-station timetable only when the current official ZIP identity
has a reviewed local proof entry for that station and actual line. Origin entries
use one GET; an entry declaring inbound/outbound definitions uses at most two
scoped GETs, both required before one complete combined context is admitted.
No existing seed is required. Qualification checks the needed yesterday/today
originating service days, holiday/date-range coverage, profile multiplicities,
whole ordered calling paths, destination identity and exact scoped direction.
Unknown or incomplete evidence cannot qualify an empty timetable. Raw response
bodies are bounded to 2,000,000 bytes. Final line/station controls must still
qualify before admission; this does not relax Journey disruption guards or
availability masks.

The shared timetable clock is the minimum original Date/Age-derived observation
from official HEAD, every required timetable response and the line/station
controls. Expiry remains that observation plus 600 seconds, capped at London
midnight. Neither completion order nor a resource/metadata/304 read restamps it.
Only a newly complete qualifying source read creates a new context. Transient
failure retains useful prior context until its original expiry; an authoritative
publication/profile rejection removes only the affected timetable source.
Cache-only row/source boundary pushes do not admit feed or timetable reads.

Independent original HEAD identity and proof revision/body conflicts are stored
transactionally with the registrations. A same-ZIP corrected body can invalidate
old plans without waiting for their row clock, expiry or an app update. Stale
observations and queued callbacks cannot undo newer negative authority. The
legacy per-record rejection marker still uses that record's original context in
either worker order; global authority filtering cannot transfer another board's
proof or erase its rejection evidence. These are source behavior, not a claim
that current publication assets or deployed renewal are available.

### Timetable publication proof resource (source prepared, deployment pending)

TB-085 adds the fixed `GET`/`HEAD` route `/api/timetable-publications/v1/{publicationSHA256}`. The lowercase SHA identifies the independently observed official publication. Its bounded, canonical wrapper carries an ordered proof revision, exact proof-body SHA and base64 body; the app validates the body and applicable service calendars before adopting it. Exact ETags support conditional reads. Invalid or missing assets return `no-store` errors. Metadata, HEAD or 304 alone never renew a departure clock or the original timetable context TTL.

The local authority reader and HTTP route now use the same module-relative `server/timetable-publications/v1/` directory. The existing Docker `COPY server` includes that location without a new Dockerfile rule, and default reads remain independent of process working directory. The old `public/timetable-publications/v1/.gitkeep` is historical and is not the authoritative asset location. No current publication asset or running maintainer is installed. The reviewed app-side packager uses atomic publication and increasing revisions. The TubeBoard engineering integration owner must review the generator proof, publish the exact wrapper atomically and maintain current assets and same-ZIP corrections. This is not an automatic producer or an arbitrary remote timetable proxy. Source now includes the bounded backend requalification path, but the empty asset directory cannot exercise it operationally. Publishing/maintaining assets, current source acceptance, installed-client adoption, authorized deployment and normal closed-app APNs expiry remain separate gates. Proof wrappers are capped at 2,000,000 bytes and decoded proof bodies at 128KiB; excess evidence is unavailable, never truncated.

For the preceding resource-only source slice, six focused loopback resource tests and all 240 repository tests passed, together with syntax, formal schema-shape and whitespace checks. The app and service resource schema bytes match. Required Fly configuration validation could not complete on 3 October 2026 because the local CLI had no access token. The workspace audit found the separately prepared v2 registration contract absent from service main; it does not establish a merged, deployed or production contract pass. PR #24 remains draft and this slice remains undeployed.

The timetable-renewal verification consumed actual Swift-produced original-clock
fixtures for all 13 legacy proof entries and the complete Goodge Street
two-direction context, including its exact 32-row registration seed. Stage 8
passed three preparatory syntax checks, all 79 focused tests, all 264 repository
tests, 11 formal checks, whitespace and the complete 19-path scoped diff; its
exact source was independently reviewed. The preceding stage-7 run remains
retained: 259/264 tests passed, five failed, and the test failure prevented the
chained production syntax checks and diff from running. Its preparatory syntax
and formal checks had passed. The minimal stage-8 corrections preserve legacy
restart shape, per-record rejection evidence and original publication
corroboration in the closure fixture.

All eight local endpoint checks passed after an initial seven-of-eight failure
was corrected by an explicit Node HTTP Host transport. Authenticated Fly
configuration validation remains blocked by the local CLI's missing session;
this is not a demonstrated configuration defect. The exact Node 22.21.1 slim
image was acquired and its Linux arm64 version verified. Its isolated runtime
run reported 255 passes and nine failures out of 264 tests, with no skips. All
nine failures are unchanged website-deploy tests whose Python 3 subprocess is
unavailable in that image (`spawnSync python3 ENOENT`); no timetable or publication
authority test failed. This remains a failed full runtime check, separate from
the passed host suite. The existing Service Quality workflow runs the full check
under Node 22 on Ubuntu with Python 3 available. For source22 checkpoint78061231,
run37147980594/job111275752522 actually passed all264 tests under Nodev22.23.3,
syntax and repository checks. Its Python Fly TOML parse passed independently of
the unauthenticated flyctl result. This CI is not the exact22.21.1 image run. No test, workflow or Dockerfile was
changed to bypass this result. These checks are not current HTTP,
physical-station, native closed-surface or APNs acceptance.

Current assets and maintenance, installed default-client adoption, 19-line
current source coverage, native own/source expiry, capability ACK and real APNs,
authenticated Fly validation, the exact-image full runtime gate and authorized
deployment remain explicit gates. No beta, deployment or release action follows
this source pass. Service version remains 1.4.4; optional capabilities do not
change the existing contract name or public version.

The separate server-owned-directory adapter passed two syntax checks, all seven
resource tests (six existing plus one default-reader/HTTP agreement regression),
and all265 host tests, chained syntax/repository checks, whitespace and its exact
three-path diff. The new test owns one exclusive synthetic asset and confirms
matching default local bytes, HTTP GET/HEAD/304 and absent-asset rejection from a
changed working directory; teardown preserves unrelated data. It does not install
a maintained publication or renew any timetable clock. Its actual receipt is
`1ebf1f7b70d1f0b39979a48a1ee1a12803d91c631c3b757f7c50464a8c1d3847`.
The source22 CI and prior host264 evidence remain distinct; this later adapter
checkpoint's CI and deployment are not established by those preceding checks.
