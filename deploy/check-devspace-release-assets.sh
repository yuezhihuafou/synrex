#!/bin/sh
set -eu
root=${1:?Usage: check-devspace-release-assets.sh <release-directory>}
test -f "$root/dist/cli.js"
test -f "$root/dist/server.js"
test -f "$root/package.json"
test -f "$root/skills/subagents/SKILL.md"
test -d "$root/node_modules"
test -f "$root/release-manifest.json"
printf '%s\n' "DevSpace release runtime assets verified"
