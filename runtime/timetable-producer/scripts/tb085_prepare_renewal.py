#!/usr/bin/env python3
"""Prepare a reviewable revision-one resource for an unserved official TfL edition."""
import argparse
import base64
import copy
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from io import BytesIO
from urllib.parse import urlencode, urlsplit, parse_qsl
from uuid import uuid4
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile
from zoneinfo import ZoneInfo

import tb085_package_timetable_proof as packager
import tb085_timetable_publication as qualifier
import tb085_monitor_publication as monitor
import tb085_source_transfer as transfer
import tb085_additive_qualification as additive
import tb085_tram_stations as tram

ROOT = Path(__file__).resolve().parents[1]
ROSTER = ROOT / "scripts/tb085_renewal_roster.json"
CATALOGUE = ROOT / "TubeBoard Watch App/TubeStationCatalog.json"
PROOFS = "https://tubeboard.co.uk/api/timetable-publications/v1/"
API = "https://api.tfl.gov.uk"
HOLIDAYS = "https://www.gov.uk/bank-holidays.json"
MIB = 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def validate_previous_resource(data, publication):
    wrapper = packager.validate_resource(data, publication)
    return wrapper, hashlib.sha256(data).hexdigest()


def require_unchanged_resource(previous, current):
    if previous != current:
        raise ValueError("Served resource changed during same-edition requalification")


def preserve_previous_qualified_scopes(roster, wrapper):
    body = packager.parse(base64.b64decode(wrapper["proofBodyBase64"], validate=True))
    expected = {(row["lineID"], row["stationID"]): row for row in roster}
    prior = {(entry["lineID"], entry["stationID"]): entry for entry in body.get("entries", [])}
    if len(prior) != len(body.get("entries", [])) or not prior.keys() <= expected.keys():
        raise ValueError("Prior publication coverage differs from the reviewed roster")
    result = copy.deepcopy(roster)
    for row in result:
        entry = prior.get((row["lineID"], row["stationID"]), {})
        if entry.get("status") == "qualified":
            old_directions = [d["direction"] for d in entry.get("directionalDefinitions", [])]
            row["qualifiedBaseline"] = True
            row["directions"] = sorted(set(row.get("directions", [])) | set(old_directions))
    check_roster(result)
    return result


def admitted_service_dates(body, entry):
    if entry.get("status") != "qualified":
        return {}
    global_start = date.fromisoformat(body["holidayCoverageStart"])
    global_end = date.fromisoformat(body["holidayCoverageEnd"])
    entry_start = date.fromisoformat(entry["operatingStartDate"])
    entry_end = date.fromisoformat(entry["operatingEndDate"])
    start, end = max(global_start, entry_start), min(global_end, entry_end)
    if end < start or (end - start).days > 730:
        raise ValueError("Unsupported operating-date span in prior or candidate proof")
    if entry.get("directionalDefinitions"):
        scopes = {definition["direction"]: definition["profiles"]
                  for definition in entry["directionalDefinitions"]}
        evidence = {item["direction"]: item for item in entry.get("directionalSourceEvidence", [])}
    else:
        scopes = {"origin": entry["profiles"]}
        evidence = {}
    holidays = set(body.get("bankHolidayDates", []))
    gaps = {gap["serviceDate"] for gap in entry.get("originatingDateGaps", [])}
    result = {}
    day = start
    while day <= end:
        civil = day.isoformat()
        weekday = day.isoweekday() % 7 + 1
        if civil not in holidays and civil not in gaps:
            for direction, profiles in scopes.items():
                scope_evidence = evidence.get(direction, {})
                scope_start = max(start, date.fromisoformat(scope_evidence["operatingStartDate"])) if scope_evidence.get("operatingStartDate") else start
                scope_end = min(end, date.fromisoformat(scope_evidence["operatingEndDate"])) if scope_evidence.get("operatingEndDate") else end
                direction_gaps = {gap["serviceDate"] for gap in scope_evidence.get("originatingDateGaps", [])}
                if day < scope_start or day > scope_end or civil in direction_gaps:
                    continue
                matches = [profile for profile in profiles
                           if weekday in profile.get("weekdays", [])
                           and ("originatingServiceDateRanges" not in profile or any(
                               date.fromisoformat(r["startDate"]) <= day <= date.fromisoformat(r["endDate"])
                               for r in profile["originatingServiceDateRanges"]))]
                published_count = (matches[0].get("publishedCount", matches[0].get("count"))
                                   if len(matches) == 1 else 0)
                if len(matches) == 1 and type(published_count) is int and published_count > 0:
                    result.setdefault(direction, set()).add(civil)
        day += timedelta(days=1)
    return result


def require_no_date_coverage_loss(previous_body, candidate_body, *, from_date=None):
    old_entries = {(e["lineID"], e["stationID"]): e for e in previous_body["entries"]}
    new_entries = {(e["lineID"], e["stationID"]): e for e in candidate_body["entries"]}
    if (len(old_entries) != len(previous_body["entries"]) or len(new_entries) != len(candidate_body["entries"])
            or not old_entries.keys() <= new_entries.keys()):
        raise ValueError("Candidate date coverage differs from the prior publication roster")
    losses = []
    for pair, old_entry in old_entries.items():
        if old_entry.get("status") != "qualified":
            continue
        old_dates = admitted_service_dates(previous_body, old_entry)
        if not old_dates or not any(old_dates.values()):
            raise ValueError("Prior qualified scope has no admitted operating dates: " + "/".join(pair))
        new_dates = admitted_service_dates(candidate_body, new_entries[pair])
        for direction, dates in old_dates.items():
            if from_date:
                dates = {civil for civil in dates if civil >= from_date.isoformat()}
            missing = sorted(dates - new_dates.get(direction, set()))
            if missing:
                label = "/".join(pair) + ("/" + direction if direction != "origin" else "")
                losses.append(label + ": " + ", ".join(missing[:8]))
    if losses:
        raise ValueError("Previously admitted operating dates lost: " + "; ".join(losses[:12]))


def require_preserved_station_directions(previous_body, candidate_body):
    """ADR024: retain all qualified scopes; new editions do not promise old dates."""
    def indexed(body):
        entries = {(e["lineID"], e["stationID"]): e for e in body["entries"]}
        if len(entries) != len(body["entries"]):
            raise ValueError("Duplicate publication station scope")
        return entries
    def directions(entry):
        definitions = entry.get("directionalDefinitions")
        if definitions is None:
            if not entry["profiles"]:
                raise ValueError("Missing qualified origin profiles")
            return {None}
        values = [d["direction"] for d in definitions]
        evidence = [d["direction"] for d in entry.get("directionalSourceEvidence", [])]
        if (entry["profiles"] or not 1 <= len(values) <= 2 or len(set(values)) != len(values)
                or any(v not in {"inbound", "outbound"} for v in values)
                or sorted(values) != sorted(evidence)):
            raise ValueError("Invalid qualified direction evidence")
        return set(values)
    candidates = indexed(candidate_body)
    for pair, previous in indexed(previous_body).items():
        if previous.get("status") != "qualified":
            continue
        candidate = candidates.get(pair)
        if (candidate is None or candidate.get("status") != "qualified"
                or not directions(previous) <= directions(candidate)):
            raise ValueError("Previously qualified station/direction lost: " + "/".join(pair))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def checked_archive(path):
    # The existing XML qualifier reads the single supported nested feed into memory.
    with ZipFile(path) as outer:
        matches = [m for m in outer.infolist() if m.filename.startswith("LULDLRTRAMRIVERCABLE FULL ")
                   and m.filename.endswith(".zip")]
        if len(matches) != 1 or matches[0].file_size > 64 * MIB:
            raise ValueError("Missing, ambiguous or oversized published Tube archive")
        with ZipFile(BytesIO(outer.read(matches[0]))) as inner:
            entries = inner.infolist()
            if (len(entries) > 1024 or len({m.filename for m in entries}) != len(entries)
                    or sum(m.file_size for m in entries) > 1024 * MIB
                    or any(m.file_size > 128 * MIB for m in entries)):
                raise ValueError("Published XML exceeds qualification bounds")


def fetch(directory, key, url, limit, deadline, *, head=False, allowed=(200,)):
    """Retain the response used by qualification; never follow an unreviewed redirect."""
    body = directory / (key + ".body")
    header_file = directory / (key + ".headers")
    for attempt in range(3):
        remaining = int(deadline - time.monotonic())
        if remaining < 1:
            raise ValueError("Timetable capture exceeded its deadline")
        timeout = min(180 if limit > 16 * MIB else 25, remaining)
        cmd = ["curl", "--silent", "--show-error", "--proto", "=https", "--max-time", str(timeout),
               "--connect-timeout", str(min(10, timeout)),
               "--header", "Cache-Control: no-cache", "--user-agent", "TubeBoard timetable renewal",
               "--dump-header", str(header_file), "--output", str(body), "--write-out", "%{http_code}"]
        started = now()
        result = subprocess.run(cmd + (["--head"] if head else ["--max-filesize", str(limit)]) + [url], capture_output=True,
                                text=True, timeout=timeout + 3)
        received = now()
        status = int(result.stdout or "0")
        headers = {}
        if header_file.exists():
            for line in header_file.read_text(encoding="latin-1").splitlines():
                if line.startswith("HTTP/"):
                    headers = {}
                elif ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.lower()] = v.strip()
        # Only allowlisted response headers are retained in the review package.
        header_file.unlink(missing_ok=True)
        if result.returncode == 0 and status in allowed:
            if not body.is_file() or body.stat().st_size > limit:
                raise ValueError(f"{key}: response exceeds capture bounds")
            return {"url": url, "status": status, "body": body.name, "bytes": body.stat().st_size,
                    "sha256": digest(body), "headers": {k: v for k, v in headers.items() if k in {
                        "date", "age", "etag", "last-modified", "cache-control", "x-amz-meta-sha256"}},
                    "startedAt": started, "receivedAt": received}
        transient = status in (408, 425, 429, 500, 502, 503, 504) or result.returncode in (6, 7, 28, 52, 56)
        if not transient or attempt == 2:
            raise ValueError(f"{key}: HTTP {status}, curl {result.returncode}")
        retry = headers.get("retry-after", "")
        delay = int(retry) if retry.isdigit() else 2 ** (attempt + 1)
        if delay > min(90, deadline - time.monotonic()):
            raise ValueError(f"{key}: retry exceeds capture deadline")
        time.sleep(delay)


