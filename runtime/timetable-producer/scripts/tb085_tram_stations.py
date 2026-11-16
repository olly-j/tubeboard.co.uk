"""Match published Tram platforms to the stations in the app's TfL route maps."""
import json
from pathlib import Path
import re


MAPS = Path(__file__).resolve().parents[1] / "My Train Times/PublishedLineMaps.json"


def stations():
    line, = (line for line in json.loads(MAPS.read_bytes()) if line["id"] == "tram")
    names = {}
    for edition in line["editions"]:
        for ident, stop in edition["stations"].items():
            if names.setdefault(ident, stop["name"]) != stop["name"]:
                raise ValueError("Conflicting Tram station names in route maps")
    return names


def platform_parents(points, names):
    if not isinstance(points, list) or not 1 <= len(points) <= 1000:
        raise ValueError("Invalid TfL Tram stop list")
    parents = {}
    children = {}
    for stop in points:
        if "tram" not in stop["modes"] or "tram" not in {line["id"] for line in stop["lines"]}:
            continue
        ident = stop["id"]
        if stop["stopType"] == "NaptanMetroPlatform":
            parent = stop["stationNaptan"]
            if (not re.fullmatch(r"9400ZZCR[A-Z0-9]+", ident)
                    or ident in parents or parent not in names):
                raise ValueError("Unrecognised or duplicate TfL Tram platform")
            parents[ident] = parent
        elif stop["stopType"] == "NaptanMetroStation" and ident in names:
            if ident in children or stop["stationNaptan"] != ident:
                raise ValueError("Conflicting TfL Tram station")
            children[ident] = {child["id"] for child in stop["children"]
                               if child.get("stopType") == "NaptanMetroPlatform"}
    if not parents or any(platform not in children.get(parent, ()) for platform, parent in parents.items()):
        raise ValueError("TfL Tram platform and parent station disagree")
    if any(parents.get(platform) != parent for parent, platforms in children.items() for platform in platforms):
        raise ValueError("TfL Tram station lists a platform with a different parent")
    return parents
