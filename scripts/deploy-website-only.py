#!/usr/bin/env python3
"""TB-016: publish only reviewed pricing HTML over the immutable live image.

The full service deployment remains separate. No tokens, /data, worker,
network, volume, environment or service configuration is changed here.
Without --confirm-production this command only produces a guarded plan.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request

APP = 'tubeboard-co-uk'
HOST = 'https://tubeboard.co.uk'
PAGES = ('index.html', 'support.html')
OLD_PRICE = '<p class="price"><strong>£24.99</strong><span>one-off</span></p>'
NEW_PRICE = ('<p class="price"><strong>£31.99</strong><span>one-off from 25 September 2026</span></p>'
             '\n          <p class="pricing-note">£24.99 until 24 September 2026.</p>')
OLD_SUPPORT = 'lifetime is £24.99 at UK launch;'
NEW_SUPPORT = 'lifetime is £31.99 from 25 September 2026 (£24.99 until 24 September 2026);'


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def price_page(name: str, source: bytes) -> bytes:
    if name not in PAGES or len(source) > 256_000:
        raise ValueError('Only the two bounded pricing pages may be changed')
    text = source.decode('utf-8')
    old, new = (OLD_PRICE, NEW_PRICE) if name == 'index.html' else (OLD_SUPPORT, NEW_SUPPORT)
    if text.count(old) != 1 or text.count('£24.99') != 1:
        raise ValueError('The reviewed prior pricing no longer matches; re-plan')
    return text.replace(old, new, 1).encode('utf-8')


def overlay_dockerfile(image: str, source: str) -> str:
    if not re.fullmatch(r'registry\.fly\.io/tubeboard-co-uk@sha256:[0-9a-f]{64}', image):
        raise ValueError('The existing production image must be immutable and app-owned')
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('Expected an exact website source commit')
    return (f'FROM {image}\nCOPY index.html support.html /app/\n'
            f'LABEL uk.co.tubeboard.website-source="{source}"\n')


def config_digest(machine: dict) -> str:
    config = dict(machine['config'])
    config.pop('image', None)
    return digest(json.dumps(config, sort_keys=True, separators=(',', ':')).encode())


def checked(args: list[str], *, cwd: Path | None = None, timeout: int = 90) -> str:
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f'{args[:3]} failed: {p.stderr[-1200:]}')
    return p.stdout


def fetch(path: str) -> bytes:
    req = urllib.request.Request(HOST + path, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return response.read(512_000)


def machine(machine_id: str) -> dict:
    all_machines = json.loads(checked(['flyctl', 'machines', 'list', '--app', APP, '--json']))
    matches = [m for m in all_machines if m['id'] == machine_id]
    if len(all_machines) != 1 or len(matches) != 1 or matches[0]['state'] != 'started':
        raise ValueError('Expected the exact single running production machine')
    result = matches[0]
    if not any(m.get('path') == '/data' and m.get('encrypted') is True
               for m in result['config'].get('mounts', [])):
        raise ValueError('Expected preserved encrypted data volume')
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-backend-revision', required=True)
    parser.add_argument('--expected-image-digest', required=True)
    parser.add_argument('--machine-id', required=True)
    parser.add_argument('--evidence-dir', required=True, type=Path)
    parser.add_argument('--confirm-production', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.expected_backend_revision):
        parser.error('Invalid expected backend revision')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', args.expected_image_digest):
        parser.error('Invalid expected image digest')
    root = Path(__file__).resolve().parents[1]
    evidence = args.evidence_dir.resolve()
    if evidence.is_relative_to(root) or evidence.is_symlink() or evidence.exists():
        raise ValueError('Use a new private evidence directory outside the source checkout')
    checked(['git', 'fetch', 'origin', 'main'], cwd=root)
    head = checked(['git', 'rev-parse', 'HEAD'], cwd=root).strip()
    if checked(['git', 'status', '--porcelain'], cwd=root).strip():
        raise ValueError('Preserve dirty source; a clean exact-main checkout is required')
    if head != checked(['git', 'rev-parse', 'origin/main'], cwd=root).strip():
        raise ValueError('Use reviewed current-main source; do not deploy a draft')
    before = machine(args.machine_id)
    if before['image_ref']['digest'] != args.expected_image_digest:
        raise ValueError('Production image changed; re-plan without overwriting it')
    health = json.loads(fetch('/healthz'))
    if health.get('ok') is not True or health.get('sourceRevision') != args.expected_backend_revision:
        raise ValueError('Production backend identity differs')
    # Read trusted immutable deployed HTML, not newer main HTML containing
    # unrelated source-only assets/features. The ONLY delta is the price copy.
    pages = {}
    for name in PAGES:
        prior = subprocess.check_output(['git', 'show', f'{args.expected_backend_revision}:{name}'], cwd=root)
        live = fetch('/' if name == 'index.html' else '/support')
        if live != prior:
            raise ValueError(f'Live {name} does not match the retained deployed source')
        pages[name] = price_page(name, prior)
        current = (root / name).read_bytes()
        replacement = NEW_PRICE if name == 'index.html' else NEW_SUPPORT
        if current.decode().count(replacement) != 1:
            raise ValueError('Current-main pricing must first contain the reviewed same change')
    image = f'registry.fly.io/{APP}@{args.expected_image_digest}'
    dockerfile = overlay_dockerfile(image, head)
    plan = {'websiteSource': head, 'backendRevision': args.expected_backend_revision,
            'backendVersion': health.get('serviceVersion'), 'baseImage': image,
            'machine': args.machine_id, 'configSha256': config_digest(before),
            'pages': {k: digest(v) for k, v in pages.items()},
            'dockerfileSha256': digest(dockerfile.encode()), 'runtimeChanged': False}
    evidence.mkdir(parents=True, mode=0o700)
    (evidence / 'plan.json').write_text(json.dumps(plan, indent=2))
    print(json.dumps(plan, indent=2), flush=True)
    if not args.confirm_production:
        return 0
    checked(['npm', 'run', 'check'], cwd=root, timeout=180)
    tag = f'website-{head[:12]}-{int(time.time())}'
    with tempfile.TemporaryDirectory(prefix='tubeboard-static-build-') as temp:
        context = Path(temp)
        for name, content in pages.items(): (context / name).write_bytes(content)
        (context / 'Dockerfile').write_text(dockerfile)
        (context / 'fly.toml').write_text(f'app = "{APP}"\n')
        build = subprocess.run(['flyctl', 'deploy', str(context), '--app', APP,
            '--config', str(context / 'fly.toml'), '--dockerfile', str(context / 'Dockerfile'),
            '--build-only', '--push', '--remote-only', '--image-label', tag],
            capture_output=True, text=True, timeout=900)
        log = build.stdout + '\n' + build.stderr
        (evidence / 'image-build.log').write_text(log)
        if build.returncode: raise RuntimeError('Build failed; production unchanged. Inspect private build log.')
        matches = re.findall(re.escape(f'registry.fly.io/{APP}:{tag}') + r'@(sha256:[0-9a-f]{64})', log)
        if not matches:
            raise RuntimeError('Cannot establish immutable pushed digest; production unchanged.')
        new_image = f'registry.fly.io/{APP}@{matches[-1]}'
    latest = machine(args.machine_id)
    if latest['image_ref']['digest'] != args.expected_image_digest or config_digest(latest) != plan['configSha256']:
        raise ValueError('Production changed during build; do not update it')
    # Only the image flag is supplied. Existing environment, workers, secrets,
    # services, checks, size and encrypted volume must remain byte-equivalent.
    result = subprocess.run(['flyctl', 'machine', 'update', args.machine_id, '--app', APP,
                             '--image', new_image, '--yes'], capture_output=True, text=True, timeout=300)
    (evidence / 'machine-update.log').write_text(result.stdout + '\n' + result.stderr)
    if result.returncode:
        raise RuntimeError('Update outcome requires readback. Do not blindly repeat or overwrite it.')
    after = machine(args.machine_id)
    if config_digest(after) != plan['configSha256'] or after['image_ref']['digest'] != matches[-1]:
        raise RuntimeError('Unexpected configuration/image readback; inspect before any further mutation')
    current_health = json.loads(fetch('/healthz'))
    if current_health != health:
        raise RuntimeError('Backend health identity changed unexpectedly')
    for name, content in pages.items():
        live = fetch('/' if name == 'index.html' else '/support')
        if live != content: raise RuntimeError(f'Published {name} does not match the exact reviewed HTML')
    receipt = {**plan, 'image': new_image, 'available': True, 'health': current_health,
               'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'rollbackImage': image, 'configurationPreserved': True}
    (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt, indent=2))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
