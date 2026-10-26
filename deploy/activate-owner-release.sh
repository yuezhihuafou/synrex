#!/usr/bin/env bash
# Rollback-safe switch of an already-built, isolated swy1 production release.
# Run from a user systemd transient service, not inside the MCP process.
set -euo pipefail
candidate=${1:?Usage: activate-owner-release.sh <pinned-release> <backups-dir>}
backup_root=${2:?Usage: activate-owner-release.sh <pinned-release> <backups-dir>}
service=devspace.service
dropdir="$HOME/.config/systemd/user/$service.d"
dropin="$dropdir/90-owner-pinned-release.conf"

# This lock belongs to the owner machine, not to a particular release or
# mutable Git checkout. A second ChatGPT conversation must not race a switch.
lockdir="$HOME/.local/state/synrex"
mkdir -p "$lockdir"
exec 9>"$lockdir/owner-release.lock"
if ! flock -n 9; then
  echo 'OWNER_RELEASE_BLOCKED another activation is already running' >&2
  exit 75
fi

# Fail before changing any systemd configuration when durable tasks are still
# running or the current production network has drifted. This is a known-busy
# guard, not a claim that ordinary GPT HTTP requests are fully drainable.
test -f "$candidate/scripts/synrex-p0.py"
test -f "$candidate/config/ops/network-topology.json"
mkdir -p "$dropdir" "$backup_root"
chmod 700 "$backup_root"
test -f "$candidate/dist/cli.js"
test -f "$candidate/release-manifest.json"
ingress_socket="${SYNREX_INGRESS_CONTROL_SOCKET:-}"
ingress_ctl="$candidate/scripts/ingress-ctl.mjs"
listen_port=7676
stable_args=()
if test -n "$ingress_socket"; then
  listen_port=7677
  stable_args=(--stable-ingress)
fi
if ! python3 "$candidate/scripts/synrex-p0.py" release-check --node swy1 "${stable_args[@]}" \
  --manifest "$candidate/config/ops/network-topology.json" \
  >"$backup_root/preflight.json"; then
  echo "OWNER_RELEASE_BLOCKED busy tasks or production network mismatch; inspect $backup_root/preflight.json" >&2
  exit 75
fi
old=""
if test -e "$dropin"; then
  cp -p "$dropin" "$backup_root/pre-switch-dropin.conf"
  old=present
fi
resume_ingress() {
  if test -n "$ingress_socket"; then
    if ! node "$ingress_ctl" --socket "$ingress_socket" --command RESUME >/dev/null; then
      echo 'OWNER_RELEASE_INGRESS_RESUME_FAILED inspect stable ingress control socket' >&2
      return 1
    fi
  fi
}

# Only a configured, owner-local Unix control socket enables true request
# admission pausing. Older deployments still use known-busy protection but
# cannot claim a seamless live HTTP cutover.
if test -n "$ingress_socket"; then
  if ! test -S "$ingress_socket" || ! test -f "$ingress_ctl" || \
      ! node "$ingress_ctl" --socket "$ingress_socket" --command STATUS >/dev/null; then
    echo 'OWNER_RELEASE_BLOCKED configured ingress controller is unavailable' >&2
    exit 75
  fi
  if ! node "$ingress_ctl" --socket "$ingress_socket" --command PAUSE >/dev/null; then
    echo 'OWNER_RELEASE_BLOCKED ingress pause failed' >&2
    exit 75
  fi
  idle=false
  for _ in $(seq 1 60); do
    if node "$ingress_ctl" --socket "$ingress_socket" --command STATUS --idle >/dev/null 2>&1; then
      idle=true
      break
    fi
    sleep 0.1
  done
  if test "$idle" != true; then
    resume_ingress || true
    echo 'OWNER_RELEASE_BLOCKED in-flight HTTP requests did not drain' >&2
    exit 75
  fi
else
  echo 'OWNER_RELEASE_LEGACY_INGRESS no stable admission controller; in-flight MCP requests remain unobservable' >&2
fi
restore() {
  local failure=$?
  trap - ERR
  if test "$old" = present; then
    cp -p "$backup_root/pre-switch-dropin.conf" "$dropin" || exit 1
  else
    rm -f "$dropin" || exit 1
  fi
  if ! systemctl --user daemon-reload || ! systemctl --user restart "$service"; then
    echo 'OWNER_RELEASE_ROLLBACK_FAILED previous drop-in restored but service recovery needs inspection' >&2
    resume_ingress || true
    exit 1
  fi
  resume_ingress || exit 1
  echo 'OWNER_RELEASE_ROLLED_BACK' >&2
  exit "$failure"
}
trap 'restore' ERR
node="/home/swy/.nvm/versions/node/v22.22.2/bin/node"
cat > "$dropin.tmp" <<EOF
[Service]
ExecStart=
Environment=SYNREX_CORE_LISTEN_PORT=$listen_port
ExecStart=$node $candidate/dist/cli.js serve
EOF
mv -f "$dropin.tmp" "$dropin"
systemctl --user daemon-reload
systemctl --user restart "$service"
healthy=false
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$listen_port/healthz" >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if test "$healthy" != true; then
  echo 'New runtime failed health; reverting' >&2
  false
fi
if test -n "$ingress_socket"; then
  # The stable ingress is paused until the candidate is responding directly.
  # Resume before checking the public end-to-end OAuth identity.
  resume_ingress
fi
if ! curl -fsS --max-time 12 https://devspace.yuezhihuafou.dpdns.org/.well-known/oauth-authorization-server >/dev/null; then
  echo 'Public OAuth discovery unavailable; reverting' >&2
  false
fi
systemctl --user is-active --quiet "$service"
resume_ingress
printf 'OWNER_RELEASE_ACTIVATED %s\n' "$candidate"
trap - ERR
