#!/usr/bin/env bash
# Consolidated guard script: type safety, mock imports, test integrity, and
# Effect-migration hygiene. Exits 1 on ANY violation.
#
# Pragma opt-out (mypy-style, rule-scoped). Two forms:
#   1. Same-line:  `// #ignore-sloppy-code[<rule>...]: <reason>` on the line
#      carrying the violation.
#   2. Next-line:  `// #ignore-sloppy-code-next-line[<rule>...]: <reason>` on
#      the line immediately BEFORE the violation. Useful when the violating
#      token sits on a multi-line signature where no end-of-line comment fits.
#
# Reason is required — a pragma without a non-empty reason does not suppress
# the check.
#
#   // #ignore-sloppy-code[promise-type]: Channel interface contract
#   // #ignore-sloppy-code[promise-type, async-keyword]: plugin edge bridge
#   // #ignore-sloppy-code-next-line[then-chain]: external SDK only exposes Promises
#
# The rule name must match the check's ID (shown in square brackets when a
# violation is reported). Unknown rule names in the pragma are silently
# ignored — typos won't fail-safe, they'll fail open (the check still fires).
#
# Long-term note: this script is getting unwieldy; consider porting to a
# TypeScript tool (ts-morph or just the TS compiler API) once the rule set
# stabilizes. For now bash keeps the zero-install story.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
ERRORS=0

PKG_SRC_GLOB="packages/*/src"
NON_TEST_EXCLUDE='__tests__|\.test\.|\.integration\.test\.|test-utils|/dist/'
PRAGMA_TAG='#ignore-sloppy-code'

# Filter lines of the form `path:N:content` through the pragma rules.
# Suppresses a match when either:
#   - `content` carries `<tag>[<rule>, ...]: <reason>` (same-line pragma), or
#   - the file's line N-1 carries `<tag>-next-line[<rule>, ...]: <reason>`
#     (next-line pragma, for multi-line signatures).
# Invocation: `... | filter_pragma <rule>`.
filter_pragma() {
  local rule="$1"
  awk -v rule="$rule" -v tag="$PRAGMA_TAG" '
    function has_pragma(text, suffix,    pat, frag, b, e, rules, n, arr, i) {
      pat = tag suffix "\\[[^]]*\\]:[ \t]*[^ \t]"
      if (match(text, pat)) {
        frag = substr(text, RSTART, RLENGTH)
        b = index(frag, "[")
        e = index(frag, "]")
        if (b && e && e > b) {
          rules = substr(frag, b + 1, e - b - 1)
          gsub(/[ \t]/, "", rules)
          n = split(rules, arr, ",")
          for (i = 1; i <= n; i++) {
            if (arr[i] == rule) return 1
          }
        }
      }
      return 0
    }
    {
      # Parse `path:lineno:content` from grep -n.
      ci = index($0, ":")
      if (ci == 0) { print; next }
      path = substr($0, 1, ci - 1)
      rest = substr($0, ci + 1)
      ci = index(rest, ":")
      if (ci == 0) { print; next }
      lineno = substr(rest, 1, ci - 1) + 0
      content = substr(rest, ci + 1)

      if (has_pragma(content, "")) next

      # Check the preceding line for a `-next-line` pragma. Read via sed so
      # we do not buffer whole files; scale fits fine (one spawn per match).
      if (path != "" && lineno > 1) {
        cmd = "sed -n " (lineno - 1) "p \"" path "\" 2>/dev/null"
        prev = ""
        if ((cmd | getline prev) > 0) {
          close(cmd)
          if (has_pragma(prev, "-next-line")) next
        } else {
          close(cmd)
        }
      }
      print
    }
  '
}

# check RULE_ID PATTERN MESSAGE [GLOB] [DIR]
check() {
  local rule="$1"
  local pattern="$2"
  local message="$3"
  local glob="${4:-*.ts}"
  local dir="${5:-$PKG_SRC_GLOB}"

  # shellcheck disable=SC2086
  matches=$(grep -rn --include="$glob" -E "$pattern" $dir 2>/dev/null \
    | grep -vE "$NON_TEST_EXCLUDE" \
    | filter_pragma "$rule" \
    || true)

  # filter_pragma emits empty lines when a match is suppressed; clean them.
  matches=$(echo "$matches" | grep -v '^$' || true)

  if [ -n "$matches" ]; then
    echo -e "${RED}[FAIL]${NC} [$rule] $message"
    echo "$matches"
    echo "    Opt out with: // $PRAGMA_TAG[$rule]: <reason>"
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
}

