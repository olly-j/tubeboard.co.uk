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
and the queue plus completed set to 256 scopes, and runs one preparation at a
time through the existing `SerialWorker`. Healthy unchanged editions do no
preparation. The existing observer is the intended trigger; this module adds
no periodic polling loop. Qualification success requires a matching admitted
identity and a still-current official edition. The producer must report any
unresolved requested scopes; the coordinator cannot qualify them itself.

Attempt reservations survive restart. Failures retry after 1, 5 and 30 minutes,
then at most every six hours, rotating unresolved requests so other stations
can progress. A new official edition resets the old edition's retry budget.
Graceful cancellation retains pending work without counting a failed attempt.
Three unsuccessful attempts retain one incident per edition. The injected
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
exact commit and all 12 file hashes. `scripts/sync-timetable-producer.py` copies
only that reviewed committed import/data closure; `--check` verifies it without
network or access to the app checkout. Repository checks also import its CLI.
The Docker image does not copy or run this bundle yet. Updating the producer
requires a reviewed source commit and an explicit bundle sync, not downloading
arbitrary code into the running service.

The earlier reviewed origin-parser projection was pinned from app commit
`940c43a505e3a0cc6bcccefeeeeac8e070a755b8`. It preserves all 51,592 origin rows
and 21 member records in the real-archive comparison and passed 112 affected
Python tests. Full qualification measured 691.7 MiB after this change. This is
still not suitable for the 256 MiB service; selected-call parsing is unchanged.

The current bundle pins app commit `27ec00a1be4f7d3dce8ff24b5f68576c2bcfb363`.
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