def require_unserved(directory, name, publication, deadline):
    check = fetch(directory, name, PROOFS + publication, 2 * MIB, deadline, allowed=(404,))
    payload = json.loads((directory / check["body"]).read_bytes())
    if (payload != {"ok": False, "error": "Publication proof not available"}
            or check["headers"].get("cache-control") != "no-store"):
        raise ValueError("Unexpected response from production proof lookup")


def unique_url(url):
    return url + ("&" if "?" in url else "?") + "tb085=" + uuid4().hex


def check_roster(roster):
    if not isinstance(roster, list) or not 1 <= len(roster) <= 128:
        raise ValueError("Invalid renewal roster size")
    pairs = set()
    for row in roster:
        line, station = row["lineID"], row["stationID"]
        directions = row.get("directions", [])
        if (not re.fullmatch("[a-z0-9-]{1,64}", line) or not re.fullmatch("[A-Z0-9]{1,32}", station)
                or line not in row["catalogueMembership"] or type(row["qualifiedBaseline"]) is not bool
                or not isinstance(directions, list) or len(directions) != len(set(directions))
                or set(directions) - {"inbound", "outbound"} or (line, station) in pairs):
            raise ValueError(f"Invalid or duplicate roster entry {line}/{station}")
        pairs.add((line, station))
    if not any(r["qualifiedBaseline"] for r in roster):
        raise ValueError("No qualified reference scopes in renewal roster")


def extend_roster(roster, origins, catalogue):
    """Preserve reviewed directional scopes and add independently catalogued origins."""
    pairs = {(r["lineID"], r["stationID"]) for r in roster}
    additions = []
    for station in catalogue["stations"]:
        station_id = station["stationID"]
        membership = sorted(line["lineID"] for line in station["lines"])
        for line_id in membership:
            pair = (line_id, station_id)
            if station_id in origins.get(line_id, ()) and pair not in pairs:
                additions.append({"lineID": line_id, "stationID": station_id,
                                  "stationName": station["stationName"],
                                  "catalogueMembership": membership, "qualifiedBaseline": False})
                pairs.add(pair)
    result = roster + additions
    check_roster(result)
    return result


def parse_requested_scopes(scopes):
    if not isinstance(scopes, list) or not 1 <= len(scopes) <= 32:
        raise ValueError("Runtime preparation requires 1 to 32 requested line/station scopes")
    pairs = []
    for scope in scopes:
        if not isinstance(scope, str) or not re.fullmatch(r"[a-z0-9-]{1,64}/[A-Z0-9]{1,32}", scope):
            raise ValueError("Invalid requested line/station scope")
        pair = tuple(scope.split("/"))
        if pair in pairs:
            raise ValueError("Duplicate requested line/station scope")
        pairs.append(pair)
    return pairs


def runtime_rosters(roster, origins, catalogue, previous, requested_scopes, *, retain_references=False, xml_pickup_scopes=()):
    """Select demand and prior authority in memory; never probe unrelated stations."""
    requested = set(parse_requested_scopes(requested_scopes))
    known = {(r["lineID"], r["stationID"]): r for r in roster}
    catalogued = {}
    for station in catalogue["stations"]:
        membership = sorted(line["lineID"] for line in station["lines"])
        for line in membership:
            catalogued[(line, station["stationID"])] = {
                "lineID": line, "stationID": station["stationID"], "stationName": station["stationName"],
                "catalogueMembership": membership, "qualifiedBaseline": False}
    body = packager.parse(base64.b64decode(previous["proofBodyBase64"], validate=True))
    prior = {(e["lineID"], e["stationID"]): e for e in body.get("entries", [])}
    qualified = {pair for pair, entry in prior.items() if entry.get("status") == "qualified"}
    for pair in requested:
        if pair not in catalogued:
            raise ValueError("Requested scope is outside the current station catalogue: " + "/".join(pair))
        if (pair[1] not in origins.get(pair[0], ()) and pair not in qualified
                and not known.get(pair, {}).get("directions") and pair not in xml_pickup_scopes):
            raise ValueError("Requested scope is not a discovered origin or reviewed directional scope: " + "/".join(pair))
    rows = []
    for pair in sorted(requested | prior.keys()):
        if pair not in catalogued:
            raise ValueError("Prior scope is outside the current station catalogue: " + "/".join(pair))
        row = copy.deepcopy(known.get(pair, catalogued[pair]))
        row["qualifiedBaseline"] = False  # Only the retained proof supplies runtime baseline authority.
        rows.append(row)
    # Existing preservation checks validate every prior entry and its directions.
    rows = preserve_previous_qualified_scopes(rows, previous)
    check_roster(rows)
    capture_pairs = requested - qualified if retain_references else requested | qualified
    captures = [row for row in rows if (row["lineID"], row["stationID"]) in capture_pairs]
    return rows, captures


def retain_uncaptured_entries(proof, previous_body, captures, *, preserve_references=True):
    captured = {(row["lineID"], row["stationID"]) for row in captures}
    retained = []
    for entry in previous_body["entries"]:
        if (entry["lineID"], entry["stationID"]) in captured:
            continue
        if preserve_references:
            retained.append(copy.deepcopy(entry))
        else:
            if entry["status"] == "qualified":
                raise ValueError("Runtime rollover omitted a prior qualified capture")
            retained.append({"lineID": entry["lineID"], "stationID": entry["stationID"],
                             "status": "gap", "gapReason": "Not requested for runtime qualification",
                             "nonOperationBankHolidays": True, "profiles": []})
    combined = dict(proof, entries=sorted(proof["entries"] + retained,
                                         key=lambda entry: (entry["lineID"], entry["stationID"])))
    if preserve_references and any(entry.get("directionalDefinitions") for entry in retained):
        # This descriptive field reflects retained selected-calling scopes too.
        # All actual operating/calendar/XML rules still reach select_entries unchanged.
        combined["qualificationScope"] = previous_body["qualificationScope"]
    return combined


def offered_directions(payload, line, station):
    """Recognize only TfL's exact same-origin, fixed-station choice forms."""
    if not isinstance(payload, dict) or payload.get("timetable") is not None:
        return []
    disambiguation = payload.get("disambiguation")
    if not isinstance(disambiguation, dict):
        return []
    options = disambiguation.get("disambiguationOptions")
    if not isinstance(options, list) or not 1 <= len(options) <= 128:
        return []
    prefix = f"/Line/{line}/Timetable/{station}?direction="
    allowed = {prefix + direction: direction for direction in ("inbound", "outbound")}
    if any(not isinstance(o, dict) or not isinstance(o.get("uri"), str) or o["uri"] not in allowed for o in options):
        return []
    return sorted({allowed[o["uri"]] for o in options})


def capture_matrix(directory, roster, deadline):
    rows = []
    for row in roster:
        line, station = row["lineID"], row["stationID"]
        origin = f"{API}/Line/{line}/Timetable/{station}"
        record = {k: row[k] for k in ("lineID", "stationID", "stationName", "catalogueMembership")}
        rows.append(record)
        if line in qualifier.RAIL:
            continue
        allowed = (200,) if row["qualifiedBaseline"] else (200, 404)
        directions = row.get("directions", [])
        if not directions:
            response = fetch(directory, f"{line}-{station}", unique_url(origin), 8 * MIB, deadline, allowed=allowed)
            record["timetableSource"] = response
            if response["status"] == 200 and not row["qualifiedBaseline"]:
                try:
                    data = json.loads((directory / response["body"]).read_bytes())
                except (UnicodeError, json.JSONDecodeError):
                    continue  # The qualifier retains this malformed optional origin as a gap.
                directions = offered_directions(data, line, station)
                if directions:
                    row["directions"] = directions
                    record["directionChoiceSource"] = record.pop("timetableSource")
        for direction in directions:
            url = origin + "?" + urlencode({"direction": direction})
            response = fetch(directory, f"{line}-{station}-{direction}", unique_url(url), 8 * MIB,
                             deadline, allowed=allowed)
            record.setdefault("directionalTimetableSources", []).append(
                {"direction": direction, "timetableSource": response})
    write_json(directory / "line-station-matrix.json", rows)


def coverage_report(roster, proof):
    expected = {(r["lineID"], r["stationID"]): r for r in roster}
    entries = proof["entries"]
    observed = {(e["lineID"], e["stationID"]): e for e in entries}
    if len(observed) != len(entries) or set(observed) != set(expected):
        raise ValueError("Qualifier coverage differs from the reviewed roster")
    coverage = {"qualified": [], "newlyQualified": [], "gaps": []}
    losses = []
    for pair, row in expected.items():
        entry = observed[pair]
        label = "/".join(pair)
        if entry["status"] == "qualified":
            directions = sorted(d["direction"] for d in entry.get("directionalDefinitions", []))
            if directions != sorted(row.get("directions", [])):
                raise ValueError(f"Directional coverage differs for {label}")
            coverage["qualified"].append(label)
            if not row["qualifiedBaseline"]:
                coverage["newlyQualified"].append(label)
        elif entry["status"] == "gap" and entry.get("gapReason"):
            coverage["gaps"].append({"scope": label, "reason": entry["gapReason"]})
            if row["qualifiedBaseline"]:
                losses.append(label + ": " + entry["gapReason"])
        else:
            raise ValueError(f"Unexpected qualification for {label}")
    if losses:
        raise ValueError("Previously qualified scopes lost: " + ", ".join(losses))
    return coverage


