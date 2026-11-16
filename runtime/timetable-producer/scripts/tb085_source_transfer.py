"""Retrieve exact TfL qualification bytes from TubeBoard's fixed first-party worker."""
import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import tb085_monitor_publication as monitor

AUDIENCE = "tubeboard-timetable-source-archive"
TRANSFER = "https://tubeboard.co.uk/api/timetable-source-archives/v1/"
LIMIT = 160 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get_token(open_request, *, audience=AUDIENCE):
    source = urlsplit(os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", ""))
    secret = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if (not secret or source.scheme != "https" or not source.hostname
            or not source.hostname.endswith(".actions.githubusercontent.com")
            or source.username or source.password or source.port not in (None, 443)):
        raise ValueError("The protected workflow's short-lived identity is unavailable")
    query = [(k, v) for k, v in parse_qsl(source.query) if k != "audience"]
    query.append(("audience", audience))
    url = urlunsplit(source._replace(query=urlencode(query), fragment=""))
    req = Request(url, headers={"Authorization": "Bearer " + secret})
    with open_request(req, timeout=10) as response:
        raw = response.read(32769)
    if len(raw) > 32768:
        raise ValueError("GitHub identity response exceeds its bound")
    token = json.loads(raw).get("value")
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token):
        raise ValueError("GitHub returned no usable workflow identity")
    return token


def acquire(directory, publication, deadline, open_request=None):
    if not re.fullmatch(r"[0-9a-f]{64}", publication):
        raise ValueError("Invalid timetable transfer digest")
    open_request = open_request or build_opener(NoRedirect()).open
    url = TRANSFER + publication
    target = directory / "official-transferred.zip"
    started = datetime.now(timezone.utc)
    try:
        token = get_token(open_request)
        remaining = int(deadline - time.monotonic())
        if remaining < 1:
            raise ValueError("Timetable transfer deadline expired")
        req = Request(url, headers={"Authorization": "Bearer " + token})
        with open_request(req, timeout=min(remaining, 180)) as response:
            h = response.headers
            length = int(h.get("Content-Length", "0"))
            # Before cold-cache support, the service only exposed GET clocks.
            clock_method = h.get("X-TubeBoard-Source-Clock-Method", "GET")
            if clock_method not in {"HEAD", "GET"}:
                raise ValueError("Unknown publisher clock provenance")
            if (not 0 < length <= LIMIT or response.status != 200
                    or h.get("Content-Type") != "application/zip"
                    or h.get("X-TubeBoard-Source-Use") != "verified-qualification-input-only"
                    or h.get("X-TubeBoard-Source-URL") != monitor.proof.SOURCE
                    or h.get("X-TubeBoard-Publication-SHA256") != publication):
                raise ValueError("Timetable transfer source, size or identity differs from the request")
            if not h.get("X-TubeBoard-Source-HTTP-Date") or not h.get("X-TubeBoard-Source-HTTP-Age"):
                raise ValueError("Timetable transfer omits the upstream observation clock")
            headers = {"date": h["X-TubeBoard-Source-HTTP-Date"], "age": h["X-TubeBoard-Source-HTTP-Age"],
                       "x-amz-meta-sha256": publication}
            if h.get("X-TubeBoard-Source-Last-Modified"):
                headers["last-modified"] = h["X-TubeBoard-Source-Last-Modified"]
            monitor.check_fresh(headers, datetime.now(timezone.utc), provider=True)
            digest = hashlib.sha256()
            count = 0
            with target.open("xb") as output:
                while block := response.read(1024 * 1024):
                    count += len(block)
                    if count > length or time.monotonic() >= deadline:
                        raise ValueError("Timetable transfer exceeded its size or time bound")
                    digest.update(block)
                    output.write(block)
            received = datetime.now(timezone.utc)
            monitor.check_fresh(headers, received, provider=True)
            if count != length or digest.hexdigest() != publication:
                raise ValueError("Transferred ZIP bytes do not match the official publication")
    except HTTPError as error:
        raise ValueError(f"Protected timetable transfer failed with HTTP {error.code}") from None
    return {"url": url, "sourceURL": monitor.proof.SOURCE, "transport": "verified-service-transfer",
            "sourceClockMethod": clock_method, "status": 200, "body": target.name, "bytes": count, "sha256": publication,
            "headers": headers, "startedAt": started.isoformat(), "receivedAt": received.isoformat()}
