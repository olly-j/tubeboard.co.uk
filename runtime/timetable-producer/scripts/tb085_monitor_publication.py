"""Verify the current rider-facing timetable resource and alert its maintainers."""
import argparse
import base64
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlsplit
from urllib.request import Request, urlopen
import uuid
from zoneinfo import ZoneInfo

from check_tfl_api_health import EXPECTED_LINE_IDS
import tb085_package_timetable_proof as proof
import tb085_reference_readback as references
from tb085_live_parity import check_live_coverage
import tb085_timetable_publication as timetable
RAIL = timetable.RAIL

ROSTER = Path(__file__).with_name("tb085_renewal_roster.json")
PRODUCTION = "https://tubeboard.co.uk/api/timetable-publications/v1/"
ROUTES = "https://api.tfl.gov.uk/Line/Mode/tube,dlr,elizabeth-line,overground,tram/Route?serviceTypes=Regular,Night"
SERVICE_OBSERVATION = "https://tubeboard.co.uk/api/timetable-publication-observation/v1"
TRACKER = "olly-j/My-Train-Times"
ISSUE = 298
MARKER = "<!-- tubeboard-timetable-monitor-v1 "
UTC = timezone.utc


def request(url, method, limit):
    req = Request(url, method=method, headers={"Cache-Control": "no-cache", "User-Agent": "TubeBoard-Timetable-Monitor/1"})
    with urlopen(req, timeout=25) as response:
        final = response.geturl()
        if final.split("?")[0] != url.split("?")[0]:
            raise ValueError("Unexpected source redirect")
        if urlsplit(url).path.endswith("/ArrivalDepartures"):
            def selectors(address):
                return sorted((k, v) for k, v in parse_qsl(urlsplit(address).query, keep_blank_values=True)
                              if k != "tb085")
            if selectors(final) != selectors(url):
                raise ValueError("Redirect changed the rail departure line filter")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("Timetable response exceeded size limit")
        return response.headers, body


def check_fresh(headers, now, *, provider=False):
    headers = {key.lower(): value for key, value in headers.items()}
    observed = parsedate_to_datetime(headers["date"])
    elapsed = (now - observed).total_seconds()
    age = int(headers["age"] if provider else headers.get("age", 0))
    max_age = re.search(r"(?:^|,)\s*max-age=(\d+)", headers.get("cache-control", ""), re.I)
    ttl = min(60, int(max_age.group(1))) if max_age else 60
    if provider:
        ttl = 600
    if elapsed < 0 or age < 0 or max(elapsed, age) >= ttl:
        raise ValueError("Source response is outside the app's freshness window")


def provider_response(fetch, url, method, limit):
    # A cold CDN response may lack Age. Retry the identical URL once, as the app does.
    headers, body = fetch(url, method, limit)
    if headers.get("Age") is None:
        headers, body = fetch(url, method, limit)
    check_fresh(headers, datetime.now(UTC), provider=True)
    return headers, body


def current_edition(fetch):
    try:
        headers, _ = provider_response(fetch, proof.SOURCE + "?tb085=" + uuid.uuid4().hex, "HEAD", 0)
        sha = headers.get("x-amz-meta-sha256", "")
        source = "direct TfL observation"
    except HTTPError as error:
        if error.code != 403:
            raise
        # The production service publishes its own latest fixed-source observation.
        # The monitor cannot cause an upstream request or extend the publisher's clock.
        _, raw = fetch(SERVICE_OBSERVATION, "GET", 4096)
        observation = json.loads(raw)
        observed = datetime.fromisoformat(observation["observedAt"])
        expires = datetime.fromisoformat(observation["expiresAt"])
        now = datetime.now(UTC)
        if (observation.get("schemaVersion") != 1 or observation.get("source") != proof.SOURCE
                or not observed <= now < expires or expires - observed > timedelta(minutes=10)):
            raise ValueError("Production has no fresh observation of the official TfL edition")
        sha = observation["publicationSHA256"]
        source = "production service observation of TfL (hosted reader returned HTTP 403)"
    if not isinstance(sha, str) or not proof.SHA.fullmatch(sha):
        raise ValueError("Official observation lacks the publication SHA-256")
    return sha, source


