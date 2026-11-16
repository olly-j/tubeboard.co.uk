#!/usr/bin/env python3
"""Wrap exact reviewed tb085_timetable_publication.py output; never qualify or fetch.

All input bytes and ordered revision are supplied by the engineering integration
owner. No generated date, timetable row, official HEAD or availability assertion
is added. Atomic output publication is a local preparation, not deployment.
"""
from __future__ import annotations
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

MAX_RESOURCE_BYTES = 2_000_000
MAX_PROOF_BYTES = 128 * 1024
MAX_PROOF_REVISION = 9007199254740991
SOURCE = 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip'
SHA = re.compile(r'[a-f0-9]{64}\Z')
FIELDS = ['schemaVersion', 'publicationSHA256', 'proofRevision', 'proofBodySHA256', 'proofBodyBase64']

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate JSON key')
        result[key] = value
    return result

def parse(data: bytes):
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique_object,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON number')))

def canonical(value: dict) -> bytes:
    return (json.dumps({key:value[key] for key in FIELDS}, ensure_ascii=True,
        separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')

def reviewed_proof(data: bytes, expected_sha: str, approved_body_sha: str) -> dict:
    if not 0 < len(data) <= MAX_PROOF_BYTES or not SHA.fullmatch(expected_sha) or not SHA.fullmatch(approved_body_sha):
        raise ValueError('invalid proof bounds or review identity')
    if digest(data) != approved_body_sha: raise ValueError('proof differs from exact reviewed bytes')
    value = parse(data)
    if not isinstance(value, dict) or value.get('schemaVersion') != 1 or type(value.get('schemaVersion')) is not int:
        raise ValueError('unsupported proof schema')
    publication = value.get('publication')
    if (not isinstance(publication, dict) or publication.get('sha256') != expected_sha
        or publication.get('url') != SOURCE or value.get('timezone') != 'Europe/London'
        or not isinstance(value.get('entries'), list)):
        raise ValueError('wrong embedded publication')
    # No requalification, reserialization, route edits or inferred dates.
    return value

def validate_resource(data: bytes, expected_sha: str) -> dict:
    if not 0 < len(data) <= MAX_RESOURCE_BYTES: raise ValueError('resource bounds')
    value = parse(data)
    if not isinstance(value, dict) or set(value) != set(FIELDS) or value['schemaVersion'] != 1 or type(value['schemaVersion']) is not int:
        raise ValueError('invalid wrapper fields/schema')
    if value['publicationSHA256'] != expected_sha or not SHA.fullmatch(expected_sha):
        raise ValueError('wrong resource publication')
    if type(value['proofRevision']) is not int or not 1 <= value['proofRevision'] <= MAX_PROOF_REVISION:
        raise ValueError('unsafe proof revision')
    if not isinstance(value['proofBodySHA256'], str) or not SHA.fullmatch(value['proofBodySHA256']):
        raise ValueError('invalid proof hash')
    if not isinstance(value['proofBodyBase64'], str) or len(value['proofBodyBase64']) > 4 * ((MAX_PROOF_BYTES+2)//3):
        raise ValueError('invalid proof encoding bounds')
    proof = base64.b64decode(value['proofBodyBase64'], validate=True)
    if base64.b64encode(proof).decode('ascii') != value['proofBodyBase64']:
        raise ValueError('noncanonical base64')
    reviewed_proof(proof, expected_sha, value['proofBodySHA256'])
    if canonical(value) != data: raise ValueError('noncanonical wrapper')
    return value

def package(data: bytes, *, expected_sha: str, approved_body_sha: str, revision: int,
            previous: bytes | None = None) -> bytes:
    proof = reviewed_proof(data, expected_sha, approved_body_sha)
    # Installed v1 clients reject the entire resource on a single unknown board, even a gap.
    catalogue = Path(__file__).resolve().parents[1] / "TubeBoard Watch App/TubeStationCatalog.json"
    boards = {line["lineID"] + "/" + station["stationID"] for station in parse(catalogue.read_bytes())["stations"]
              for line in station["lines"]}
    if digest("\n".join(sorted(boards)).encode()) != "b735d4f35aea27ac9b99e6a48f02be1b586e0283d154588aae204e390df26b68":
        raise ValueError("Version-one client station catalogue has changed")
    for entry in proof["entries"]:
        if entry["lineID"] + "/" + entry["stationID"] not in boards:
            raise ValueError("Station outside the installed version-one client catalogue")
    if type(revision) is not int or not 1 <= revision <= MAX_PROOF_REVISION:
        raise ValueError('unsafe proof revision')
    value = {'schemaVersion':1, 'publicationSHA256':expected_sha, 'proofRevision':revision,
        'proofBodySHA256':approved_body_sha, 'proofBodyBase64':base64.b64encode(data).decode('ascii')}
    encoded = canonical(value)
    if len(encoded) > MAX_RESOURCE_BYTES: raise ValueError('resource overflow')
    if previous is None:
        if revision != 1: raise ValueError('higher revision needs retained previous resource')
    else:
        prior = validate_resource(previous, expected_sha)
        if revision < prior['proofRevision']: raise ValueError('revision rollback')
        if revision == prior['proofRevision'] and encoded != previous:
            raise ValueError('equal revision conflicting body')
    return encoded

def bounded_read(file: Path, limit: int) -> bytes:
    # Refuse source symlinks and cap actual bytes before JSON/base64 decoding.
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise ValueError('input is not a bounded regular file')
        data = handle.read(limit + 1)
    if not 0 < len(data) <= limit: raise ValueError('input size bound')
    return data

def publish(proof: Path, output: Path, *, expected_sha: str, approved_body_sha: str,
            revision: int, previous_resource: Path | None = None) -> dict:
    if output.name != expected_sha + '.json': raise ValueError('output filename must be exact official SHA')
    data = bounded_read(proof, MAX_PROOF_BYTES)
    output.parent.mkdir(parents=True, exist_ok=True)
    # One owned output-directory lock serializes local package publication. It
    # is separate from APP admission state; no source authority is created.
    with (output.parent / '.tbproof-publication.lock').open('a+b') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        previous = bounded_read(previous_resource, MAX_RESOURCE_BYTES) if previous_resource is not None else None
        existing = bounded_read(output, MAX_RESOURCE_BYTES) if output.exists() or output.is_symlink() else None
        if existing is not None:
            existing_value = validate_resource(existing, expected_sha)
            if previous is not None:
                supplied = validate_resource(previous, expected_sha)
                if supplied['proofRevision'] != existing_value['proofRevision'] or previous != existing:
                    raise ValueError('previous resource differs from owned current asset')
            previous = existing
        encoded = package(data, expected_sha=expected_sha, approved_body_sha=approved_body_sha,
            revision=revision, previous=previous)
        if encoded != existing:
            temp_name = None
            try:
                with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.tbproof-', delete=False) as temp:
                    temp_name = temp.name
                    os.fchmod(temp.fileno(), 0o644)
                    temp.write(encoded); temp.flush(); os.fsync(temp.fileno())
                os.replace(temp_name, output); temp_name = None
                directory_fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
                try: os.fsync(directory_fd)
                finally: os.close(directory_fd)
            finally:
                if temp_name is not None: os.unlink(temp_name)
    return {'publicationSHA256':expected_sha, 'proofRevision':revision,
        'proofBodySHA256':approved_body_sha, 'resourceSHA256':digest(encoded),
        'proofBytes':len(data), 'resourceBytes':len(encoded), 'status':'packaged_only_not_deployed'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proof', type=Path, required=True)
    parser.add_argument('--expected-publication-sha', required=True)
    parser.add_argument('--approved-proof-sha', required=True)
    parser.add_argument('--revision', type=int, required=True)
    parser.add_argument('--previous-resource', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(publish(args.proof, args.output, expected_sha=args.expected_publication_sha,
        approved_body_sha=args.approved_proof_sha, revision=args.revision,
        previous_resource=args.previous_resource), sort_keys=True))

if __name__ == '__main__': main()
