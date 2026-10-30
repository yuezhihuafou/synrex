#!/usr/bin/env bash
# A user-invoked one-step rollback request; detached from the MCP Core process.
set -euo pipefail
test "${1:-}" = --previous || {
  echo 'Usage: request-owner-rollback.sh --previous' >&2
  exit 64
}
current_exe=$(systemctl --user show devspace.service -p ExecStart | grep -oE '/home/swy/services/devspace/releases/[^ ;]+/dist/cli.js' | head -1)
test -n "$current_exe"
current=${current_exe%/dist/cli.js}
test -f "$current/deploy/rollback-owner-release.sh"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
receipts="/home/swy/services/devspace/backups/rollback-$stamp"
mkdir -p "$receipts"
chmod 700 "$receipts"
systemd-run --user --collect --unit="synrex-rollback-$stamp" \
  --description="Explicit verified previous Synrex Core rollback" \
  --property=Type=exec /bin/bash "$current/deploy/rollback-owner-release.sh" "$receipts"
echo "ROLLBACK_DISPATCHED receipts=$receipts/rollback-receipt.json"
