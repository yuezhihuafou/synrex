#!/usr/bin/env bash
# Install the owner-local, read-only Console data plane without coupling it to
# the MCP Core process. The stable snapshot bootstrap follows the actually
# pinned immutable release on every run.
set -euo pipefail

state_dir=${1:?Usage: install-console-data-plane.sh <state-dir> <release-root> [repo-root]}
release_root=${2:?Usage: install-console-data-plane.sh <state-dir> <release-root> [repo-root]}
repo_root=${3:-}

state_dir=$(realpath "$state_dir")
release_root=$(realpath "$release_root")
test -d "$state_dir"
test -d "$release_root"
node=$(command -v node)
test -n "$node"

source_dir=$(cd "$(dirname "$0")" && pwd)
stable_dir="$HOME/.local/share/synrex-observability"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$stable_dir" "$unit_dir" "$state_dir/observability"
chmod 700 "$stable_dir" "$state_dir/observability"

install -m 700 "$source_dir/active-console-snapshot.mjs" "$stable_dir/active-console-snapshot.mjs"
install -m 700 "$source_dir/archive-indexer.mjs" "$stable_dir/archive-indexer.mjs"
install -m 700 "$source_dir/usage-rollup.mjs" "$stable_dir/usage-rollup.mjs"

cat >"$unit_dir/synrex-console-snapshot.service" <<EOF
[Unit]
Description=Synrex out-of-process console snapshot
After=devspace.service

[Service]
Type=oneshot
Environment=SYNREX_STATE_DIR=$state_dir
Environment=SYNREX_RELEASE_ROOT=$release_root
ExecStart=$node $stable_dir/active-console-snapshot.mjs
Nice=15
IOSchedulingClass=idle
MemoryMax=256M
CPUQuota=25%
TimeoutStartSec=20
UMask=0077
NoNewPrivileges=true
EOF

cat >"$unit_dir/synrex-console-snapshot.timer" <<'EOF'
[Unit]
Description=Refresh Synrex console snapshot independently of MCP

[Timer]
OnBootSec=5s
OnUnitInactiveSec=15s
AccuracySec=2s
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat >"$unit_dir/synrex-archive-index.service" <<EOF
[Unit]
Description=Synrex compact 7-day searchable telemetry index

[Service]
Type=simple
Environment=SYNREX_STATE_DIR=$state_dir
ExecStart=$node --disable-warning=ExperimentalWarning $stable_dir/archive-indexer.mjs serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
MemoryMax=256M
CPUQuota=25%
UMask=0077

[Install]
WantedBy=default.target
EOF

repo_environment=""
if test -n "$repo_root"; then
  repo_root=$(realpath "$repo_root")
  test -d "$repo_root/.git" || test -f "$repo_root/.git"
  repo_environment="Environment=SYNREX_REPO_ROOT=$repo_root"
fi
cat >"$unit_dir/synrex-usage-rollup.service" <<EOF
[Unit]
Description=Synrex isolated usage statistics rollup
After=synrex-archive-index.service

[Service]
Type=oneshot
Environment=SYNREX_STATE_DIR=$state_dir
$repo_environment
ExecStart=$node $stable_dir/usage-rollup.mjs
Nice=15
IOSchedulingClass=idle
MemoryMax=128M
CPUQuota=10%
TimeoutStartSec=25
NoNewPrivileges=true
UMask=0077
EOF

cat >"$unit_dir/synrex-usage-rollup.timer" <<'EOF'
[Unit]
Description=Refresh Synrex usage metrics out of process

[Timer]
OnBootSec=30s
OnUnitInactiveSec=5min
RandomizedDelaySec=20s
Persistent=true

[Install]
WantedBy=timers.target
EOF

chmod 600 "$unit_dir"/synrex-console-snapshot.{service,timer} \
  "$unit_dir/synrex-archive-index.service" "$unit_dir"/synrex-usage-rollup.{service,timer}

if test "${SYNREX_OBSERVABILITY_RENDER_ONLY:-}" = 1; then
  printf 'SYNREX_CONSOLE_DATA_PLANE_RENDERED state=%s releases=%s\n' "$state_dir" "$release_root"
  exit 0
fi

systemctl --user daemon-reload
systemctl --user enable synrex-archive-index.service
# The indexer is long-lived. Restart it explicitly so an installer upgrade
# never leaves the previous script inode running until the next reboot.
systemctl --user restart synrex-archive-index.service
systemctl --user enable --now synrex-console-snapshot.timer synrex-usage-rollup.timer
# Prime each cached artifact immediately; timers own subsequent refreshes.
systemctl --user start synrex-console-snapshot.service
systemctl --user start synrex-usage-rollup.service
systemctl --user is-active --quiet synrex-archive-index.service
systemctl --user is-active --quiet synrex-console-snapshot.timer
systemctl --user is-active --quiet synrex-usage-rollup.timer
test -s "$state_dir/observability/console-snapshot.json"
test -s "$state_dir/observability/history.sqlite"
test -s "$state_dir/observability/usage-rollup.json"
printf 'SYNREX_CONSOLE_DATA_PLANE_READY state=%s releases=%s\n' "$state_dir" "$release_root"
