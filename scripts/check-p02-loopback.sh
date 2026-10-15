#!/bin/sh
# Refuses a P02 build that would enable the test-only loopback allowance, the
# `e2e-loopback` feature of p02-fetch. `--all-features` turns every feature on,
# so no P02 command may use it, and no P02 crate may default the feature on.
# Prints its counters on success; an empty inspection is a failure, never a pass.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FEATURE="e2e-loopback"
SELF="scripts/check-p02-loopback.sh"

metadata="$(cargo metadata --format-version 1 --no-deps)"
packages="$(printf '%s' "$metadata" | jq '[.packages[] | select(.name | startswith("p02-"))] | length')"
if [ "$packages" -eq 0 ]; then
  echo "p02 loopback guard: no p02-* package found in cargo metadata" >&2
  exit 1
fi

defaulted="$(printf '%s' "$metadata" |
  jq -r --arg f "$FEATURE" \
    '.packages[] | select(.name | startswith("p02-")) | select((.features.default // []) | any(contains($f))) | .name')"

files="$(git ls-files -- '.github/workflows/*.yml' 'scripts/*' 'crates/p02-*' 'apps/p02-api/*' |
  grep -v "^$SELF\$" || true)"
scanned="$(printf '%s\n' "$files" | grep -c . || true)"
if [ "$scanned" -eq 0 ]; then
  echo "p02 loopback guard: no tracked P02 file to scan" >&2
  exit 1
fi

hits="$(printf '%s\n' "$files" | xargs grep -ln -e 'all-features' || true)"

status=0
if [ -n "$defaulted" ]; then
  echo "p02 loopback guard: default feature enables $FEATURE in: $defaulted" >&2
  status=1
fi
if [ -n "$hits" ]; then
  echo "p02 loopback guard: --all-features (or its spelling) in P02 paths: $hits" >&2
  status=1
fi

echo "p02 loopback guard: $packages p02-* package(s) inspected, $scanned tracked file(s) scanned, $(printf '%s' "$defaulted" | grep -c . || true) defaulting the feature, $(printf '%s' "$hits" | grep -c . || true) all-features occurrence(s)"
exit "$status"
