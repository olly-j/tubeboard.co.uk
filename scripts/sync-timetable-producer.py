#!/usr/bin/env python3
"""Copy the reviewed producer's committed import closure; never fetch or build it."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1] / "runtime/timetable-producer"
MODULES = ["tb085_prepare_renewal", "tb085_package_timetable_proof",
           "tb085_timetable_publication", "tb085_monitor_publication",
           "tb085_source_transfer", "tb085_additive_qualification",
           "tb085_reference_readback", "tb085_live_parity", "tb085_tram_stations",
           "check_tfl_api_health"]
FILES = [f"scripts/{name}.py" for name in MODULES] + [
    "scripts/tb085_renewal_roster.json", "TubeBoard Watch App/TubeStationCatalog.json"]


def safe_target(relative):
    target = ROOT / relative
    for part in [target, *target.parents]:
        if part.is_symlink():
            raise ValueError("Producer bundle path contains a symlink")
    return target


def verify():
    manifest = json.loads(safe_target("manifest.json").read_text())
    if (manifest.get("schemaVersion") != 1 or
            manifest.get("repository") != "olly-j/My-Train-Times" or
            not re.fullmatch(r"[a-f0-9]{40}", manifest.get("revision", "")) or
            sorted(manifest.get("files", {})) != sorted(FILES)):
        raise ValueError("Invalid producer provenance manifest")
    for relative, expected in manifest["files"].items():
        data = safe_target(relative).read_bytes()
        if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
            raise ValueError(f"Producer bundle differs from its source manifest: {relative}")
    print(f"Verified {len(FILES)} producer files from {manifest['revision']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--revision")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        if args.source or args.revision:
            parser.error("--check reads the installed bundle without a source checkout")
        verify()
        return
    if not args.source or not re.fullmatch(r"[a-f0-9]{40}", args.revision or ""):
        parser.error("copy requires --source and an exact 40-digit --revision")
    # Read every allowed file before changing the bundle. A missing committed
    # dependency never leaves half a new source set next to an old manifest.
    payloads = {relative: subprocess.run(
        ["git", "-C", str(args.source), "show", f"{args.revision}:{relative}"],
        check=True, capture_output=True).stdout for relative in FILES}
    manifest = {"schemaVersion": 1, "repository": "olly-j/My-Train-Times",
                "revision": args.revision, "files": {relative: {
                    "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()
                } for relative, data in payloads.items()}}
    for relative, data in payloads.items():
        target = safe_target(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    safe_target("manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    verify()


if __name__ == "__main__":
    main()
