#!/usr/bin/env bash
# Host command for the OpenClaw agent image: bind the run's Claude Code token
# profile, then become the gateway.
#
# OpenClaw forwards a subscription token to the `claude` child only from a
# stored auth profile, and it rejects a token reference written into
# openclaw.json. So when the simulator delivers a secrets plan
# (OPENCLAW_SECRETS_PLAN), this script applies it once against the fresh
# per-pod state before the gateway exists. The plan names an environment
# variable and never carries a value. A failed apply ends the host with the
# apply's exit status, so the run reports an agent start failure instead of a
# gateway that cannot authenticate. The gateway then replaces this shell, so
# it receives the entrypoint's signals and reports its own exit status with
# no relay in between. Without a plan this is the gateway command alone.
# OPENCLAW_ENTRY stands in for OpenClaw in the tests.
set -euo pipefail

readonly ENTRY="${OPENCLAW_ENTRY:-/app/openclaw.mjs}"

if [[ -n "${OPENCLAW_SECRETS_PLAN:-}" ]]; then
  status=0
  node "${ENTRY}" secrets apply --from "${OPENCLAW_SECRETS_PLAN}" || status=$?
  if ((status != 0)); then
    echo "[moltzap openclaw host] secrets apply exited ${status}; not starting the gateway" >&2
    exit "${status}"
  fi
fi

exec node "${ENTRY}" gateway run --allow-unconfigured --port 18789
