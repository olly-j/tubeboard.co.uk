"""Read the comparison URLs used by the installed app, retaining only their digests."""
import hashlib
import re
import time


BASE = "https://tubeboard.co.uk/api/timetable-source-bodies/v1/"
MIB = 1024 * 1024


def source_url(edition, proof_sha, line, station, direction, body_sha):
    if (any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)
            for value in (edition, proof_sha, body_sha))
            or not re.fullmatch(r"[a-z0-9-]{1,64}", line) or not re.fullmatch(r"[A-Za-z0-9]{1,32}", station)
            or direction not in {"default", "inbound", "outbound"}):
        raise ValueError("Invalid proof-bound comparison identity")
    return BASE + "/".join((edition, proof_sha, line, station, direction, body_sha))


def scopes(body):
    result = []
    for entry in body["entries"]:
        if entry["status"] != "qualified":
            continue
        evidence = entry.get("directionalSourceEvidence") or [
            {"direction": "default", "apiBodySHA256": entry.get("apiBodySHA256")}]
        for item in evidence:
            result.append({"line": entry["lineID"], "station": entry["stationID"], "direction": item["direction"],
                           "bodySHA": item["apiBodySHA256"]})
    return result


def verify(report, fetch):
    if "comparisonScopes" not in report:
        return
    errors = []
    total = 0
    deadline = time.monotonic() + 120
    sources = report["comparisonScopes"]
    if len(sources) > 128:
        errors.append("Publication exceeds the comparison-source bound")
        sources = []
    verified = 0
    for row in sources:
        if time.monotonic() >= deadline or total >= 32 * MIB:
            errors.append("Comparison-source verification budget expired")
            break
        try:
            url = source_url(report["publication"], report["proofBodySHA256"], row["line"], row["station"],
                             row["direction"], row["bodySHA"])
            headers, data = fetch(url, "GET", min(8 * MIB, 32 * MIB - total))
            total += len(data)
            headers = {key.lower(): value for key, value in headers.items()}
            if ("no-store" not in {v.strip().lower() for v in headers.get("cache-control", "").split(",")}
                    or headers.get("content-type", "").split(";")[0].strip().lower() != "application/json"
                    or hashlib.sha256(data).hexdigest() != row["bodySHA"]):
                raise ValueError("response identity or cache policy differs")
            verified += 1
        except (ValueError, KeyError, TypeError, OSError) as exc:
            errors.append(f"{row['line']}/{row['station']}/{row['direction']}: {str(exc)[:130]}")
    report["verifiedComparisonScopes"] = verified
    report["details"].extend("Production comparison unavailable: " + error for error in errors)
    if errors and report["status"] == "healthy":
        report["status"] = "production-comparison-unavailable"
