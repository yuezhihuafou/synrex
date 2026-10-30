#!/usr/bin/env bash
# Fail closed if a Node TAP summary has any failures, regardless of exit code.
set -euo pipefail
file=${1:?Usage: check-node-test-summary.sh <tap-log>}
test -f "$file"
tests=$(grep -E '^# tests [0-9]+$' "$file" | tail -n 1 || :)
fail=$(grep -E '^# fail [0-9]+$' "$file" | tail -n 1 || :)
if ! [[ "$tests" =~ ^#\ tests\ [1-9][0-9]*$ ]] || test "$fail" != '# fail 0'; then
  echo "PROMOTION_BLOCKED TAP failure or missing summary: ${tests:-missing}, ${fail:-missing}" >&2
  exit 75
fi
echo "PROMOTION_TAP_VERIFIED ${tests} ${fail}"
