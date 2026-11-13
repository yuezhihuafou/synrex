#!/usr/bin/env bash
# Switch only the independent Console to the already-active, verified Owner
# Core release's companion assets. Never alters MCP/OAuth or peer services.
set -euo pipefail
candidate=${1:?Usage: activate-synced-console.sh PINNED_OWNER_RELEASE PRIVATE_BACKUP_DIR}
backup=${2:?Usage: activate-synced-console.sh PINNED_OWNER_RELEASE PRIVATE_BACKUP_DIR}
service=synrex-console.service
dropdir="$HOME/.config/systemd/user/$service.d"
dropin="$dropdir/95-synced-release.conf"
lockdir="$HOME/.local/state/synrex"
mkdir -p "$lockdir"
exec 9>"$lockdir/owner-release.lock"
flock -n 9 || { echo 'CONSOLE_BLOCKED concurrent release transaction' >&2; exit 75; }

systemctl --user is-active --quiet devspace.service
systemctl --user is-active --quiet "$service"
test -d "$candidate" && test ! -L "$candidate"
candidate=$(realpath "$candidate")
case "$candidate" in /home/swy/services/devspace/releases/*) ;; *)
  echo 'CONSOLE_BLOCKED candidate is not a pinned Owner release' >&2; exit 75 ;;
esac
test -f "$candidate/release-manifest.json"
test -f "$candidate/dist-console/monitor-app.html"
test -f "$candidate/dist-console-server/console-monitor.js"
test -f "$candidate/dist/build-info.json"
python3 - "$candidate" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
manifest=json.loads((root/"release-manifest.json").read_text())
build=json.loads((root/"dist/build-info.json").read_text())
assert manifest["sourceRevision"]==build["revision"], "Console/source revision mismatch"
assert manifest["sourceDirty"] is False and build["dirty"] is False, "Dirty release"
assert "pending" not in manifest.get("qa","").lower() and manifest.get("qa"), "No QA evidence"
for part in ("dist-console/monitor-app.html","dist-console-server/console-monitor.js"):
 p=root/part
 assert p.is_file() and not p.is_symlink(), "Console release asset missing or unsafe"
 assert hashlib.sha256(p.read_bytes()).hexdigest()==manifest.get("assets",{}).get(part), "Console asset hash mismatch"
print("CONSOLE_ASSETS_VERIFIED",manifest["sourceRevision"][:12])
PY
active_core=$(systemctl --user show devspace.service -p ExecStart --no-pager)
[[ "$active_core" == *"$candidate/dist/cli.js"* ]] || {
  echo 'CONSOLE_BLOCKED candidate must already be the active immutable Owner Core' >&2; exit 75;
}
mkdir -p "$dropdir" "$backup"
chmod 700 "$backup"
old_exec=$(systemctl --user show "$service" -p ExecStart --no-pager)
new_cli="$candidate/dist-console-server/console-monitor.js"
if [[ "$old_exec" == *"$new_cli"* ]]; then
  echo "CONSOLE_ALREADY_SYNCED $candidate"
  exit 0
fi

# Derive flags from the effective service command, not from an old template.
# Existing OAuth/Owner state, allowed write roots, peer settings and origins
# stay exactly as configured by the systemd manager.
CONSOLE_EFFECTIVE_EXEC="$old_exec" python3 - "$new_cli" "$backup" "$dropin" <<'PY'
import os,re,shlex,sys,pathlib,json
target,backup,dropin=sys.argv[1:]
effective=os.environ["CONSOLE_EFFECTIVE_EXEC"]
m=re.search(r"argv\[\]=(.*?) ; ignore_errors=",effective)
assert m, "Unable to inspect Console ExecStart safely"
args=shlex.split(m.group(1))
assert len(args)>4 and os.path.isfile(args[0]), "Console Node executable unavailable"
matches=[i for i,arg in enumerate(args) if arg.endswith("/dist-console-server/console-monitor.js")]
assert len(matches)==1, "Console entrypoint must be unambiguous"
old=args[matches[0]]
assert os.path.isfile(old), "Existing Console release is missing: "+old
args[matches[0]]=target
assert "--auth-file" in args and "--monitor-dir" in args, "Console authority/state flags absent"
monitor=args[args.index("--monitor-dir")+1]
assert pathlib.Path(monitor).is_dir(), "Monitor state directory missing"
def systemd_quote(s):
 return '"'+s.replace("\\","\\\\").replace('"','\\"').replace("%","%%")+'"'
entry="[Service]\nExecStart=\nExecStart="+" ".join(systemd_quote(x) for x in args)+"\n"
pathlib.Path(backup,"candidate-command.json").write_text(json.dumps({
 "oldEntrypoint":old,"newEntrypoint":target,"monitorDir":monitor,
 "argvCount":len(args)
},indent=2)+"\n")
pathlib.Path(backup,"candidate-command.json").chmod(0o600)
pathlib.Path(backup,"candidate-dropin.conf").write_text(entry)
pathlib.Path(backup,"candidate-dropin.conf").chmod(0o600)
PY

# Consistent SQLite online backup while the old Console still runs. A failed
# snapshot blocks activation rather than risking incompatible monitor state.
monitor_dir=$(python3 - "$backup/candidate-command.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))["monitorDir"])
PY
)
if test -f "$monitor_dir/statistics.sqlite"; then
  python3 - "$monitor_dir/statistics.sqlite" "$backup/statistics-before.sqlite" <<'PY'
import sqlite3,sys
with sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True) as live:
 with sqlite3.connect(sys.argv[2]) as saved:
  live.backup(saved,pages=128,sleep=0.05)
  assert saved.execute("pragma quick_check").fetchone()[0]=="ok"
PY
  chmod 600 "$backup/statistics-before.sqlite"
fi
had_dropin=false
if test -f "$dropin"; then
  cp -p "$dropin" "$backup/previous-synced-dropin.conf"
  had_dropin=true
fi
changed=false
activated=false
restore() {
  status=$?
  trap - EXIT INT TERM
  if test "$activated" = true; then exit 0; fi
  if test "$changed" = true; then
    # Stop any newly started Console before restoring its previous SQLite
    # image. Restoring a live WAL-backed database by copying bytes is unsafe.
    systemctl --user stop "$service" || status=1
    if test -f "$backup/statistics-before.sqlite"; then
      if ! python3 - "$backup/statistics-before.sqlite" "$monitor_dir/statistics.sqlite" <<'PY'
import sqlite3,sys
with sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True) as saved:
 with sqlite3.connect(sys.argv[2]) as previous:
  saved.backup(previous,pages=128,sleep=0.05)
  assert previous.execute("pragma quick_check").fetchone()[0]=="ok"
PY
      then
        echo 'CONSOLE_DATABASE_RESTORE_FAILED manual recovery from private backup required' >&2
        status=1
      fi
    fi
    if test "$had_dropin" = true; then
      cp -p "$backup/previous-synced-dropin.conf" "$dropin"
    else rm -f "$dropin"; fi
    systemctl --user daemon-reload
    systemctl --user restart "$service" || status=1
    echo 'CONSOLE_ROLLED_BACK to previous independent release' >&2
  fi
  exit "${status:-1}"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$backup/candidate-dropin.conf" "$dropin.tmp"
chmod 600 "$dropin.tmp"
mv "$dropin.tmp" "$dropin"
changed=true
systemctl --user daemon-reload
systemctl --user restart "$service"
healthy=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4318/health >/dev/null 2>&1; then
    healthy=true; break
  fi
  sleep 1
done
test "$healthy" = true
systemctl --user is-active --quiet "$service"
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:4318/console/api/snapshot)" = 401
python3 - "$backup/activation-receipt.json" "$candidate" <<'PY'
import datetime,json,pathlib,sys
p=pathlib.Path(sys.argv[1])
p.write_text(json.dumps({"status":"activated","candidate":sys.argv[2],
 "activatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+"\n")
p.chmod(0o600)
PY
activated=true
echo "CONSOLE_SYNCED_RELEASE=$candidate"
