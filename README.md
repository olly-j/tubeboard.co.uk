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

TB-085 prepares optional typed station-board pushes with presentation capability
2 and publication-authority capability 1 on the existing token endpoint. A
reviewed local publication proof can qualify a bounded selected-station timetable
read against the original official HEAD, service calendars and current controls;
HEAD or a proof-resource cache hit alone never extends a departure's expiry.
Legacy clients keep their existing contract. The HTTP route and local authority
reader share the module-relative `server/timetable-publications/v1/` directory,
which the existing Docker `COPY server` includes independently of the working
directory. No publication asset is installed or running maintainer established.
The adapter passed seven focused resource tests and all 265 host tests. The
preceding source22 checkpoint78061231 separately passed all 264 Service Quality
CI tests under Node v22.23.3 with Python3; original-clock Swift-to-Node parity
and eight local endpoint checks also passed. The exact Node22.21.1 slim image
retains its 255/264 passes and nine missing-Python3 website-test failures.
CI Fly TOML parsing passed; authenticated flyctl validation remains unresolved.
Maintained current assets, deployment and normal closed-app APNs acceptance
remain required. See
`docs/live-activity-service.md` for qualification and compatibility boundaries.

The public service also provides a server-rendered data-health page at
`GET /status` and privacy-safe versioned responses at `GET /api/status/v1`
and `GET /api/status/v2`. Status contract v1 retains its 11-line Underground
scope; v2 and the HTML page cover those lines plus the six named London
Overground lines supported by TubeBoard v1.2. Existing disruption-alert clients retain
contract v1's Underground-only scope; contract v2 adds the six Overground IDs.
The production monitor is disabled by default outside Fly configuration so a
local development server never creates recurring TfL traffic unexpectedly.

TB-077 sharing uses `GET /train/v1#<public-selection>` as the uninstalled-app
fallback and `GET /.well-known/apple-app-site-association` for the exact app
association. The bounded selection stays in the URL fragment, so it is never
sent in the HTTP request. The page validates it locally, displays only its line
and expiry state, and offers the live App Store listing; it stores no journey,
device, account, purchase or recipient data.
