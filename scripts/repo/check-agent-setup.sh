#!/usr/bin/env bash
# check-agent-setup.sh — verify the environment an agent needs before it can
# honestly claim a change is reviewed.
#
# Two people working this repo should get the same behavior. The failures this
# guards against are the silent ones: `/review` degrades to a single model when
# codex is absent and still records a clean Eng Review entry, so a missing tool
# lowers the merge bar without anyone seeing it happen.
#
# Loud failures need no entry here. A missing pnpm errors on first use; that is
# self-reporting and costs nothing to discover.
#
# Run once per session, not per command — a per-command check is how the old
# 165s pre-commit happened.
#
# Exits 0 when every required item is present, 1 otherwise. Advisory items
# print a note and never change the exit code.
#
# Two probes are deliberately absent. /simplify ships with the harness and has
# no SKILL.md on disk, so testing for one would report a permanent false
# absence. codex quota is not probed either: a rate-limited codex fails exactly
# like a missing one, quietly, but detecting it costs a request per session.
#
# gbrain carries the decision-evidence corpus, so provenance verification
# resolves against it. An absent brain is not a degraded experience, it is an
# unanswerable question.
#
# Hook freshness is advisory. .husky/pre-commit is tracked, so every branch
# carries its own copy and a fix on main reaches nobody until they merge; this
# repo has had 70 worktrees on a stale 165s hook at once. A branch may differ
# on purpose.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'; YEL=$'\033[0;33m'; GRN=$'\033[0;32m'; NC=$'\033[0m'
MISSING=0

ok()   { printf "  ${GRN}ok${NC}    %-26s %s\n" "$1" "${2:-}"; }
gone() { printf "  ${RED}MISS${NC}  %-26s %s\n" "$1" "$2"; MISSING=$((MISSING + 1)); }
note() { printf "  ${YEL}note${NC}  %-26s %s\n" "$1" "$2"; }

echo "Agent setup — $REPO_ROOT"
echo ""

# ── toolchain ───────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  # engines: >=22.19.0 <25
  if [ "$node_major" -ge 22 ] && [ "$node_major" -lt 25 ]; then
    ok "node" "$(node -v)"
  else
    gone "node" "$(node -v) is outside the engines range >=22.19.0 <25"
  fi
else
  gone "node" "not on PATH"
fi

command -v pnpm >/dev/null 2>&1 && ok "pnpm" "$(pnpm --version)" || gone "pnpm" "not on PATH — see packageManager in package.json"

# ── review path ─────────────────────────────────────────────────────────────
for skill in plan-eng-review review ship land-and-deploy codex; do
  if [ -f "$HOME/.claude/skills/$skill/SKILL.md" ]; then
    ok "/$skill" ""
  else
    gone "/$skill" "expected ~/.claude/skills/$skill/SKILL.md — install or update gstack"
  fi
done

if command -v codex >/dev/null 2>&1; then
  ok "codex" "$(codex --version 2>/dev/null | head -1)"
  note "codex quota" "not probed — a rate-limited codex degrades review silently"
else
  gone "codex" "not on PATH — /review falls back to a single model"
fi

if command -v gbrain >/dev/null 2>&1; then
  if gbrain doctor --json >/dev/null 2>&1; then
    ok "gbrain" "$(gbrain --version 2>/dev/null | head -1)"
  else
    gone "gbrain" "installed but not reachable — run 'gbrain doctor' for the engine error"
  fi
else
  gone "gbrain" "not on PATH — run /setup-gbrain; provenance lookups resolve against it"
fi

# ── hook freshness ──────────────────────────────────────────────────────────
if git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  local_hook=$(git hash-object .husky/pre-commit 2>/dev/null || echo none)
  main_hook=$(git rev-parse "origin/main:.husky/pre-commit" 2>/dev/null || echo none)
  if [ "$local_hook" = "$main_hook" ]; then
    ok "hooks" "match origin/main"
  else
    note "hooks" ".husky/pre-commit differs from origin/main — stale hooks run the slow path"
  fi
else
  note "hooks" "no origin/main ref to compare against"
fi

echo ""
if [ "$MISSING" -gt 0 ]; then
  printf "%s%s required item(s) missing.%s Fix these before claiming a change is reviewed.\n" \
    "$RED" "$MISSING" "$NC"
  exit 1
fi
printf "%sSetup complete.%s\n" "$GRN" "$NC"
