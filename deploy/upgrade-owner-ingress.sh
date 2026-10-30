#!/usr/bin/env bash
# Exceptional owner ingress software upgrade: Core remains running on :7677.
# May interrupt existing HTTP streams once. Run detached via systemd-run.
# Ordinary Core releases DO NOT restart the ingress or the Cloudflare Tunnel.
set -euo pipefail
candidate=${1:?Usage: upgrade-owner-ingress.sh <verified-release> <private-backup-dir>}
backup=${2:?Usage: upgrade-owner-ingress.sh <verified-release> <private-backup-dir>}
unit=synrex-ingress.service
file="$HOME/.config/systemd/user/$unit"
lockdir="$HOME/.local/state/synrex"
mkdir -p "$lockdir" "$backup"
chmod 700 "$backup"
exec 9>"$lockdir/owner-release.lock"
flock -n 9 || { echo 'INGRESS_UPGRADE_BLOCKED owner release lock held' >&2; exit 75; }
test -f "$file"
test -f "$candidate/scripts/ingress-gate.mjs"
test -f "$candidate/deploy/systemd/synrex-ingress.service.template"
test -f "$candidate/scripts/synrex-release-provenance.py"
python3 "$candidate/scripts/synrex-release-provenance.py" --candidate "$candidate" \
  >"$backup/provenance.json" || {
    echo 'INGRESS_UPGRADE_BLOCKED candidate not exact main or production ancestor' >&2
    exit 75
  }
systemctl --user is-active --quiet "$unit"
systemctl --user is-active --quiet devspace.service
systemctl --user is-active --quiet cloudflared-devspace.service
curl -fsS --max-time 3 http://127.0.0.1:7677/healthz >/dev/null
cp -p "$file" "$backup/old-ingress.service"
core_before=$(systemctl --user show devspace.service -p MainPID --value)
test "$core_before" -gt 0
finished=false
changed=false
receipt="$backup/ingress-upgrade.json"
write_receipt(){
  python3 - "$receipt" "$1" "$candidate" <<'PY'
import datetime,json,pathlib,sys
p=pathlib.Path(sys.argv[1])
p.write_text(json.dumps({"status":sys.argv[2],"release":sys.argv[3],
 "at":datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2,sort_keys=True)+"\n")
p.chmod(0o600)
PY
}
restore(){
  local code=$?
  trap - EXIT TERM INT
  if test "$finished" = true; then exit 0; fi
  if test "$changed" = true; then
    cp -p "$backup/old-ingress.service" "$file"
    systemctl --user daemon-reload
    if systemctl --user restart "$unit" && \
       curl -fsS --max-time 3 http://127.0.0.1:7676/healthz >/dev/null; then
      write_receipt 'old-ingress-restored' || true
      echo 'INGRESS_UPGRADE_OLD_SERVICE_RESTORED' >&2
    else
      write_receipt 'ingress-restore-failed' || true
      echo 'INGRESS_UPGRADE_RESTORE_FAILED manual inspection required' >&2
      code=1
    fi
  else
    write_receipt 'blocked-before-switch' || true
  fi
  exit "${code:-1}"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
rendered="$backup/new-ingress.service"
sed "s|@RELEASE_DIRECTORY@|$candidate|g" \
  "$candidate/deploy/systemd/synrex-ingress.service.template" >"$rendered"
systemd-analyze --user verify "$rendered"
changed=true
install -m 0644 "$rendered" "$file"
systemctl --user daemon-reload
# A one-time gate software refresh interrupts open streams. It is *not* how
# ordinary Core releases work; the Core and its independent tasks stay alive.
systemctl --user restart "$unit"
healthy=false
for _ in $(seq 1 25); do
  if curl -fsS --max-time 2 http://127.0.0.1:7676/healthz >/dev/null 2>&1; then
    healthy=true; break
  fi
  sleep 1
done
test "$healthy" = true
test "$core_before" = "$(systemctl --user show devspace.service -p MainPID --value)"
systemctl --user is-active --quiet cloudflared-devspace.service
curl -fsS --max-time 12 \
  https://devspace.yuezhihuafou.dpdns.org/.well-known/oauth-authorization-server >/dev/null
node "$candidate/scripts/ingress-ctl.mjs" \
  --socket "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/synrex-ingress.sock" \
  --command STATUS >"$backup/ingress-after.json"
write_receipt 'upgraded'
finished=true
echo "OWNER_INGRESS_UPGRADED release=$candidate core_unchanged=$core_before"
