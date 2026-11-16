"""Check current Unified timetable profiles against the served publication."""
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlencode
from uuid import uuid4
from zoneinfo import ZoneInfo

from tb085_package_timetable_proof import parse
from tb085_tram_stations import stations as tram_stations
from tb085_timetable_publication import API_DAYS, api_profile_rows, fingerprint

LONDON = ZoneInfo("Europe/London")
MAX_BYTES = 2_000_000


@lru_cache(maxsize=1)
def catalogue():
    path = Path(__file__).resolve().parents[1] / "TubeBoard Watch App/TubeStationCatalog.json"
    lines = {}
    for station in parse(path.read_bytes())["stations"]:
        for line in station["lines"]:
            lines.setdefault(line["lineID"], {})[station["stationID"]] = station["stationName"]
    lines["tram"] = tram_stations()
    return lines


def normalized(name):
    folded = unicodedata.normalize("NFD", name.casefold())
    plain = "".join(c for c in folded if not unicodedata.combining(c))
    for suffix in (" underground station", " rail station", " dlr station"):
        plain = plain.replace(suffix, "")
    return " ".join(plain.split())


def read_timetable(fetch, line, station, direction):
    if not re.fullmatch("[a-z0-9-]+", line) or not re.fullmatch("[A-Z0-9]+", station):
        raise ValueError("invalid roster selector")
    params = {"tb085": uuid4().hex}
    if direction:
        if direction not in ("inbound", "outbound"):
            raise ValueError("invalid timetable direction")
        params["direction"] = direction
    url = f"https://api.tfl.gov.uk/Line/{line}/Timetable/{station}?" + urlencode(params)
    for attempt in range(2):
        headers, raw = fetch(url, "GET", MAX_BYTES)
        age = headers.get("Age")
        if age is None and attempt == 0:
            continue
        if not isinstance(age, str) or not re.fullmatch("[0-9]+", age) or "Date" not in headers:
            raise ValueError("missing or invalid TfL cache clock")
        elapsed = (datetime.now(timezone.utc) - parsedate_to_datetime(headers["Date"])).total_seconds()
        if elapsed < -120 or max(elapsed, int(age)) >= 600:
            raise ValueError("stale TfL timetable")
        if len(raw) > MAX_BYTES:
            raise ValueError("oversized live timetable")
        return parse(raw)


def raw_profiles(payload, line, station, direction):
    if direction and payload.get("direction") != direction:
        raise ValueError("wrong live direction")
    offered = set()
    for route in payload["timetable"]["routes"]:
        for interval in route["stationIntervals"]:
            ident = interval["id"]
            if not isinstance(ident, str) or not re.fullmatch("[+-]?[0-9]+", ident) or not interval["intervals"]:
                raise ValueError("invalid interval identity or empty path")
            interval["id"] = str(int(ident))  # App joins typed integer IDs; 01 and 1 are identical.
            for call in interval["intervals"]:
                if not isinstance(call["stopId"], str) or not call["stopId"]:
                    raise ValueError("empty calling stop")
        for schedule in route["schedules"]:
            offered.add(schedule["name"])
            for j in schedule["knownJourneys"]:
                if (type(j["intervalId"]) is not int or any(not isinstance(j[k], str)
                        or not re.fullmatch("[+-]?[0-9]+", j[k]) for k in ("hour", "minute"))):
                    raise ValueError("invalid typed timetable journey")
    rows = api_profile_rows(payload, line, station)
    return {name: rows.get(name, []) for name in offered}


def qualified_keys(keys, profile):
    exclusions = profile.get("excludedJourneyKeys")
    if exclusions is None:
        if (profile.get("publishedCount") is not None or profile.get("publishedSHA256") is not None
                or fingerprint(keys) != {"count": profile["count"], "sha256": profile["sha256"]}):
            raise ValueError("full timetable profile differs from publication")
        return keys
    counts = {e["key"]: e["count"] for e in exclusions}
    if (len(counts) != len(exclusions) or len(counts) > 4096
            or any(type(n) is not int or not 1 <= n <= 4096 for n in counts.values())
            or not re.fullmatch("[a-f0-9]{64}", profile["sha256"])
            or profile["count"] != profile["publishedCount"] + sum(counts.values())):
        raise ValueError("invalid published exclusions")
    # A known wrong-day occurrence may already have disappeared upstream.
    # Every remaining counted occurrence must match the published subset exactly.
    keep = list((Counter(keys) - Counter(counts)).elements())
    if fingerprint(keep) != {"count": profile["publishedCount"], "sha256": profile["publishedSHA256"]}:
        raise ValueError("published timetable subset differs")
    return keep


