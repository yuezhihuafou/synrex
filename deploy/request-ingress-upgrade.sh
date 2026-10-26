#!/usr/bin/env bash
# Owner action for exceptional gate code upgrades, independent of the MCP call.
set -euo pipefail
candidate=${1:?Usage: request-ingress-upgrade.sh <verified-immutable-main-release>}
test -f "$candidate/deploy/upgrade-owner-ingress.sh"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/home/swy/services/devspace/backups/ingress-upgrade-$stamp"
mkdir -p "$backup"
chmod 700 "$backup"
systemd-run --user --collect --unit="synrex-ingress-upgrade-$stamp" \
  --description="Synrex guarded stable ingress software upgrade" \
  --property=Type=exec /bin/bash "$candidate/deploy/upgrade-owner-ingress.sh" "$candidate" "$backup"
echo "INGRESS_UPGRADE_DISPATCHED receipts=$backup/ingress-upgrade.json"
