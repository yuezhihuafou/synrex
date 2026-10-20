#!/usr/bin/env bash
# Rollback-safe switch of an already-built, isolated swy1 production release.
# Run from a user systemd transient service, not inside the MCP process.
set -euo pipefail
candidate=${1:?Usage: activate-owner-release.sh <pinned-release> <backups-dir>}
backup_root=${2:?Usage: activate-owner-release.sh <pinned-release> <backups-dir>}
service=devspace.service
dropdir="$HOME/.config/systemd/user/$service.d"
dropin="$dropdir/90-owner-pinned-release.conf"
mkdir -p "$dropdir" "$backup_root"
chmod 700 "$backup_root"
test -f "$candidate/dist/cli.js"
test -f "$candidate/release-manifest.json"
old=""
if test -e "$dropin"; then
  cp -p "$dropin" "$backup_root/pre-switch-dropin.conf"
  old=present
fi
restore() {
  if test "$old" = present; then
    cp -p "$backup_root/pre-switch-dropin.conf" "$dropin"
  else
    rm -f "$dropin"
  fi
  systemctl --user daemon-reload
  systemctl --user restart "$service"
  echo 'OWNER_RELEASE_ROLLED_BACK' >&2
}
trap 'restore' ERR
node="/home/swy/.nvm/versions/node/v22.22.2/bin/node"
cat > "$dropin.tmp" <<EOF
[Service]
ExecStart=
ExecStart=$node $candidate/dist/cli.js serve
EOF
mv -f "$dropin.tmp" "$dropin"
systemctl --user daemon-reload
systemctl --user restart "$service"
healthy=false
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 http://127.0.0.1:7676/healthz >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if test "$healthy" != true; then
  echo 'New runtime failed health; reverting' >&2
  false
fi
if ! curl -fsS --max-time 12 https://devspace.yuezhihuafou.dpdns.org/.well-known/oauth-authorization-server >/dev/null; then
  echo 'Public OAuth discovery unavailable; reverting' >&2
  false
fi
systemctl --user is-active --quiet "$service"
printf 'OWNER_RELEASE_ACTIVATED %s\n' "$candidate"
trap - ERR
