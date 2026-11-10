# Protected timetable publication admission

This optional service path receives a fully qualified, previously unseen TfL
edition from the protected timetable workflow. It stores immutable proof and
comparison-source bytes, independently rechecks the official edition, and
publishes only an admitted package through the existing versioned GET/HEAD
routes. Archived timetable bodies remain comparison references; fresh Unified
responses and current status/closure checks remain the only departure authority.

## Enablement boundary

The service writer is disabled unless
`TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_DIRECTORY` is explicitly configured.
The current `fly.toml` does not set it. A configured writer also requires
`TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_BASELINE_SHA256`; that exact wrapper
must already be published by the service. The persistent store captures that
baseline proof and any available source archive on first initialization.

Publish a reviewed baseline wrapper and its bundled source changes before
enabling the writer. The configured baseline hash and bytes must remain stable
for the admission ledger's lifetime. If a later packaged wrapper for that same
hash differs from the persisted baseline, initialization fails visibly:
`/healthz` remains available and reports
`timetablePublicationAdmissionConfigured: true` and
`timetablePublicationAdmissionReady: false`, and the process emits only the
fixed `timetable-publication-admission-init-failed` event. Do not silently
rebase or discard admission history. Resolve a baseline migration in a separate
reviewed operation.

When enabled in production, the directory must be on the existing persistent
`/data` volume, with a dedicated path such as
`/data/timetable-publication-admission`. Do not create or replace a volume.
The store uses mode `0700` directories, mode `0600` files, create-if-absent
immutable objects, bounded temporary files on the same volume, atomic ledger
replacement and startup recovery. The current service deployment is not
configured to write this store.

## Protected caller contract

Every candidate write and private readback requires a GitHub Actions OIDC token
with audience `tubeboard-timetable-publication-candidate`, repository
`olly-j/My-Train-Times` (repository ID `1267669215`), `refs/heads/main`, workflow
`olly-j/My-Train-Times/.github/workflows/timetable-publication.yml`, and event
`schedule` or `workflow_dispatch`. Tokens are verified locally against GitHub's
issuer and keys. No token or caller-controlled URL is persisted or logged.

For a new publication SHA, the workflow uses these immutable staging calls:

1. `PUT /api/timetable-publication-candidates/v1/{publicationSHA256}/proof`
   with the exact canonical v1 proof wrapper (at most 2,000,000 bytes).
2. `PUT .../{publicationSHA256}/archives/{proofBodySHA256}/manifest` with the
   exact producer comparison-reference manifest (at most 256 KiB).
3. `PUT .../{publicationSHA256}/archives/{proofBodySHA256}/bodies/{bodySHA256}`
   once per unique manifest body (at most 8 MiB each; source archives are
   limited to 32 MiB total).
4. `POST .../{publicationSHA256}/admit` with an empty body,
   `If-Match: "{previousResourceSHA256}"`, and
   `X-TubeBoard-Resource-SHA256: {candidateResourceSHA256}`.

Proof, manifest and body PUTs are idempotent only for identical bytes. Any
different bytes at the same immutable path fail. Staging is private and is not
served by the app's proof or source-body endpoints. Admission rereads and
validates every staged object, enforces the complete proof-to-manifest-to-body
binding, compares all previously supported qualified directions and still
effective service dates, verifies a fresh matching independent TfL edition
observation before and immediately before the commit, checks the previous
resource precondition, and stores one monotonic receipt. Same-edition revisions
and previously admitted edition hashes cannot be replayed as new publications.

The protected receipt endpoint is
`GET /api/timetable-publication-candidates/v1/{publicationSHA256}`. It returns
the original receipt bytes, including the admission revision, prior and new
resource digests, proof and manifest digests, source counts and observed time.
Private authenticated `GET` paths ending in `/proof`,
`/archives/{proofBodySHA256}/manifest`, or
`/archives/{proofBodySHA256}/bodies/{bodySHA256}` return exact stored objects
for independent transfer verification. Repeating the final POST with the
original `If-Match` and resource digest returns the same receipt, including
after process restart. For a still-retained package, the service also rehashes
its stored wrapper before returning that receipt.

After admission, the existing unauthenticated
`GET`/`HEAD /api/timetable-publications/v1/{publicationSHA256}` and
`GET`/`HEAD /api/timetable-source-bodies/v1/{publicationSHA256}/{proofBodySHA256}/{lineID}/{stationID}/{direction}/{bodySHA256}`
routes expose only the admitted immutable bytes. No active pointer, row
qualification rule, or departure source is changed. On restart, the service
validates the full receipt chain and retained packages before exposing them.

## Bounds and rollback

At most one incomplete candidate is staged at a time; staging expires after
24 hours, with a maximum package budget of about 34 MiB. The service retains
the current and preceding admitted payload packages, limited to 128 MiB
combined, and keeps compact immutable receipts for up to 10,000 monotonic
admissions. Superseded managed packages are pruned only after the new receipt
is durable; startup repeats this cleanup after a crash. The existing in-memory
source-body index remains bounded to 32 MiB and 16 archive packages. A full
limit or corrupt ledger fails admission closed and leaves existing bundled
proofs and rider routes available.

Rollback of service source must preserve `/data`; do not delete or recreate the
volume. A rollback to a service build without this reader cannot serve a newly
admitted edition. Before any future enablement, retain the previous service
image/source and record the exact admitted resource/receipt readbacks. If the
admission code has a defect after public readback begins, stop new workflow
admissions, restore the last verified service source, and keep the existing
volume intact while a compatible reader or a verified return to the prior
official edition is established. This document does not authorize production
enablement or data mutation.

Local route behavior, concurrency, crash recovery, receipt replay, payload
rotation and public GET/HEAD visibility are exercised by
`test/timetable-publication-admission-store.test.js`; the pure preflight checks
are in `test/timetable-publication-admission.test.js`.
