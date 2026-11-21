# Ordinary timetable fallback for active station boards

The existing worker may read a station's ordinary TfL timetable when a typed Activity advertises `supportsRegularTimetable: true`. Only exact origin station/line pairs with a supported service calendar are eligible. At a mixed origin, the working must have an exclusive outbound first call from the published route map. The timer represents a scheduled departure from an ordinary profile. The feed does not identify a platform, so an explicitly selected platform does not admit these rows.

The original HTTP age controls eligibility. The worker enforces the response cache limit and caps the presentation at the earlier of ten minutes from receipt and London midnight. Dated withdrawal and no-service controls override the regular profile. A 429 sets a retry floor. Live and dated rows take precedence when they answer the same direction and destination. No credential or timetable body is passed by the handset.

Regenerate the checked-in origin catalogue from the app checkout that owns the reviewed `PublishedLineMaps.json` and origin generator:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/import-regular-timetable-origins.py "$APP_CHECKOUT" > contracts/station-board-regular-origins-v1.json
```

The file records the app revision, atlas digest and the service catalogue digest. The test fixtures replay retained TfL responses for Stratford Jubilee, Epping, Edgware and the Circle line starting path from Edgware Road. Origin rules describe which runs can qualify, independently of whether a future service is operating. Older app versions continue to receive their existing wire vocabulary.

A newer push replaces an Apple Activity's complete content. A capability flag by itself supplies no provenance for a newer phone-only local fallback that the worker has never successfully observed. A deployment and end-to-end handoff test are required before claiming that guarantee.