def qualified_source_records(capture_dir, proof, retained=None):
    """Return only exact source bodies committed by qualified proof scopes."""
    matrix = json.loads((capture_dir / "line-station-matrix.json").read_text(encoding="utf-8"))
    captured = {(row["lineID"], row["stationID"]): row for row in matrix}
    if len(captured) != len(matrix):
        raise ValueError("Duplicate source capture scope")
    proof_entries = {(entry["lineID"], entry["stationID"]): entry for entry in proof["entries"]}
    retained = retained or {}
    qualified = {pair for pair, entry in proof_entries.items() if entry["status"] == "qualified"}
    if (len(proof_entries) != len(proof["entries"]) or not set(captured) <= set(proof_entries)
            or not set(retained) <= qualified or not qualified <= set(captured) | set(retained)):
        raise ValueError("Source archive scope differs from qualified proof")
    result = []
    for (line, station), entry in sorted(proof_entries.items()):
        if entry["status"] != "qualified":
            continue
        row = retained[(line, station)] if (line, station) in retained else captured[(line, station)]
        if entry.get("directionalDefinitions"):
            definitions = {item["direction"]: item for item in entry["directionalDefinitions"]}
            evidence = {item["direction"]: item for item in entry["directionalSourceEvidence"]}
            sources = {item["direction"]: item for item in row["directionalTimetableSources"]}
            if (len(definitions) != len(entry["directionalDefinitions"])
                    or len(evidence) != len(entry["directionalSourceEvidence"])
                    or len(sources) != len(row["directionalTimetableSources"])
                    or set(definitions) != set(evidence) or set(evidence) != set(sources)):
                raise ValueError(f"Directional source archive scope differs for {line}/{station}")
            for direction in sorted(definitions):
                result.append((line, station, direction, sources[direction]["timetableSource"], evidence[direction]["apiBodySHA256"]))
        else:
            result.append((line, station, None, row["timetableSource"], entry["apiBodySHA256"]))
    if not result:
        raise ValueError("No qualified source bodies to retain")
    return result


def validate_source_capture_metadata(item):
    try:
        started = datetime.fromisoformat(item["startedAt"])
        received = datetime.fromisoformat(item["receivedAt"])
        http_date = parsedate_to_datetime(item["httpDate"])
        age_text = item["age"]
        if not isinstance(age_text, str) or not re.fullmatch(r"\d{1,4}", age_text):
            raise ValueError("Age must be a decimal response header")
        age = int(age_text)
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise ValueError("Source archive capture metadata is invalid") from error
    if (started.utcoffset() is None or received.utcoffset() is None or http_date.utcoffset() is None
            or started > received or (received - started).total_seconds() > 30 or not 0 <= age <= 600):
        raise ValueError("Source archive capture metadata or response timing is invalid")
    headers = {"date": item["httpDate"], "age": age_text,
               "cache-control": item.get("cacheControl", "")}
    monitor.check_fresh(headers, received.astimezone(timezone.utc))
    return started, received, http_date, age


def build_source_archive(capture_dir, proof, publication_sha, proof_body_sha, output_dir, *, retained=None):
    """Write exact, proof-bound Unified bodies for comparison only, never serving."""
    if output_dir.exists():
        raise ValueError("Source archive output already exists")
    if (not re.fullmatch(r"[0-9a-f]{64}", publication_sha)
            or not re.fullmatch(r"[0-9a-f]{64}", proof_body_sha)
            or proof.get("publication", {}).get("sha256") != publication_sha):
        raise ValueError("Source archive publication/proof identity is invalid")
    scopes = qualified_source_records(capture_dir, proof, retained)
    if len(scopes) > 128:
        raise ValueError("Qualified source archive exceeds scope bound")
    bodies_dir = output_dir / "bodies"
    bodies_dir.mkdir(parents=True)
    records, total_bytes = [], 0
    body_metadata = {}
    for line, station, direction, source, expected_sha in scopes:
        if source.get("status") != 200 or source.get("sha256") != expected_sha:
            raise ValueError(f"Qualified source hash differs for {line}/{station}")
        name = source.get("body")
        if not isinstance(name, str) or Path(name).name != name:
            raise ValueError("Invalid captured source body path")
        source_path = capture_dir / name
        if source_path.is_symlink() or not source_path.is_file():
            raise ValueError("Qualified source body is unavailable")
        source_size = source_path.stat().st_size
        if type(source.get("bytes")) is not int or not 1 <= source_size <= 8 * MIB or source_size != source["bytes"]:
            raise ValueError("Qualified source body exceeds the per-body bound")
        capture_metadata = {"startedAt": source.get("startedAt"), "receivedAt": source.get("receivedAt"),
                            "httpDate": source.get("headers", {}).get("date"),
                            "age": source.get("headers", {}).get("age"),
                            "cacheControl": source.get("headers", {}).get("cache-control", "")}
        validate_source_capture_metadata(capture_metadata)
        if source["sha256"] not in body_metadata and total_bytes + source_size > 32 * MIB:
            raise ValueError("Qualified source archive exceeds 32 MiB")
        body = source_path.read_bytes()
        body_sha = hashlib.sha256(body).hexdigest()
        if body_sha != expected_sha or len(body) != source.get("bytes") or len(body) > 8 * MIB:
            raise ValueError(f"Qualified source body readback differs for {line}/{station}")
        # Recheck the response's intrinsic scope before preserving it.
        payload = json.loads(body.decode("utf-8"))
        if payload.get("lineId") != line or payload.get("timetable", {}).get("departureStopId") != station:
            raise ValueError(f"Qualified source body has wrong scope for {line}/{station}")
        if direction is not None and payload.get("direction") != direction:
            raise ValueError(f"Qualified source body has wrong direction for {line}/{station}")
        response_direction = payload.get("direction")
        if response_direction is not None and response_direction not in {"inbound", "outbound"}:
            raise ValueError(f"Qualified source body has an unsupported response direction for {line}/{station}")
        relative = f"bodies/{body_sha}.json"
        prior = body_metadata.get(body_sha)
        if prior is None:
            total_bytes += len(body)
            if total_bytes > 32 * MIB:
                raise ValueError("Qualified source archive exceeds 32 MiB")
            target = output_dir / relative
            target.write_bytes(body)
            body_metadata[body_sha] = {"path": relative, "bytes": len(body)}
        elif prior["bytes"] != len(body):
            raise ValueError("Conflicting content-addressed source body")
        endpoint = f"{API}/Line/{line}/Timetable/{station}"
        if direction is not None:
            endpoint += "?" + urlencode({"direction": direction})
        records.append({"lineID": line, "stationID": station, "direction": direction,
                        "endpoint": endpoint, "bodySHA256": body_sha,
                        "bodyPath": relative, "bodyBytes": len(body),
                        "responseDirection": response_direction,
                        "startedAt": capture_metadata["startedAt"], "receivedAt": capture_metadata["receivedAt"],
                        "httpDate": source.get("headers", {}).get("date"),
                        "age": source.get("headers", {}).get("age"),
                        "cacheControl": source.get("headers", {}).get("cache-control", "")})
    manifest = {"schemaVersion": 1, "kind": "tubeboard-timetable-comparison-reference",
                "publicationSHA256": publication_sha, "proofBodySHA256": proof_body_sha,
                "usePolicy": {"role": "comparison-reference-only", "mayServeDepartures": False,
                              "requiresFreshCurrentResponse": True,
                              "requiresCurrentStatusAndDisruptionChecks": True,
                              "captureMetadataMayEstablishFreshness": False,
                              "capturedResponseWasFreshAtReadback": True},
                "canonicalBodyKey": "SHA-256 of exact UTF-8 Unified timetable response bytes",
                "sourceCount": len(records), "uniqueBodyCount": len(body_metadata),
                "totalBodyBytes": total_bytes, "sources": records}
    manifest_path = output_dir / "manifest.json"
    write_json(manifest_path, manifest)
    return verify_source_archive(output_dir, proof, publication_sha, proof_body_sha)


