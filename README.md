# TubeBoard Website

Production website and Live Activity service for [tubeboard.co.uk](https://tubeboard.co.uk/).

The dependency-free website is served by the Node service that also runs the Live Activity API and worker. Develop locally with:

```sh
npm run dev
```

Run the release checks with `npm test`. Production is deployed to the existing Fly app from this repository using `flyctl deploy --remote-only`; see `docs/live-activity-service.md` for service configuration and secrets.
