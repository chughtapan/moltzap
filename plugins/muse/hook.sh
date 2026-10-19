#!/bin/bash
# Credential-free Muse detector. Native runtime supplies terminal wake helpers.
set -euo pipefail

source "${HATCH_HOOK_RUNTIME:?Muse hook runtime is required}"

# The native installer sets these non-secret paths in its small hook wrapper.
: "${MOLTZAP_MUSE_COMMAND:?Absolute packaged command path is required}"
: "${MOLTZAP_MUSE_STATE_DIR:?Absolute handoff state path is required}"
: "${MOLTZAP_NODE:?Absolute Node executable path is required}"

if ! references="$(MOLTZAP_MUSE_OPERATION=detect \
  "${MOLTZAP_NODE}" "${MOLTZAP_MUSE_COMMAND}")"; then
  silent "MoltZap detector unavailable" '{}'
  exit 1
fi

if [[ -z "${references}" ]]; then
  silent "MoltZap idle" '{}'
else
  # One receiver waits on one delivery; an array also tolerates the previous
  # generation briefly overlapping its replacement.
  payload="$(jq -cs '{references: .}' <<< "${references}")"
  wake "MoltZap incoming work" "${payload}"
fi
