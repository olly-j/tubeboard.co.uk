#!/usr/bin/env python3
"""Deterministic offline and explicit low-rate live TfL health validation."""

from __future__ import annotations

import argparse
import email.utils
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


EXPECTED_LINE_IDS = (
    "bakerloo",
    "central",
    "circle",
    "district",
    "dlr",
    "elizabeth",
    "hammersmith-city",
    "jubilee",
    "liberty",
    "lioness",
    "metropolitan",
    "mildmay",
    "northern",
    "piccadilly",
    "suffragette",
    "victoria",
    "waterloo-city",
    "weaver",
    "windrush",
)
DEFAULT_FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "tfl-api-health"
DEFAULT_RATE = 0.65
MAX_LIVE_RATE = 0.65
DEFAULT_TIMEOUT = 12.0
MAX_RETRIES = 3
MAX_RETRY_AFTER = 60.0
MAX_FULL_STATIONS = 470
EXPECTED_OBSERVATION_KEYS = frozenset(
    {
        "lineCount",
        "statusLineCount",
        "stationMembershipCount",
        "uniqueStationCount",
        "repeatedIDGroups",
        "conflictingRepeatedIDGroups",
        "exactDuplicateGroups",
        "sparseDirectionRows",
        "selectedLineEmptyObservations",
        "placeholderTrainIdentifierRows",
        "missingTrainIdentifierRows",
        "placeholderDestinationRows",
        "missingDestinationRows",
        "placeholderCurrentLocationRows",
        "missingCurrentLocationRows",
    }
)
SWIFT_INTERNET_DATE_TIME = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


@dataclass(frozen=True)
class Anomaly:
    code: str
    severity: str
    scope: str
    detail: str
    expected: Any = None
    observed: Any = None


