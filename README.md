# TubeBoard Website

Production website and Live Activity service for [tubeboard.co.uk](https://tubeboard.co.uk/).

The static website is served by the Node service that also runs the Live
Activity API, Premium disruption-alert API, and their workers. The only
runtime package is Apple's official App Store Server Library, pinned in the
lockfile so Premium entitlement evidence can be verified server-side. Develop
locally with:

```sh
npm run dev
```

Run the release checks with `npm run check`. Production is deployed to the
existing Fly app only after explicit owner authorization using
`scripts/deploy-production.sh --confirm-production`; see
`docs/live-activity-service.md` for service configuration, central tracking,
revision evidence, and secrets.

Product scope and owner decisions are coordinated by `TB-NNN` Issues in
`olly-j/My-Train-Times` and the private TubeBoard Delivery Project. Read
`AGENTS.md` before changing this repository.

The public service also provides a server-rendered data-health page at
`GET /status` and a privacy-safe versioned response at `GET /api/status/v1`.
Those surfaces monitor the 11 Underground and six named London Overground
lines supported by TubeBoard v1.2. Existing disruption-alert clients retain
contract v1's Underground-only scope; contract v2 adds the six Overground IDs.
The production monitor is disabled by default outside Fly configuration so a
local development server never creates recurring TfL traffic unexpectedly.