def verify_source_archive(archive_dir, proof, publication_sha, proof_body_sha, expected_manifest_sha=None):
    """Read back the manifest and every exact body against proof source digests."""
    if (not re.fullmatch(r"[0-9a-f]{64}", publication_sha)
            or not re.fullmatch(r"[0-9a-f]{64}", proof_body_sha)
            or proof.get("publication", {}).get("sha256") != publication_sha):
        raise ValueError("Source archive publication/proof identity is invalid")
    manifest_path = archive_dir / "manifest.json"
    if (archive_dir.is_symlink() or not archive_dir.is_dir() or manifest_path.is_symlink()
            or not manifest_path.is_file() or manifest_path.stat().st_size > MIB):
        raise ValueError("Source archive manifest is missing or exceeds its size bound")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    if (archive_dir.is_symlink() or set(manifest) != {"schemaVersion", "kind", "publicationSHA256", "proofBodySHA256",
                                                       "usePolicy", "canonicalBodyKey", "sourceCount", "uniqueBodyCount",
                                                       "totalBodyBytes", "sources"}
            or manifest.get("schemaVersion") != 1
            or manifest.get("kind") != "tubeboard-timetable-comparison-reference"
            or manifest.get("usePolicy") != {"role": "comparison-reference-only", "mayServeDepartures": False,
                                              "requiresFreshCurrentResponse": True,
                                              "requiresCurrentStatusAndDisruptionChecks": True,
                                              "captureMetadataMayEstablishFreshness": False,
                                              "capturedResponseWasFreshAtReadback": True}
            or manifest.get("publicationSHA256") != publication_sha
            or manifest.get("proofBodySHA256") != proof_body_sha
            or expected_manifest_sha is not None and manifest_sha != expected_manifest_sha
            or manifest.get("canonicalBodyKey") != "SHA-256 of exact UTF-8 Unified timetable response bytes"):
        raise ValueError("Source archive manifest identity is invalid")
    expected = {}
    for entry in proof["entries"]:
        if entry["status"] != "qualified":
            continue
        pair = (entry["lineID"], entry["stationID"])
        if entry.get("directionalDefinitions"):
            evidence = {item["direction"]: item["apiBodySHA256"] for item in entry["directionalSourceEvidence"]}
            for direction, sha in evidence.items():
                expected[(*pair, direction)] = sha
        else:
            expected[(*pair, None)] = entry["apiBodySHA256"]
    if len(expected) > 128 or any(not re.fullmatch(r"[0-9a-f]{64}", sha) for sha in expected.values()):
        raise ValueError("Qualified proof source digests are invalid")
    sources = manifest.get("sources")
    required_fields = {"lineID", "stationID", "direction", "endpoint", "bodySHA256", "bodyPath", "bodyBytes",
                       "responseDirection", "startedAt", "receivedAt", "httpDate", "age", "cacheControl"}
    if (not isinstance(sources, list) or not 1 <= len(sources) <= 128 or len(sources) != len(expected)
            or manifest.get("sourceCount") != len(sources)
            or not all(isinstance(item, dict) and set(item) == required_fields for item in sources)
            or any(not isinstance(item["bodySHA256"], str)
                   or not re.fullmatch(r"[0-9a-f]{64}", item["bodySHA256"])
                   or item["bodyPath"] != f"bodies/{item['bodySHA256']}.json"
                   or type(item["bodyBytes"]) is not int or not 1 <= item["bodyBytes"] <= 8 * MIB
                   for item in sources)
            or manifest.get("uniqueBodyCount") != len({item["bodySHA256"] for item in sources})
            or type(manifest.get("totalBodyBytes")) is not int or not 1 <= manifest["totalBodyBytes"] <= 32 * MIB):
        raise ValueError("Source archive manifest scope is incomplete")
    bodies_dir = archive_dir / "bodies"
    if (bodies_dir.is_symlink() or not bodies_dir.is_dir()
            or {path.name for path in archive_dir.iterdir()} != {"manifest.json", "bodies"}):
        raise ValueError("Source archive contains unexpected files")
    expected_files = {item["bodySHA256"] + ".json" for item in sources}
    if {path.name for path in bodies_dir.iterdir()} != expected_files:
        raise ValueError("Source archive contains unexpected body files")
    seen, unique = set(), {}
    for item in sources:
        key = (item.get("lineID"), item.get("stationID"), item.get("direction"))
        if (not isinstance(key[0], str) or not re.fullmatch(r"[a-z0-9-]{1,64}", key[0])
                or not isinstance(key[1], str) or not re.fullmatch(r"[A-Z0-9]{1,32}", key[1])
                or key[2] not in {None, "inbound", "outbound"}
                or key in seen or key not in expected or item.get("bodySHA256") != expected[key]):
            raise ValueError("Source archive record does not match qualified proof scope")
        seen.add(key)
        expected_endpoint = f"{API}/Line/{key[0]}/Timetable/{key[1]}"
        if key[2] is not None:
            expected_endpoint += "?" + urlencode({"direction": key[2]})
        validate_source_capture_metadata(item)
        if item["endpoint"] != expected_endpoint:
            raise ValueError("Source archive capture metadata or endpoint is invalid")
        relative = item.get("bodyPath")
        if not isinstance(relative, str) or not re.fullmatch(r"bodies/[0-9a-f]{64}\.json", relative):
            raise ValueError("Source archive body path is invalid")
        path = archive_dir / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError("Source archive body is missing")
        if type(item.get("bodyBytes")) is not int or not 1 <= item["bodyBytes"] <= 8 * MIB \
                or path.stat().st_size != item["bodyBytes"]:
            raise ValueError("Source archive body length is invalid")
        body = path.read_bytes()
        sha = hashlib.sha256(body).hexdigest()
        if sha != item.get("bodySHA256") or sha != Path(relative).stem or len(body) != item.get("bodyBytes"):
            raise ValueError("Source archive body digest or length is invalid")
        payload = json.loads(body.decode("utf-8"))
        if (payload.get("lineId") != key[0] or payload.get("timetable", {}).get("departureStopId") != key[1]
                or (key[2] is not None and payload.get("direction") != key[2])
                or (payload.get("direction") is not None and payload.get("direction") not in {"inbound", "outbound"})
                or item.get("responseDirection") != payload.get("direction")):
            raise ValueError("Source archive body does not match its line/station/direction key")
        unique[sha] = len(body)
    if (seen != set(expected)
            or manifest.get("uniqueBodyCount") != len(unique)
            or manifest.get("totalBodyBytes") != sum(unique.values())
            or sum(unique.values()) > 32 * MIB):
        raise ValueError("Source archive manifest counts are invalid")
    return {"manifestSHA256": manifest_sha,
            "sourceCount": len(sources), "uniqueBodyCount": len(unique),
            "totalBodyBytes": sum(unique.values())}


@contextmanager
def bounded_source_file(path, limit):
    path = Path(path)
    if ".." in path.parts or not path.name:
        raise ValueError("Source input path contains traversal")
    parts = path.parts[1:] if path.is_absolute() else path.parts
    directory = os.open(path.anchor if path.is_absolute() else ".", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise ValueError("Source input is not a bounded regular file")
        yield source, info.st_size


def source_json(path):
    with bounded_source_file(path, 64 * 1024) as (source, size):
        raw = source.read(64 * 1024 + 1)
    if len(raw) != size:
        raise ValueError("Source metadata changed while reading")
    value = packager.parse(raw)
    if not isinstance(value, dict):
        raise ValueError("Source metadata must be a JSON object")
    return value, hashlib.sha256(raw).hexdigest()


def fresh_cached_edition(work, key, publication, deadline):
    url = unique_url(qualifier.SOURCE_URL)
    observation = fetch(work, key, url, 64 * 1024, deadline, head=True)
    if observation["status"] == 200 and "age" not in observation["headers"]:
        observation = fetch(work, key, url, 64 * 1024, deadline, head=True)
    if observation["status"] != 200 or observation["headers"].get("x-amz-meta-sha256") != publication:
        raise ValueError("Official publication changed while reusing cached archive")
    monitor.check_fresh(observation["headers"], datetime.now(timezone.utc), provider=True)
    return dict(observation, sourceClockMethod="HEAD")


def cached_qualification_date(observation, publication):
    if (observation.get("status") != 200 or observation.get("sourceClockMethod") != "HEAD"
            or observation.get("headers", {}).get("x-amz-meta-sha256") != publication):
        raise ValueError("Qualification date requires a current official HEAD")
    received = datetime.fromisoformat(observation["receivedAt"])
    current = datetime.now(timezone.utc)
    if received.utcoffset() is None or not 0 <= (current - received).total_seconds() < 600:
        raise ValueError("Qualification HEAD receipt must be aware and current")
    monitor.check_fresh(observation["headers"], current, provider=True)
    return received.astimezone(ZoneInfo("Europe/London")).date()


def acquire_cached_archive(work, publication, deadline, archive, receipt_path, metadata_path):
    receipt, receipt_sha = source_json(receipt_path)
    metadata, metadata_sha = source_json(metadata_path)
    size = receipt.get("bytes")
    method = metadata.get("sourceClockMethod", "GET")
    transport = metadata.get("transport", "direct")
    final = receipt.get("finalObservation", {})
    if (not isinstance(final, dict) or not isinstance(final.get("headers", {}), dict)
            or not isinstance(metadata.get("headers"), dict)
            or not all(isinstance(metadata.get(key), str) for key in ("url", "startedAt", "receivedAt"))):
        raise ValueError("Cached archive source metadata is malformed")
    observed_sha = final.get("headers", {}).get("x-amz-meta-sha256") or final.get("independentlyObservedPublication")
    if (receipt.get("status") != "verified-source-only" or receipt.get("publication") != publication
            or receipt.get("sha256") != publication or observed_sha != publication
            or type(size) is not int or not 0 < size <= 256 * MIB
            or metadata.get("status") != 200 or metadata.get("sha256") != publication
            or type(metadata.get("bytes")) is not int or metadata.get("bytes") != size
            or metadata.get("headers", {}).get("x-amz-meta-sha256") != publication
            or method not in {"GET", "HEAD"} or receipt.get("sourceClockMethod") != method
            or receipt.get("transport") != transport):
        raise ValueError("Cached archive receipt and original source metadata do not match")
    source_url = urlsplit(metadata.get("url", ""))
    official_url = urlsplit(qualifier.SOURCE_URL)
    direct = (transport == "direct" and method == "GET" and source_url.scheme == "https"
              and source_url.hostname == official_url.hostname and source_url.path == official_url.path
              and source_url.port in (None, 443) and not source_url.username and not source_url.password
              and not source_url.fragment and all(key == "tb085" for key, _ in parse_qsl(source_url.query)))
    transferred = (transport == "verified-service-transfer" and metadata.get("sourceURL") == qualifier.SOURCE_URL
                   and metadata.get("url") == transfer.TRANSFER + publication)
    if not direct and not transferred:
        raise ValueError("Cached archive has no supported original source provenance")
    started = datetime.fromisoformat(metadata["startedAt"])
    received = datetime.fromisoformat(metadata["receivedAt"])
    if started.utcoffset() is None or received.utcoffset() is None or not started <= received <= datetime.now(timezone.utc):
        raise ValueError("Cached archive source clocks are invalid")
    # Validate the original response at its original receipt, never at reuse time.
    monitor.check_fresh(metadata["headers"], received, provider=True)
    before = fresh_cached_edition(work, "cached-official-before", publication, deadline)
    target = work / "cached-official.zip"
    copied = 0
    sha = hashlib.sha256()
    with bounded_source_file(archive, 256 * MIB) as (source, original_size), target.open("xb") as output:
        if original_size != size:
            raise ValueError("Cached archive byte count differs from its receipt")
        while chunk := source.read(MIB):
            copied += len(chunk)
            if copied > size or time.monotonic() >= deadline:
                raise ValueError("Cached archive exceeded its size or time bound")
            sha.update(chunk)
            output.write(chunk)
    if copied != size or sha.hexdigest() != publication:
        raise ValueError("Cached archive bytes differ from the official edition")
    checked_archive(target)
    after = fresh_cached_edition(work, "cached-official-after", publication, deadline)
    retained = {key: copy.deepcopy(metadata[key]) for key in
                ("url", "status", "bytes", "sha256", "headers", "startedAt", "receivedAt", "transport", "sourceURL", "sourceClockMethod")
                if key in metadata}
    retained.update(body=target.name, cachedArchiveEvidence={"receiptSHA256": receipt_sha,
                    "metadataSHA256": metadata_sha, "before": before, "after": after})
    return retained


def retain_verified_cached_archive(work, captures, download):
    """Move our verified private copy; never link or move the caller's cache."""
    work, captures = Path(work), Path(captures)
    if (download.get("body") != "cached-official.zip"
            or not isinstance(download.get("cachedArchiveEvidence"), dict)
            or captures != work / "artifact" / "captures"):
        raise ValueError("Cached archive retention requires the private verified copy")
    source, target = work / "cached-official.zip", captures / "official-timetable.zip"
    for directory in (work, work / "artifact", captures):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("Cached archive retention directory is not private")
    if work.stat().st_mode & 0o077:
        raise ValueError("Cached archive retention requires private work custody")
    if target.exists() or target.is_symlink():
        raise ValueError("Cached archive retention destination already exists")
    with bounded_source_file(source, 256 * MIB) as (opened, size):
        info = os.fstat(opened.fileno())
        current = source.lstat()
        if (size != download.get("bytes") or info.st_nlink != 1
                or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)
                or info.st_dev != captures.stat().st_dev):
            raise ValueError("Cached archive retention lost exclusive same-filesystem custody")
        # Only this exclusive verified private inode may be synchronized/advised.
        # A writable descriptor keeps fsync portable without changing any bytes.
        private_fd = os.open(source, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            writable = os.fstat(private_fd)
            if ((writable.st_dev, writable.st_ino, writable.st_size, writable.st_nlink)
                    != (info.st_dev, info.st_ino, size, 1)):
                raise ValueError("Cached archive synchronization identity changed")
            os.fsync(private_fd)
            advise = getattr(os, "posix_fadvise", None)
            dontneed = getattr(os, "POSIX_FADV_DONTNEED", None)
            if advise is not None and dontneed is not None:
                try:
                    # Advice is optional and does not guarantee eviction or fit.
                    # Sync first so these completed writes are eligible for release.
                    advise(private_fd, 0, 0, dontneed)
                except OSError as error:
                    if error.errno not in {errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP}:
                        raise
        finally:
            os.close(private_fd)
        # Both names are inside the one exclusive TemporaryDirectory. Rename
        # keeps the same verified inode/bytes and allocates no second ZIP copy.
        # EXDEV and other errors propagate; constrained mode never falls back.
        source.rename(target)
        retained = target.lstat()
        if (retained.st_dev, retained.st_ino, retained.st_size) != (info.st_dev, info.st_ino, size):
            raise ValueError("Cached archive retention identity changed")
    return target


def acquire_current_zip(work, publication, deadline):
    download = fetch(work, "official", unique_url(qualifier.SOURCE_URL), 256 * MIB, deadline,
                     allowed=(200, 403))
    if download["status"] == 403:
        download = transfer.acquire(work, publication, deadline)
    if download["sha256"] != publication or download["headers"].get("x-amz-meta-sha256") != publication:
        raise ValueError("Official ZIP/header differs from requested edition")
    archive = work / download["body"]
    checked_archive(archive)
    return download


def confirm_current_edition(work, publication, deadline):
    latest = fetch(work, "official-final", unique_url(qualifier.SOURCE_URL), 64 * 1024,
                   deadline, head=True, allowed=(200, 403))
    if latest["status"] == 403:
        observed, source = monitor.current_edition(monitor.request)
        latest = dict(latest, independentlyObservedPublication=observed, observationSource=source)
    else:
        observed = latest["headers"].get("x-amz-meta-sha256")
    if observed != publication:
        raise ValueError("Official publication changed while the candidate was being prepared")
    return latest


def record_tram_comparisons(work, download, output, deadline):
    """Keep the independent Tram checks outside the resource consumed by installed apps."""
    if output is None:
        return
    edition = download["sha256"]
    report = {"publication": edition, "status": "unverified"}
    try:
        directory = work / "tram-comparison"
        directory.mkdir()
        write_json(directory / "publication-download.json", download)
        today = datetime.now(ZoneInfo("Europe/London")).date()
        routes = fetch(directory, "network-routes", unique_url(monitor.ROUTES), MIB, deadline)
        monitor.check_fresh(routes["headers"], datetime.now(timezone.utc))
        origins = monitor.route_origins(json.loads((directory / routes["body"]).read_bytes()), today)["tram"]
        stop_source = fetch(directory, "tram-stop-points", unique_url(API + "/Line/tram/StopPoints"), 2 * MIB, deadline)
        monitor.check_fresh(stop_source["headers"], datetime.now(timezone.utc))
        names = tram.stations()
        parents = tram.platform_parents(json.loads((directory / stop_source["body"]).read_bytes()), names)
        if origins - set(parents.values()):
            raise ValueError("Tram route origin lacks a verified platform and mapped station")
        roster = [{"lineID": "tram", "stationID": station, "stationName": names[station],
                   "catalogueMembership": ["tram"], "qualifiedBaseline": False} for station in sorted(origins)]
        holiday = fetch(directory, "bank-holidays", HOLIDAYS, MIB, deadline)
        write_json(directory / "source-receipts.json", {"routes": routes, "stops": stop_source, "holidays": holiday})
        capture_matrix(directory, roster, deadline)
        proof, origin_inventory = qualifier.generate_with_inventory(work / download["body"], directory, CATALOGUE)
        write_json(directory / "xml-passenger-origin-inventory.json", origin_inventory)
        coverage = coverage_report(roster, proof)
        failures = monitor.check_live_coverage(proof, roster, today, monitor.request)
        report.update(coverage=coverage, liveErrors=failures, proof=proof,
                      xmlPassengerOriginInventory=inventory_receipt(origin_inventory,
                          directory / "xml-passenger-origin-inventory.json"),
                      stationSourceSHA256=stop_source["sha256"],
                      mapSHA256=digest(tram.MAPS), checkedAt=now())
        evidence = work / "tram-sources.zip"
        with ZipFile(evidence, "w", compression=ZIP_DEFLATED) as bundle:
            for source in sorted(directory.iterdir()):
                if source.suffix in {".body", ".json"}:
                    bundle.write(source, source.name)
        report["evidenceSHA256"] = digest(evidence)
        os.replace(evidence, output.with_suffix(".zip"))
        if not coverage["gaps"] and not failures:
            report["status"] = "verified"
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, BadZipFile) as error:
        report["reason"] = str(error).replace("\n", " ")[:500]
    write_json(output, report)


