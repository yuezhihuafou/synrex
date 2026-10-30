#!/usr/bin/env bash
# One-time swy1 :7676 owner handover to a persistent local reverse proxy.
# Run as a detached user systemd transient unit, NEVER through the MCP Core.
# Subsequent releases use activate-owner-release.sh, not this migration script.
set -euo pipefail
candidate=${1:?Usage: migrate-stable-ingress.sh <immutable-release> <rollback-dir>}
backup_root=${2:?Usage: migrate-stable-ingress.sh <immutable-release> <rollback-dir>}
service=devspace.service
ingress=synrex-ingress.service
dropdir="$HOME/.config/systemd/user/$service.d"
dropin="$dropdir/90-owner-pinned-release.conf"
lockdir="$HOME/.local/state/synrex"
mkdir -p "$lockdir" "$backup_root" "$dropdir"
chmod 700 "$backup_root"
exec 9>"$lockdir/owner-release.lock"
flock -n 9 || { echo 'STABLE_CUTOVER_BLOCKED concurrent owner release' >&2; exit 75; }

started=false
finished=false
had_previous=false
unit_enabled=false
old_copy="$backup_root/legacy-pre-stable-ingress-dropin.conf"
receipt="$backup_root/stable-ingress-cutover.json"
node=/home/swy/.nvm/versions/node/v22.22.2/bin/node

write_receipt() {
  local result="$1"
  python3 - "$receipt" "$result" "$candidate" <<'PY'
import json,sys,datetime,pathlib
file=pathlib.Path(sys.argv[1]);release=sys.argv[3]
doc={"status":sys.argv[2],"release":release,
     "timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat(),
     "publicPort":7676,"privateCorePort":7677,
     "productionSwitch":sys.argv[2] in ("activated", "rolled-back", "rollback-failed")}
file.write_text(json.dumps(doc,sort_keys=True,indent=2)+"\n")
PY
}
rollback() {
  local failed=$?
  trap - EXIT ERR INT TERM
  if test "$finished" = true; then return 0; fi
  if test "$started" != true; then
    write_receipt "blocked-before-switch" || true
    exit "$failed"
  fi
  echo 'STABLE_CUTOVER_ROLLING_BACK to last verified Core on :7676' >&2
  systemctl --user stop "$ingress" || true
  if test "$unit_enabled" = true; then
    systemctl --user disable "$ingress" || true
  fi
  if test "$had_previous" = true; then
    cp -p "$old_copy" "$dropin" || true
  else
    rm -f "$dropin" || true
  fi
  systemctl --user daemon-reload || true
  if systemctl --user restart "$service"; then
    for _ in $(seq 1 40); do
      if curl -fsS --max-time 2 http://127.0.0.1:7676/healthz >/dev/null 2>&1; then
        echo 'STABLE_CUTOVER_ROLLED_BACK old :7676 Core healthy' >&2
        write_receipt "rolled-back" || true
        exit "$failed"
      fi
      sleep 1
    done
  fi
  echo 'STABLE_CUTOVER_ROLLBACK_FAILED immediate operator investigation required' >&2
  write_receipt "rollback-failed" || true
  exit 1
}
trap rollback EXIT
trap 'exit 1' INT TERM

# Fail closed if the target or existing live owner is not positively identified.
test -f "$candidate/release-manifest.json"
test -f "$candidate/dist/cli.js"
test -f "$candidate/scripts/ingress-gate.mjs"
test -f "$candidate/scripts/synrex-p0.py"
test -f "$candidate/config/ops/network-topology.json"
test -f "$dropin"
test ! -e "$receipt"
test ! -e "$old_copy"
systemctl --user is-active --quiet "$service"
systemctl --user is-active --quiet cloudflared-devspace.service
if systemctl --user is-active --quiet "$ingress"; then
  echo 'STABLE_CUTOVER_BLOCKED ingress already active' >&2
  exit 75
fi
if ss -H -ltn | grep -Eq ':7677[[:space:]]'; then
  echo 'STABLE_CUTOVER_BLOCKED private :7677 port occupied' >&2
  exit 75
fi
test "$(curl -fsS --max-time 3 http://127.0.0.1:7676/healthz)" = '{"ok":true,"name":"devspace"}'
curl -fsS --max-time 10 \
  https://devspace.yuezhihuafou.dpdns.org/.well-known/oauth-authorization-server >/dev/null
python3 "$candidate/scripts/synrex-p0.py" network --node swy1 --probe \
  --manifest "$candidate/config/ops/network-topology.json" \
  >"$backup_root/stable-ingress-network-before.json"
python3 - "$backup_root/stable-ingress-network-before.json" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
critical={"swy1-core","swy1-cloudflare-metrics"}
problems=[x for x in doc["endpoints"] if x["id"] in critical and x["status"]!="ok"]
assert not doc["manifestConflicts"] and not problems, "legacy ingress topology is not healthy"
PY

cp -p "$dropin" "$old_copy"
had_previous=true
echo 'STABLE_CUTOVER_PREFLIGHT_OK; old owner and tunnel untouched'

# Allow the initiating MCP request to return before retiring its old Core.
sleep 10
started=true
cat >"$dropin.tmp" <<EOF
[Service]
ExecStart=
Environment=SYNREX_CORE_LISTEN_PORT=7677
ExecStart=$node $candidate/dist/cli.js serve
EOF
mv -f "$dropin.tmp" "$dropin"
systemctl --user daemon-reload
systemctl --user restart "$service"
healthy=false
for _ in $(seq 1 45); do
  if curl -fsS --max-time 2 http://127.0.0.1:7677/healthz >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
if test "$healthy" != true; then
  echo 'STABLE_CUTOVER private Core failed health check' >&2
  exit 1
fi
systemctl --user start "$ingress"
for _ in $(seq 1 15); do
  if curl -fsS --max-time 2 http://127.0.0.1:7676/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 4 http://127.0.0.1:7676/healthz >/dev/null
curl -fsS --max-time 12 \
  https://devspace.yuezhihuafou.dpdns.org/.well-known/oauth-authorization-server \
  >"$backup_root/stable-ingress-oauth-discovery.json"
python3 - "$backup_root/stable-ingress-oauth-discovery.json" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
assert str(doc.get("issuer","")).rstrip("/")=="https://devspace.yuezhihuafou.dpdns.org"
PY
python3 "$candidate/scripts/synrex-p0.py" network --node swy1 --stable-ingress --probe \
  --manifest "$candidate/config/ops/network-topology.json" \
  >"$backup_root/stable-ingress-network-after.json"
python3 - "$backup_root/stable-ingress-network-after.json" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
critical={"swy1-core","swy1-stable-ingress","swy1-cloudflare-metrics"}
problems=[x for x in doc["endpoints"] if x["id"] in critical and x["status"]!="ok"]
assert not doc["manifestConflicts"] and not problems, "stable ingress layout is not healthy"
PY
systemctl --user enable "$ingress"
unit_enabled=true
systemctl --user is-active --quiet cloudflared-devspace.service
systemctl --user is-active --quiet "$ingress"
systemctl --user is-active --quiet "$service"
finished=true
write_receipt "activated"
trap - EXIT
echo "STABLE_CUTOVER_ACTIVATED owner=$service core=:7677 ingress=:7676 release=$candidate"
