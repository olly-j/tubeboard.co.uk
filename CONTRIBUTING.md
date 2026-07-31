# Contributing To The TubeBoard Website And Service

Start with `AGENTS.md`. Every change must reference an owner-approved
`TB-NNN` Issue in `olly-j/My-Train-Times` and use a short-lived branch from
current `origin/main`.

Before opening a PR, run:

```sh
npm run check
flyctl config validate --config fly.toml
```

Use the PR template, describe backward compatibility and production impact,
and link the central Issue with `Relates to olly-j/My-Train-Times#NN`.
Merging does not deploy. Production deployment requires a separate explicit
owner instruction and the guarded script documented in
`docs/live-activity-service.md`.
