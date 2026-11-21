# Ordinary timetable fallback for active station boards

The existing worker may read a station's ordinary TfL timetable when a typed Activity advertises `supportsRegularTimetable: true`. Only exact origin station/line pairs with a supported service calendar are eligible. At a mixed origin, the working must have an exclusive outbound first call from the published route map. The timer represents a scheduled departure from an ordinary profile. The feed does not identify a platform, so an explicitly selected platform does not admit these rows.

The original HTTP age controls eligibility. The worker enforces the response cache limit and caps the presentation at the earlier of ten minutes from receipt and London midnight. Dated withdrawal and no-service controls override the regular profile. A 429 sets a retry floor. Live and dated rows take precedence when they answer the same direction and destination. No credential or timetable body is passed by the handset.

Regenerate the checked-in origin catalogue from the app checkout that owns the reviewed `PublishedLineMaps.json` and origin generator:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/import-regular-timetable-origins.py "$APP_CHECKOUT" > contracts/station-board-regular-origins-v1.json
```

The file records the app revision, atlas digest and the service catalogue digest. The test fixtures replay retained TfL responses for Stratford Jubilee, Epping, Edgware and the Circle line starting path from Edgware Road. Origin rules describe which runs can qualify, independently of whether a future service is operating. Older app versions continue to receive their existing wire vocabulary.

An Apple Activity push replaces its complete content. A capable handset may include `initialRegularDisplayUntil` only when a qualified ordinary departure is already visible. It sends an ISO-8601 UTC deadline capped by that train’s original departure and source expiry. The worker accepts it on the first exact-board registration, caps it at ten minutes and Activity end, and never renews it on replay or token rotation. While the deadline is still future and the worker has never successfully delivered content, it defers a replacement with no qualifying boarding clock after a provider failure. An independently qualified boarding clock, a fresh scoped closure or cancellation, or arrival at the original deadline overrides that guard. The deadline neither supplies rows nor extends any source state.

Deployment and a handset/worker handoff test remain necessary for end-to-end verification of this contract.