class RateLimiter:
    def __init__(
        self,
        requests_per_second: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        if (
            not math.isfinite(requests_per_second)
            or requests_per_second <= 0
            or requests_per_second > MAX_LIVE_RATE
        ):
            raise ValueError(
                f"live rate must be greater than 0 and no more than {MAX_LIVE_RATE} requests/second"
            )
        self.minimum_interval = 1.0 / requests_per_second
        self.clock = clock
        self.sleeper = sleeper
        self.last_request_started: float | None = None

    def wait(self) -> None:
        now = self.clock()
        if self.last_request_started is not None:
            remaining = self.minimum_interval - (now - self.last_request_started)
            if remaining > 0:
                self.sleeper(remaining)
                now = self.clock()
        self.last_request_started = now


class TfLClient:
    def __init__(
        self,
        *,
        requests_per_second: float = DEFAULT_RATE,
        timeout: float = DEFAULT_TIMEOUT,
        api_key: str | None = None,
        transport: Callable[[urllib.request.Request, float], tuple[int, dict[str, str], bytes]] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        if not math.isfinite(timeout) or timeout <= 0 or timeout > 60:
            raise ValueError("timeout must be greater than 0 and no more than 60 seconds")
        self.timeout = timeout
        self.api_key = api_key
        self.clock = clock
        self.sleeper = sleeper
        self.rate_limiter = RateLimiter(
            requests_per_second,
            clock=clock,
            sleeper=sleeper,
        )
        self.transport = transport or self._default_transport
        self.request_metrics: list[dict[str, Any]] = []

    def get_json(self, path: str) -> Any:
        request = urllib.request.Request(
            self._url(path),
            headers={"User-Agent": "TubeBoard-Health-Validator/1.0"},
        )

        for attempt in range(MAX_RETRIES + 1):
            self.rate_limiter.wait()
            started = self.clock()
            try:
                status, headers, data = self.transport(request, self.timeout)
                elapsed = self.clock() - started
                if not 200 <= status < 300:
                    raise urllib.error.HTTPError(
                        request.full_url,
                        status,
                        f"HTTP {status}",
                        headers,
                        None,
                    )
                self._record(path, status, elapsed, attempt)
                try:
                    return json.loads(data.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ValueError(f"{path} returned invalid JSON: {error}") from error
            except urllib.error.HTTPError as error:
                elapsed = self.clock() - started
                self._record(path, error.code, elapsed, attempt)
                retry_after = parse_retry_after(
                    error.headers.get("Retry-After") if error.headers else None
                )
                retry_after_is_bounded = (
                    retry_after is None or retry_after <= MAX_RETRY_AFTER
                )
                should_retry = (
                    attempt < MAX_RETRIES
                    and error.code in {429, 500, 502, 503, 504}
                    and retry_after_is_bounded
                )
                close_error = getattr(error, "close", None)
                if getattr(error, "fp", None) is not None and callable(close_error):
                    close_error()
                if not should_retry:
                    raise
                backoff = retry_after if retry_after is not None else min(8.0, 2.0**attempt)
                self.sleeper(max(0.0, backoff))
            except urllib.error.URLError:
                elapsed = self.clock() - started
                self._record(path, None, elapsed, attempt)
                if attempt >= MAX_RETRIES:
                    raise
                self.sleeper(min(8.0, 2.0**attempt))

        raise RuntimeError(f"unreachable retry state for {path}")

    def _url(self, path: str) -> str:
        split = urllib.parse.urlsplit(path)
        query = list(urllib.parse.parse_qsl(split.query, keep_blank_values=True))
        if self.api_key:
            query.append(("app_key", self.api_key))
        return urllib.parse.urlunsplit(
            (
                "https",
                "api.tfl.gov.uk",
                split.path,
                urllib.parse.urlencode(query),
                "",
            )
        )

    def _record(self, path: str, status: int | None, elapsed: float, attempt: int) -> None:
        # Record only the endpoint path supplied by the caller. The generated
        # URL may contain an environment-provided API key and is never logged.
        self.request_metrics.append(
            {
                "endpoint": path,
                "status": status,
                "elapsedMilliseconds": round(elapsed * 1000, 1),
                "attempt": attempt + 1,
            }
        )

    @staticmethod
    def _default_transport(
        request: urllib.request.Request,
        timeout: float,
    ) -> tuple[int, dict[str, str], bytes]:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    if not value:
        return None
    stripped = value.strip()
    try:
        delay = float(stripped)
        if not math.isfinite(delay):
            return None
        return max(0.0, delay)
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(stripped)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    delay = (parsed - reference).total_seconds()
    if not math.isfinite(delay):
        return None
    return max(0.0, delay)


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def add_error(anomalies: list[Anomaly], code: str, scope: str, detail: str, **values: Any) -> None:
    anomalies.append(Anomaly(code, "error", scope, detail, **values))


def add_observation(anomalies: list[Anomaly], code: str, scope: str, detail: str, **values: Any) -> None:
    anomalies.append(Anomaly(code, "observed", scope, detail, **values))


def add_warning(anomalies: list[Anomaly], code: str, scope: str, detail: str, **values: Any) -> None:
    anomalies.append(Anomaly(code, "warning", scope, detail, **values))


def is_finite_json_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_lines(payload: Any, anomalies: list[Anomaly], *, scope: str = "lines") -> list[str]:
    if not isinstance(payload, list):
        add_error(anomalies, "lines-not-array", scope, "Expected an array of Tube lines")
        return []

    line_ids: list[str] = []
    for index, line in enumerate(payload):
        item_scope = f"{scope}[{index}]"
        if not isinstance(line, dict):
            add_error(anomalies, "line-not-object", item_scope, "Expected a line object")
            continue
        line_id = line.get("id")
        name = line.get("name")
        if not is_nonempty_string(line_id):
            add_error(anomalies, "line-id-invalid", item_scope, "Line id must be a non-empty string")
            continue
        if not is_nonempty_string(name):
            add_error(anomalies, "line-name-invalid", item_scope, "Line name must be a non-empty string")
        line_ids.append(line_id)

    observed = sorted(set(line_ids))
    expected = sorted(EXPECTED_LINE_IDS)
    if observed != expected:
        add_error(
            anomalies,
            "supported-line-set-changed",
            scope,
            "Supported line identifiers differ from the app contract",
            expected=expected,
            observed=observed,
        )
    if len(line_ids) != len(set(line_ids)):
        add_error(anomalies, "duplicate-line-id", scope, "Line catalogue contains duplicate ids")
    return line_ids


def validate_statuses(payload: Any, anomalies: list[Anomaly], *, scope: str = "statuses") -> list[str]:
    if not isinstance(payload, list):
        add_error(anomalies, "statuses-not-array", scope, "Expected an array of line statuses")
        return []
    line_ids: list[str] = []
    for index, line in enumerate(payload):
        item_scope = f"{scope}[{index}]"
        if not isinstance(line, dict):
            add_error(anomalies, "status-line-not-object", item_scope, "Expected a status line object")
            continue
        line_id = line.get("id")
        name = line.get("name")
        if not is_nonempty_string(line_id):
            add_error(anomalies, "status-line-id-invalid", item_scope, "Status line id must be a non-empty string")
            continue
        if not is_nonempty_string(name):
            add_error(
                anomalies,
                "status-line-name-invalid",
                item_scope,
                "Status line name must be a non-empty string",
            )
        line_ids.append(line_id)
        statuses = line.get("lineStatuses")
        if not isinstance(statuses, list) or not statuses:
            add_error(anomalies, "line-statuses-empty", item_scope, "Expected at least one line status")
            continue
        for status_index, status in enumerate(statuses):
            status_scope = f"{item_scope}.lineStatuses[{status_index}]"
            if not isinstance(status, dict):
                add_error(anomalies, "line-status-not-object", status_scope, "Expected a status object")
                continue
            severity = status.get("statusSeverity")
            description = status.get("statusSeverityDescription")
            if not isinstance(severity, int) or isinstance(severity, bool):
                add_error(anomalies, "status-severity-invalid", status_scope, "statusSeverity must be an integer")
            if not is_nonempty_string(description):
                add_error(anomalies, "status-description-invalid", status_scope, "Status description must be a non-empty string")
            if "reason" in status and status["reason"] is not None and not isinstance(status["reason"], str):
                add_error(anomalies, "status-reason-invalid", status_scope, "Status reason must be a string or null")
    observed = sorted(set(line_ids))
    expected = sorted(EXPECTED_LINE_IDS)
    if observed != expected:
        add_error(
            anomalies,
            "status-line-set-changed",
            scope,
            "Status line identifiers differ from the app contract",
            expected=expected,
            observed=observed,
        )
    if len(line_ids) != len(set(line_ids)):
        add_error(anomalies, "duplicate-status-line-id", scope, "Status payload contains duplicate line ids")
    return line_ids


def validate_stations_by_line(
    payload: Any,
    anomalies: list[Anomaly],
    *,
    scope: str = "stationsByLine",
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, set[str]]]:
    if not isinstance(payload, dict):
        add_error(anomalies, "stations-by-line-not-object", scope, "Expected an object keyed by line id")
        return {}, {}

    stations_by_line: dict[str, list[dict[str, Any]]] = {}
    memberships: dict[str, set[str]] = {}
    for line_id in EXPECTED_LINE_IDS:
        stations = payload.get(line_id)
        line_scope = f"{scope}.{line_id}"
        if not isinstance(stations, list) or not stations:
            add_error(anomalies, "line-stations-empty", line_scope, "Expected at least one representative station")
            continue
        valid_stations: list[dict[str, Any]] = []
        for index, station in enumerate(stations):
            station_scope = f"{line_scope}[{index}]"
            if not isinstance(station, dict):
                add_error(anomalies, "station-not-object", station_scope, "Expected a station object")
                continue
            station_id = station.get("id")
            name = station.get("commonName")
            latitude = station.get("lat")
            longitude = station.get("lon")
            if not is_nonempty_string(station_id):
                add_error(anomalies, "station-id-invalid", station_scope, "Station id must be a non-empty string")
                continue
            if not is_nonempty_string(name):
                add_error(anomalies, "station-name-invalid", station_scope, "Station name must be a non-empty string")
            if not is_finite_json_number(latitude) or not is_finite_json_number(longitude):
                add_error(anomalies, "station-coordinate-invalid", station_scope, "Station coordinates must be numeric")
            elif not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                add_error(
                    anomalies,
                    "station-coordinate-out-of-range",
                    station_scope,
                    "Station coordinates must be valid latitude/longitude values",
                )
            valid_stations.append(station)
            memberships.setdefault(station_id, set()).add(line_id)
        stations_by_line[line_id] = valid_stations

    extra_lines = sorted(set(payload) - set(EXPECTED_LINE_IDS))
    if extra_lines:
        add_warning(
            anomalies,
            "unexpected-station-line-keys",
            scope,
            "Station fixture contains additional line keys",
            observed=extra_lines,
        )
    return stations_by_line, memberships


ARRIVAL_OPTIONAL_TYPES: dict[str, tuple[type, ...]] = {
    "lineId": (str,),
    "destinationName": (str,),
    "direction": (str,),
    "lineDirection": (str,),
    "platformDirection": (str,),
    "platformName": (str,),
    "towards": (str,),
    "currentLocation": (str,),
    "vehicleId": (str,),
    "trainId": (str,),
    "timeToStation": (int,),
}

FIELD_PLACEHOLDERS = frozenset(
    {"-", "--", "changed", "n/a", "na", "not available", "null", "train changed", "unknown"}
)


def normalized_field_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value.casefold() if value else None


def is_train_identifier_placeholder(value: Any) -> bool:
    normalized = normalized_field_text(value)
    if normalized is None:
        return False
    return normalized in FIELD_PLACEHOLDERS or all(character == "0" for character in normalized)


def classify_train_identifier(arrival: dict[str, Any]) -> str:
    candidates = [arrival.get("vehicleId"), arrival.get("trainId")]
    for candidate in candidates:
        normalized = normalized_field_text(candidate)
        if normalized is not None and not is_train_identifier_placeholder(candidate):
            return "available"
    if any(is_train_identifier_placeholder(candidate) for candidate in candidates):
        return "provider-placeholder"
    return "temporarily-missing"


def classify_destination(arrival: dict[str, Any]) -> str:
    candidates = [arrival.get("destinationName"), arrival.get("towards")]
    for candidate in candidates:
        normalized = normalized_field_text(candidate)
        if normalized is not None and normalized not in FIELD_PLACEHOLDERS:
            return "available"
    if any(normalized_field_text(candidate) in FIELD_PLACEHOLDERS for candidate in candidates):
        return "provider-placeholder"
    return "temporarily-missing"


def classify_current_location(arrival: dict[str, Any]) -> str:
    normalized = normalized_field_text(arrival.get("currentLocation"))
    if normalized is None:
        return "temporarily-missing"
    if normalized in FIELD_PLACEHOLDERS:
        return "provider-placeholder"
    return "available"


def validate_arrivals(
    payload: Any,
    anomalies: list[Anomaly],
    *,
    station_id: str,
    selected_line_ids: Iterable[str] = (),
    scope: str | None = None,
) -> dict[str, Any]:
    resolved_scope = scope or f"arrivals.{station_id}"
    selected = set(selected_line_ids)
    if not isinstance(payload, list):
        add_error(anomalies, "arrivals-not-array", resolved_scope, "Expected an array of arrivals")
        return {
            "rows": 0,
            "repeatedIDGroups": 0,
            "conflictingRepeatedIDGroups": 0,
            "exactDuplicateGroups": 0,
            "sparseDirectionRows": 0,
            "placeholderTrainIdentifierRows": 0,
            "missingTrainIdentifierRows": 0,
            "placeholderDestinationRows": 0,
            "missingDestinationRows": 0,
            "placeholderCurrentLocationRows": 0,
            "missingCurrentLocationRows": 0,
            "observedKeys": [],
        }

    rows_by_id: dict[str, list[dict[str, Any]]] = {}
    matching_lines: set[str] = set()
    sparse_direction_rows = 0
    placeholder_train_identifier_rows = 0
    missing_train_identifier_rows = 0
    placeholder_destination_rows = 0
    missing_destination_rows = 0
    placeholder_current_location_rows = 0
    missing_current_location_rows = 0
    observed_keys: set[str] = set()
    for index, arrival in enumerate(payload):
        item_scope = f"{resolved_scope}[{index}]"
        if not isinstance(arrival, dict):
            add_error(anomalies, "arrival-not-object", item_scope, "Expected an arrival object")
            continue
        observed_keys.update(arrival.keys())
        source_id = arrival.get("id")
        line_name = arrival.get("lineName")
        expected_arrival = arrival.get("expectedArrival")
        if not is_nonempty_string(source_id):
            add_error(anomalies, "arrival-id-invalid", item_scope, "Arrival id must be a non-empty string")
        else:
            rows_by_id.setdefault(source_id, []).append(arrival)
        if not is_nonempty_string(line_name):
            add_error(anomalies, "arrival-line-name-invalid", item_scope, "lineName must be a non-empty string")
        if not isinstance(expected_arrival, str) or not is_iso8601(expected_arrival):
            add_error(anomalies, "arrival-expected-time-invalid", item_scope, "expectedArrival must be an ISO-8601 string")
        for key, allowed_types in ARRIVAL_OPTIONAL_TYPES.items():
            value = arrival.get(key)
            if value is not None and (
                not isinstance(value, allowed_types)
                or (isinstance(value, bool) and bool not in allowed_types)
            ):
                add_error(anomalies, "arrival-optional-type-invalid", f"{item_scope}.{key}", f"{key} has an incompatible type")
        line_id = arrival.get("lineId")
        if isinstance(line_id, str):
            matching_lines.add(line_id)
        train_identifier_state = classify_train_identifier(arrival)
        if train_identifier_state == "provider-placeholder":
            placeholder_train_identifier_rows += 1
        elif train_identifier_state == "temporarily-missing":
            missing_train_identifier_rows += 1
        destination_state = classify_destination(arrival)
        if destination_state == "provider-placeholder":
            placeholder_destination_rows += 1
        elif destination_state == "temporarily-missing":
            missing_destination_rows += 1
        current_location_state = classify_current_location(arrival)
        if current_location_state == "provider-placeholder":
            placeholder_current_location_rows += 1
        elif current_location_state == "temporarily-missing":
            missing_current_location_rows += 1
        if not arrival.get("platformDirection") and not arrival.get("lineDirection"):
            sparse_direction_rows += 1
            if not any(arrival.get(field) for field in ("platformName", "direction", "towards")):
                add_warning(
                    anomalies,
                    "arrival-direction-fallback-empty",
                    item_scope,
                    "No platform or direction fallback field is populated",
                )

    repeated_groups = {key: rows for key, rows in rows_by_id.items() if len(rows) > 1}
    exact_duplicate_groups = 0
    conflicting_groups = 0
    for source_id, rows in sorted(repeated_groups.items()):
        canonical_rows = {json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows}
        if len(canonical_rows) == 1:
            exact_duplicate_groups += 1
            kind = "exact duplicate"
        else:
            conflicting_groups += 1
            kind = "conflicting"
        add_observation(
            anomalies,
            "reused-arrival-source-id",
            f"{resolved_scope}.id={source_id}",
            f"TfL source id is reused by {len(rows)} {kind} rows",
            observed={
                "rowCount": len(rows),
                "kind": kind,
                "rows": [
                    {
                        key: row.get(key)
                        for key in (
                            "lineId",
                            "destinationName",
                            "expectedArrival",
                            "platformName",
                            "direction",
                            "platformDirection",
                            "lineDirection",
                            "towards",
                            "vehicleId",
                            "trainId",
                            "currentLocation",
                            "timeToStation",
                        )
                    }
                    for row in rows
                ],
            },
        )

    if selected and payload:
        empty_selected = sorted(selected - matching_lines)
        for line_id in empty_selected:
            add_observation(
                anomalies,
                "selected-line-empty",
                resolved_scope,
                "Station payload has departures but none for a station-member line",
                expected=line_id,
                observed=sorted(matching_lines),
            )

    if placeholder_train_identifier_rows:
        add_observation(
            anomalies,
            "provider-placeholder-train-identifiers",
            resolved_scope,
            "TfL returned explicit placeholder train identifiers",
            observed=placeholder_train_identifier_rows,
        )
    if placeholder_destination_rows:
        add_observation(
            anomalies,
            "provider-placeholder-destinations",
            resolved_scope,
            "TfL returned explicit placeholder destination text",
            observed=placeholder_destination_rows,
        )
    if placeholder_current_location_rows:
        add_observation(
            anomalies,
            "provider-placeholder-current-locations",
            resolved_scope,
            "TfL returned explicit placeholder current-location text",
            observed=placeholder_current_location_rows,
        )

    return {
        "rows": len(payload),
        "repeatedIDGroups": len(repeated_groups),
        "conflictingRepeatedIDGroups": conflicting_groups,
        "exactDuplicateGroups": exact_duplicate_groups,
        "sparseDirectionRows": sparse_direction_rows,
        "placeholderTrainIdentifierRows": placeholder_train_identifier_rows,
        "missingTrainIdentifierRows": missing_train_identifier_rows,
        "placeholderDestinationRows": placeholder_destination_rows,
        "missingDestinationRows": missing_destination_rows,
        "placeholderCurrentLocationRows": placeholder_current_location_rows,
        "missingCurrentLocationRows": missing_current_location_rows,
        "observedKeys": sorted(observed_keys),
    }


def is_iso8601(value: str) -> bool:
    if not SWIFT_INTERNET_DATE_TIME.fullmatch(value):
        return False
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        datetime.fromisoformat(normalized)
        return True
    except ValueError:
        return False


def deduplicated_station_ids(memberships: dict[str, set[str]]) -> list[str]:
    return sorted(memberships)


def validate_representative_station_ids(
    manifest: dict[str, Any],
    anomalies: list[Anomaly],
    *,
    known_station_ids: Iterable[str] = (),
    scope: str = "manifest.liveRepresentativeStationIDs",
) -> list[str]:
    station_ids = manifest.get("liveRepresentativeStationIDs")
    if (
        not isinstance(station_ids, list)
        or not station_ids
        or not all(is_nonempty_string(station_id) for station_id in station_ids)
    ):
        add_error(
            anomalies,
            "live-representative-stations-invalid",
            scope,
            "liveRepresentativeStationIDs must be a non-empty array of station ids",
        )
        return []
    if len(station_ids) != len(set(station_ids)):
        add_error(
            anomalies,
            "live-representative-stations-duplicate",
            scope,
            "liveRepresentativeStationIDs must not contain duplicates",
        )
    known = set(known_station_ids)
    unknown = sorted(set(station_ids) - known) if known else []
    if unknown:
        add_error(
            anomalies,
            "live-representative-stations-unknown",
            scope,
            "Representative station is absent from the fixture Tube catalogue",
            observed=unknown,
        )
    return sorted(set(station_ids) - set(unknown))


def report_from(
    *,
    mode: str,
    anomalies: list[Anomaly],
    coverage: dict[str, Any],
    request_metrics: list[dict[str, Any]] | None = None,
    schema_fields: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    metrics = request_metrics or []
    latencies = [metric["elapsedMilliseconds"] for metric in metrics if metric.get("status")]
    errors = sum(anomaly.severity == "error" for anomaly in anomalies)
    warnings = sum(anomaly.severity == "warning" for anomaly in anomalies)
    observations = sum(anomaly.severity == "observed" for anomaly in anomalies)
    return {
        "schemaVersion": 1,
        "mode": mode,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pointInTimeEvidence": mode == "live",
        "passed": errors == 0,
        "summary": {
            "errors": errors,
            "warnings": warnings,
            "observations": observations,
            "requestCount": len(metrics),
            "medianLatencyMilliseconds": round(statistics.median(latencies), 1) if latencies else None,
            "maximumLatencyMilliseconds": max(latencies) if latencies else None,
        },
        "coverage": coverage,
        "schemaFields": schema_fields or {},
        "anomalies": [asdict(anomaly) for anomaly in anomalies],
        "requests": metrics,
    }


def run_offline(fixture_dir: Path) -> dict[str, Any]:
    anomalies: list[Anomaly] = []
    try:
        manifest = load_json(fixture_dir / "manifest.json")
        lines = load_json(fixture_dir / "lines.json")
        stations_payload = load_json(fixture_dir / "stations-by-line.json")
        statuses = load_json(fixture_dir / "statuses.json")
    except (OSError, json.JSONDecodeError) as error:
        add_error(anomalies, "fixture-load-failed", str(fixture_dir), str(error))
        return report_from(mode="offline", anomalies=anomalies, coverage={})

    if not isinstance(manifest, dict):
        add_error(
            anomalies,
            "fixture-manifest-not-object",
            "manifest",
            "Fixture manifest root must be a JSON object",
        )
        return report_from(mode="offline", anomalies=anomalies, coverage={})

    schema_version = manifest.get("schemaVersion")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != 1
    ):
        add_error(anomalies, "fixture-manifest-version", "manifest", "Unsupported fixture manifest version", expected=1, observed=manifest.get("schemaVersion"))

    line_ids = validate_lines(lines, anomalies)
    status_line_ids = validate_statuses(statuses, anomalies)
    _, memberships = validate_stations_by_line(stations_payload, anomalies)
    validate_representative_station_ids(
        manifest,
        anomalies,
        known_station_ids=memberships,
    )

    arrival_summaries: list[dict[str, Any]] = []
    observed_schema_fields: set[str] = set()
    arrival_fixtures = manifest.get("arrivalFixtures")
    if not isinstance(arrival_fixtures, list):
        add_error(
            anomalies,
            "arrival-fixtures-invalid",
            "manifest.arrivalFixtures",
            "arrivalFixtures must be an array",
        )
        arrival_fixtures = []
    for fixture in arrival_fixtures:
        if not isinstance(fixture, dict):
            add_error(anomalies, "arrival-fixture-invalid", "manifest.arrivalFixtures", "Fixture entry must be an object")
            continue
        filename = fixture.get("file")
        station_id = fixture.get("stationID")
        selected_line_ids = fixture.get("selectedLineIDs", [])
        if (
            not is_nonempty_string(filename)
            or not is_nonempty_string(station_id)
            or not isinstance(selected_line_ids, list)
            or not all(is_nonempty_string(line_id) for line_id in selected_line_ids)
        ):
            add_error(
                anomalies,
                "arrival-fixture-metadata-invalid",
                "manifest.arrivalFixtures",
                "Fixture file, stationID, and selectedLineIDs must use valid string values",
            )
            continue
        try:
            payload = load_json(fixture_dir / filename)
        except (OSError, json.JSONDecodeError) as error:
            add_error(anomalies, "arrival-fixture-load-failed", filename, str(error))
            continue
        summary = validate_arrivals(
            payload,
            anomalies,
            station_id=station_id,
            selected_line_ids=selected_line_ids,
            scope=f"fixture.{filename}",
        )
        observed_schema_fields.update(summary.pop("observedKeys", []))
        arrival_summaries.append({"file": filename, **summary})

    expected = manifest.get("expectedObservations")
    if not isinstance(expected, dict):
        add_error(
            anomalies,
            "expected-observations-invalid",
            "manifest.expectedObservations",
            "expectedObservations must be a JSON object",
        )
        expected = {}
    elif set(expected) != EXPECTED_OBSERVATION_KEYS:
        add_error(
            anomalies,
            "expected-observation-keys-invalid",
            "manifest.expectedObservations",
            "expectedObservations must contain the exact validator oracle keys",
            expected=sorted(EXPECTED_OBSERVATION_KEYS),
            observed=sorted(expected),
        )
        expected = {}
    elif not all(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
        for value in expected.values()
    ):
        add_error(
            anomalies,
            "expected-observation-values-invalid",
            "manifest.expectedObservations",
            "Expected observation values must be non-negative integers",
        )
        expected = {}
    observed = {
        "lineCount": len(set(line_ids)),
        "statusLineCount": len(set(status_line_ids)),
        "stationMembershipCount": sum(len(lines) for lines in memberships.values()),
        "uniqueStationCount": len(memberships),
        "repeatedIDGroups": sum(item["repeatedIDGroups"] for item in arrival_summaries),
        "conflictingRepeatedIDGroups": sum(item["conflictingRepeatedIDGroups"] for item in arrival_summaries),
        "exactDuplicateGroups": sum(item["exactDuplicateGroups"] for item in arrival_summaries),
        "sparseDirectionRows": sum(item["sparseDirectionRows"] for item in arrival_summaries),
        "selectedLineEmptyObservations": sum(anomaly.code == "selected-line-empty" for anomaly in anomalies),
        "placeholderTrainIdentifierRows": sum(item["placeholderTrainIdentifierRows"] for item in arrival_summaries),
        "missingTrainIdentifierRows": sum(item["missingTrainIdentifierRows"] for item in arrival_summaries),
        "placeholderDestinationRows": sum(item["placeholderDestinationRows"] for item in arrival_summaries),
        "missingDestinationRows": sum(item["missingDestinationRows"] for item in arrival_summaries),
        "placeholderCurrentLocationRows": sum(item["placeholderCurrentLocationRows"] for item in arrival_summaries),
        "missingCurrentLocationRows": sum(item["missingCurrentLocationRows"] for item in arrival_summaries),
    }
    for key, expected_value in expected.items():
        if observed.get(key) != expected_value:
            add_error(
                anomalies,
                "offline-observation-mismatch",
                f"manifest.expectedObservations.{key}",
                "Offline fixture detector output changed",
                expected=expected_value,
                observed=observed.get(key),
            )

    coverage = {**observed, "lineIDs": sorted(set(line_ids)), "arrivalFixtures": arrival_summaries}
    return report_from(
        mode="offline",
        anomalies=anomalies,
        coverage=coverage,
        schema_fields={"arrival": sorted(observed_schema_fields)},
    )


def route_station_ids(payload: Any, anomalies: list[Anomaly], scope: str) -> set[str]:
    if not isinstance(payload, dict):
        add_error(anomalies, "route-sequence-not-object", scope, "Expected a route sequence object")
        return set()
    sequences = payload.get("stopPointSequences")
    if not isinstance(sequences, list):
        add_error(anomalies, "route-stop-sequences-invalid", scope, "stopPointSequences must be an array")
        return set()
    station_ids: set[str] = set()
    for sequence_index, sequence in enumerate(sequences):
        if not isinstance(sequence, dict):
            add_error(
                anomalies,
                "route-stop-sequence-not-object",
                f"{scope}[{sequence_index}]",
                "Expected a stop-point sequence object",
            )
            continue
        stops = sequence.get("stopPoint")
        if not isinstance(stops, list):
            add_error(anomalies, "route-stop-points-invalid", f"{scope}[{sequence_index}]", "stopPoint must be an array")
            continue
        for stop_index, stop in enumerate(stops):
            stop_scope = f"{scope}[{sequence_index}].stopPoint[{stop_index}]"
            if not isinstance(stop, dict):
                add_error(anomalies, "route-stop-not-object", stop_scope, "Expected a route stop object")
                continue
            station_id = stop.get("id")
            if not is_nonempty_string(station_id):
                add_error(anomalies, "route-stop-id-invalid", stop_scope, "Route stop id must be a non-empty string")
                continue
            station_ids.add(station_id)
    return station_ids


def compare_route_station_coverage(
    *,
    catalogue_ids: Iterable[str],
    route_ids: Iterable[str],
    anomalies: list[Anomaly],
    scope: str,
) -> None:
    catalogue = set(catalogue_ids)
    routes = set(route_ids)
    missing = sorted(catalogue - routes)
    if missing:
        add_warning(
            anomalies,
            "route-union-missing-catalogue-stations",
            scope,
            "Route-sequence union does not include every catalogue station in this snapshot",
            observed=missing,
        )
    unexpected = sorted(routes - catalogue)
    if unexpected:
        add_warning(
            anomalies,
            "route-union-stations-absent-from-catalogue",
            scope,
            "Route-sequence union includes stations absent from the line catalogue in this snapshot",
            observed=unexpected,
        )


def did_complete_full_arrival_sweep(
    *,
    full_requested: bool,
    expected_station_ids: Iterable[str],
    completed_station_ids: Iterable[str],
) -> bool:
    expected = set(expected_station_ids)
    completed = set(completed_station_ids)
    return full_requested and bool(expected) and completed == expected


def expected_live_line_ids(observed_line_ids: Iterable[str]) -> list[str]:
    return sorted(set(observed_line_ids) & set(EXPECTED_LINE_IDS))


def bounded_full_station_ids(
    memberships: dict[str, set[str]],
    anomalies: list[Anomaly],
    *,
    scope: str = "live.arrivals",
) -> list[str]:
    station_ids = deduplicated_station_ids(memberships)
    if len(station_ids) > MAX_FULL_STATIONS:
        add_error(
            anomalies,
            "full-sweep-station-limit-exceeded",
            scope,
            "Full arrival sweep exceeds the validator request ceiling",
            expected=f"<= {MAX_FULL_STATIONS}",
            observed=len(station_ids),
        )
        return []
    return station_ids


def run_live(
    *,
    fixture_dir: Path,
    full: bool,
    station_overrides: list[str],
    rate: float,
    timeout: float,
    baseline: Path | None,
) -> dict[str, Any]:
    anomalies: list[Anomaly] = []
    client = TfLClient(
        requests_per_second=rate,
        timeout=timeout,
        api_key=os.environ.get("TFL_API_KEY") or None,
    )
    line_ids: list[str] = []
    memberships: dict[str, set[str]] = {}
    route_union_by_line: dict[str, set[str]] = {}
    arrival_summaries: list[dict[str, Any]] = []
    observed_arrival_fields: set[str] = set()
    full_station_ids: list[str] = []
    completed_arrival_station_ids: set[str] = set()

    try:
        print(
            f"live: explicit TfL check at {rate:g} requests/second (timeout {timeout:g}s)",
            file=sys.stderr,
        )
        print("live: checking Tube line catalogue and statuses", file=sys.stderr)
        lines = client.get_json("/Line/Mode/tube,elizabeth-line,overground,dlr")
        line_ids = validate_lines(lines, anomalies, scope="live.lines")
        live_line_ids = expected_live_line_ids(line_ids)
        statuses = client.get_json("/Line/Mode/tube,elizabeth-line,overground,dlr/Status")
        validate_statuses(statuses, anomalies, scope="live.statuses")

        stations_by_line: dict[str, list[dict[str, Any]]] = {}
        for line_id in live_line_ids:
            print(f"live: station catalogue {line_id}", file=sys.stderr)
            stations = client.get_json(f"/Line/{urllib.parse.quote(line_id)}/StopPoints")
            stations_by_line[line_id] = stations if isinstance(stations, list) else []
        _, memberships = validate_stations_by_line(stations_by_line, anomalies, scope="live.stationsByLine")

        for line_id in live_line_ids:
            route_union: set[str] = set()
            for direction in ("inbound", "outbound"):
                print(f"live: route sequence {line_id} {direction}", file=sys.stderr)
                path = f"/Line/{urllib.parse.quote(line_id)}/Route/Sequence/{direction}?serviceTypes=Regular"
                route_union.update(route_station_ids(client.get_json(path), anomalies, f"live.routes.{line_id}.{direction}"))
            route_union_by_line[line_id] = route_union
            catalogue_ids = {station["id"] for station in stations_by_line.get(line_id, []) if isinstance(station, dict) and isinstance(station.get("id"), str)}
            compare_route_station_coverage(
                catalogue_ids=catalogue_ids,
                route_ids=route_union,
                anomalies=anomalies,
                scope=f"live.routes.{line_id}",
            )

        manifest = load_json(fixture_dir / "manifest.json")
        if not isinstance(manifest, dict):
            raise ValueError("fixture manifest root must be a JSON object")
        if station_overrides:
            station_ids = sorted(set(station_overrides))
        elif full:
            full_station_ids = bounded_full_station_ids(memberships, anomalies)
            station_ids = full_station_ids
        else:
            station_ids = validate_representative_station_ids(
                manifest,
                anomalies,
                known_station_ids=memberships,
            )
        unknown_stations = sorted(set(station_ids) - set(memberships))
        if unknown_stations:
            add_error(
                anomalies,
                "requested-station-not-in-catalogue",
                "live.arrivals",
                "Requested station is not in the current Tube catalogue",
                observed=unknown_stations,
            )

        for station_index, station_id in enumerate(station_ids, start=1):
            if station_id not in memberships:
                continue
            print(f"live: arrivals {station_index}/{len(station_ids)} {station_id}", file=sys.stderr)
            payload = client.get_json(f"/StopPoint/{urllib.parse.quote(station_id)}/Arrivals")
            completed_arrival_station_ids.add(station_id)
            summary = validate_arrivals(
                payload,
                anomalies,
                station_id=station_id,
                selected_line_ids=memberships.get(station_id, set()),
                scope=f"live.arrivals.{station_id}",
            )
            observed_arrival_fields.update(summary.pop("observedKeys", []))
            arrival_summaries.append({"stationID": station_id, **summary})
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError) as error:
        add_error(anomalies, "live-request-failed", "live", f"{type(error).__name__}: {error}")

    for metric in client.request_metrics:
        if metric["elapsedMilliseconds"] > 2000:
            add_warning(
                anomalies,
                "slow-live-response",
                metric["endpoint"],
                "Request exceeded the two-second health threshold",
                expected="<= 2000 ms",
                observed=metric["elapsedMilliseconds"],
            )

    coverage = {
        "lineIDs": sorted(set(line_ids)),
        "lineCount": len(set(line_ids)),
        "stationMembershipCount": sum(len(lines) for lines in memberships.values()),
        "uniqueStationCount": len(memberships),
        "arrivalStationCount": len(arrival_summaries),
        "arrivalRows": sum(item["rows"] for item in arrival_summaries),
        "repeatedIDGroups": sum(item["repeatedIDGroups"] for item in arrival_summaries),
        "exactDuplicateGroups": sum(item["exactDuplicateGroups"] for item in arrival_summaries),
        "placeholderTrainIdentifierRows": sum(item["placeholderTrainIdentifierRows"] for item in arrival_summaries),
        "missingTrainIdentifierRows": sum(item["missingTrainIdentifierRows"] for item in arrival_summaries),
        "placeholderDestinationRows": sum(item["placeholderDestinationRows"] for item in arrival_summaries),
        "missingDestinationRows": sum(item["missingDestinationRows"] for item in arrival_summaries),
        "placeholderCurrentLocationRows": sum(item["placeholderCurrentLocationRows"] for item in arrival_summaries),
        "missingCurrentLocationRows": sum(item["missingCurrentLocationRows"] for item in arrival_summaries),
        "routeDirectionCount": len(route_union_by_line) * 2,
        "fullArrivalSweep": did_complete_full_arrival_sweep(
            full_requested=full,
            expected_station_ids=full_station_ids,
            completed_station_ids=completed_arrival_station_ids,
        ),
    }
    report = report_from(
        mode="live",
        anomalies=anomalies,
        coverage=coverage,
        request_metrics=client.request_metrics,
        schema_fields={"arrival": sorted(observed_arrival_fields)},
    )
    if baseline:
        compare_with_baseline(report, baseline)
        report = report_from(
            mode="live",
            anomalies=[Anomaly(**item) for item in report["anomalies"]],
            coverage=report["coverage"],
            request_metrics=report["requests"],
            schema_fields=report["schemaFields"],
        )
    return report


def compare_with_baseline(report: dict[str, Any], baseline_path: Path) -> None:
    try:
        baseline = load_json(baseline_path)
    except (OSError, json.JSONDecodeError) as error:
        report["anomalies"].append(asdict(Anomaly("baseline-load-failed", "error", str(baseline_path), str(error))))
        return
    if not isinstance(baseline, dict):
        report["anomalies"].append(
            asdict(
                Anomaly(
                    "baseline-root-invalid",
                    "error",
                    str(baseline_path),
                    "Baseline report root must be a JSON object",
                )
            )
        )
        return
    schema_version = baseline.get("schemaVersion")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != 1
    ):
        report["anomalies"].append(
            asdict(
                Anomaly(
                    "baseline-schema-version-invalid",
                    "error",
                    f"{baseline_path}.schemaVersion",
                    "Baseline schemaVersion must be integer 1",
                    expected=1,
                    observed=schema_version,
                )
            )
        )
    mode = baseline.get("mode")
    if mode != "live":
        report["anomalies"].append(
            asdict(
                Anomaly(
                    "baseline-mode-invalid",
                    "error",
                    f"{baseline_path}.mode",
                    "Baseline must be a live report",
                    expected="live",
                    observed=mode,
                )
            )
        )
    baseline_coverage = baseline.get("coverage")
    baseline_coverage_is_valid = isinstance(baseline_coverage, dict)
    if not baseline_coverage_is_valid:
        report["anomalies"].append(
            asdict(
                Anomaly(
                    "baseline-coverage-invalid",
                    "error",
                    f"{baseline_path}.coverage",
                    "Baseline coverage must be a JSON object",
                )
            )
        )
        baseline_coverage = {}
    baseline_schema_fields = baseline.get("schemaFields")
    baseline_schema_fields_is_valid = isinstance(baseline_schema_fields, dict)
    if not baseline_schema_fields_is_valid:
        report["anomalies"].append(
            asdict(
                Anomaly(
                    "baseline-schema-fields-invalid",
                    "error",
                    f"{baseline_path}.schemaFields",
                    "Baseline schemaFields must be a JSON object",
                )
            )
        )
        baseline_schema_fields = {}
    comparisons: list[tuple[str, Any, Any]] = []
    if baseline_coverage_is_valid:
        line_ids = baseline_coverage.get("lineIDs")
        if (
            not isinstance(line_ids, list)
            or not line_ids
            or not all(is_nonempty_string(line_id) for line_id in line_ids)
        ):
            report["anomalies"].append(
                asdict(
                    Anomaly(
                        "baseline-line-ids-invalid",
                        "error",
                        f"{baseline_path}.coverage.lineIDs",
                        "Baseline lineIDs must be a non-empty array of strings",
                    )
                )
            )
        else:
            comparisons.append(
                ("coverage.lineIDs", line_ids, report.get("coverage", {}).get("lineIDs"))
            )
        station_count = baseline_coverage.get("uniqueStationCount")
        if (
            not isinstance(station_count, int)
            or isinstance(station_count, bool)
            or station_count < 0
        ):
            report["anomalies"].append(
                asdict(
                    Anomaly(
                        "baseline-station-count-invalid",
                        "error",
                        f"{baseline_path}.coverage.uniqueStationCount",
                        "Baseline uniqueStationCount must be a non-negative integer",
                    )
                )
            )
        else:
            comparisons.append(
                (
                    "coverage.uniqueStationCount",
                    station_count,
                    report.get("coverage", {}).get("uniqueStationCount"),
                )
            )
    if baseline_schema_fields_is_valid:
        arrival_fields = baseline_schema_fields.get("arrival")
        if (
            not isinstance(arrival_fields, list)
            or not arrival_fields
            or not all(is_nonempty_string(field) for field in arrival_fields)
        ):
            report["anomalies"].append(
                asdict(
                    Anomaly(
                        "baseline-arrival-schema-invalid",
                        "error",
                        f"{baseline_path}.schemaFields.arrival",
                        "Baseline arrival schema must be a non-empty array of strings",
                    )
                )
            )
        else:
            comparisons.append(
                (
                    "schemaFields.arrival",
                    arrival_fields,
                    report.get("schemaFields", {}).get("arrival"),
                )
            )
    for scope, expected, observed in comparisons:
        if expected != observed:
            report["anomalies"].append(
                asdict(
                    Anomaly(
                        "historical-change",
                        "warning",
                        scope,
                        "Live result differs from the supplied prior report",
                        expected=expected,
                        observed=observed,
                    )
                )
            )