def acquire_and_record(work, publication, deadline, output):
    if output is not None:
        write_json(output, {"status": "transfer-attempted", "publication": publication})
    receipt = acquire_current_zip(work, publication, deadline)
    if output is not None:
        final = confirm_current_edition(work, publication, deadline)
        write_json(output, {"status": "verified-source-only", "publication": publication,
                            "transport": receipt.get("transport", "direct"), "bytes": receipt["bytes"],
                            "sha256": receipt["sha256"], "sourceClockMethod": receipt.get("sourceClockMethod", "GET"),
                            "finalObservation": final})
    return receipt


def inventory_receipt(inventory, path):
    detail=inventory["inventory"]
    return {"schemaVersion":1,"kind":inventory["kind"],
        "publicationSHA256":inventory["publicationSHA256"],
        "artifact":"xml-passenger-origin-inventory.json","artifactSHA256":digest(path),
        "inventoryDifferenceSHA256":detail["inventoryDifferenceSHA256"],
        "discoveryStatus":detail["discoveryStatus"],
        "passengerOriginCount":detail["passengerOriginCount"],
        "uncataloguedOriginCount":detail["uncataloguedOriginCount"],
        "unresolvedMemberCount":len(detail["unresolvedMembers"]),
        "malformedCurrentRowCount":len(detail["malformedCurrentRows"]),
        "xmlLineIDs":detail["xmlLineIDs"],"missingXmlLineIDs":detail["missingXmlLineIDs"]}


def rehearse_source(publication, output, *, tram_report=None, origin_inventory_output=None):
    if not packager.SHA.fullmatch(publication):
        raise ValueError("Invalid official edition")
    deadline = time.monotonic() + 300
    with tempfile.TemporaryDirectory(dir=output.parent) as directory:
        work = Path(directory)
        receipt = acquire_and_record(work, publication, deadline, output)
        if origin_inventory_output is not None:
            try:
                holiday=fetch(work,"inventory-bank-holidays",HOLIDAYS,MIB,deadline)
                holiday_body=json.loads((work/holiday["body"]).read_bytes())
                dates=sorted({row["date"] for row in holiday_body["england-and-wales"]["events"]})
                sidecar=qualifier.inventory_from_archive(work/receipt["body"],CATALOGUE,
                    receipt["receivedAt"],dates)
            except (ValueError,KeyError,TypeError,OSError,subprocess.SubprocessError,BadZipFile) as error:
                code=getattr(error,"code",None)
                detail=f"Official holiday calendar or XML inventory read failed ({code}). Active origins were not asserted."
                sidecar=qualifier.unavailable_origin_inventory(publication,receipt["receivedAt"],CATALOGUE,detail)
            origin_inventory_output.parent.mkdir(parents=True,exist_ok=True)
            write_json(origin_inventory_output,sidecar)
        record_tram_comparisons(work, receipt, tram_report, time.monotonic() + 180)


def prepare_origin_inventory_only(publication, output):
    """One protected ZIP read for discovery when neither qualifier ran."""
    if not packager.SHA.fullmatch(publication):
        raise ValueError("Invalid official edition")
    if output.exists() or output.is_symlink():
        raise ValueError("Origin inventory output must be new")
    output.parent.mkdir(parents=True, exist_ok=True)
    deadline=time.monotonic()+300
    with tempfile.TemporaryDirectory(dir=output.parent,prefix=".tb085-origin-inventory-") as directory:
        work=Path(directory)
        download=acquire_and_record(work,publication,deadline,None)
        if download.get("sha256")!=publication:
            raise ValueError("Downloaded archive differs from the selected official edition")
        confirm_current_edition(work,publication,deadline)
        try:
            holiday=fetch(work,"bank-holidays",HOLIDAYS,MIB,deadline)
            holiday_body=json.loads((work/holiday["body"]).read_bytes())
            dates=sorted({row["date"] for row in holiday_body["england-and-wales"]["events"]})
            sidecar=qualifier.inventory_from_archive(work/download["body"],CATALOGUE,download["receivedAt"],dates)
        except (ValueError,KeyError,TypeError,OSError,subprocess.SubprocessError,BadZipFile) as error:
            code=getattr(error,"code",None)
            detail=f"Official holiday calendar or XML inventory read failed ({code}). Active origins were not asserted."
            sidecar=qualifier.unavailable_origin_inventory(publication,download["receivedAt"],CATALOGUE,detail)
        write_json(output,sidecar)


