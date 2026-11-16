# Timetable recovery preparation (TB-085)

Central scope: [My-Train-Times #298](https://github.com/olly-j/My-Train-Times/issues/298).
The owner stopped recurring GitHub Actions after excessive usage. Recovery
belongs in this service, using the existing edition observation and one shared
verified archive. This document describes source preparation, not deployment.

`TimetablePublicationAdmissionStore.admitTrustedPackage` accepts an in-process
producer's bounded bytes and expected predecessor resource hash. It performs
the existing proof, source archive, official edition and atomic publication
checks. Same-edition additions require the next revision, unchanged previous
qualified entries and unchanged calendar semantics. The external HTTP admission
route keeps its OIDC requirements and new-edition behavior.

Trusted packages use an immutable edition/revision/proof-hash directory key.
Public edition reads return the newest retained wrapper; earlier proof-bound
comparison sources remain available within the existing retention bounds.
Legacy SHA-only receipts remain readable. Older binaries cannot read the new
receipt field: a rollback must preserve the volume and use a compatible reader.
Do not replace or reset the ledger to make an old binary start.

`TimetableRecovery` is a prepared coordinator; it is not wired into the server.
It joins repeated validated station requests, limits each batch to 32 scopes
and reserves up to 256 required scopes plus 256 nonmandatory demands. It runs
one preparation at a time through the existing `SerialWorker`. Healthy unchanged editions do no
preparation. The existing observer is the intended trigger; this module adds
no periodic polling loop. Qualification success requires a matching admitted
identity and a still-current official edition. The producer must report any
unresolved requested scopes; the coordinator cannot qualify them itself.

Attempt reservations survive restart. Failures retry after 1, 5 and 30 minutes,
then at most every six hours, rotating unresolved requests so other stations
can progress. A new official edition resets the old edition's retry budget.
Graceful cancellation retains pending work without counting a failed attempt.
Three unsuccessful attempts retain one incident per continuous unresolved episode. The injected
alert transport uses its stable incident key for best-effort deduplication. Failed or absent alert
delivery remains pending; it is never recorded as acknowledged. Neither raw
provider errors nor customer identifiers are persisted in this state.

The prepared `GitHubTimetableRecoveryAlert` posts only a fixed failure reason
and public publication hash to the existing central Issue. It is not wired
into the server. A durable reservation, trusted author identity and exact
comment lookup prevent ordinary duplicate delivery after restart. GitHub
comment creation provides no exactly-once guarantee: after an ambiguous
response, a later complete lookup and at least 30 minutes of quiescence permit
a retry. A delayed original comment can therefore produce a duplicate. This
bounded retry is intentional so an uncertain response does not permanently
silence an operational alert. Incomplete or rate-limited lookups remain pending.
The prepared coordinator now persists an edition generation before handing
authority to the alert transport. Idempotent replay repairs either cross-store
crash window, while older generations cannot restore a superseded incident.
Alert authorization failure suppresses delivery for that attempt but does not
prevent healthy timetable recovery. Server construction and credential
configuration remain activation gates; this source is not running in production.
The reviewed transport and coordinator passed 45 focused tests, including
ambiguous delivery, rate limits, bounded pagination, durable restart and
supersession, both cross-store crash windows and failed alert authorization.
Each authorized edition starts its own lookup horizon so old
issue history cannot permanently exhaust the page bound for later incidents.

Required before activation:

- Package and exercise the app repository's requested-scope producer and its
  verified cached-archive input, preserving original source clocks.
- Connect actual demand/rollover scopes without assuming the global public
  proof URL currently carries a station. It does not. App source-body URLs
  carry a scope only after qualification, so cannot recover an initial 404.
- Verify the preparation path fits the existing single 256 MB machine while
  notification workers remain responsive. Do not silently increase hosting.
- Supply and test a least-privilege operator-alert transport. Production has
  no outbound operator-alert credential configured. Customer APNs tokens and
  diagnostic observation sockets are not substitutes.
- Verify source/receipt retention limits, including the finite admission
  history, and recovery across restarts and deployment rollback.
- Run complete service checks, local endpoints, protected deployment and
  production readback. Keep installed app and physical APNs acceptance separate.

There is no all-terminus coverage, production recovery or delivered-alert claim
from the unit tests or this source preparation.

Local verification on 16 November: `npm run check` passed all 458 tests,
including 22 admission/store and 16 recovery tests; Fly configuration validation
passed. A real local server returned the expected responses for health, home,
privacy, support, a bundled publication, a missing publication and the disabled
edition observer (503). The coordinator received independent source review
after correcting expired-authority completion and a stranded alert retry.

The first real retained-data resource measurement blocks activation of the
unchanged producer on this service. macOS/Python 3.15.2 qualification of the
133,106,037-byte `788955e8…` official archive used 828.9 MiB maximum resident
memory (14.11 seconds); archive parsing alone used 532.7 MiB (7.35 seconds).
These are not Linux-container acceptance measurements, but neither supports
cohosting the parser with notifications on the existing 256 MiB machine.
Narrower API batches cannot eliminate the full-archive parse cost. Preserve
production configuration while reducing and measuring that cost.

The source bundle under `runtime/timetable-producer` pins the app producer's
exact commit and all 13 file hashes. `scripts/sync-timetable-producer.py` copies
only that reviewed committed import/data closure; `--check` verifies it without
network or access to the app checkout. Repository checks also import its CLI.
The prepared Docker image copies this closure; server recovery is not activated. Updating the producer
requires a reviewed source commit and an explicit bundle sync, not downloading
arbitrary code into the running service.

The earlier reviewed origin-parser projection was pinned from app commit
`940c43a505e3a0cc6bcccefeeeeac8e070a755b8`. It preserves all 51,592 origin rows
and 21 member records in the real-archive comparison and passed 112 affected
Python tests. Full qualification measured 691.7 MiB after this change. This is
still not suitable for the 256 MiB service; selected-call parsing is unchanged.

The earlier bundle pinned app commit `27ec00a1be4f7d3dce8ff24b5f68576c2bcfb363`.
It includes bounded disk-backed record streaming, property-level calendar
inheritance, explicit dated exclusions and separate origin/selected lifetimes.
All 207 affected Python tests passed, and the retained current-edition replay
qualified all 14 previous scopes without network requests or admission. It
preserves acquisition clocks and released proof fields. This is not all-network
coverage or a fresh live parity result.

Capacity remains blocked. The streamed parser's earlier archive measurement
fell from 689.19 to 254.27 MiB, but the newly supported calendars in current
edition `21d82a62…` require more work: the final current-edition replay measured
357,859,328 bytes RSS (341.28 MiB) and 54.03 seconds on macOS. Separating origin
and selected phases changed that peak by only 0.21%. Neither result supports
cohosting this producer with notifications on the existing 256 MiB machine.
No Linux co-resident acceptance, resource increase, server activation or
production deployment follows from the pinned bundle.

The integrated prepared service passed `npm run check` on Node 22.21.1:
516 tests passed, followed by syntax, repository and 12-file bundle-provenance
checks. Fly configuration validation passed. These checks do not activate the
new modules or replace the unresolved production resource and delivery gates.
Seven local HTTP checks also passed with all workers disabled: health, home,
privacy, support, a bundled publication, missing publication and disabled
observer. Earlier diagnostic attempts used incorrect health/publication paths;
their failures are retained alongside the corrected canonical-route check.

A later real live-parity attempt exposed a missing lazy data dependency:
`PublishedLineMaps.json`, used by the Tram catalogue even while checking Tube
lines. The bundle now includes that exact committed file. The deterministic
repository check loads the real live-parity and Tram catalogues offline
(20 lines, 39 Tram stations); a separate missing-map copy reproduces the failure.
All original 12 files remain unchanged in this closure correction. Monitor-only
workflow fingerprinting and the standalone API-health fixture CLI have separate
data dependencies outside this preparation/live-parity runtime path; no claim
of completeness is made for those dormant entry points.

The current bundle pins app commit `124e8bd573000f68df5acd1b938910c14f51d2eb`.
This producer update stores origin sections on disk and reuses
normalized journey keys within each qualification call. The current-edition
macOS peak is now 131.77 MiB, with unchanged complete proof output. Current
departure relevance in the producer's live comparison and service consumer
requires yesterday whenever any validated raw offered row can still depart
before the next London midnight; today always receives full validation.
All raw clocks are checked before choosing relevant dates or applying exclusions.
Historical conflicts and overnight safeguards remain intact. All 221 affected
Python tests and 521 service tests pass; the retained live-response replay
passes 14/14 at its original acquisition clocks, not as a new live admission.

A local emulated x86_64 probe ran the exact producer beside Node with one CPU,
256 MiB, no swap and no network. All 14 scopes qualified in 98.331 seconds;
384 health checks passed, with no OOM. The full cgroup memory limit was reached
and 627 pressure events occurred. This is bounded HTTP coexistence evidence,
not spare capacity or notification/APNs acceptance. The image and exact input,
output and source bindings are retained in the integration owner's external
`tb085-linux-capacity-20261116/capacity-final-receipt.json`. Actual server wiring,
alert credentials, notification workload acceptance and production readback
remain required. No production activation or hosting increase occurred.

## Prepared producer adapter

`TimetableRecoveryProducer` now connects the existing admission contract to
the exact bundled producer. It validates the 13-file manifest, fixed commands,
actual prior resource identity and predecessor comparison before admission.
It reuses verified archive bytes with their original acquisition clocks.
Empty rollover requests may seed a scope only from the validated prior
publication; missing history is a bounded failure, not invented coverage.

Canonical cache/work roots must be disjoint. Retained editions, individual
files, output, entry counts and elapsed child work are bounded; the workspace
watchdog is sampled and does not establish a hard instantaneous allocation
limit. Final acquisition contents are checked again before retention. Unknown
cache entries are rejected without deletion. Cleanup occurs only under
exclusive custody and cannot remove a nested caller directory.

OS-owned advisory locks replace crash-stale directory locks. A fixed Python
holder keeps custody across acquisition, preparation and admission; workers
inherit the lock descriptors and have an independent bounded lifetime.
Cancellation, parent/holder death and natural/error worker completion terminate
remaining owned descendants before cleanup. A later attempt recovers without
manual lock removal or unsafe PID/age takeover. Already-running watchdog scans
cannot cancel a later job after their original job has settled.

Independent review cleared the final adapter and regressions. All 545 Node22
tests pass, including 24 focused adapter cases, real bundled archive receipt
reuse, fixed launcher contracts, actual process crashes and lock reacquisition.
This remains preparation: the extra interpreter and watchdog need measured
full-workload capacity, Docker must include the exact bundle and Python tools,
and server construction, actual demand/rollover wiring, alert credentials and
production readback are still absent. Cooperative admission callbacks must
honour cancellation; a timeout must not leave an unobserved mutation running.

## Full image integration boundary (16 November)

The prepared image now includes Python, curl, CA roots, timezone data and the
explicit thirteen-file producer closure. It does not activate recovery. The
reviewed adapter hashes cached ZIPs with one reusable 64 KiB buffer and verifies
the opened file's identity, size and timestamps before and after reading.
All 547 Node 22 tests pass, including 26 focused adapter tests.

Full preparation in the actual Linux/amd64 image (locally emulated) failed at
256 MiB twice with exit 137 / OOMKilled, during a second archive copy and before
qualification. The fixed buffer reduced isolated hashing RSS by about 11 MiB;
it did not establish hosting capacity. One separate 512 MiB diagnostic avoided
OOM but failed before admission. A retained-input replay independently
reproduces future dated-coverage losses caused by conflicting publication
members; it is not a captured traceback from that diagnostic. The previous
qualifier-only 256 MiB result remains valid only for that narrower experiment.

Neither full recovery, publication admission nor notification cohosting has
passed. No production capacity, deployment, scheduled workflow or server
activation changed. Evidence is retained in the external release evidence
`20261116-tb085-current-edition/runtime-image/receipt.json`; both OOM results and
the separate coverage failure remain unresolved acceptance gates.

The subsequent producer bundle at `333aa08dac07fe8560b87c63e219a4df1773913e`
keeps only one private archive copy, synchronizes its completed writes, and
requests private cache release where supported. All 51 focused producer tests
and independent source review passed. A single complete historical replay
on exact image `sha256:c44d324b6c217d276f2ce0bc7c6bfe3033faef835db18dfcecee70f46fc44f1c`
finished qualification in 103.463 seconds at 256 MiB without OOM. The recorded
private-file cache release lowered cgroup usage by about 145 MB at that
boundary; overall peak still reached 256 MiB with 1,541 pressure events.
This does not establish notification cohosting or full recovery capacity.

Actual retained child stderr confirms that preparation then failed the
unchanged prior-date coverage guard for twelve station/date pairs. No live
comparison or admission ran, and no packaged proof was emitted. Historical
source clocks and cache receipts remain byte-identical. At that checkpoint the current-service-day correction remained a proposal.
Production and server activation were unchanged; the subsequent implementation
is described below.


## Current service-day recovery (ADR024, prepared)

The canonical app ADR024 and producer bundle at
`f8e224b292e1cc0949b3719a8a03c614fc697963` replace the cross-edition demand to
preserve every old future date with verified coverage of the full current
London service day. Every previously qualified station/direction remains
mandatory. Yesterday is also required when structurally valid offered rows
can still contribute at the assessment instant. Future conflicts remain
explicit gaps: no conflicting XML winner, copied trains or inferred closure.
Same-edition additive immutability remains unchanged.

Admission, producer readback and recovery use the same pure comparison core
as runtime qualification, with the actual archived source bytes bound to the
exact publication and proof identity. Observation freshness remains a separate
runtime gate. Recovery reassesses the current day and proof on the existing
worker, including after restart; it cannot treat an old completed request as
permanent coverage. Required scopes and accepted demand have separate bounded
reservations of 256 each, with batches of 32. The combined queue never exceeds
512 scopes.

An unresolved incident continues across calendar changes. A verified healthy
interval permits a distinct later incident for the same edition. Durable
transport custody and one bounded oldest resolution handoff preserve recovery
messages through offline periods and restart. This adds no polling job or
scheduled GitHub workflow. A rollback reader must support the new incident
episode semantics; an older reader is not a verified rollback merely because
it accepts the outer state version.

The initial integrated source check passed all 588 Node 22 tests. Independent
review then found a new-request race at the queued healthy-state write; its
correction rechecks pending requests within the transaction. Both prior-phase
regressions and all 110 affected coordinator, transport, producer and assessment
tests passed. Integration acceptance remains separate.
The canonical producer separately passed 53 preparation and 16 live-parity
tests. These are source checks, not production or end-to-end capacity proof.

The offline image harness replays retained HTTP responses at their original
clocks. It assesses after the latest retained comparison response; repeated
final-resource, official-HEAD and missing-resource checks explicitly reuse
original captures, including the original 404. This historical boundary replay
is not a temporally coherent fresh network acceptance run or production
readback. Full preparation/local admission, current live comparisons,
notification cohosting at the existing memory limit, server activation and
restricted alert credentials remain delivery gates. No hosting increase or
production activation is included in this prepared change.
