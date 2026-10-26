#!/usr/bin/env bash
# Explicit one-step rollback to the previously verified immutable Core release.
# Must be launched by an independent user systemd unit, not by the Core itself.
# This intentionally bypasses "candidate == latest main" but NEVER accepts an
# arbitrary worktree, path or older code without a recorded release ancestry.
set -euo pipefail
backup=${1:?Usage: rollback-owner-release.sh <private-rollback-receipts-directory>}
service=devspace.service
ingress=synrex-ingress.service
release_root=/home/swy/services/devspace/releases
dropin="$HOME/.config/systemd/user/$service.d/90-owner-pinned-release.conf"
lockdir="$HOME/.local/state/synrex"
mkdir -p "$lockdir" "$backup"
chmod 700 "$backup"
exec 9>"$lockdir/owner-release.lock"
if ! flock -n 9; then
  echo 'ROLLBACK_BLOCKED another release or rollback holds the owner lock' >&2
  exit 75
fi
systemctl --user is-active --quiet "$service"
systemctl --user is-active --quiet "$ingress"
systemctl --user is-active --quiet cloudflared-devspace.service
test -f "$dropin"
current_exe=$(systemctl --user show "$service" -p ExecStart | grep -oE '/home/swy/services/devspace/releases/[^ ;]+/dist/cli.js' | head -1)
test -n "$current_exe"
current=${current_exe%/dist/cli.js}
test -f "$current/release-manifest.json"
target_name=$(python3 - "$current/release-manifest.json" <<'PY'
import json,re,sys
doc=json.load(open(sys.argv[1]))
name=doc.get("previousRelease")
if not isinstance(name,str) or not re.fullmatch(r"[a-zA-Z0-9._-]{5,150}",name):
 raise SystemExit("ROLLBACK_BLOCKED no recorded previous immutable release")
print(name)
PY
)
target="$release_root/$target_name"
test -d "$target"
test "$(realpath "$target")" = "$target"
test -f "$target/release-manifest.json"
test -f "$target/dist/cli.js"
test -f "$target/dist/server-bind.js"
test -f "$target/dist/build-info.json"
python3 - "$current" "$target" <<'PY'
import hashlib,json,pathlib,sys
old,new=map(pathlib.Path,sys.argv[1:])
assert old.parent==new.parent and old!=new, "Release is not an immutable sibling"
doc=json.loads((new/"release-manifest.json").read_text())
build=json.loads((new/"dist/build-info.json").read_text())
assert doc["sourceRevision"]==build["revision"], "Rollback release build identity mismatch"
assert doc.get("sourceDirty") is False and build.get("dirty") is False, "Rollback source is dirty"
assert doc.get("qa") and "pending" not in doc["qa"].lower(), "Rollback release was not verified"
for key,sha in doc["assets"].items():
 item=new/key
 assert ".." not in pathlib.Path(key).parts and item.is_file() and not item.is_symlink(), "Unsafe rollback asset"
 assert hashlib.sha256(item.read_bytes()).hexdigest()==sha, "Rollback asset was modified"
print("ROLLBACK_VERIFIED target="+doc["sourceRevision"][:12])
PY
cp -p "$dropin" "$backup/pre-rollback-dropin.conf"
ctl="$current/scripts/ingress-ctl.mjs"
socket="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/synrex-ingress.sock"
test -S "$socket"
node "$ctl" --socket "$socket" --command STATUS >/dev/null
paused=false
changed=false
completed=false
receipt="$backup/rollback-receipt.json"
write_receipt() {
  python3 - "$receipt" "$1" "$current" "$target" <<'PY'
import datetime,json,pathlib,sys
f=pathlib.Path(sys.argv[1])
f.write_text(json.dumps({"status":sys.argv[2],"from":sys.argv[3],"to":sys.argv[4],
 "at":datetime.datetime.now(datetime.timezone.utc).isoformat()},sort_keys=True,indent=2)+"\n")
f.chmod(0o600)
PY
}
restore() {
  local status=$?
  trap - EXIT TERM INT
  if test "$completed" = true; then exit 0; fi
  if test "$changed" = true; then
    cp -p "$backup/pre-rollback-dropin.conf" "$dropin"
    systemctl --user daemon-reload
    if systemctl --user restart "$service"; then
      echo 'ROLLBACK_CANCELLED original Core restored' >&2
      write_receipt 'original-restored' || true
    else
      echo 'ROLLBACK_RECOVERY_FAILED manual inspection required' >&2
      write_receipt 'recovery-failed' || true
      status=1
    fi
  else
    write_receipt 'blocked-before-switch' || true
  fi
  if test "$paused" = true; then
    node "$ctl" --socket "$socket" --command RESUME >/dev/null || status=1
  fi
  exit "${status:-1}"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$ctl" --socket "$socket" --command PAUSE >/dev/null
paused=true
idle=false
for _ in $(seq 1 60); do
  if node "$ctl" --socket "$socket" --command STATUS --idle >/dev/null 2>&1; then
    idle=true; break
  fi
  sleep 0.1
done
if test "$idle" != true; then
  echo 'ROLLBACK_BLOCKED in-flight requests cannot safely drain' >&2
  exit 75
fi
changed=true
cat >"$dropin.tmp" <<EOF
[Service]
ExecStart=
Environment=SYNREX_CORE_LISTEN_PORT=7677
ExecStart=/home/swy/.nvm/versions/node/v22.22.2/bin/node $target/dist/cli.js serve
EOF
mv -f "$dropin.tmp" "$dropin"
systemctl --user daemon-reload
systemctl --user restart "$service"
healthy=false
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 http://127.0.0.1:7677/healthz >/dev/null 2>&1; then
    healthy=true; break
  fi
  sleep 1
done
test "$healthy" = true
node "$ctl" --socket "$socket" --command RESUME >/dev/null
paused=false
curl -fsS --max-time 12 \
  https://devspace.yuezhihuafou.dpdns.org/.well-known/oauth-authorization-server >/dev/null
systemctl --user is-active --quiet "$ingress"
systemctl --user is-active --quiet "$service"
write_receipt 'rolled-back'
completed=true
echo "OWNER_ROLLBACK_ACTIVATED $target"