# ============================================================
# Type Safety
# ============================================================
echo "=== Type Safety Guardrails ==="
echo ""

check raw-sql \
  '[^.]*[^q]\.query\(|db\.query\(' \
  "Raw SQL detected — use Kysely query builder instead of .query()"

check params-cast \
  '[pP]arams as \{' \
  "Unsafe params cast — handler params should type-derive from the RpcDefinition manifest"

check dbpool \
  'DbPool' \
  "Legacy DbPool reference — use Db (Kysely<Database>) instead"

check rowcount \
  '\.rowCount' \
  "pg-style .rowCount access — use Kysely typed queries"

check record-cast \
  'as Record<string, unknown>' \
  "Unsafe Record<string, unknown> cast — use Kysely typed results"

check enum-cast \
  'as "[a-z_]+" \| "[a-z_]+"' \
  "Manual enum cast — use generated types from database.ts"

check legacy-define-method \
  'defineMethod<[^>]+>\(\{' \
  "Legacy defineMethod<T>({...}) — migrate to defineMethod(Manifest, { handler })"

# ============================================================
# Effect Hygiene
# ============================================================
echo "=== Effect Hygiene ==="
echo ""

check promise-type \
  ': Promise<' \
  "Promise<> return type in non-test source — prefer Effect"

check async-keyword \
  '(^|[^A-Za-z_])async( |\()' \
  "async keyword in non-test source — prefer Effect.gen / Effect handlers"

check effect-promise \
  'Effect\.promise\(' \
  "Effect.promise( swallows rejections as defects — use Effect.tryPromise({ try, catch })"

check then-chain \
  '\.then\(' \
  "Promise .then() chain in non-test source — compose with Effect.flatMap / Effect.map"

# ============================================================
# Bare Catch Guards
# ============================================================
echo "=== Bare Catch Guards ==="
echo ""

check bare-catch \
  '} catch (\{|\(_[A-Za-z0-9_]*\) \{)' \
  "Silently swallowed error — always bind and log it (logger.warn({ err }, '...') at minimum)"

# ============================================================
# RLS (Supabase migrations, only runs if directory exists)
# ============================================================
if [ -d "supabase/migrations" ]; then
  for migration in supabase/migrations/*.sql; do
    [ -f "$migration" ] || continue
    while IFS= read -r table; do
      [ -z "$table" ] && continue
      if ! grep -rq "$table.*ENABLE ROW LEVEL SECURITY" supabase/migrations/ 2>/dev/null; then
        echo -e "${RED}[FAIL]${NC} [rls] Table $table (in $(basename "$migration")) missing ENABLE ROW LEVEL SECURITY"
        ERRORS=$((ERRORS + 1))
      fi
    done < <(sed -n 's/.*CREATE TABLE \(IF NOT EXISTS \)\{0,1\}\([^ (]*\).*/\2/p' "$migration" 2>/dev/null)
  done
fi

# ============================================================
# Test Integrity
# ============================================================
echo ""
echo "=== Test Integrity Guards ==="
echo ""

check integration-vi-mock \
  'vi\.mock|vi\.hoisted|vi\.spyOn' \
  "Integration tests must not use vi.mock/hoisted/spyOn — test the real flow" \
  "*.integration.test.ts" \
  "packages/"

check evals-mock-model \
  'echo-server|echo-1|mock.*model|ECHO:' \
  "Eval source must not reference echo/mock models — evals use real LLMs" \
  "*.ts" \
  "packages/evals/src/"

check hardcoded-api-key \
  "api[Kk]ey.*=.*['\"][a-zA-Z0-9_-]{20,}['\"]" \
  "Hardcoded API key in test file — use environment variables" \
  "*.test.ts" \
  "packages/"

# ============================================================
# Summary
# ============================================================
echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}Found $ERRORS guard violation(s).${NC}"
  exit 1
else
  echo -e "${GREEN}All guards passed.${NC}"
fi
