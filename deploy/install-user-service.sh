#!/usr/bin/env bash
set -euo pipefail

# This helper is for the first installation only. Existing installations may
# have an immutable, OAuth-stateful production release; replacing its unit from
# a mutable checkout would bypass backup, provenance checks and rollback.
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: bash deploy/install-user-service.sh (first installation only)"
  echo "For upgrades, use the immutable, verified release procedure."
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "Unknown arguments; see --help." >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
home_dir=${HOME:?HOME must be set}
node_bin=${NODE_BIN:-$(command -v node || true)}
service_dir="${XDG_CONFIG_HOME:-$home_dir/.config}/systemd/user"
unit_path="$service_dir/devspace.service"

# Check before dependency installation, compilation, or any systemd mutation.
# Refuse even a stopped pre-existing unit: it may own production credentials.
if [[ -e "$unit_path" || -L "$unit_path" ]] || \
    { command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet devspace.service; }; then
  echo "INSTALL_BLOCKED: an existing devspace.service was detected." >&2
  echo "This first-install helper will not replace it or restart production." >&2
  echo "Use docs/platform/SINGLE_OWNER_SELF_HOSTED.md and the reviewed pinned-release upgrade procedure." >&2
  exit 75
fi

# Non-login invocations may not export the user systemd bus variables.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "node >=22.19 is required; set NODE_BIN=/path/to/node" >&2
  exit 1
fi

node_version=$($node_bin --version)
echo "Using $node_bin ($node_version)"

if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  corepack enable
  pnpm_cmd=(pnpm)
else
  echo "pnpm or corepack is required" >&2
  exit 1
fi

"${pnpm_cmd[@]}" --dir "$repo_root" install --frozen-lockfile
"${pnpm_cmd[@]}" --dir "$repo_root" build

mkdir -p "$service_dir"
node_dir=$(dirname "$(readlink -f "$node_bin")")
template="$repo_root/deploy/systemd/devspace.service.in"
backup_path="$service_dir/devspace.service.pre-personal-fork"
tmp_path=$(mktemp "$service_dir/devspace.service.XXXXXX")
trap 'rm -f "$tmp_path"' EXIT

if [[ -f "$unit_path" && ! -f "$backup_path" ]]; then
  cp -p "$unit_path" "$backup_path"
  echo "Saved previous service as $backup_path"
fi

sed \
  -e "s|@REPO_ROOT@|$repo_root|g" \
  -e "s|@HOME_DIR@|$home_dir|g" \
  -e "s|@NODE_BIN@|$node_bin|g" \
  -e "s|@NODE_DIR@|$node_dir|g" \
  "$template" > "$tmp_path"
chmod 0644 "$tmp_path"
mv "$tmp_path" "$unit_path"
trap - EXIT

# The transient timer must stop before its service, otherwise it can
# immediately recreate the old process and reclaim port 7676.
systemctl --user stop devspace-compact-live.timer 2>/dev/null || true
systemctl --user stop devspace-compact-live.service 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable devspace.service
systemctl --user restart devspace.service

echo "Installed and started $unit_path"
if [[ -f "$backup_path" ]]; then
  echo "Rollback backup: $backup_path"
fi
systemctl --user --no-pager --full status devspace.service