def coverage_errors(body, roster, today):
    entries = {(r["lineID"], r["stationID"]): r for r in body["entries"]}
    if len(entries) != len(body["entries"]):
        raise ValueError("Duplicate station/line coverage")
    errors = []
    if not date.fromisoformat(body["holidayCoverageStart"]) <= today <= date.fromisoformat(body["holidayCoverageEnd"]):
        errors.append("Bank holiday calendar does not cover today")
    for item in roster:
        key = item["lineID"], item["stationID"]
        name = f'{item["stationName"]} ({item["lineID"]})'
        row = entries.get(key)
        if row is None:
            errors.append(f"{name}: coverage record missing")
        elif item["qualifiedBaseline"] or row["status"] == "qualified":
            directions = {d["direction"]: d["profiles"] for d in row.get("directionalDefinitions", [])}
            profiles = [directions.get(d, []) for d in item.get("directions", [])] or [row["profiles"]]
            if row["status"] != "qualified" or not all(any(p["count"] > 0 for p in group) for group in profiles):
                errors.append(f"{name}: qualified departures lost")
            elif not date.fromisoformat(row["operatingStartDate"]) <= today <= date.fromisoformat(row["operatingEndDate"]):
                errors.append(f"{name}: operating period does not cover today")
            else:
                for gap in row.get("originatingDateGaps", []):
                    day = date.fromisoformat(gap["serviceDate"])
                    if today <= day <= today + timedelta(days=1):
                        errors.append(f"{name}: publication has a gap on {day}")
    return errors


