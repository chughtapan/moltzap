#!/usr/bin/env bash
# Consolidated guard script: type safety, mock imports, and test integrity.
# Run in CI or as a pre-commit check. Exits 1 on ANY violation.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
ERRORS=0

SERVER_SRC="packages/server/src"
EXCLUDE_PATTERN="__tests__|\.test\.|test-utils/db\.ts"

check() {
  local pattern="$1"
  local message="$2"
  local glob="${3:-*.ts}"
  local dir="${4:-$SERVER_SRC}"

  matches=$(grep -rn --include="$glob" -E "$pattern" "$dir" \
    | grep -vE "$EXCLUDE_PATTERN" || true)

  if [ -n "$matches" ]; then
    echo -e "${RED}[FAIL]${NC} $message"
    echo "$matches"
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
}

# ============================================================
# Section 1: Type Safety (8 checks from check-type-safety.sh)
# ============================================================
echo "=== Type Safety Guardrails ==="
echo ""

# 1. Raw SQL queries (should use Kysely query builder)
check '[^.]*[^q]\.query\(|db\.query\(' \
  "Raw SQL detected — use Kysely query builder instead of .query()"

# 2. Unsafe params casts in handlers (should use defineMethod<T>)
check '[pP]arams as \{' \
  "Unsafe params cast — use defineMethod<T>() with explicit type parameter"

# 3. DbPool references (should use Db/Kysely)
check 'DbPool' \
  "Legacy DbPool reference — use Db (Kysely<Database>) instead"

# 4. Untyped pg result access
check '\.rowCount' \
  "pg-style .rowCount access — use Kysely typed queries"

# 5. Record<string, unknown> casts on DB rows
check 'as Record<string, unknown>' \
  "Unsafe Record<string, unknown> cast — use Kysely typed results"

# 6. defineMethod without explicit type parameter
check 'defineMethod\(\{' \
  "defineMethod without type parameter — use defineMethod<ParamsType>({...})"

# 7. Manual enum casts
check 'as "[a-z_]+" \| "[a-z_]+"' \
  "Manual enum cast — use generated types from database.ts"

# ============================================================
# Section 4: Bare Catch Guards
# ============================================================
echo ""
echo "=== Bare Catch Guards ==="
echo ""

check '} catch \{' \
  "Bare catch block — use 'catch (err)' and handle the error"
check '} catch \{' \
  "Bare catch block — use 'catch (err)' and handle the error" \
  "*.tsx" "packages/web/src"
check '} catch \{' \
  "Bare catch block — use 'catch (err)' and handle the error" \
  "*.ts" "packages/web/src"

# 9. Missing RLS — every CREATE TABLE must have RLS enabled
for migration in supabase/migrations/*.sql; do
  while IFS= read -r table; do
    [ -z "$table" ] && continue
    if ! grep -rq "$table.*ENABLE ROW LEVEL SECURITY" supabase/migrations/ 2>/dev/null; then
      echo -e "${RED}[FAIL]${NC} Table $table (in $(basename "$migration")) missing ENABLE ROW LEVEL SECURITY"
      ERRORS=$((ERRORS + 1))
    fi
  done < <(sed -n 's/.*CREATE TABLE \(IF NOT EXISTS \)\{0,1\}\([^ (]*\).*/\2/p' "$migration" 2>/dev/null)
done

# ============================================================
# Section 2: Mock Imports (from CI mock-import-guard)
# ============================================================
echo ""
echo "=== Mock Import Guards ==="
echo ""

mock_matches=$(grep -r "from.*mock-data" packages/web/src/app/app/ 2>/dev/null | grep -v "app-provider" || true)
if [ -n "$mock_matches" ]; then
  echo -e "${RED}[FAIL]${NC} App screens must not import from mock-data directly. Use useMoltZap() hook."
  echo "$mock_matches"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

# ============================================================
# Section 3: Test Integrity (new guards)
# ============================================================
echo ""
echo "=== Test Integrity Guards ==="
echo ""

# 1. No vi.mock/vi.hoisted/vi.spyOn in integration test files
vi_mock_matches=$(grep -rn "vi\.mock\|vi\.hoisted\|vi\.spyOn" --include="*.integration.test.ts" packages/ 2>/dev/null || true)
if [ -n "$vi_mock_matches" ]; then
  echo -e "${RED}[FAIL]${NC} Integration tests must not use vi.mock(), vi.hoisted(), or vi.spyOn() — test the real flow"
  echo "$vi_mock_matches"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

# 2. No echo/mock references in eval source (evals must use real models)
echo_in_evals=$(grep -rn "echo-server\|echo-1\|mock.*model\|ECHO:" packages/evals/src/ --include="*.ts" 2>/dev/null || true)
if [ -n "$echo_in_evals" ]; then
  echo -e "${RED}[FAIL]${NC} Eval source must not reference echo/mock models — evals use real LLMs"
  echo "$echo_in_evals"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

# 3. No hardcoded API key values in test files
hardcoded_keys=$(grep -rn "api[Kk]ey.*=.*['\"][a-zA-Z0-9_-]\{20,\}['\"]" --include="*.test.ts" --include="*.integration.test.ts" packages/ 2>/dev/null \
  | grep -vE '"test"|"fake"|"dummy"|"placeholder"' || true)
if [ -n "$hardcoded_keys" ]; then
  echo -e "${RED}[FAIL]${NC} Hardcoded API key values in test files — use environment variables"
  echo "$hardcoded_keys"
  echo ""
  ERRORS=$((ERRORS + 1))
fi

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
