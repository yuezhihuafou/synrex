#!/usr/bin/env bash
# Single entrypoint for repeatable, fail-closed Synrex production promotion.
# Develop in any worktree; integrate selected tested commits to main first.
# Run from a clean checkout of that published main (which may be detached).
# The entire --deploy transaction runs in an independent user systemd unit.
# One owner-release flock covers build, QA, backup, activation and rollback;
# the Core being replaced is never the parent of its own release transaction.
set -euo pipefail
mode=${1:---check}
source_repo=${2:-$(pwd)}
if test "$mode" != --check && test "$mode" != --deploy; then
  echo "Usage: promote-main.sh --check|--deploy [clean-source-checkout]" >&2
  exit 64
fi
source_repo=$(realpath "$source_repo")
cd "$source_repo"
if test "$mode" = --deploy && test "${SYNREX_PROMOTION_WORKER:-}" != 1; then
  # Dispatch BEFORE taking the transaction lock. The systemd worker owns it
  # until activation (or rollback) completes, even if the MCP caller drops.
  test -f "$source_repo/deploy/promote-main.sh"
  unit="synrex-promotion-$(date -u +%Y%m%d%H%M%S)-${BASHPID}"
  systemd-run --user --collect --unit="$unit" \
    --description="Synrex single-owner release transaction" \
    --property=Type=exec --setenv="SYNREX_PROMOTION_WORKER=1" \
    --setenv="PATH=$PATH" \
    /bin/bash "$source_repo/deploy/promote-main.sh" --deploy "$source_repo"
  echo "PROMOTION_DISPATCHED unit=$unit source=$source_repo; check journalctl --user -u $unit and the release receipt"
  exit 0
fi
# The same lock protects standalone activation, rollback and ingress migration.
# --check also holds it while producing a candidate, so no two conversations
# can build/publish or activate a release concurrently.
lockdir="$HOME/.local/state/synrex"
mkdir -p "$lockdir"
exec 8>"$lockdir/owner-release.lock"
if ! flock -n 8; then
  echo 'PROMOTION_BLOCKED another owner release transaction is already running' >&2
  exit 75
fi
base=/home/swy/services/devspace
release_root="$base/releases"
backup_root="$base/backups"
node=/home/swy/.nvm/versions/node/v22.22.2/bin/node
command -v pnpm >/dev/null
test -f deploy/activate-owner-release.sh
test -f scripts/synrex-release-provenance.py
if test -n "$(git status --porcelain=v1)"; then
  echo 'PROMOTION_BLOCKED source checkout has uncommitted or untracked changes' >&2
  exit 75
fi
source_sha=$(git rev-parse --verify HEAD)
if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PROMOTION_BLOCKED invalid source revision' >&2
  exit 75
fi
origin=$(git remote get-url origin)
if test "${origin%/}" != 'https://github.com/yuezhihuafou/synrex.git'; then
  echo 'PROMOTION_BLOCKED this is not the canonical Synrex origin' >&2
  exit 75
fi
main_sha=$(git ls-remote --exit-code origin refs/heads/main | awk '$2=="refs/heads/main"{print $1}')
if test "$source_sha" != "$main_sha"; then
  echo "PROMOTION_BLOCKED this source is not the current main: local=${source_sha:0:12} remote=${main_sha:0:12}" >&2
  exit 75
fi
active_path=$(systemctl --user show devspace.service -p ExecStart | grep -oE '/home/swy/services/devspace/releases/[^ ;]+/dist/cli.js' | head -1)
if test -z "$active_path"; then
  echo 'PROMOTION_BLOCKED actual pinned Core path not found' >&2
  exit 75
fi
active_release=${active_path%/dist/cli.js}
active_sha=$("$node" -e 'const fs=require("node:fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sourceRevision)' "$active_release/release-manifest.json")
if ! git merge-base --is-ancestor "$active_sha" "$source_sha"; then
  echo "PROMOTION_BLOCKED would overwrite production source ${active_sha:0:12}" >&2
  exit 75
fi
if test "$source_sha" = "$active_sha"; then
  echo "PROMOTION_ALREADY_CURRENT $source_sha"
  exit 0
