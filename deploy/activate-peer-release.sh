#!/usr/bin/env bash
# Activate a tested immutable peer build without changing peer configuration.
set -euo pipefail
candidate=${1:?Usage: activate-peer-release.sh RELEASE BACKUP_DIR}
backup_root=${2:?Usage: activate-peer-release.sh RELEASE BACKUP_DIR}
dropin="$HOME/.config/systemd/user/devspace.service.d/90-pinned-peer-release.conf"
test -f "$candidate/dist/cli.js"
test -f "$candidate/release-manifest.json"
test -f "$dropin"
mkdir -p "$backup_root"
chmod 700 "$backup_root"
test ! -e "$backup_root/pre-switch-peer.conf"
cp -p "$dropin" "$backup_root/pre-switch-peer.conf"
restore() {
  cp -p "$backup_root/pre-switch-peer.conf" "$dropin"
  systemctl --user daemon-reload
  systemctl --user restart devspace.service
  echo PEER_RELEASE_ROLLED_BACK >&2
}
trap restore ERR
node=/home/swy/.nvm/versions/node/v22.22.2/bin/node
test -x "$node"
printf '[Service]\nExecStart=\nExecStart=%s %s/dist/cli.js serve\n' "$node" "$candidate" > "$dropin.tmp"
mv -f "$dropin.tmp" "$dropin"
systemctl --user daemon-reload
systemctl --user restart devspace.service
healthy=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:7676/healthz >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
test "$healthy" = true
systemctl --user is-active --quiet devspace.service
echo "PEER_RELEASE_ACTIVATED $candidate"
trap - ERR
