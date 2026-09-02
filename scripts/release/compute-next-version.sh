#!/usr/bin/env bash
# Print the next calendar version for one release of every named package.
#
# Usage: compute-next-version.sh <package-dir>...
# Output: YYYY.MDD.N — today's UTC date (month without a leading zero) and the
# smallest build counter that none of the named packages has published yet. The
# release writes that one string into every manifest, so the counter is taken
# over the union of the packages' npm histories rather than any single one.
#
# `npm view` fails for a package that has never been published; that package
# contributes nothing to the union instead of aborting the release.
set -euo pipefail

[ "$#" -ge 1 ] || { echo "usage: $0 <package-dir>..." >&2; exit 2; }

YEAR=$(date -u +%Y)
MDD=$(date -u +%-m%d)
PREFIX="${YEAR}.${MDD}."

PUBLISHED="[]"
for PKG in "$@"; do
  PKG_JSON="packages/${PKG}/package.json"
  if [ -f "$PKG_JSON" ]; then
    NPM_PACKAGE=$(node -p "require('./${PKG_JSON}').name")
  else
    NPM_PACKAGE="@moltzap/${PKG}"
  fi

  set +e
  VERSIONS=$(npm view "$NPM_PACKAGE" versions --json 2>/dev/null)
  NPM_EXIT=$?
  set -e
  if [ "$NPM_EXIT" -ne 0 ]; then
    VERSIONS="[]"
  fi

  # A package with exactly one published version comes back as a bare string.
  PUBLISHED=$(node -e '
    const [union, next] = process.argv.slice(1).map((text) => JSON.parse(text));
    console.log(JSON.stringify([...union, ...(Array.isArray(next) ? next : [next])]));
  ' "$PUBLISHED" "$VERSIONS")
done

MAX_N=$(node -e '
  const [prefix, published] = process.argv.slice(1);
  const counters = JSON.parse(published)
    .filter((version) => version.startsWith(prefix))
    .map((version) => Number.parseInt(version.slice(prefix.length), 10))
    .filter((counter) => Number.isInteger(counter));
  console.log(counters.length === 0 ? -1 : Math.max(...counters));
' "$PREFIX" "$PUBLISHED")

echo "${PREFIX}$((MAX_N + 1))"