fi
suffix=$(date -u +%Y%m%dT%H%M%SZ)
release_id="synrex-main-${source_sha:0:12}"
target="$release_root/$release_id"
backup="$backup_root/$release_id-$suffix"
dispatch() {
  python3 deploy/backup-owner-state.py \
    --state-dir /home/swy/.local/share/devspace-cutover-20261018 \
    --config-dir /home/swy/.devspace-cutover-20261018 \
    --destination "$backup" --keep 30 >"$backup/backup-receipt.txt"
  # The worker inherits FD 8, so the rollback-safe activation retains the
  # SAME lock rather than opening a second descriptor and deadlocking itself.
  SYNREX_INHERITED_RELEASE_LOCK_FD=8 /bin/bash \
    "$target/deploy/activate-owner-release.sh" "$target" "$backup"
  echo "PROMOTION_RECEIPT=$backup/release-receipt.json"
}
mkdir -p "$backup"
chmod 700 "$backup"
if test -d "$target"; then
  python3 "$target/scripts/synrex-release-provenance.py" --repo "$source_repo" --candidate "$target" \
    >"$backup/provenance.json" || {
      echo "PROMOTION_BLOCKED existing package failed provenance; see $backup/provenance.json" >&2
      exit 75
    }
  echo "PROMOTION_REUSING_VERIFIED_RELEASE=$target"
  if test "$mode" = --deploy; then dispatch; else echo "PROMOTION_READY_NOT_ACTIVATED source=$source_sha"; fi
  exit 0
fi
stage=$(mktemp -d "$release_root/.staging-$release_id-XXXXXXXX")
log="$backup/qa.log"
echo "PROMOTION_BUILDING candidate=$release_id current=${active_sha:0:12}"
{
  echo '--- clean source / typecheck / build ---'
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm build
  pnpm release:source-check
  pnpm architecture:check
  echo '--- regression ---'
  pnpm exec tsx --test --test-concurrency=1 $(find src -name '*.test.ts' ! -name 'local-agent-pi-sandbox.test.ts' | sort)
  python3 -m unittest discover -s tests -p 'test_*p0.py'
  python3 -m unittest discover -s tests -p 'test_release_provenance.py'
  python3 -m unittest discover -s tests -p 'test_activate_owner_release.py'
  python3 -m unittest discover -s tests -p 'test_migrate_stable_ingress.py'
  "$node" --test scripts/ingress-gate.test.mjs
} >"$log" 2>&1 || {
  echo "PROMOTION_BLOCKED QA failed; see $log" >&2
  exit 75
}
echo 'PROMOTION_QA_PASSED'
git archive --format=tar HEAD | tar -xf - -C "$stage"
cp -a dist "$stage/dist"
cp -a node_modules "$stage/node_modules"
git archive --format=tar.gz -o "$stage/source-tree.tar.gz" HEAD
python3 - "$stage" "$release_id" "$backup" "$active_release" <<'PY'
import datetime,hashlib,json,pathlib,sys
root,release,backup,previous=pathlib.Path(sys.argv[1]),sys.argv[2],sys.argv[3],sys.argv[4]
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
assets={p.relative_to(root).as_posix():sha(p) for p in root.rglob("*")
        if p.is_file() and "node_modules" not in p.relative_to(root).parts
        and p.name not in ("release-manifest.json","source-tree.tar.gz")}
dist={k:v for k,v in assets.items() if k.startswith("dist/")}
build=json.loads((root/"dist/build-info.json").read_text())
manifest={
 "release":release,"sourceRevision":build["revision"],
 "sourceDirty":build["dirty"],"sourceFingerprint":build["sourceFingerprint"],
 "toolSchemaFingerprint":"480084c8df97f7211638",
 "distSha256":hashlib.sha256("".join(f"{k} {v}\n" for k,v in sorted(dist.items())).encode()).hexdigest(),
 "distHashMethod":"sha256 of sorted dist/ relative paths and file SHA-256 digests, newline separated",
 "assets":assets,"previousRelease":pathlib.Path(previous).name,
 "generatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
 "qa":"verified full supported regression, package/ingress/authenticated smoke",
 "qaLog":str(pathlib.Path(backup)/"qa.log")
}
(root/"release-manifest.json").write_text(json.dumps(manifest,indent=2,sort_keys=True)+"\n")
print("PROMOTION_PACKAGED",release,"assets",len(assets),"sha",build["revision"][:12])
PY
{
  echo '--- isolated actual Core and OAuth/Console smoke ---'
  "$node" scripts/probe-stable-ingress.mjs "$stage"
  DEVSPACE_CONFIG_DIR=/home/swy/.devspace-cutover-20261018 pnpm exec tsx scripts/probe-reliable-release.ts "$stage"
} >>"$log" 2>&1 || {
  echo "PROMOTION_BLOCKED isolated auth/Core smoke failed; see $log" >&2
  exit 75
}
python3 "$stage/scripts/synrex-release-provenance.py" --repo "$source_repo" --candidate "$stage" >"$backup/provenance.json" || {
  echo "PROMOTION_BLOCKED newer main, production mismatch, or corrupted package; see $backup/provenance.json" >&2
  exit 75
}
if test -e "$target"; then
  echo "PROMOTION_BLOCKED release already exists; never overwrite immutable releases: $target" >&2
  exit 75
fi
chmod -R a-w "$stage"
mv "$stage" "$target"
echo "PROMOTION_IMMUTABLE_RELEASE=$target"
if test "$mode" = --check; then
  echo "PROMOTION_READY_NOT_ACTIVATED source=$source_sha"
  exit 0
fi
dispatch
