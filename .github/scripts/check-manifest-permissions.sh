#!/usr/bin/env bash
# Fails if manifest.json requests permissions/host_permissions beyond the
# allow-list in .github/security/manifest-baseline.json.
set -euo pipefail

MANIFEST="manifest.json"
BASELINE=".github/security/manifest-baseline.json"
fail=0

for field in permissions host_permissions; do
  new=$(jq -r ".${field}[]? // empty" "$MANIFEST" | tr -d '\r' | sort -u)
  allowed=$(jq -r ".${field}[]? // empty" "$BASELINE" | tr -d '\r' | sort -u)

  extra=$(comm -23 <(echo "$new") <(echo "$allowed"))

  if [ -n "$extra" ]; then
    echo "::error::manifest.json requests '$field' not in $BASELINE:"
    echo "$extra" | sed 's/^/  - /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "If this addition is intentional, update $BASELINE in the same PR."
  exit 1
fi

echo "Manifest permissions OK — no new permissions beyond baseline."
