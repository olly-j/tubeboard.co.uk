#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

required=(
  AGENTS.md
  CONTRIBUTING.md
  .github/SECURITY.md
  .github/ISSUE_TEMPLATE/config.yml
  .github/pull_request_template.md
  .github/workflows/service-quality.yml
  contracts/live-activity-registration-v1.schema.json
  contracts/fixtures/live-activity-registration-v1.json
  contracts/disruption-alert-registration-v1.schema.json
  contracts/fixtures/disruption-alert-registration-v1.json
  contracts/disruption-alert-registration-v2.schema.json
  contracts/fixtures/disruption-alert-registration-v2.json
  contracts/tubeboard-status-v1.schema.json
  contracts/tubeboard-status-v2.schema.json
  certificates/AppleRootCA-G2.pem
  certificates/AppleRootCA-G3.pem
  docs/live-activity-service.md
  scripts/deploy-production.sh
  server/version.js
  server/status-monitor.js
  .well-known/apple-app-site-association
  train-v1.html
  train-20260830-v2.css
  train-20260830-v2.js
)

for path in "${required[@]}"; do
  [[ -f "$path" ]] || {
    echo "Missing required project file: $path" >&2
    exit 1
  }
done

python3 -m json.tool contracts/live-activity-registration-v1.schema.json >/dev/null
python3 -m json.tool contracts/fixtures/live-activity-registration-v1.json >/dev/null
python3 -m json.tool contracts/disruption-alert-registration-v1.schema.json >/dev/null
python3 -m json.tool contracts/fixtures/disruption-alert-registration-v1.json >/dev/null
python3 -m json.tool contracts/disruption-alert-registration-v2.schema.json >/dev/null
python3 -m json.tool contracts/fixtures/disruption-alert-registration-v2.json >/dev/null
python3 -m json.tool contracts/tubeboard-status-v1.schema.json >/dev/null
python3 -m json.tool contracts/tubeboard-status-v2.schema.json >/dev/null
python3 -m json.tool .well-known/apple-app-site-association >/dev/null
openssl x509 -in certificates/AppleRootCA-G2.pem -noout -subject -fingerprint -sha256 >/dev/null
openssl x509 -in certificates/AppleRootCA-G3.pem -noout -subject -fingerprint -sha256 >/dev/null
python3 -c 'import pathlib, tomllib; tomllib.loads(pathlib.Path("fly.toml").read_text())'

if grep -Rqs -- 'flyctl deploy' .github/workflows; then
  echo "Production deployment must not run in GitHub Actions." >&2
  exit 1
fi

if git ls-files | grep -Eq '(^|/)(\.env|live-activities\.json|disruption-alerts\.json)$|\.p8$|\.key$'; then
  echo "Sensitive service material is tracked by Git." >&2
  exit 1
fi

if git grep -I -l -E -- '-----BEGIN (EC |RSA )?PRIVATE KEY-----' >/dev/null; then
  echo "A private key block is tracked by Git." >&2
  exit 1
fi

echo "Repository checks passed."