def in_range(day, first, last):
    return date.fromisoformat(first) <= day <= date.fromisoformat(last)


def current_profile(profiles, day):
    weekday = day.isoweekday() % 7 + 1
    matches = [p for p in profiles if weekday in p["weekdays"]
               and ("originatingServiceDateRanges" not in p or any(
                   in_range(day, r["startDate"], r["endDate"]) for r in p["originatingServiceDateRanges"]))]
    if len(matches) != 1:
        raise ValueError(f"{day}: expected one originating service profile, found {len(matches)}")
    return matches[0]


def check_calls(key, line, station, names, stops):
    calls = key.split("|", 1)[1].split(">")
    if any(s not in stops for s in calls):
        raise ValueError("live path has a stop outside the selected line catalogue")
    endpoint = calls[-1]
    if endpoint == station and all(s == station for s in calls):
        raise ValueError("origin-only path")
    if line == "northern" and "940GZZLUBNK" in calls and "940GZZLUCHX" in calls:
        raise ValueError("conflicting Northern branches")
    destinations = [endpoint]
    if line == "circle" and endpoint == station:
        destinations.append(next(s for s in calls if s != station))
    for s in destinations:
        if s in names and normalized(names[s]) != normalized(stops[s]):
            raise ValueError(f"destination name differs from catalogue for {s}")


def verify_scope(body, entry, metadata, profiles, today, payload, direction, live_rows=None):
    line, station = entry["lineID"], entry["stationID"]
    rows = live_rows if live_rows is not None else raw_profiles(payload, line, station, direction)
    if set(rows) != {p["name"] for p in profiles}:
        raise ValueError("offered timetable profile names differ from publication")
    names = {}
    for stop in payload["stations"]:
        if stop["id"] in names or not isinstance(stop["name"], str) or not stop["name"].strip():
            raise ValueError("duplicate or unnamed live station")
        names[stop["id"]] = stop["name"]
    stops = catalogue()[line]
    if station not in stops or entry.get("nonOperationBankHolidays") is not True:
        raise ValueError("origin or bank-holiday policy not qualified")
    local = datetime.now(LONDON)
    cutoff = local.hour * 60 + local.minute if today == local.date() else 0
    for days_ago in (1, 0):
        day = today - timedelta(days=days_ago)
        for scope in [body, entry, metadata]:
            if scope is body:
                ok = in_range(day, scope["holidayCoverageStart"], scope["holidayCoverageEnd"])
            else:
                ok = in_range(day, scope["operatingStartDate"], scope["operatingEndDate"])
                if any(g["serviceDate"] == day.isoformat() for g in scope.get("originatingDateGaps", [])):
                    raise ValueError(f"{day}: published originating-date conflict")
            if not ok:
                raise ValueError(f"{day}: outside published calendar")
        if day.isoformat() in body["bankHolidayDates"]:
            if any("originatingServiceDateRanges" in p for p in profiles):
                raise ValueError(f"{day}: bank holiday withheld")
            continue
        p = current_profile(profiles, day)
        try:
            keys = qualified_keys(rows[p["name"]], p)
        except ValueError as error:
            raise ValueError(f"{day} {p['name']}: {error}") from error
        for key in keys:
            minute = int(key[:4]) - 1440 * days_ago
            if cutoff <= minute < 1440:
                check_calls(key, line, station, names, stops)
    return {k for values in rows.values() for k in values}