def retain_origin_inventory(report, path):
    raw=proof.bounded_read(path,timetable.MAX_ORIGIN_INVENTORY_BYTES)
    sidecar=proof.parse(raw)
    root=Path(timetable.__file__).resolve().parents[1]
    expected={"producerSHA256":hashlib.sha256(Path(timetable.__file__).read_bytes()).hexdigest(),
              "rosterSHA256":hashlib.sha256(Path(timetable.__file__).with_name("tb085_renewal_roster.json").read_bytes()).hexdigest(),
              "catalogueSHA256":hashlib.sha256((root/"TubeBoard Watch App/TubeStationCatalog.json").read_bytes()).hexdigest()}
    required={"schemaVersion","kind","publicationSHA256","capturedAt","producerSHA256","rosterSHA256",
              "catalogueSHA256","xmlPublicationMembers","inventory"}
    if (not isinstance(sidecar,dict) or set(sidecar) not in (required,required|{"inventoryTruncated"}) or sidecar.get("schemaVersion")!=1
            or type(sidecar.get("schemaVersion")) is not int
            or sidecar.get("kind")!="tubeboard-official-passenger-origin-inventory"
            or sidecar.get("publicationSHA256")!=report.get("publication")
            or not proof.SHA.fullmatch(sidecar.get("publicationSHA256",""))
            or not proof.SHA.fullmatch(sidecar.get("producerSHA256",""))
            or not proof.SHA.fullmatch(sidecar.get("rosterSHA256",""))
            or any(sidecar.get(key)!=value for key,value in expected.items())
            or not isinstance(sidecar.get("capturedAt"),str)
            or not isinstance(sidecar.get("xmlPublicationMembers"),list)
            or not isinstance(sidecar.get("inventory"),dict)):
        raise ValueError("Invalid or wrong-edition XML passenger-origin inventory")
    members=sidecar["xmlPublicationMembers"]
    if len(members)>2048 or any(not isinstance(member,dict)
        or not isinstance(member.get("member"),str) or not isinstance(member.get("lineID"),str)
        or not proof.SHA.fullmatch(member.get("sha256","")) for member in members):
        raise ValueError("Malformed XML inventory member receipts")
    item=sidecar["inventory"]
    required_inventory={"schemaVersion","discoveryStatus","source","originSemantics","horizon","xmlMemberCount",
        "xmlLineIDs","missingXmlLineIDs","passengerOriginCount","uncataloguedOriginCount",
        "activePassengerOrigins","bankHolidayDates","uncataloguedOrigins",
        "unresolvedMembers","malformedCurrentRows","inventoryDifferenceSHA256"}
    truncated=sidecar.get("inventoryTruncated") is True
    allowed_inventory=required_inventory|({"inventoryUnavailableReason"} if truncated else set())
    if (set(item)!=allowed_inventory or item.get("schemaVersion")!=1 or type(item.get("schemaVersion")) is not int
            or item.get("discoveryStatus") not in {"complete","incomplete"}
            or any(type(item.get(key)) is not int or item[key]<0 for key in
                   ("xmlMemberCount","passengerOriginCount","uncataloguedOriginCount"))
            or item["xmlMemberCount"]!=len(members)
            or not proof.SHA.fullmatch(item.get("inventoryDifferenceSHA256",""))):
        raise ValueError("Malformed XML passenger-origin inventory")
    def flatten(origin_map):
        if not isinstance(origin_map,dict) or any(not isinstance(line,str) or not isinstance(stations,list)
                or any(not isinstance(station,str) for station in stations) for line,stations in origin_map.items()):
            raise ValueError("Malformed XML passenger-origin line map")
        return [(line,station) for line,stations in origin_map.items() for station in stations]
    uncatalogued=flatten(item["uncataloguedOrigins"])
    if ((not truncated and item["uncataloguedOriginCount"]!=len(uncatalogued))
            or not isinstance(item["xmlLineIDs"],list)
            or not isinstance(item["missingXmlLineIDs"],list)
            or any(not isinstance(line,str) for line in item["xmlLineIDs"]+item["missingXmlLineIDs"])
            or not isinstance(item["unresolvedMembers"],list)
            or not isinstance(item["malformedCurrentRows"],list)):
        raise ValueError("XML passenger-origin counts or source lists disagree")
    if not isinstance(item["activePassengerOrigins"],list) or not isinstance(item["bankHolidayDates"],list):
        raise ValueError("XML passenger-origin active-date data is malformed")
    for origin in item["activePassengerOrigins"]:
        if (not isinstance(origin,dict) or not isinstance(origin.get("lineID"),str)
                or not isinstance(origin.get("stationID"),str) or type(origin.get("catalogued")) is not bool
                or not isinstance(origin.get("serviceWindows"),list)):
            raise ValueError("Malformed XML passenger-origin service scope")
        for window in origin["serviceWindows"]:
            if (not isinstance(window,dict) or not isinstance(window.get("startDate"),str)
                    or not isinstance(window.get("endDate"),str) or not isinstance(window.get("weekdays"),list)
                    or any(type(day) is not int or day not in range(1,8) for day in window["weekdays"])):
                raise ValueError("Malformed XML passenger-origin service window")
    if sidecar.get("inventoryTruncated") not in (None,True):
        raise ValueError("Invalid XML passenger-origin truncation marker")
    if truncated and not isinstance(item.get("inventoryUnavailableReason"),str):
        raise ValueError("Truncated XML inventory lacks a bounded reason")
    if timetable.inventory_difference_digest(sidecar)!=item["inventoryDifferenceSHA256"]:
        raise ValueError("XML passenger-origin difference digest mismatch")

    today=datetime.now(ZoneInfo("Europe/London")).date()
    holidays=set(item["bankHolidayDates"])
    active_pairs=set();active_unlisted=set()
    for origin in item["activePassengerOrigins"]:
        for window in origin["serviceWindows"]:
            try:
                active=(date.fromisoformat(window["startDate"])<=today<=date.fromisoformat(window["endDate"])
                    and today.isoweekday() in window["weekdays"] and today.isoformat() not in holidays)
            except ValueError:
                raise ValueError("Malformed XML passenger-origin service date")
            if active:
                pair=(origin["lineID"],origin["stationID"])
                if origin["catalogued"]:active_pairs.add(pair)
                else:active_unlisted.add(pair)
                break
    qualified=report.get("publicationQualifiedStations")
    comparison_available=isinstance(qualified,dict)
    qualified_pairs={(line,station) for line,stations in (qualified or {}).items()
                     if isinstance(line,str) and isinstance(stations,list) for station in stations if isinstance(station,str)}
    unqualified=sorted(active_pairs-qualified_pairs) if comparison_available else []
    def grouped(pairs):
        result={}
        for line,station in sorted(pairs):result.setdefault(line,[]).append(station)
        return result
    unqualified_by_line=grouped(unqualified)
    unlisted_by_line=grouped(active_unlisted)
    coverage_difference={"publicationSHA256":sidecar["publicationSHA256"],
        "inventoryDifferenceSHA256":item["inventoryDifferenceSHA256"],
        "comparisonAvailable":comparison_available,"unqualifiedPassengerOrigins":unqualified_by_line,
        "uncataloguedOrigins":unlisted_by_line}
    coverage_digest=hashlib.sha256(json.dumps(coverage_difference,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    receipt={"publicationSHA256":sidecar["publicationSHA256"],"artifact":"xml-passenger-origin-inventory.json",
        "artifactSHA256":hashlib.sha256(raw).hexdigest(),"inventoryDifferenceSHA256":item["inventoryDifferenceSHA256"],
        "discoveryStatus":item["discoveryStatus"],"passengerOriginCount":len(active_pairs),
        "uncataloguedOriginCount":len(active_unlisted),
        "activeOriginCount":len(active_pairs)+len(active_unlisted),"comparisonAvailable":comparison_available,
        "unqualifiedOriginCount":len(unqualified),"unqualifiedPassengerOrigins":unqualified_by_line,
        "uncataloguedOrigins":unlisted_by_line,
        "coverageDifferenceSHA256":coverage_digest,
        "xmlLineIDs":item["xmlLineIDs"],"missingXmlLineIDs":item["missingXmlLineIDs"],
        "unresolvedMemberCount":len(item["unresolvedMembers"]),"malformedCurrentRowCount":len(item["malformedCurrentRows"])}
    if truncated: receipt["inventoryTruncated"]=True
    report["xmlPassengerOriginInventory"]=receipt
    details=[]
    if unqualified:
        names=", ".join(f"{line}/{station}" for line,station in unqualified[:8])
        details.append(f"{len(unqualified)} active XML passenger start(s) lack qualified timetable departures: {names}")
    elif not comparison_available:
        details.append("Current production proof coverage was unavailable for comparison with the XML passenger-origin inventory.")
    if active_unlisted:
        names=", ".join(f"{line}/{station}" for line,station in sorted(active_unlisted)[:8])
        details.append(f"{len(active_unlisted)} XML pickup origin(s) are not listed for that line in the app catalogue: {names}")
    if item["missingXmlLineIDs"]:
        details.append("Official XML origin inventory lacks expected line sources: "+", ".join(item["missingXmlLineIDs"][:12]))
    if truncated:
        details.append(item["inventoryUnavailableReason"]+" Full proof qualification remains independent.")
    if item["unresolvedMembers"] or item["malformedCurrentRows"] or item["discoveryStatus"]!="complete":
        unresolved=", ".join(row.get("member","unknown") for row in item["unresolvedMembers"][:5]
                             if isinstance(row,dict))
        details.append("Official XML passenger-origin discovery is incomplete"+(f": {unresolved}" if unresolved else ""))
    if details:
        details.append(f"Full line/station IDs are retained in the protected run's {receipt['artifact']} artifact.")
        report["details"].extend(details)
    return receipt


def route_origins(lines, today):
    """Use published outgoing route starts, including branches and night services."""
    origins = {}
    for line in lines:
        line_id = line["id"]
        if not re.fullmatch(r"[a-z0-9-]+", line_id) or line_id in origins:
            raise ValueError("Duplicate or invalid TfL route line")
        stations = set()
        for route in line["routeSections"]:
            start = date.fromisoformat(route["validFrom"].split("T")[0])
            end = date.fromisoformat(route["validTo"].split("T")[0])
            if start <= today <= end:
                station = route["originator"]
                if not re.fullmatch(r"[A-Za-z0-9]+", station):
                    raise ValueError(f"Invalid originating station on {line_id}")
                stations.add(station)
        if not stations:
            raise ValueError(f"No current outgoing routes for {line_id}")
        origins[line_id] = stations
    missing = (set(EXPECTED_LINE_IDS) | {"tram"}) - origins.keys()
    if missing:
        raise ValueError("TfL route list omitted " + ", ".join(sorted(missing)))
    return origins


def read_direct_rail(url, station, fetch):
    headers, raw = fetch(url, "GET", 4 * 1024 * 1024)
    clock = {k.lower(): v for k, v in headers.items()}
    if "age" not in clock or not re.search(r"(?:^|,)\s*max-age=\d+", clock.get("cache-control", "")):
        raise ValueError("rail response lacks its cache clock")
    now = datetime.now(UTC)
    check_fresh(clock, now)
    rows = json.loads(raw)
    if not isinstance(rows, list) or len(rows) > 500:
        raise ValueError("invalid rail response shape")
    with_departure = 0
    for row in rows:
        if not isinstance(row, dict) or str(row.get("naptanId", "")).upper() != station.upper():
            raise ValueError("rail response contains another station")
        destination = row.get("destinationNaptanId")
        stamp = row.get("estimatedTimeOfDeparture") or row.get("scheduledTimeOfDeparture")
        if (stamp and destination and destination != station and
                datetime.fromisoformat(stamp) >= now):
            with_departure += 1
    return {"rows": len(rows), "rowsWithFutureDepartureFields": with_departure}


def rail_status_context(line, stations, fetch):
    """Attribute a status only where TfL identifies the station and current time window."""
    url = f"https://api.tfl.gov.uk/Line/{line}/Status?detail=true"
    headers, raw = fetch(url, "GET", 2 * 1024 * 1024)
    now = datetime.now(UTC)
    check_fresh(headers, now)
    lines = json.loads(raw)
    if not isinstance(lines, list) or len(lines) != 1 or lines[0].get("id") != line:
        raise ValueError("status response changed line")
    matched = {station: set() for station in stations}
    for status in lines[0]["lineStatuses"]:
        severity = status.get("statusSeverity")
        if type(severity) is not int or severity not in {*range(1, 10), 16, 20}:
            continue
        periods = status.get("validityPeriods") or []
        if not any(datetime.fromisoformat(p["fromDate"]) <= now < datetime.fromisoformat(p["toDate"])
                   for p in periods):
            continue
        affected = {stop["id"] for stop in (status.get("disruption") or {}).get("affectedStops", [])}
        for station in affected.intersection(stations):
            matched[station].add(str(status["statusSeverityDescription"]))
    return {station: sorted(values) for station, values in matched.items()}


def check_direct_rail(origins, fetch, pause=time.sleep):
    """Check the same one-line rail feed as the app. Empty boards can be legitimate."""
    results = {}
    errors = []
    deadline = time.monotonic() + 180
    for line, stations in sorted(origins.items()):
        if line not in RAIL:
            continue
        for station in sorted(stations):
            key = f"{line}/{station}"
            if time.monotonic() >= deadline:
                errors.append("Direct rail observation budget expired; remaining origins are unverified")
                return results, errors
            if results or errors:
                pause(1.55)
            url = f"https://api.tfl.gov.uk/StopPoint/{station}/ArrivalDepartures?lineIds={line}"
            for attempt in range(2):
                try:
                    results[key] = read_direct_rail(url, station, fetch)
                    break
                except (KeyError, ValueError, TypeError, OSError, OverflowError) as error:
                    detail = str(error)[:150]
                    if attempt == 0 and transient_details({"details": [detail]}) and time.monotonic() < deadline:
                        pause(1.55)
                        url += "&tb085=" + uuid.uuid4().hex
                        continue
                    errors.append(f"{key}: {detail}")
                    break
        empty = {s for s in stations if results.get(f"{line}/{s}", {}).get("rowsWithFutureDepartureFields") == 0}
        if empty and time.monotonic() < deadline:
            pause(1.55)
            try:
                context = rail_status_context(line, empty, fetch)
                for s in empty:
                    results[f"{line}/{s}"]["stationStatus"] = context[s]
            except (KeyError, ValueError, TypeError, OSError, OverflowError, AttributeError) as error:
                # A fresh valid empty departure feed stands independently of status.
                for s in empty:
                    results[f"{line}/{s}"]["stationStatusUnavailable"] = str(error)[:150]
    return results, errors


def check_network_origins(report, fetch=request):
    """Keep inventory gaps visible without masking or triggering edition repair."""
    if "publicationQualifiedStations" not in report:
        return
    try:
        headers, raw = fetch(ROUTES + "&tb085=" + uuid.uuid4().hex, "GET", 1024 * 1024)
        check_fresh(headers, datetime.now(UTC))
        origins = route_origins(json.loads(raw), datetime.now(ZoneInfo("Europe/London")).date())
        rail_observations, rail_errors = check_direct_rail(origins, fetch)
        report["directRailObservations"] = rail_observations
        report["details"].extend(rail_errors)
        qualified = report["publicationQualifiedStations"]
        gaps = {line: sorted(stations.difference(qualified.get(line, [])))
                for line, stations in sorted(origins.items()) if line not in RAIL}
        report["unqualifiedRouteOrigins"] = {line: ids for line, ids in gaps.items() if ids}
        total = sum(map(len, origins.values()))
        count = sum(map(len, gaps.values()))
        report["routeOriginCount"] = total
        if count:
            scheduled = sum(len(ids) for line, ids in origins.items() if line not in RAIL)
            report["details"].append(
                f"{count} of {scheduled} timetable route origins lack a qualified record. "
                "The run lists their station IDs and separate direct rail observations.")
        if not count and not rail_errors:
            return
        state = "incomplete-terminus-coverage" if count else "direct-rail-unavailable"
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        report["details"].append(f"Cannot verify TfL route origin inventory: {str(error)[:200]}")
        state = "route-inventory-unavailable"
    if report["status"] == "healthy":
        report["status"] = state


def monitored_roster(roster, body):
    known = {(r["lineID"], r["stationID"]): dict(r) for r in roster}
    for entry in body["entries"]:
        if entry["status"] != "qualified":
            continue
        line, station = entry["lineID"], entry["stationID"]
        row = known.setdefault((line, station), {"lineID": line, "stationID": station,
                               "stationName": station, "qualifiedBaseline": False})
        if not row["qualifiedBaseline"] and not row.get("directions"):
            # For newly qualified sources read precisely the direction(s) independently
            # certified against XML. Maintain the reviewed baseline's exact selectors.
            row["directions"] = [scope["direction"] for scope in entry.get("directionalDefinitions", [])]
        row["qualifiedBaseline"] = True
    return list(known.values())


def observe(roster, fetch=request):
    report = {"status": "source-unavailable", "publication": "", "details": []}
    try:
        sha, source = current_edition(fetch)
        report.update(publication=sha, sourceObservation=source, status="resource-unavailable")
        try:
            headers, data = fetch(PRODUCTION + sha, "GET", proof.MAX_RESOURCE_BYTES)
        except HTTPError as error:
            if error.code != 404:
                raise
            affected = [f'{r["stationName"]} ({r["lineID"]})' for r in roster if r["qualifiedBaseline"]]
            report.update(status="missing-edition", details=["Production returned 404 for the current TfL edition.",
                          "Affected qualified station/line pairs: " + ", ".join(affected)])
            return report
        check_fresh(headers, datetime.now(UTC))
        wrapper = proof.validate_resource(data, sha)
        body = proof.parse(base64.b64decode(wrapper["proofBodyBase64"], validate=True))
        today = datetime.now(ZoneInfo("Europe/London")).date()
        roster = monitored_roster(roster, body)
        errors = coverage_errors(body, roster, today)
        weekday_observations, source_profiles = [], []
        errors.extend(check_live_coverage(body, roster, today, fetch, weekday_observations, source_profiles))
        qualified_stations = {}
        for entry in body["entries"]:
            if entry["status"] == "qualified":
                qualified_stations.setdefault(entry["lineID"], []).append(entry["stationID"])
        report.update(publicationQualifiedStations=qualified_stations, comparisonScopes=references.scopes(body),
                      status="coverage-regression" if errors else "healthy", details=errors,
                      qualified=sum(r["status"] == "qualified" for r in body["entries"]),
                      rosterSize=len(roster), revision=wrapper["proofRevision"],
                      proofBodySHA256=wrapper["proofBodySHA256"], resourceSHA256=proof.digest(data),
                      weekdayGapObservations=weekday_observations,
                      sourceProfileObservations=source_profiles)
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        report["details"] = [str(error)[:300]]
    return report


TRANSIENT_MARKERS = (
    "timed out", "timeout", "temporary failure", "connection reset", "connection refused",
    "remote end closed", "try again", "outside the app's freshness window",
    "missing or invalid tfl cache clock", "stale tfl timetable",
    "HTTP Error 408", "HTTP Error 425", "HTTP Error 429", "HTTP Error 500",
    "HTTP Error 502", "HTTP Error 503", "HTTP Error 504",
)


def transient_details(report):
    return [detail for detail in report.get("details", [])
            if any(marker.casefold() in detail.casefold() for marker in TRANSIENT_MARKERS)]


def requalification_scope(report):
    """Fingerprint exact served bytes, stable incident details and proof-producing code."""
    root = Path(__file__).resolve().parent
    relevant = ("tb085_monitor_publication.py", "tb085_prepare_renewal.py",
                "tb085_timetable_publication.py", "tb085_live_parity.py",
                "tb085_package_timetable_proof.py", "tb085_renewal_roster.json", "tb085_source_transfer.py",
                "tb085_tram_stations.py", "tb085_additive_qualification.py")
    code = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in relevant}
    catalogue = root.parent / "TubeBoard Watch App/TubeStationCatalog.json"
    code["TubeStationCatalog.json"] = hashlib.sha256(catalogue.read_bytes()).hexdigest()
    maps = root.parent / "My Train Times/PublishedLineMaps.json"
    code["PublishedLineMaps.json"] = hashlib.sha256(maps.read_bytes()).hexdigest()
    workflow = root.parent / ".github/workflows/timetable-publication.yml"
    code["timetable-publication.yml"] = hashlib.sha256(workflow.read_bytes()).hexdigest()
    identity = {key: report.get(key) for key in
                ("publication", "revision", "proofBodySHA256", "resourceSHA256")}
    identity["details"] = report.get("stableCoverageDetails", [])
    identity["sourceProfiles"] = report.get("sourceProfileObservations", [])
    identity["weekdayGaps"] = report.get("stableWeekdayGapObservations", [])
    identity["code"] = code
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]


