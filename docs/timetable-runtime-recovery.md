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
alert transport must honor its stable idempotency key. Failed or absent alert
delivery remains pending; it is never recorded as acknowledged. Neither raw
provider errors nor customer identifiers are persisted in this state.

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
