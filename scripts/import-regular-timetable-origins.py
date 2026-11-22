"""Export mobile origin rules into the worker's station-board catalogue scope."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def main():
    app = Path(sys.argv[1]).resolve()
    service = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "common_onward_stops", app / "scripts/tb085_common_onward_stops.py"
    )
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    catalogue = (service / "contracts/station-board-catalogue-v2.json").read_bytes()
    atlas = generator.ATLAS.read_bytes()
    station_lines = {s["stationID"]: s["lineIDs"] for s in json.loads(catalogue)["stations"]}
    rules = {}
    for line in json.loads(atlas):
        line_id = line["id"]
        def known(station):
            return line_id in station_lines.get(station, [])

        ends = generator.physical_ends(line["editions"])
        starts = generator.boarding_origins(line["editions"])
        known_ends = sorted(station for station in ends if known(station))
        known_starts = {station: sorted(call for call in calls if known(call))
                        for station, calls in starts.items() if station not in ends and known(station)}
        if known_ends or known_starts:
            # Only the complete-atlas lookup certifies a common enquiry stop.
            # The mobile partial-line hints are broader than this bounded scope.
            common_targets = {station: target for station, target in generator.common_stops(line["editions"]).items()
                              if station in known_ends and known(target)}
            rules[line_id] = {"physicalEnds": known_ends, "exclusiveFirstCalls": known_starts,
                              "commonJourneyTargets": common_targets}
    receipt = {
        "sourceAppHead": subprocess.check_output(["git", "-C", str(app), "rev-parse", "HEAD"], text=True).strip(),
        "publishedLineMapsSHA256": hashlib.sha256(atlas).hexdigest(),
        "serviceCatalogueSHA256": hashlib.sha256(catalogue).hexdigest(),
        "lines": rules,
    }
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