def confirm_observation(roster, fetch=request, pause=None):
    """Retry bounded transient faults and independently confirm stable coverage failures."""
    pause = pause or time.sleep
    first = observe(roster, fetch)
    if first["status"] == "healthy":
        return first
    # A second full read distinguishes a temporary request failure from a stable
    # mismatch. This does not change any profile, calendar or freshness proof.
    pause(3)
    second = observe(roster, fetch)
    identity_keys = ("publication", "revision", "proofBodySHA256", "resourceSHA256")
    same_identity = tuple(first.get(key) for key in identity_keys) == tuple(second.get(key) for key in identity_keys)
    if first["status"] == second["status"] == "coverage-regression" and same_identity:
        first_errors = set(first["details"]) - set(transient_details(first))
        second_errors = set(second["details"]) - set(transient_details(second))
        stable = sorted(first_errors & second_errors)
        first_gaps = {json.dumps(item, sort_keys=True, separators=(",", ":")) for item in first.get("weekdayGapObservations", [])}
        second_gaps = {json.dumps(item, sort_keys=True, separators=(",", ":")) for item in second.get("weekdayGapObservations", [])}
        stable_gaps = [json.loads(item) for item in sorted(first_gaps & second_gaps)]
        second["stableCoverageRegression"] = bool(stable)
        second["stableCoverageDetails"] = stable
        second["stableWeekdayGapObservations"] = stable_gaps
        second["conclusiveMissingWeekdays"] = bool(stable_gaps)
        for gap in stable_gaps:
            labels = {1: "Sunday", 2: "Monday", 3: "Tuesday", 4: "Wednesday", 5: "Thursday", 6: "Friday", 7: "Saturday"}
            missing = ", ".join(labels[d] for d in gap["requiredWeekdays"])
            dates = ", ".join(sorted(day for values in gap["requiredServiceDates"].values() for day in values))
            direction = f" {gap['direction']}" if gap["direction"] else ""
            detail = (f"{gap['stationName']} ({gap['lineID']}){direction}: fresh TfL timetable profiles do not cover "
                      f"served {missing} service date(s) {dates}. Replacing this station’s proof would remove those dates.")
            if detail not in second["details"]:
                second["details"].append(detail)
        if not stable and second_errors:
            second["details"].append("Coverage findings did not persist unchanged between independent reads; automatic requalification was not attempted.")
        if stable:
            second["requalificationScope"] = requalification_scope(second)
        return second
    if first["status"] == second["status"] == "coverage-regression":
        second["stableCoverageRegression"] = False
        second["stableCoverageDetails"] = []
        second["stableWeekdayGapObservations"] = []
        second["conclusiveMissingWeekdays"] = False
        second["details"].append("Publication or proof revision changed between independent reads; automatic requalification was not attempted.")
        return second
    if first["status"] == "coverage-regression" and second["status"] in {"source-unavailable", "resource-unavailable"}:
        findings = [d for d in first.get("details", []) if d not in transient_details(first)]
        if findings:
            second["details"].append(
                "Earlier unconfirmed coverage findings for edition "
                f"{first.get('publication') or 'unavailable'} revision {first.get('revision') or 'unknown'}: "
                + "; ".join(findings[:8]))
        second["stableCoverageRegression"] = False
        second["stableCoverageDetails"] = []
        return second
    # Keep the most recent source state. If it recovered, the ordinary healthy
    # notification path records recovery; if it did not, its current evidence
    # remains the actionable alert.
    return second


