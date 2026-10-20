#!/bin/sh
# Emergency rollback of gateway ingress after a failed swy1 cutover.
# Only run when the swy1 Cloudflare connector is stopped (single-writer edge).
set -eu
base="$HOME/.local/share/devspace-refactor-backups/peer-cutover-20261018/service-rollback"
test -f "$base/active-config.jsonc"
test -f "$base/active-auth.json"
test -f "$base/user-units/devspace.service"
if test -f "$HOME/.local/share/devspace-refactor-backups/peer-cutover-20261018/cutover-ack"; then
  echo 'Cutover acknowledged; rollback not required'
  exit 0
fi
# A remote unreachable host is not proof that its tunnel is stopped.
# Refuse an automatic dual-connector rollout when remote shutdown is unknown.
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 swy@192.168.5.148 'systemctl --user stop cloudflared-devspace.service'; then
  echo 'Could not verify swy1 tunnel shutdown. Manual intervention required.' >&2
  exit 1
fi
systemctl --user stop cloudflared-devspace.service || true
systemctl --user stop devspace.service || true
cp -p "$base/active-config.jsonc" "$HOME/.devspace/config.jsonc"
cp -p "$base/active-auth.json" "$HOME/.devspace/auth.json"
cp -p "$base/user-units/devspace.service" "$HOME/.config/systemd/user/devspace.service"
systemctl --user daemon-reload
systemctl --user start devspace.service
systemctl --user start cloudflared-devspace.service
echo 'Gateway ingress restored from saved configuration'
