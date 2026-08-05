#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $test_name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $test_name — expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

YEAR=$(date -u +%Y)
MDD=$(date -u +%-m%d)
TODAY="${YEAR}.${MDD}"

# Create a fake npm script that reads a response from NPM_MOCK_RESPONSE env var
MOCK_DIR=$(mktemp -d)
cat > "$MOCK_DIR/npm" <<'MOCK'
#!/usr/bin/env bash
echo "$NPM_MOCK_RESPONSE"
exit ${NPM_MOCK_EXIT:-0}
MOCK
chmod +x "$MOCK_DIR/npm"
# Prepend to PATH so our mock npm is found first
export PATH="$MOCK_DIR:$PATH"

cleanup() { rm -rf "$MOCK_DIR"; }
trap cleanup EXIT

# Test 1: No existing versions (fresh package)
echo "--- Test 1: No existing versions ---"
export NPM_MOCK_RESPONSE='[]'
RESULT=$("$SCRIPT_DIR/compute-next-version.sh" protocol)
assert_eq "no existing versions" "${TODAY}.0" "$RESULT"

# Test 2: One existing version today
echo "--- Test 2: One existing version today ---"
export NPM_MOCK_RESPONSE="[\"${TODAY}.0\"]"
RESULT=$("$SCRIPT_DIR/compute-next-version.sh" protocol)
assert_eq "one existing version" "${TODAY}.1" "$RESULT"

# Test 3: Multiple versions today
echo "--- Test 3: Multiple versions today ---"
export NPM_MOCK_RESPONSE="[\"${TODAY}.0\", \"${TODAY}.1\", \"${TODAY}.2\"]"
RESULT=$("$SCRIPT_DIR/compute-next-version.sh" protocol)
assert_eq "multiple versions" "${TODAY}.3" "$RESULT"

# Test 4: Mixed versions (old dates + today)
echo "--- Test 4: Mixed old and today versions ---"
export NPM_MOCK_RESPONSE="[\"2026.101.0\", \"2026.101.1\", \"${TODAY}.0\"]"
RESULT=$("$SCRIPT_DIR/compute-next-version.sh" protocol)
assert_eq "mixed versions" "${TODAY}.1" "$RESULT"

# Test 5: npm returns single string (only one version ever published)
echo "--- Test 5: npm returns single string ---"
export NPM_MOCK_RESPONSE="\"${TODAY}.0\""
RESULT=$("$SCRIPT_DIR/compute-next-version.sh" protocol)
assert_eq "single string response" "${TODAY}.1" "$RESULT"

# Test 6: Only old versions, none today
echo "--- Test 6: Only old versions ---"
export NPM_MOCK_RESPONSE='["2026.101.0", "2026.102.0"]'
RESULT=$("$SCRIPT_DIR/compute-next-version.sh" protocol)
assert_eq "only old versions" "${TODAY}.0" "$RESULT"

# Test 7: npm returns 404 (deleted package)
echo "--- Test 7: npm 404 (deleted package) ---"
export NPM_MOCK_RESPONSE='{"error":{"code":"E404"}}'
export NPM_MOCK_EXIT=1
RESULT=$("$SCRIPT_DIR/compute-next-version.sh" protocol)
assert_eq "npm 404" "${TODAY}.0" "$RESULT"
unset NPM_MOCK_EXIT

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