def weekday_gap_observation(body, entry, metadata, profiles, today, payload, direction, live_rows=None):
    """Describe only a provable served weekday that a fresh Unified payload omits."""
    line, station = entry["lineID"], entry["stationID"]
    if direction and payload.get("direction") != direction:
        return None
    try:
        live_rows = live_rows if live_rows is not None else raw_profiles(payload, line, station, direction)
        active_names = {name for name, rows in live_rows.items() if rows}
        definitions = {name: API_DAYS[name] for name in active_names if name in API_DAYS}
        expected_names = {p["name"] for p in profiles}
        if expected_names == set(live_rows) or not expected_names:
            return None
        if any(name not in API_DAYS for name in expected_names):
            return None
        first = max(date.fromisoformat(body["holidayCoverageStart"]),
                    date.fromisoformat(entry["operatingStartDate"]),
                    date.fromisoformat(metadata.get("operatingStartDate", entry["operatingStartDate"])), today)
        last = min(date.fromisoformat(body["holidayCoverageEnd"]),
                   date.fromisoformat(entry["operatingEndDate"]),
                   date.fromisoformat(metadata.get("operatingEndDate", entry["operatingEndDate"])))
        if last < first or (last - first).days > 730:
            return None
        gaps = {g["serviceDate"] for scope in (body, entry, metadata)
                for g in scope.get("originatingDateGaps", [])}
        covered = set().union(*definitions.values()) if definitions else set()
        required = {}
        day = first
        while day <= last:
            civil = day.isoformat()
            weekday = day.isoweekday() % 7 + 1
            if civil not in gaps and civil not in body["bankHolidayDates"]:
                matches = [profile for profile in profiles
                           if weekday in profile["weekdays"]
                           and (profile.get("originatingServiceDateRanges") is None
                                or any(in_range(day, r["startDate"], r["endDate"])
                                       for r in profile["originatingServiceDateRanges"]))]
                if len(matches) == 1:
                    profile = matches[0]
                    admitted_count = profile.get("publishedCount", profile.get("count"))
                    if type(admitted_count) is not int or admitted_count <= 0:
                        return None
                    if weekday not in covered:
                        required.setdefault(weekday, set()).add(civil)
            day += timedelta(days=1)
        if not required:
            return None
        return {
            "lineID": line, "stationID": station,
            "stationName": catalogue().get(line, {}).get(station, entry.get("stationName", "")),
            "direction": direction or "", "requiredWeekdays": sorted(required),
            "requiredServiceDates": {str(k): sorted(v)[:3] for k, v in sorted(required.items())},
            "servedProfiles": sorted(expected_names), "liveProfiles": sorted(active_names),
            "liveWeekdayCoverage": sorted(covered),
        }
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def check_live_coverage(body, roster, today, fetch, weekday_observations=None,
                        source_profile_observations=None):
    """Return per-scope failures; no arrival, disruption or actual-train inference."""
    entries = {(e["lineID"], e["stationID"]): e for e in body["entries"]}
    errors = []
    for item in roster:
        line, station = item["lineID"], item["stationID"]
        entry = entries.get((line, station), {})
        label = f"{item['stationName']} ({line})"
        if entry.get("status") != "qualified":
            if item["qualifiedBaseline"]:
                errors.append(f"{label}: published timetable is not qualified")
            continue
        expected = item.get("directions", [])
        try:
            defs = entry.get("directionalDefinitions", [])
            evidence = entry.get("directionalSourceEvidence", [])
            if (sorted(d["direction"] for d in defs) != sorted(expected)
                    or sorted(d["direction"] for d in evidence) != sorted(expected)
                    or (defs and entry["profiles"])):
                raise ValueError("published direction definitions or evidence differ from roster")
            scopes = {d["direction"]: d["profiles"] for d in defs} or {None: entry["profiles"]}
            by_direction = {d["direction"]: d for d in evidence}
        except (KeyError, TypeError, ValueError) as error:
            errors.append(f"{label}: {error}")
            continue
        seen = set()
        for direction, profiles in scopes.items():
            try:
                payload = read_timetable(fetch, line, station, direction)
                live_rows = raw_profiles(payload, line, station, direction)
                if source_profile_observations is not None:
                    source_profile_observations.append({
                        "lineID": line, "stationID": station, "direction": direction or "",
                        "profiles": sorted(name for name, rows in live_rows.items() if rows),
                        "weekdayCoverage": sorted(set().union(*(API_DAYS[name] for name, rows in live_rows.items()
                                                                  if rows and name in API_DAYS))) if any(live_rows.values()) else [],
                    })
                observation = weekday_gap_observation(body, entry, by_direction.get(direction, entry),
                                                      profiles, today, payload, direction, live_rows)
                if observation is not None and weekday_observations is not None:
                    weekday_observations.append(observation)
                keys = verify_scope(body, entry, by_direction.get(direction, entry), profiles, today,
                                    payload, direction, live_rows)
                if seen & keys:
                    raise ValueError("opposite directions share live journey keys")
                seen.update(keys)
            except (OSError, ValueError, TypeError, KeyError, OverflowError, AttributeError) as error:
                name = f"{label} {direction}" if direction else label
                errors.append(f"{name}: {error}")
    return errors