def validate_runtime_discovery(value):
    """Validate this bounded interoperability result, not departure authority."""
    keys={'schemaVersion','kind','publicationSHA256','assessedAt','parsedAt','serviceDay','validUntil','structuralValidUntil','discoveryStatus',
        'eligibleScopesComplete','requiredScopesComplete','eligibleScopes','requiredScopes','unresolvedPublicSourceGaps','inputs','reuseRequirements','counts'}
    if not isinstance(value,dict) or set(value)!=keys or type(value['schemaVersion']) is not int or value['schemaVersion']!=2 or value['kind']!='tubeboard-runtime-origin-discovery-v2':raise ValueError('Invalid discovery schema')
    def instant(text):
        if not isinstance(text,str):raise ValueError('Invalid discovery timestamp')
        result=datetime.fromisoformat(text)
        if result.utcoffset() is None:raise ValueError('Discovery timestamps must be aware')
        return result
    at=instant(value['assessedAt']);until=instant(value['validUntil']);parsed=instant(value['parsedAt']);structural=instant(value['structuralValidUntil']);local=at.astimezone(ZoneInfo('Europe/London'))
    if value['serviceDay']!=local.date().isoformat() or parsed.astimezone(ZoneInfo('Europe/London')).date()!=local.date() or not parsed<=at<until<=structural<=datetime.combine(local.date()+timedelta(days=1),datetime.min.time(),ZoneInfo('Europe/London')):raise ValueError('Invalid discovery day/validity')
    for name in ('eligibleScopes','requiredScopes'):
        scopes=value[name]
        if not isinstance(scopes,list) or any(not isinstance(v,str) or not re.fullmatch(r'[a-z0-9-]{1,64}/[A-Z0-9]{1,32}',v) for v in scopes) or scopes!=sorted(set(scopes)):raise ValueError('Invalid discovery scopes')
    if len(value['requiredScopes'])>256 or not set(value['requiredScopes'])<=set(value['eligibleScopes']):raise ValueError('Invalid required discovery union')
    for flag in ('eligibleScopesComplete','requiredScopesComplete'):
        if type(value[flag]) is not bool:raise ValueError('Invalid discovery completeness')
    counts=value['counts']
    if not isinstance(counts,dict) or set(counts)!={'eligible','required','uncatalogued'} or any(type(v) is not int or not 0<=v<=2147483647 for v in counts.values()):raise ValueError('Invalid discovery counts')
    if counts['required']>counts['eligible']:raise ValueError('Required discovery count exceeds eligible count')
    for label in ('eligible','required'):
        if (value[label+'ScopesComplete'] and counts[label]!=len(value[label+'Scopes'])
                or not value[label+'ScopesComplete'] and value[label+'Scopes']):raise ValueError('Discovery cannot silently truncate authority')
    codes={'uncatalogued-passenger-origin','unqualified-xml-member','unqualified-xml-row','missing-xml-line','required-scope-overflow','inventory-overflow','holiday-authority-unavailable'}
    if not isinstance(value['unresolvedPublicSourceGaps'],list):raise ValueError('Invalid discovery gaps')
    for gap in value['unresolvedPublicSourceGaps']:
        if (not isinstance(gap,dict) or set(gap)!={'code','lineID','stationID','affectsCurrentCoverage'} or not isinstance(gap['code'],str) or gap['code'] not in codes or type(gap['affectsCurrentCoverage']) is not bool
                or any(gap[name] is not None and (not isinstance(gap[name],str) or not 0<len(gap[name])<=128) for name in ('lineID','stationID'))):raise ValueError('Invalid discovery gap')
    current_gaps=[g for g in value['unresolvedPublicSourceGaps'] if g['affectsCurrentCoverage']]
    unavailable=any(g['code']=='unqualified-xml-member' and g['lineID'] is None and g['stationID'] is None for g in current_gaps)
    inventory_overflow=any(g['code']=='inventory-overflow' for g in current_gaps)
    required_overflow=any(g['code']=='required-scope-overflow' for g in current_gaps)
    if (not value['eligibleScopesComplete'] and (value['requiredScopesComplete'] or not (inventory_overflow or unavailable))
            or not value['requiredScopesComplete'] and not (inventory_overflow or required_overflow or unavailable)):
        raise ValueError('Incomplete discovery requires an explicit whole-inventory reason')
    if counts['required']>256 and (value['requiredScopesComplete'] or not (inventory_overflow or required_overflow)):
        raise ValueError('Required discovery overflow must be explicit')
    incomplete=not value['eligibleScopesComplete'] or not value['requiredScopesComplete'] or any(g['affectsCurrentCoverage'] for g in value['unresolvedPublicSourceGaps'])
    if value['discoveryStatus']!=('incomplete' if incomplete else 'complete'):raise ValueError('Invalid current discovery status')
    inputs=value['inputs'];hashes={'archiveSHA256','sourceMetadataSHA256','sourceReceiptSHA256','producerSHA256','parserSHA256','catalogueSHA256','holidayBodySHA256'}
    if not isinstance(inputs,dict) or set(inputs)!=hashes|{'holidayReceivedAt','holidayExpiresAt','originalAcquisition','officialObservation'} or any(not isinstance(inputs[k],str) or not packager.SHA.fullmatch(inputs[k]) for k in hashes):raise ValueError('Invalid discovery input binding')
    if inputs['archiveSHA256']!=value['publicationSHA256']:raise ValueError('Discovery edition mismatch')
    original=inputs['originalAcquisition'];official=inputs['officialObservation']
    if (not isinstance(original,dict) or set(original)!={'startedAt','receivedAt'} or not instant(original['startedAt'])<=instant(original['receivedAt'])<=at
            or not isinstance(official,dict) or set(official)!={'publicationSHA256','observedAt','expiresAt'} or official['publicationSHA256']!=value['publicationSHA256']
            or not instant(official['observedAt'])<=at<instant(official['expiresAt'])
            or not instant(inputs['holidayReceivedAt'])<=at<instant(inputs['holidayExpiresAt']) or until>instant(inputs['holidayExpiresAt'])):raise ValueError('Invalid discovery clocks')
    reuse=value['reuseRequirements']
    if not isinstance(reuse,dict) or set(reuse)!={'freshSameEditionObservation','unchangedParserCatalogueHoliday','monotonicAssessment'} or any(flag is not True for flag in reuse.values()):raise ValueError('Invalid discovery reuse requirements')
    if len((json.dumps(value,indent=2)+'\n').encode())>qualifier.MAX_ORIGIN_INVENTORY_BYTES:raise ValueError('Discovery exceeds 2 MiB')
    return value


def discover_cached_origins(publication, output, *, source_archive, source_archive_receipt, source_archive_metadata, retained_inventory=None):
    """Bounded scope discovery; sidecar never replaces actual candidate qualification."""
    if not packager.SHA.fullmatch(publication):raise ValueError('Invalid discovery publication')
    if any(value is None for value in (source_archive,source_archive_receipt,source_archive_metadata)):
        raise ValueError('Cached discovery requires all original source inputs')
    if output.exists() or output.is_symlink():raise ValueError('Discovery output must be new')
    output.parent.mkdir(parents=True,exist_ok=True)
    prior=None
    if retained_inventory is not None:
        try:
            with bounded_source_file(retained_inventory,qualifier.MAX_ORIGIN_INVENTORY_BYTES) as (source,size):
                raw=source.read(qualifier.MAX_ORIGIN_INVENTORY_BYTES+1)
            if len(raw)!=size:raise ValueError('Retained discovery changed while reading')
            prior=validate_runtime_discovery(packager.parse(raw))
        except (OSError,ValueError,TypeError,KeyError):
            prior=None  # Missing/old/disputed inventories never imply structural proof.
    deadline=time.monotonic()+300
    with tempfile.TemporaryDirectory(dir=output.parent,prefix='.tb085-discovery-') as directory:
        work=Path(directory)
        download=acquire_cached_archive(work,publication,deadline,source_archive,source_archive_receipt,source_archive_metadata)
        first_day=cached_qualification_date(download['cachedArchiveEvidence']['after'],publication)
        holiday=fetch(work,'bank-holidays',HOLIDAYS,MIB,deadline)
        raw=(work/holiday['body']).read_bytes()
        if digest(work/holiday['body'])!=holiday['sha256']:raise ValueError('Holiday body differs from receipt')
        try:
            body=packager.parse(raw);events=body['england-and-wales']['events']
            if not isinstance(events,list) or not 1<=len(events)<=4096:raise ValueError('Invalid bounded holiday calendar')
            dates={row['date'] for row in events}
            if any(not isinstance(value,str) or date.fromisoformat(value).isoformat()!=value for value in dates):raise ValueError('Invalid holiday date')
        except (KeyError,TypeError,ValueError) as error:raise ValueError('Invalid bounded official holiday calendar') from error
        headers=holiday['headers'];received=datetime.fromisoformat(holiday['receivedAt'])
        provider_date=parsedate_to_datetime(headers['date']);age=int(headers.get('age','0'))
        match=re.search(r'(?:^|,)\s*max-age=(\d+)',headers.get('cache-control',''),re.I)
        ttl=min(86400,int(match.group(1))) if match else 60
        if received.utcoffset() is None or provider_date.utcoffset() is None:raise ValueError('Holiday timestamps must be aware')
        elapsed=(received-provider_date).total_seconds()
        if received.utcoffset() is None or provider_date.utcoffset() is None or age<0 or elapsed<0 or max(elapsed,age)>=ttl:
            raise ValueError('Holiday authority is expired or malformed')
        holiday_expires=received+timedelta(seconds=ttl-max(elapsed,age))
        catalogue=json.loads(CATALOGUE.read_bytes())
        membership={(line['lineID'],station['stationID']) for station in catalogue['stations'] for line in station['lines']}
        bound_hashes={'archiveSHA256':publication,'sourceMetadataSHA256':download['cachedArchiveEvidence']['metadataSHA256'],
            'sourceReceiptSHA256':download['cachedArchiveEvidence']['receiptSHA256'],
            'producerSHA256':digest(Path(__file__)),'parserSHA256':digest(Path(qualifier.__file__)),
            'catalogueSHA256':digest(CATALOGUE),'holidayBodySHA256':holiday['sha256']}
        acquisition={'startedAt':download['startedAt'],'receivedAt':download['receivedAt']}
        def reusable(at):
            return (prior is not None and prior['publicationSHA256']==publication
                and not any(g['code']=='unqualified-xml-member' and g['lineID'] is None and g['stationID'] is None for g in prior['unresolvedPublicSourceGaps'])
                and all(prior['inputs'][key]==value for key,value in bound_hashes.items())
                and prior['inputs']['originalAcquisition']==acquisition
                and prior['serviceDay']==at.astimezone(ZoneInfo('Europe/London')).date().isoformat()
                and datetime.fromisoformat(prior['assessedAt'])<=at<datetime.fromisoformat(prior['structuralValidUntil']))
        reuse=reusable(datetime.now(timezone.utc))
        parse_failed=False
        def parse_archive():
            try:return (*qualifier.read_archive(work/download['body']),False)
            except (ValueError,KeyError,TypeError,qualifier.ET.ParseError):return [],[],True
        if not reuse:source,members,parse_failed=parse_archive()
        latest=fresh_cached_edition(work,'cached-official-final',publication,deadline)
        final_day=cached_qualification_date(latest,publication)
        assessed=datetime.now(timezone.utc)
        if reuse and not reusable(assessed):
            # A carryover boundary crossed during HTTP work: use one real parse,
            # then reassess retained rows at a final genuine observation.
            reuse=False;source,members,parse_failed=parse_archive()
            latest=fresh_cached_edition(work,'cached-official-final',publication,deadline)
            final_day=cached_qualification_date(latest,publication);assessed=datetime.now(timezone.utc)
        if final_day!=first_day or assessed.astimezone(ZoneInfo('Europe/London')).date()!=final_day:
            raise ValueError('London service day changed during discovery')
        if not min(dates)<=final_day.isoformat()<=max(dates) or holiday_expires<=assessed:
            raise ValueError('Holiday authority does not cover current discovery')
        detail=({key:copy.deepcopy(prior[key]) for key in ('eligibleScopesComplete','requiredScopesComplete','eligibleScopes','requiredScopes','unresolvedPublicSourceGaps','discoveryStatus','counts')}
            if reuse else qualifier.runtime_origin_scopes(source,members,membership,assessed,dates))
        structural=prior['structuralValidUntil'] if reuse else detail.pop('validUntil')
        parsed=prior['parsedAt'] if reuse else assessed.isoformat()
        if parse_failed:
            detail.update(discoveryStatus='incomplete',eligibleScopesComplete=False,requiredScopesComplete=False)
            detail['unresolvedPublicSourceGaps']=[{'code':'unqualified-xml-member','lineID':None,'stationID':None,'affectsCurrentCoverage':True}]
        until=min(datetime.fromisoformat(structural),holiday_expires)
        if until<=assessed:raise ValueError('Discovery validity elapsed during assessment')
        observed=parsedate_to_datetime(latest['headers']['date']);official_age=int(latest['headers']['age'])
        observed=assessed-timedelta(seconds=max((assessed-observed).total_seconds(),official_age))
        result={'schemaVersion':2,'kind':'tubeboard-runtime-origin-discovery-v2','publicationSHA256':publication,
            'assessedAt':assessed.isoformat(),'parsedAt':parsed,'structuralValidUntil':structural,'serviceDay':final_day.isoformat(),**detail,'validUntil':until.isoformat(),
            'inputs':{'archiveSHA256':publication,'sourceMetadataSHA256':download['cachedArchiveEvidence']['metadataSHA256'],
                'sourceReceiptSHA256':download['cachedArchiveEvidence']['receiptSHA256'],
                'producerSHA256':digest(Path(__file__)),'parserSHA256':digest(Path(qualifier.__file__)),
                'catalogueSHA256':digest(CATALOGUE),'holidayBodySHA256':holiday['sha256'],
                'holidayReceivedAt':holiday['receivedAt'],'holidayExpiresAt':holiday_expires.isoformat(),
                'originalAcquisition':{'startedAt':download['startedAt'],'receivedAt':download['receivedAt']},
                'officialObservation':{'publicationSHA256':publication,'observedAt':observed.isoformat(),
                    'expiresAt':(observed+timedelta(seconds=600)).isoformat()}},
            'reuseRequirements':{'freshSameEditionObservation':True,'unchangedParserCatalogueHoliday':True,'monotonicAssessment':True}}
        if len((json.dumps(result,indent=2)+'\n').encode())>qualifier.MAX_ORIGIN_INVENTORY_BYTES:
            result.update(discoveryStatus='incomplete',eligibleScopesComplete=False,requiredScopesComplete=False,
                eligibleScopes=[],requiredScopes=[],unresolvedPublicSourceGaps=[{'code':'inventory-overflow','lineID':None,'stationID':None,'affectsCurrentCoverage':True}])
        if len((json.dumps(result,indent=2)+'\n').encode())>qualifier.MAX_ORIGIN_INVENTORY_BYTES:raise ValueError('Discovery evidence exceeds bound')
        validate_runtime_discovery(result)
        write_json(output,result)
        return result


