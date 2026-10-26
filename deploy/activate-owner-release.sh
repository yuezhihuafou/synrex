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
test -f "$candidate/scripts/synrex-release-provenance.py"
# Do not regress production just because a developer finished on an older
# worktree. The candidate must equal the remote canonical main at cutover,
# contain the CURRENT pinned release, and have verified immutable build bytes.
if ! python3 "$candidate/scripts/synrex-release-provenance.py" \
  --candidate "$candidate" >"$backup_root/provenance-preflight.json"; then
  echo "OWNER_RELEASE_BLOCKED candidate is stale or not on canonical main; inspect $backup_root/provenance-preflight.json" >&2
  exit 75
fi
ingress_socket="${SYNREX_INGRESS_CONTROL_SOCKET:-}"
# After the first migration, the owner ingress is an independently managed
# service. Never silently fall back to the legacy :7676 layout while it runs.
if systemctl --user is-active --quiet synrex-ingress.service; then
  if test -z "$ingress_socket"; then
    ingress_socket="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/synrex-ingress.sock"
  fi
elif test -n "$ingress_socket"; then
  echo 'OWNER_RELEASE_BLOCKED ingress socket configured but stable unit is not active' >&2
  exit 75
fi
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
changed=false
paused=false
activated=false
write_release_receipt() {
  local outcome="$1"
  python3 - "$backup_root/release-receipt.json" "$candidate" "$outcome" <<'PY'
import json,sys,datetime,pathlib
output=pathlib.Path(sys.argv[1])
release=pathlib.Path(sys.argv[2])
manifest=json.loads((release/"release-manifest.json").read_text())
output.write_text(json.dumps({
  "status":sys.argv[3],
  "candidate":str(release),
  "sourceRevision":manifest["sourceRevision"],
  "at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "productionCorePort":7677,
  "publicIngressUnchanged":True
},sort_keys=True,indent=2)+"\n")
output.chmod(0o600)
PY
}
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
    paused=false
  fi
}
cleanup() {
  local failure=$?
  trap - EXIT ERR INT TERM
  if test "$activated" = true; then
    exit 0
  fi
  if test "$changed" = true; then
    echo 'OWNER_RELEASE_RESTORING previous immutable Core' >&2
    if test "$old" = present; then
      cp -p "$backup_root/pre-switch-dropin.conf" "$dropin" || failure=1
    else
      rm -f "$dropin" || failure=1
    fi
    if ! systemctl --user daemon-reload || ! systemctl --user restart "$service"; then
      echo 'OWNER_RELEASE_ROLLBACK_FAILED previous configuration restored but Core needs inspection' >&2
      failure=1
      write_release_receipt "rollback-failed" || true
    else
      echo 'OWNER_RELEASE_ROLLED_BACK' >&2
      write_release_receipt "rolled-back" || true
    fi
  else
    write_release_receipt "blocked-before-switch" || true
  fi
  if test "$paused" = true; then
    resume_ingress || failure=1
  fi
  exit "${failure:-1}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
  paused=true
  # Gateway peers hold /_devspace/node/v1/poll for 25 seconds and immediately
  # re-poll. The old six-second drain ALWAYS conflicted with normal peer
  # traffic. PAUSE blocks the *next* poll; the current one must be allowed to
  # finish naturally. Keep a bound below the ingress 75s pause lease.
  idle=false
  drain_deadline=$((SECONDS + 40))
  while test "$SECONDS" -lt "$drain_deadline"; do
    if node "$ingress_ctl" --socket "$ingress_socket" --command STATUS --idle >/dev/null 2>&1; then
      idle=true
      break
    fi
    sleep 0.4
  done
  if test "$idle" != true; then
    resume_ingress || true
    echo 'OWNER_RELEASE_BLOCKED in-flight HTTP requests did not drain' >&2
    exit 75
  fi
else
  echo 'OWNER_RELEASE_LEGACY_INGRESS no stable admission controller; in-flight MCP requests remain unobservable' >&2
fi
# Recheck immediately before the switch: another conversation may publish a
# newer main while requests are draining. No version is ever silently skipped.
if ! python3 "$candidate/scripts/synrex-release-provenance.py" \
  --candidate "$candidate" >"$backup_root/provenance-cutover.json"; then
  echo 'OWNER_RELEASE_BLOCKED main advanced during drain; restarting would be stale' >&2
  exit 75
fi
node="/home/swy/.nvm/versions/node/v22.22.2/bin/node"
changed=true
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
write_release_receipt "activated"
activated=true
printf 'OWNER_RELEASE_ACTIVATED %s\n' "$candidate"
