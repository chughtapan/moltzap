#!/usr/bin/env bash
# Answer whether NAME@VERSION is on the npm registry, telling absence apart
# from a registry that could not answer.
#
# Usage: npm-version-exists.sh <name>@<version>
# Exit 0: published. Exit 1: npm answered 404 for the name or the version.
# Exit 2: any other failure, reported on stderr. The release treats only a 404
# as "absent": a timeout read as absent would either publish over an existing
# version or resume a release that needs no resuming.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 <name>@<version>" >&2; exit 2; }

if OUTPUT=$(npm view "$1" version --json 2>/dev/null) && [ -n "$OUTPUT" ]; then
  exit 0
fi
if node -e 'process.exit(JSON.parse(process.argv[1])?.error?.code === "E404" ? 0 : 1)' "${OUTPUT:-}" 2>/dev/null; then
  exit 1
fi
echo "npm view $1 failed without a 404: ${OUTPUT:-no output}" >&2
exit 2