def fingerprint(report):
    details = [detail for detail in report["details"]
               if not detail.startswith("Same-edition qualification failed closed in the prior 24 hours")
               and not detail.startswith(("Current production proof coverage was unavailable",
                   "Official XML passenger-origin discovery", "Full line/station IDs are retained"))
               and "active XML passenger start(s)" not in detail
               and "XML pickup origin(s)" not in detail]
    values = [report["status"], report["publication"], report.get("revision"),
              report.get("resourceSHA256"), sorted(details)]
    if report.get("unqualifiedRouteOrigins"):
        values.append(report["unqualifiedRouteOrigins"])
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()[:20]


def inventory_needs_attention(inventory):
    return bool(inventory and (inventory.get("discoveryStatus")!="complete"
        or inventory.get("unqualifiedOriginCount",0)>0 or inventory.get("uncataloguedOriginCount",0)>0
        or not inventory.get("comparisonAvailable",False)))


def inventory_snapshot(report):
    inventory=report.get("xmlPassengerOriginInventory")
    if not isinstance(inventory,dict):
        return None
    return {"state":"partial" if inventory_needs_attention(inventory) else "complete",
        "publicationSHA256":inventory.get("publicationSHA256"),
        "inventoryDifferenceSHA256":inventory.get("inventoryDifferenceSHA256"),
        "coverageDifferenceSHA256":inventory.get("coverageDifferenceSHA256"),
        "discoveryStatus":inventory.get("discoveryStatus"),
        "activeOriginCount":inventory.get("activeOriginCount"),
        "unqualifiedOriginCount":inventory.get("unqualifiedOriginCount"),
        "uncataloguedOriginCount":inventory.get("uncataloguedOriginCount"),
        "comparisonAvailable":inventory.get("comparisonAvailable")}


