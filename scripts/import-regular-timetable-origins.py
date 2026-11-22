"""Export mobile origin rules into the worker's station-board catalogue scope."""
from collections import defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def lines_by_mode_and_segment(atlas):
    segments = defaultdict(set)
    for line in atlas:
        for edition in line["editions"]:
            for path in edition["paths"]:
                stops = path["stops"]
                for index, pair in enumerate(zip(stops, stops[1:]), start=1):
                    if index not in path["breaks"]:
                        segment = (line["mode"], *sorted(pair))
                        segments[segment].add(line["id"])
    return segments


def main():
    app = Path(sys.argv[1]).resolve()
    service = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "common_onward_stops", app / "scripts/tb085_common_onward_stops.py"
    )
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    catalogue = (service / "contracts/station-board-catalogue-v2.json").read_bytes()
    atlas_bytes = generator.ATLAS.read_bytes()
    atlas = json.loads(atlas_bytes)
    segments = lines_by_mode_and_segment(atlas)
    station_lines = {s["stationID"]: s["lineIDs"] for s in json.loads(catalogue)["stations"]}
    rules = {}
    for line in atlas:
        line_id = line["id"]
        def known(station):
            return line_id in station_lines.get(station, [])

        ends = generator.physical_ends(line["editions"])
        starts = generator.boarding_origins(line["editions"])
        known_ends = sorted(station for station in ends if known(station))
        known_starts = {station: sorted(call for call in calls if known(call))
                        for station, calls in starts.items() if station not in ends and known(station)}
        if known_ends or known_starts:
            # A different service of the same mode can dominate a short query
            # on a shared segment because Journey Results queries a mode, not a line.
            common_targets = {station: target for station, target in generator.common_stops(line["editions"]).items()
                              if station in known_ends and known(target)
                              and segments[(line["mode"], *sorted((station, target)))] == {line_id}}
            rules[line_id] = {"physicalEnds": known_ends, "exclusiveFirstCalls": known_starts,
                              "commonJourneyTargets": common_targets}
    receipt = {
        "sourceAppHead": subprocess.check_output(["git", "-C", str(app), "rev-parse", "HEAD"], text=True).strip(),
        "publishedLineMapsSHA256": hashlib.sha256(atlas_bytes).hexdigest(),
        "serviceCatalogueSHA256": hashlib.sha256(catalogue).hexdigest(),
        "lines": rules,
    }
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