def write_report(report: dict[str, Any], output: Path | None) -> None:
    serialized = json.dumps(report, indent=2, sort_keys=True)
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized + "\n", encoding="utf-8")
        print(f"report: {output}", file=sys.stderr)
    print(serialized)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    mode = result.add_mutually_exclusive_group()
    mode.add_argument("--offline", action="store_true", help="validate deterministic fixtures (default)")
    mode.add_argument("--live", action="store_true", help="explicitly query TfL at a bounded rate")
    live_scope = result.add_mutually_exclusive_group()
    live_scope.add_argument("--full", action="store_true", help="with --live, request arrivals once per unique supported station")
    live_scope.add_argument("--station", action="append", default=[], help="with --live, check only this station id (repeatable)")
    result.add_argument("--requests-per-second", type=float, default=DEFAULT_RATE)
    result.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    result.add_argument("--fixture-dir", type=Path, default=DEFAULT_FIXTURE_DIR)
    result.add_argument("--baseline", type=Path, help="compare live coverage/schema with a prior JSON report")
    result.add_argument("--output", type=Path, help="also write the exact JSON report to this path")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.full and not args.live:
        print("ERROR: --full requires --live", file=sys.stderr)
        return 2
    if args.station and not args.live:
        print("ERROR: --station requires --live", file=sys.stderr)
        return 2
    if args.baseline and not args.live:
        print("ERROR: --baseline requires --live", file=sys.stderr)
        return 2
    try:
        if args.live:
            report = run_live(
                fixture_dir=args.fixture_dir,
                full=args.full,
                station_overrides=args.station,
                rate=args.requests_per_second,
                timeout=args.timeout,
                baseline=args.baseline,
            )
        else:
            report = run_offline(args.fixture_dir)
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    write_report(report, args.output)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
