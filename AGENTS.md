# TubeBoard Website And Service Agent Instructions

This repository contains the public website and production Live Activity push
service. It is part of the TubeBoard workspace coordinated from
`olly-j/My-Train-Times` and the private TubeBoard Delivery Project.

## Authority And Tracking

- Product scope, owner decisions, feedback, release intent, and stable
  `TB-NNN` IDs live in `olly-j/My-Train-Times`.
- Service implementation, tests, Fly configuration, and deployment history
  live here.
- The versioned registration contract lives in
  `contracts/live-activity-registration-v1.schema.json`; the app repository
  retains an audited identical copy so either repository can be used offline.
- Every change requires an owner-approved app-repository `TB-NNN` Issue. Use
  `Relates to olly-j/My-Train-Times#NN`; do not open a competing service
  backlog or close the central Issue from a service PR.

If repository documents conflict, preserve evidence and reconcile both
repositories in the same task. Never silently choose one side.

## Required Work Loop

1. Read this file, `README.md`, `docs/live-activity-service.md`, the central
   Issue, and the app-side contract before changing behavior.
2. Start from current `origin/main` on `codex/TB-NNN-short-slug` or the
   documented human equivalent.
3. Assess compatibility with the App Store build already in users' hands and
   the build currently under review. Registration additions must be optional
   until every supported app build sends them.
4. Make the smallest complete change. Preserve website, `/privacy`, `/support`,
   `/healthz`, registration, APNs environment selection, token retention, and
   volume safety outside scope.
5. Run `npm run check`, `flyctl config validate --config fly.toml`, and focused
   local endpoint checks. Never use production tokens in tests.
6. Reconcile the central Issue/Project, contract copies, documentation, and
   source/deployed revision record before handoff.

## Production Safety

- Never commit `.env`, APNs keys, TfL keys, runtime token records, Fly tokens,
  logs containing tokens, or `/data/live-activities.json`.
- Treat `pushTokenHex`, install IDs, activity IDs, and stored records as
  sensitive operational data. Do not expose them in logs or health output.
- Preserve the persistent Fly volume and single-worker assumption.
- A merge is source-ready, not deployed. Only an explicit owner instruction
  authorizes `scripts/deploy-production.sh --confirm-production`.
- A deployment handoff must record the source SHA, service version, contract
  version, Fly release, health response, checks, rollback revision, and any
  physical-device validation gap.
- Do not introduce automatic production deployment without a separate owner
  decision and least-privilege/security review.

## GitHub And Review

- PRs target `main`; squash is the default for one coherent work item.
- The lightweight Service Quality workflow is permitted. Do not add macOS,
  scheduled, deployment, matrix, cache, artifact, or third-party Actions
  without an approved central backlog change.
- Keep `main` protected, require the service check, resolve review threads,
  and delete merged branches.
- Do not mark app work shipped based on this repository. Public app
  version/build truth remains in the app repository and App Store records.
