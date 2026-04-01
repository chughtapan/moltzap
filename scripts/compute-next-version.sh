#!/usr/bin/env bash
# Compute the next date-based version for a @moltzap package.
# Usage: compute-next-version.sh <package-name>
# Output: YYYY.MDD.N (e.g., 2026.318.0 for March 18, build 0)
# Exit 1 on error (e.g., npm unreachable)
set -euo pipefail

PKG="$1"
YEAR=$(date -u +%Y)
# MDD = month (no leading zero) * 100 + day (e.g., March 18 = 318, December 1 = 1201)
MDD=$(date -u +%-m%d)
PREFIX="${YEAR}.${MDD}."

# Query npm for all published versions
# On 404 (deleted/new packages), npm exits non-zero — fall back to empty array
set +e
VERSIONS=$(npm view "@moltzap/${PKG}" versions --json 2>/dev/null)
NPM_EXIT=$?
set -e
if [ "$NPM_EXIT" -ne 0 ]; then
  VERSIONS="[]"
fi

# Filter for today's versions and find the max build counter
MAX_N=$(echo "$VERSIONS" | node -e "
  const versions = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  const arr = Array.isArray(versions) ? versions : [versions];
  const prefix = '${PREFIX}';
  const todayVersions = arr.filter(v => v.startsWith(prefix));
  if (todayVersions.length === 0) { console.log(-1); process.exit(0); }
  const maxN = Math.max(...todayVersions.map(v => parseInt(v.slice(prefix.length), 10)));
  console.log(maxN);
")

NEXT_N=$((MAX_N + 1))
echo "${PREFIX}${NEXT_N}"
