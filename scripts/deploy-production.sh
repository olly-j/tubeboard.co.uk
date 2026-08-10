#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" != "--confirm-production" ]]; then
  echo "Production deployment requires --confirm-production and explicit owner authorization." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

flyctl_bin="${FLYCTL_BIN:-}"
if [[ -z "$flyctl_bin" ]]; then
  flyctl_bin="$(command -v flyctl || true)"
fi
if [[ -z "$flyctl_bin" ]]; then
  for candidate in /opt/homebrew/opt/flyctl/bin/flyctl /usr/local/opt/flyctl/bin/flyctl; do
    if [[ -x "$candidate" ]]; then
      flyctl_bin="$candidate"
      break
    fi
  done
fi
[[ -n "$flyctl_bin" && -x "$flyctl_bin" ]] || {
  echo "flyctl is required. Install it or set FLYCTL_BIN to its executable path." >&2
  exit 1
}

[[ "$(git branch --show-current)" == "main" ]] || {
  echo "Production deploys must run from main." >&2
  exit 1
}

[[ -z "$(git status --porcelain)" ]] || {
  echo "Production deploys require a clean worktree." >&2
  exit 1
}

git fetch origin main
local_revision="$(git rev-parse HEAD)"
remote_revision="$(git rev-parse origin/main)"
[[ "$local_revision" == "$remote_revision" ]] || {
  echo "Local main must exactly match origin/main." >&2
  exit 1
}

npm run check
"$flyctl_bin" config validate --config fly.toml
"$flyctl_bin" deploy --remote-only --build-arg "TUBEBOARD_GIT_SHA=$local_revision"

node --input-type=module -e '
  const expected = process.argv[1];
  const response = await fetch("https://tubeboard.co.uk/healthz", { cache: "no-store" });
  const health = await response.json();
  if (!response.ok || health.ok !== true || health.sourceRevision !== expected) {
    throw new Error(`Production health revision mismatch: ${JSON.stringify(health)}`);
  }
  console.log(JSON.stringify(health));
' "$local_revision"
