# Release tag authorization and fail-closed publishing

GitHub restricts creating a new ref that introduces a change to
`.github/workflows/*` unless the actor has explicit workflow write
permission. Neither a typical `repo`-scope OAuth App credential nor the
repository's GitHub Actions `GITHUB_TOKEN` with `contents: write` is
sufficient to create the v0.4.1 tag for this repository. Do not remove
the workflow files, rewrite old commits, create a lightweight tag as a
substitute, or retry publication with a different unverified source.

The source for the v0.4.1 security patch was fully accepted at:

- Exact source SHA: `cdcc5937fe8a3b30628838643ddff7066c2efd03`
- Main CI: https://github.com/yuezhihuafou/synrex/actions/runs/43811544018
- Verified: Ubuntu full suite, macOS and Windows native installation,
  official npm dependency security audit (zero vulnerability findings),
  and the isolated production OAuth/Console/MCP qualification receipt
  `PROMOTION_READY_NOT_ACTIVATED`.

## Authorized maintainer action

In an authenticated GitHub CLI session that has `workflow` permission,
refresh scopes if necessary:

```bash
gh auth refresh -h github.com -s workflow
gh auth status
```

From a clean clone of the canonical repository, verify that v0.4.1 is
absent, the expected source is an ancestor of canonical main, and the
known CI run completed successfully. Then create the annotated tag
without force or any existing-ref update:

```bash
git fetch origin main --tags
git merge-base --is-ancestor cdcc5937fe8a3b30628838643ddff7066c2efd03 origin/main
if test -n "$(git ls-remote origin refs/tags/v0.4.1)"; then
  echo 'v0.4.1 already exists: do not modify it' >&2
else
  git tag -a v0.4.1 cdcc5937fe8a3b30628838643ddff7066c2efd03 \
    -m 'Synrex v0.4.1 security and reproducible release' &&
  git push origin refs/tags/v0.4.1:refs/tags/v0.4.1
fi
```

Check the printed branch and tag identities before running this block,
and do not continue if GitHub cannot be reached. The tag push uses no
force flag and refuses an existing remote ref.

Then dispatch the release workflow against canonical main while passing
the **exact tagged source**:

```bash
gh workflow run release.yml --repo yuezhihuafou/synrex --ref main \
  -f version=0.4.1 \
  -f source_sha=cdcc5937fe8a3b30628838643ddff7066c2efd03
```

The workflow checks tag type, exact source identity, main ancestry and
its successful CI run, performs package checks and production dependency
audit, emits CycloneDX SBOM and SHA256SUMS, attests archive provenance,
and refuses to overwrite an existing GitHub Release. Release
publication does not imply a live production deployment.

## Runtime ownership

The production Owner and standalone Console are separately pinned.
Never change their OAuth issuer, stored grants, SQLite or backup
directory as a side effect of a GitHub tag. The live runtime must be
promoted separately using the guarded, backed-up deployment path only
after confirming source and services, avoiding concurrent promotion
transactions and unrelated feature changes.
