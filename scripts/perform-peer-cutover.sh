#!/bin/bash
# Offline-to-online handover: gateway -> swy1. Launch as an independent user
# systemd service, NEVER from a foreground MCP request that it would terminate.
set -euo pipefail
PATH=/home/swy/.nvm/versions/node/v22.22.2/bin:/usr/local/bin:/usr/bin:/bin
cd /home/swy/DevSpace
base="$HOME/.local/share/devspace-refactor-backups/peer-cutover-20261018"
state="$HOME/.local/share/devspace-cutover-20261018"
config="$HOME/.devspace-cutover-20261018"
gateway=swy@192.168.5.9
marker="$base/cutover-in-progress"
ack="$base/cutover-ack"
rollback() {
  code=$?
  if [[ $code -ne 0 && -f "$marker" ]]; then
    echo 'Cutover failed. Beginning coordinated rollback.' >&2
    /bin/sh /home/swy/DevSpace/deploy/rollback-peer-cutover-swy1.sh || true
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$gateway" '/bin/sh /home/swy/.local/share/devspace-refactor-backups/peer-cutover-20261018/rollback-gateway.sh' || true
  fi
  exit "$code"
}
trap rollback EXIT

# No cutover when already acknowledged or with unverified baseline services.
[[ ! -e "$marker" && ! -e "$ack" ]]
systemctl --user is-active --quiet devspace.service
systemctl --user is-active --quiet devspace-peer-candidate-complete-20261018-b.service
! systemctl --user is-active --quiet cloudflared-devspace.service
ssh -o BatchMode=yes -o ConnectTimeout=8 "$gateway" 'systemctl --user is-active --quiet cloudflared-devspace.service'
sh /home/swy/DevSpace/deploy/check-devspace-release-assets.sh /home/swy/services/devspace/releases/20261018-peer-coordinator-complete
python3 /home/swy/DevSpace/scripts/probe_private_coordinator.py "$state" 7681
if [[ "${1:-}" == "--preflight" ]]; then
  echo 'cutover_preflight=pass, production untouched'
  exit 0
fi
if [[ "${1:-}" != "--commit" ]]; then
  echo 'Usage: perform-peer-cutover.sh --preflight|--commit' >&2
  exit 2
fi

# Two independent rollback watchdogs, 210s/225s. A real authenticated GPT
# tool call must write cutover-ack on BOTH hosts to suppress them.
systemd-run --user --on-active=210s --unit=devspace-cutover-rollback-swy1-20261018-b /bin/sh /home/swy/DevSpace/deploy/rollback-peer-cutover-swy1.sh
ssh -o BatchMode=yes "$gateway" 'systemd-run --user --on-active=225s --unit=devspace-cutover-rollback-gateway-20261018-b /bin/sh /home/swy/.local/share/devspace-refactor-backups/peer-cutover-20261018/rollback-gateway.sh'
touch "$marker"

# Freeze PUBLIC OAuth and route mutations. Gateway remains privately
# accessible over SSH while the snapshot is prepared and validated.
ssh -o BatchMode=yes "$gateway" 'systemctl --user stop cloudflared-devspace.service'
ssh -o BatchMode=yes "$gateway" 'cd /home/swy/DevSpace && python3 scripts/snapshot-live-for-cutover.py'
scp -q -o BatchMode=yes "$gateway:$base/gateway-authority-final.sqlite" "$base/gateway-authority-final.sqlite"
chmod 600 "$base/gateway-authority-final.sqlite"

# Release the two private coordinator instances and the existing swy1 worker.
systemctl --user stop devspace-peer-candidate-complete-20261018-b.service
systemctl --user stop devspace-core.service || true
systemctl --user stop devspace.service

python3 /home/swy/DevSpace/scripts/peer_coordinator_snapshot.py --authority "$base/gateway-authority-final.sqlite" --previous "$HOME/.local/share/devspace-core/devspace.sqlite" --local "$HOME/.local/share/devspace-node-b/devspace.sqlite" --output "$base/coordinator-final-owner-isolated.sqlite" --report "$base/coordinator-final-audit.json" --owner-isolated

rm -f "$state/devspace.sqlite-wal" "$state/devspace.sqlite-shm"
cp -p "$base/coordinator-final-owner-isolated.sqlite" "$state/devspace.sqlite"
chmod 600 "$state/devspace.sqlite"
DEVSPACE_CONFIG_DIR="$config" node --input-type=module -e 'import("./dist/user-config.js").then(m=>m.setDevspaceConfigValue(["server","port"],7676))'
install -m 600 /home/swy/DevSpace/deploy/devspace-swy1-production-coordinator.service "$HOME/.config/systemd/user/devspace.service"
systemctl --user daemon-reload
systemctl --user start devspace.service
coordinator_ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl --noproxy '*' -fsS -m 2 http://127.0.0.1:7676/healthz >/dev/null 2>&1; then
    coordinator_ready=1
    break
  fi
  sleep 1
done
if [[ $coordinator_ready -ne 1 ]]; then
  echo 'swy1 coordinator did not become healthy in bounded startup window' >&2
  exit 1
fi

# Redirect gateway's private SSH relay to the new coordinator's port and
# convert the REAL gateway runtime to a full peer (not its disposable canary).
ssh -o BatchMode=yes "$gateway" 'systemctl --user stop devspace-peer-candidate-ssh-20261018.service || true'
ssh -o BatchMode=yes "$gateway" 'systemd-run --user --unit=devspace-peer-cutover-ssh-20261018 --property=Restart=on-failure /usr/bin/ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:7682:127.0.0.1:7676 swy@192.168.5.148'
ssh -o BatchMode=yes "$gateway" 'cd /home/swy/DevSpace && /bin/sh scripts/activate-gateway-peer.sh'
for attempt in 1 2 3 4 5; do
  if python3 /home/swy/DevSpace/scripts/probe_private_coordinator.py "$state" 7676; then
    break
  fi
  if [[ $attempt -eq 5 ]]; then
    echo 'Final private MCP cross-node probe failed' >&2
    exit 1
  fi
  sleep 2
done

# Only one Cloudflare connector may now own the public ingress.
systemctl --user start cloudflared-devspace.service
public_ok=0
for attempt in 1 2 3 4 5 6; do
  if curl --noproxy '*' -fsS -m 8 https://devspace.yuezhihuafou.dpdns.org/healthz >/dev/null; then
    public_ok=1
    break
  fi
  sleep 3
done
if [[ $public_ok -ne 1 ]]; then
  echo 'Public ingress did not recover before deadline' >&2
  exit 1
fi
echo 'PROVISIONAL_CUTOVER_UP: swy1 public; pending authenticated ChatGPT acknowledgement'
