#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# Non-login invocations may not export the user systemd bus variables.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

node_cmd=$(command -v node || true)
package_manager=$(cd "$repo_root" && "$node_cmd" -p "require('./package.json').packageManager || ''" 2>/dev/null || true)
pnpm_version=${package_manager#pnpm@}
corepack_home=${COREPACK_HOME:-"$HOME/.cache/node/corepack"}
cached_pnpm="$corepack_home/v1/pnpm/$pnpm_version/bin/pnpm.cjs"

if [[ -n "$node_cmd" && "$package_manager" == pnpm@* && -f "$cached_pnpm" ]]; then
  pnpm_cmd=("$node_cmd" "$cached_pnpm")
elif command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  corepack enable
  pnpm_cmd=(pnpm)
else
  echo "pnpm or corepack is required" >&2
  exit 1
fi

unit=devspace.service
unit_path=$(systemctl --user show "$unit" -p FragmentPath --value 2>/dev/null || true)
if [[ -z "$unit_path" || ! -f "$unit_path" ]]; then
  echo "$unit is not installed; run: bash deploy/install-user-service.sh" >&2
  exit 1
fi

expected_entry="$repo_root/dist/cli.js"
configured_exec=$(systemctl --user show "$unit" -p ExecStart --value)
if [[ "$configured_exec" != *"$expected_entry"* ]]; then
  echo "$unit is not configured for this checkout: $repo_root" >&2
  echo "run: bash deploy/install-user-service.sh" >&2
  exit 1
fi

old_pid=$(systemctl --user show "$unit" -p MainPID --value 2>/dev/null || true)

"${pnpm_cmd[@]}" --dir "$repo_root" build

# The compiled server must contain the project-intelligence registration before
# the service is restarted. This catches the exact stale-schema failure that
# prompted this deployment path.
test -s "$repo_root/dist/cli.js"
test -s "$repo_root/dist/server.js"
test -s "$repo_root/dist/project-intelligence-tools.js"
grep -q "registerProjectIntelligenceTools" "$repo_root/dist/server.js"

# Do not interrupt an active local subagent turn during deployment. A forced
# deploy is still available for recovery when the operator explicitly accepts
# that risk.
if [[ "${DEVSPACE_DEPLOY_FORCE:-0}" != "1" ]]; then
  agent_status=$("$repo_root/bin/devspace.js" agents daemon status --json 2>/dev/null || true)
  if [[ -n "$agent_status" ]]; then
    active_turns=$(printf '%s' "$agent_status" | python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
    print(int(value.get("activeTurns", 0)))
except Exception:
    print(0)
')
    if (( active_turns > 0 )); then
      echo "Refusing to restart DevSpace while $active_turns local agent turn(s) are active." >&2
      echo "Retry after they finish, or set DEVSPACE_DEPLOY_FORCE=1 for recovery." >&2
      exit 2
    fi
  fi
fi

systemctl --user restart "$unit"

new_pid=""
for _ in {1..50}; do
  if systemctl --user is-active --quiet "$unit"; then
    new_pid=$(systemctl --user show "$unit" -p MainPID --value)
    if [[ -n "$new_pid" && "$new_pid" != "0" && "$new_pid" != "$old_pid" ]]; then
      break
    fi
  fi
  sleep 0.1
done

if [[ -z "$new_pid" || "$new_pid" == "0" || "$new_pid" == "$old_pid" ]]; then
  echo "DevSpace did not restart onto a new process." >&2
  systemctl --user --no-pager --full status "$unit" >&2 || true
  exit 1
fi

cmdline=$(tr '\0' ' ' < "/proc/$new_pid/cmdline")
if [[ "$cmdline" != *"$expected_entry serve"* ]]; then
  echo "Unexpected live DevSpace command: $cmdline" >&2
  exit 1
fi

# Exercise the real HTTP/OAuth/MCP path against the restarted process. This
# catches stale services, wrong tool modes, and registration/schema regressions
# that a dist-file grep cannot detect.
schema_probe=$("${pnpm_cmd[@]}" --dir "$repo_root" --silent schema:probe-live)
if [[ "$schema_probe" != *'"ok":true'* ]]; then
  echo "Live MCP schema probe did not report success: $schema_probe" >&2
  exit 1
fi

echo "DevSpace live: pid=$new_pid build=$(stat -c %y "$repo_root/dist/server.js")"
echo "Schema-bearing build verified: project intelligence is present in dist/server.js"
if [[ "$schema_probe" == *'"liveAuthenticatedToolListVerified":false'* ]]; then
  echo "OAuth enrollment locked: live HTTP challenge and compiled MCP schema verified without creating production credentials."
  echo "Authenticated live MCP tools/list MUST be checked from an existing ChatGPT session before claiming end-to-end deployment verified."
else
  echo "Live MCP schema verified: $schema_probe"
fi