def prepare(publication, output, *, same_edition=False, additive_only=False, expected_resource_sha=None,
            expected_proof_sha=None, expected_revision=None, prior_served=None, tram_report=None, archive_receipt=None, requested_scopes=None,
            source_archive=None, source_archive_receipt=None, source_archive_metadata=None):
    cached_inputs = (source_archive, source_archive_receipt, source_archive_metadata)
    if any(value is not None for value in cached_inputs) and not all(value is not None for value in cached_inputs):
        raise ValueError("Cached archive requires its verified receipt and original source metadata")
    if archive_receipt is not None and any(Path(archive_receipt).absolute() == Path(value).absolute()
                                           for value in cached_inputs if value is not None):
        raise ValueError("Archive receipt output cannot replace cached input evidence")
    if archive_receipt is not None and Path(archive_receipt).exists():
        if any(Path(value).exists() and os.path.samefile(archive_receipt, value)
               for value in cached_inputs if value is not None):
            raise ValueError("Archive receipt output cannot replace cached input evidence")
    if requested_scopes is not None:
        parse_requested_scopes(requested_scopes)
        if tram_report is not None:
            raise ValueError("Runtime preparation cannot run the independent all-Tram comparison")
    if additive_only and not same_edition:
        raise ValueError("Existing station references can only be retained for the same edition")
    if not re.fullmatch("[0-9a-f]{64}", publication):
        raise ValueError("Expected a lowercase 64-digit official publication SHA-256")
    if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
        raise ValueError("Output must be absent or an empty directory")
    roster = json.loads(ROSTER.read_text())
    check_roster(roster)
    output.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 900
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".tb085-renewal-") as tmp:
        work = Path(tmp)
        artifact = work / "artifact"
        artifact.mkdir()
        # Hold complete API captures beside the local proof for independent reproduction.
        captures = artifact / "captures"
        captures.mkdir()
        routes = fetch(captures, "network-routes", unique_url(monitor.ROUTES), MIB, deadline)
        monitor.check_fresh(routes["headers"], datetime.now(timezone.utc))
        origins = monitor.route_origins(json.loads((captures / routes["body"]).read_bytes()),
                                       datetime.now(ZoneInfo("Europe/London")).date())
        if requested_scopes is None:
            roster = extend_roster(roster, origins, json.loads(CATALOGUE.read_text()))
        previous = None
        previous_readback = None
        previous_resource_path = None
        previous_body = None
        previous_readback_evidence = None
        final_readback_evidence = None
        prior_publication = publication
        if not same_edition:
            require_unserved(work, "existing", publication, deadline)
            if prior_served is None:
                raise ValueError("Missing last served edition receipt for rollover")
            prior_publication = prior_served["publication"]
            expected_resource_sha = prior_served["resourceSHA256"]
            expected_proof_sha = prior_served["proofBodySHA256"]
            expected_revision = prior_served["revision"]
            if (not all(isinstance(v, str) and packager.SHA.fullmatch(v)
                        for v in (prior_publication, expected_resource_sha, expected_proof_sha))
                    or prior_publication == publication or type(expected_revision) is not int or expected_revision < 1):
                raise ValueError("Invalid last served edition receipt for rollover")
        previous_readback = fetch(work, "previous-resource", PROOFS + prior_publication,
                                  packager.MAX_RESOURCE_BYTES, deadline)
        monitor.check_fresh(previous_readback["headers"], datetime.now(timezone.utc))
        previous = (work / previous_readback["body"]).read_bytes()
        prior_wrapper, previous_digest = validate_previous_resource(previous, prior_publication)
        if (expected_resource_sha and previous_digest != expected_resource_sha
                or expected_proof_sha and prior_wrapper["proofBodySHA256"] != expected_proof_sha
                or expected_revision is not None and prior_wrapper["proofRevision"] != expected_revision):
            raise ValueError("Served resource identity differs from the confirmed monitor probes")
        previous_body = packager.parse(base64.b64decode(prior_wrapper["proofBodyBase64"], validate=True))
        if requested_scopes is None:
            roster = preserve_previous_qualified_scopes(roster, prior_wrapper)
            capture_roster = roster
        previous_resource_path = captures / "previous-resource.json"
        previous_resource_path.write_bytes(previous)
        previous_readback_evidence = {key: value for key, value in previous_readback.items() if key != "body"}
        if source_archive is None:
            download = acquire_and_record(work, publication, deadline, archive_receipt)
        else:
            download = acquire_cached_archive(work, publication, deadline, source_archive,
                                              source_archive_receipt, source_archive_metadata)
            if archive_receipt is not None:
                write_json(archive_receipt, {"status": "verified-source-only", "publication": publication,
                    "transport": download.get("transport", "direct"), "bytes": download["bytes"],
                    "sha256": download["sha256"], "sourceClockMethod": download.get("sourceClockMethod", "GET"),
                    "finalObservation": download["cachedArchiveEvidence"]["after"],
                    "cachedArchiveEvidence": download["cachedArchiveEvidence"]})
        archive = work / download["body"]
        if source_archive is None or requested_scopes is None:
            shutil.copyfile(archive, captures / "official-timetable.zip")
        else:
            archive = retain_verified_cached_archive(work, captures, download)
        download_evidence = dict(download, body="official-timetable.zip")
        write_json(captures / "publication-download.json", download_evidence)
        holiday = fetch(captures, "bank-holidays", HOLIDAYS, MIB, deadline)
        write_json(captures / "bank-holidays-capture.json", holiday)
        parsed_archive = None
        if requested_scopes is not None:
            # Derive new origin eligibility from this verified archive, never
            # from a caller-supplied discovery sidecar. Parse once per batch.
            parsed_archive = qualifier.read_archive(archive)
            catalogue_data = json.loads(CATALOGUE.read_text())
            membership = {(line['lineID'],station['stationID']) for station in catalogue_data['stations'] for line in station['lines']}
            dates = {event['date'] for event in json.loads((captures/holiday['body']).read_bytes())['england-and-wales']['events']}
            discovered = qualifier.runtime_origin_scopes(*parsed_archive,membership,datetime.now(timezone.utc),dates)
            xml_scopes = {tuple(scope.split('/')) for scope in discovered['eligibleScopes']}
            roster, capture_roster = runtime_rosters(roster, origins, catalogue_data,
                prior_wrapper, requested_scopes, retain_references=additive_only, xml_pickup_scopes=xml_scopes)
        capture_matrix(captures, capture_roster, deadline)
        write_json(captures / "effective-roster.json", roster)
        qualification_date = (cached_qualification_date(download["cachedArchiveEvidence"]["after"], publication)
                              if source_archive is not None else None)
        qualification_options = {"qualification_date": qualification_date} if qualification_date is not None else {}
        if parsed_archive is not None:qualification_options["_parsed_archive"] = parsed_archive
        proof, origin_inventory = qualifier.generate_with_inventory(archive, captures, CATALOGUE, **qualification_options)
        if requested_scopes is not None:
            proof = retain_uncaptured_entries(proof, previous_body, capture_roster,
                                              preserve_references=additive_only)
        inventory_path=artifact / "xml-passenger-origin-inventory.json"
        write_json(inventory_path,origin_inventory)
        origin_inventory_receipt=inventory_receipt(origin_inventory,inventory_path)
        today = datetime.now(ZoneInfo("Europe/London")).date()
        retained = None
        additions = None
        if additive_only:
            proof, additions = additive.select_entries(previous_body, proof, roster, today, monitor.request)
            retained = additive.retained_sources(captures, previous_body, prior_wrapper["proofBodySHA256"],
                                                 monitor.request, monitor.check_fresh, deadline)
        coverage = coverage_report(roster, proof)
        # Departures after midnight can still belong to yesterday's service day.
        if same_edition:
            require_no_date_coverage_loss(previous_body, proof)
        else:
            require_preserved_station_directions(previous_body, proof)
        if not additive_only:
            live_errors = monitor.check_live_coverage(proof, roster, today, monitor.request)
            if live_errors:
                raise ValueError("Candidate failed direct live coverage: " + "; ".join(live_errors[:12]))
        proof_path = artifact / "proof.json"
        proof_path.write_text(json.dumps(proof, separators=(",", ":")) + "\n", encoding="utf-8")
        latest = (confirm_current_edition(work, publication, deadline) if source_archive is None else
                  fresh_cached_edition(work, "cached-official-final", publication, deadline))
        if source_archive is not None and cached_qualification_date(latest, publication) != qualification_date:
            raise ValueError("Qualification day changed during cached archive preparation; retry with current HEAD")
        if not same_edition:
            require_unserved(work, "still-unserved", publication, deadline)
        final_resource = fetch(work, "final-resource", PROOFS + prior_publication,
                               packager.MAX_RESOURCE_BYTES, deadline)
        monitor.check_fresh(final_resource["headers"], datetime.now(timezone.utc))
        final_bytes = (work / final_resource["body"]).read_bytes()
        require_unchanged_resource(previous, final_bytes)
        (captures / "final-resource.json").write_bytes(final_bytes)
        final_readback_evidence = {key: value for key, value in final_resource.items() if key != "body"}
        revision = prior_wrapper["proofRevision"] + 1 if same_edition else 1
        receipt = packager.publish(proof_path, artifact / (publication + ".json"),
                                   expected_sha=publication, approved_body_sha=digest(proof_path), revision=revision,
                                   previous_resource=previous_resource_path if same_edition else None)
        wrapper = packager.validate_resource((artifact / (publication + ".json")).read_bytes(), publication)
        packaged_proof = packager.parse(base64.b64decode(wrapper["proofBodyBase64"], validate=True))
        archive_readback = build_source_archive(captures, packaged_proof, publication,
                                                receipt["proofBodySHA256"], artifact / "source-archive", retained=retained)
        if additions is not None:
            receipt["additiveComparison"] = additions
        receipt.update(coverage=coverage, preparedAt=now(), rosterSHA256=digest(ROSTER),
                       effectiveRosterSHA256=digest(captures / "effective-roster.json"),
                       routeInventoryObservation=routes, catalogueSHA256=digest(CATALOGUE), generatorSHA256=digest(Path(qualifier.__file__)),
                       packagerSHA256=digest(Path(packager.__file__)), finalOfficialObservation=latest,
                       candidateMode="same-edition-requalification" if same_edition else "new-edition",
                       previousPublicationSHA256=prior_publication, previousResourceSHA256=previous_digest,
                       previousProofRevision=prior_wrapper["proofRevision"],
                       currentProductionReadback=previous_readback_evidence,
                       finalProductionReadback=final_readback_evidence,
                       monitorSHA256=digest(Path(monitor.__file__)),
                       xmlPassengerOriginInventory=origin_inventory_receipt,
                       preparationSHA256=digest(Path(__file__)),
                       sourceArchive={"schemaVersion": 1, "manifest": "source-archive/manifest.json",
                                      **archive_readback})
        if qualification_date is not None:
            receipt["qualificationDate"] = qualification_date.isoformat()
        if requested_scopes is not None:
            receipt["requestedScopes"] = sorted(requested_scopes)
            receipt["capturedScopes"] = ["/".join((row["lineID"], row["stationID"])) for row in capture_roster]
        if os.environ.get("GITHUB_ACTIONS") == "true":
            receipt["qualificationRun"] = {"repository": os.environ["GITHUB_REPOSITORY"],
                                           "workflow": os.environ["GITHUB_WORKFLOW_REF"],
                                           "source": os.environ["GITHUB_SHA"], "id": os.environ["GITHUB_RUN_ID"]}
        write_json(artifact / "receipt.json", receipt)
        os.replace(artifact, output)
        record_tram_comparisons(work, download, tram_report, time.monotonic() + 180)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publication", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--requested-scope", action="append",
                        help="Runtime demand scope LINE/STATION; repeat up to 32 times. Preserve prior qualified coverage.")
    parser.add_argument("--archive-receipt", type=Path, help="Retain the acquired archive result independently of subsequent qualification")
    parser.add_argument("--source-archive", type=Path, help="Reuse a bounded verified official ZIP without downloading it again")
    parser.add_argument("--source-archive-receipt", type=Path, help="Original verified-source-only acquisition receipt")
    parser.add_argument("--source-archive-metadata", type=Path, help="Original publication-download.json source clocks and headers")
    parser.add_argument("--tram-report", type=Path, help="Retain separate Tram timetable evidence for this edition")
    parser.add_argument("--origin-inventory-output", type=Path,
                        help="Write the standalone inventory from the already acquired official archive")
    parser.add_argument("--rehearse-source", action="store_true", help="Verify the current archive and save only its receipt")
    parser.add_argument("--retained-origin-inventory", type=Path, help="Revalidate an existing v2 discovery inventory before its structural boundary")
    parser.add_argument("--discover-cached-origins", action="store_true", help="Discover bounded current XML pickup scopes from verified cached source")
    parser.add_argument("--inventory-only", action="store_true",
                        help="Read one official archive and retain only its independent passenger-origin inventory")
    parser.add_argument("--additive-only", action="store_true", help="Keep served station definitions and verify additional origins")
    parser.add_argument("--same-edition", action="store_true",
                        help="Requalify a currently served edition at the next monotonic proof revision")
    parser.add_argument("--prior-served", type=Path, help="Last verified served edition receipt for new-edition admission")
    parser.add_argument("--expected-resource-sha256")
    parser.add_argument("--expected-proof-sha256")
    parser.add_argument("--expected-revision", type=int)
    parser.add_argument("--result", type=Path,
                        help="Write a bounded success or fail-closed result for the workflow alert")
    args = parser.parse_args()
    if any(value is not None for value in (args.source_archive, args.source_archive_receipt, args.source_archive_metadata)) and (args.rehearse_source or args.inventory_only):
        parser.error("Cached source archives apply only to candidate preparation")
    if args.requested_scope is not None and (args.rehearse_source or args.inventory_only):
        parser.error("Requested scopes apply only to candidate preparation")
    if args.discover_cached_origins and (args.rehearse_source or args.inventory_only or args.requested_scope or args.same_edition or args.additive_only):
        parser.error("Cached discovery is independent of preparation/manual inventory modes")
    if args.retained_origin_inventory is not None and not args.discover_cached_origins:
        parser.error("Retained origin inventories apply only to cached discovery")
    try:
        if args.discover_cached_origins:
            discover_cached_origins(args.publication,args.output,source_archive=args.source_archive,
                source_archive_receipt=args.source_archive_receipt,source_archive_metadata=args.source_archive_metadata,
                retained_inventory=args.retained_origin_inventory)
            return
        if args.rehearse_source:
            rehearse_source(args.publication, args.output, tram_report=args.tram_report,
                            origin_inventory_output=args.origin_inventory_output)
            return
        if args.inventory_only:
            prepare_origin_inventory_only(args.publication,args.output)
            return
        receipt = prepare(args.publication, args.output, same_edition=args.same_edition, additive_only=args.additive_only,
                          expected_resource_sha=args.expected_resource_sha256,
                          expected_proof_sha=args.expected_proof_sha256,
                          expected_revision=args.expected_revision,
                          prior_served=json.loads(args.prior_served.read_text()) if args.prior_served else None,
                          tram_report=args.tram_report, archive_receipt=args.archive_receipt,
                          requested_scopes=args.requested_scope, source_archive=args.source_archive,
                          source_archive_receipt=args.source_archive_receipt, source_archive_metadata=args.source_archive_metadata)
    except (ValueError, KeyError, BadZipFile, OSError, subprocess.SubprocessError) as exc:
        if args.result:
            write_json(args.result, {"status": "failed-closed", "publication": args.publication,
                                     "candidateMode": "same-edition-requalification" if args.same_edition else "new-edition",
                                     "reason": str(exc).replace("\n", " ")[:500]})
        parser.exit(1, f"Could not prepare timetable renewal: {exc}\n")
    if args.result:
        write_json(args.result, {"status": "candidate-prepared", "publication": args.publication,
                                 "proofRevision": receipt["proofRevision"],
                                 "resourceSHA256": receipt["resourceSHA256"],
                                 "previousResourceSHA256": receipt.get("previousResourceSHA256"),
                                 "xmlPassengerOriginInventory": receipt["xmlPassengerOriginInventory"]})
    print(json.dumps({k: receipt[k] for k in ("publicationSHA256", "resourceSHA256", "status")}))


if __name__ == "__main__":
    main()