def inventory_event(report, previous):
    """Return a transition while keeping a missing sample from erasing state."""
    current=inventory_snapshot(report)
    old=previous.get("xmlPassengerOriginInventory") if previous else None
    if current is None:
        return None,old
    if old is None:
        return ("attention" if current["state"]=="partial" else None),current
    if old.get("state")=="partial" and current["state"]=="complete":
        return "recovered",current
    if old.get("state")=="complete" and current["state"]=="partial":
        return "attention",current
    changed=(old.get("inventoryDifferenceSHA256")!=current.get("inventoryDifferenceSHA256")
             or old.get("coverageDifferenceSHA256")!=current.get("coverageDifferenceSHA256"))
    if changed and current["state"]=="partial":
        return "attention",current
    if changed:
        return "updated",current
    return None,current


def needs_notice(report, previous, now):
    event,_=inventory_event(report,previous)
    if report["status"] == "healthy":
        overall=bool(previous and previous["state"]!="healthy")
    else:
        overall=(not previous or previous["fingerprint"]!=fingerprint(report)
                 or now-datetime.fromisoformat(previous["at"])>=timedelta(hours=24))
    return overall or event is not None


def notify(report, run_url):
    # The comment history is the durable incident state across runner replacements.
    raw = subprocess.check_output(["gh", "api", "--paginate", "--slurp",
        f"repos/{TRACKER}/issues/{ISSUE}/comments?per_page=100"], text=True)
    previous = None
    for page in json.loads(raw):
        for comment in page:
            first = comment["body"].splitlines()[:1]
            if comment["user"]["login"] == "github-actions[bot]" and first and first[0].startswith(MARKER):
                if first[0].endswith(" -->"):
                    previous = json.loads(first[0][len(MARKER):-4])
    now = datetime.now(UTC)
    if not needs_notice(report, previous, now):
        return
    event,current_inventory=inventory_event(report,previous)
    tag = {"state": report["status"], "fingerprint": fingerprint(report), "at": now.isoformat(),
           "xmlPassengerOriginInventory":current_inventory}
    msg = MARKER + json.dumps(tag) + " -->\n"
    if event=="recovered":
        msg += "@olly-j **XML passenger-origin inventory recovered.** The current source inventory now matches the qualified departures. "
        msg += f"The independent rider-health check is `{report['status']}`."
    elif event=="attention":
        msg += "@olly-j **Timetable XML passenger-origin inventory needs review.**\n\n"
        msg += "\n".join("- " + d for d in report["details"])
        msg += f"\n\nThe independent rider-health status remains `{report['status']}`. No source was silently added."
    elif event=="updated":
        msg += "Timetable XML passenger-origin inventory changed; current qualified coverage remains complete."
    elif report["status"] == "healthy":
        if current_inventory and current_inventory.get("state")=="partial":
            msg += "Rider timetable health recovered: the production service serves the current TfL edition and monitored station checks pass. The separately tracked XML passenger-origin inventory remains partial; this health recovery does not resolve that inventory finding."
        else:
            msg += "Timetable coverage recovered. The production service serves the current TfL edition and the monitored station checks pass."
    else:
        msg += f'@olly-j **Timetable alert: {report["status"]}.**\n\n'
        msg += "\n".join("- " + d for d in report["details"])
        msg += "\n\nCheck the qualification result in the run, resolve the affected source or publication, and verify the production readback. Live arrival predictions remain separate."
    msg += f'\n\nTfL edition: `{report["publication"] or "unavailable"}`. [Monitor run]({run_url})\n'
    subprocess.run(["gh", "issue", "comment", str(ISSUE), "--repo", TRACKER, "--body-file", "-"],
                   input=msg, text=True, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--notify", metavar="RUN_URL")
    parser.add_argument("--origin-inventory", type=Path,
                        help="Retain and alert on a generated standalone XML passenger-origin inventory")
    args = parser.parse_args()
    if args.notify:
        result=json.loads(args.report.read_text())
        if args.origin_inventory:
            retain_origin_inventory(result,args.origin_inventory)
            args.report.write_text(json.dumps(result,indent=2)+"\n")
        notify(result, args.notify)
        return
    roster = json.loads(ROSTER.read_text())
    result = confirm_observation(roster)
    references.verify(result, request)
    check_network_origins(result)
    args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
