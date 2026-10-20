#!/bin/sh
# Emergency rollback of swy1 runtime. Does not touch its existing worker DB.
set -eu
root="$HOME/.local/share/devspace-refactor-backups/peer-cutover-20261018"
base="$root/service-rollback"
if test -f "$root/cutover-ack"; then
  echo 'Cutover acknowledged; rollback not required'
  exit 0
fi
test -f "$base/user-units/devspace.service"
systemctl --user stop cloudflared-devspace.service || true
systemctl --user stop devspace.service || true
cp -p "$base/user-units/devspace.service" "$HOME/.config/systemd/user/devspace.service"
systemctl --user daemon-reload
systemctl --user start devspace.service
echo 'swy1 worker restored; gateway ingress still needs confirmation'
