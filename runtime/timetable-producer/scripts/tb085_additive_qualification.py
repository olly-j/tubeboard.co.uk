"""Preserve previously qualified scopes while extending the same official TfL edition."""
from datetime import datetime, timezone
import hashlib
import json
import time

import tb085_reference_readback as references
from tb085_live_parity import check_live_coverage


def select_entries(previous, candidate, roster, today, fetch):
    # Both documents must describe the same archive, calendar, operating rules
    # and XML members. Only the enumerated station scopes can be extended.
    def rules(body):
        return {key: value for key, value in body.items() if key not in {"entries", "coverage"}}

    # A later download of identical bytes has a new receipt. Keep the original
    # edition capture in the combined proof so clients can verify predecessor
    # aliases. The candidate's actual acquisition stays in publication-download.
    original_clock = previous["publication"]["capturedAt"]
    fresh_clock = candidate["publication"]["capturedAt"]
    original = datetime.fromisoformat(original_clock)
    fresh = datetime.fromisoformat(fresh_clock)
    if original.utcoffset() is None or fresh.utcoffset() is None or fresh < original:
        raise ValueError("Invalid same-edition acquisition clocks")
    candidate = dict(candidate, publication=dict(candidate["publication"], capturedAt=original_clock))
    if rules(previous) != rules(candidate) or previous["coverage"]["catalogueLineIDs"] != candidate["coverage"]["catalogueLineIDs"]:
        raise ValueError("Same-edition operating rules or catalogue changed")
    prior = {(e["lineID"], e["stationID"]): e for e in previous["entries"]}
    offered = {(e["lineID"], e["stationID"]): e for e in candidate["entries"]}
    expected = {(r["lineID"], r["stationID"]) for r in roster}
    if (len(prior) != len(previous["entries"]) or len(offered) != len(candidate["entries"])
            or set(offered) != expected or not set(prior) <= expected or len(expected) != len(roster)):
        raise ValueError("Same-edition qualification roster changed or contains duplicates")
    selected = []
    added = []
    rejected = []
    for row in roster:
        pair = row["lineID"], row["stationID"]
        old, new = prior.get(pair), offered[pair]
        if old and old["status"] == "qualified":
            selected.append(old)
        elif new["status"] == "qualified":
            errors = check_live_coverage(candidate, [row], today, fetch)
            if errors:
                rejected.extend(errors)
                selected.append(old or {"lineID": pair[0], "stationID": pair[1], "status": "gap",
                                         "gapReason": "Fresh timetable comparison did not qualify",
                                         "nonOperationBankHolidays": True, "profiles": []})
            else:
                added.append("/".join(pair))
                selected.append(new)
        else:
            selected.append(old or new)
    if not added:
        raise ValueError("No additional station passed both qualification and fresh timetable comparison")
    return dict(candidate, entries=sorted(selected, key=lambda item: (item["lineID"], item["stationID"]))), {
        "addedScopes": sorted(added), "retainedQualifiedScopes": sum(e["status"] == "qualified" for e in prior.values()),
        "rejectedFreshComparisons": rejected}


def retained_sources(directory, previous, proof_sha, fetch, check_fresh, deadline):
    """Recover original immutable bodies and clocks from the previous public proof namespace."""
    edition = previous["publication"]["sha256"]
    scopes = references.scopes(previous)
    if len(scopes) > 128:
        raise ValueError("Too many retained source scopes")
    total = 0
    rows = {}
    for scope in scopes:
        line, station, direction = scope["line"], scope["station"], scope["direction"]
        sha = scope["bodySHA"]
        url = references.source_url(edition, proof_sha, line, station, direction, sha)
        if time.monotonic() >= deadline or total >= 32 * references.MIB:
            raise ValueError("Retained timetable source budget exhausted")
        headers, body = fetch(url, "GET", min(8 * references.MIB, 32 * references.MIB - total))
        headers = {k.lower(): v for k, v in headers.items()}
        check_fresh(headers, datetime.now(timezone.utc))
        total += len(body)
        endpoint = f"https://api.tfl.gov.uk/Line/{line}/Timetable/{station}"
        if direction != "default":
            endpoint += "?direction=" + direction
        expected = {"source-use": "archived-comparison-only", "publication-sha256": edition,
                    "proof-body-sha256": proof_sha, "api-body-sha256": sha,
                    "source-direction": direction, "source-endpoint": endpoint}
        if (any(headers.get("x-tubeboard-" + k) != v for k, v in expected.items())
                or "no-store" not in {v.strip().lower() for v in headers.get("cache-control", "").split(",")}
                or headers.get("content-type", "").split(";")[0].strip().lower() != "application/json"
                or not body or hashlib.sha256(body).hexdigest() != sha):
            raise ValueError(f"Prior timetable comparison identity differs for {line}/{station}/{direction}")
        response_direction = json.loads(body).get("direction")
        if headers.get("x-tubeboard-source-response-direction") != response_direction:
            raise ValueError(f"Retained response direction differs for {line}/{station}")
        path = directory / ("retained-" + sha + ".body")
        path.write_bytes(body)
        record = {"status": 200, "body": path.name, "bytes": len(body), "sha256": sha,
                  "startedAt": headers["x-tubeboard-source-started-at"],
                  "receivedAt": headers["x-tubeboard-source-received-at"],
                  "headers": {"date": headers["x-tubeboard-source-http-date"],
                              "age": headers["x-tubeboard-source-http-age"],
                              "cache-control": headers["x-tubeboard-source-http-cache-control"]}}
        row = rows.setdefault((line, station), {})
        if direction == "default":
            row["timetableSource"] = record
        else:
            row.setdefault("directionalTimetableSources", []).append({"direction": direction, "timetableSource": record})
    return rows
