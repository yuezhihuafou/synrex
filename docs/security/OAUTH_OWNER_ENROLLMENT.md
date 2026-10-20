# Synrex owner-controlled OAuth enrollment

## Current production recovery policy (2026-10-18)

swy1 is the sole public OAuth authority. Production uses the pinned release
`/home/swy/services/devspace/releases/20261018-auth-three-node-recovery`
and `DEVSPACE_CONFIG_DIR=/home/swy/.devspace-cutover-20261018`.
The permanent password-only policy described in prior recovery notes is superseded.
New enrollment is locked except for a bounded local-admin recovery window.

From an authenticated SSH shell on swy1, run:

```bash
~/.local/bin/devspace-auth-admin status
~/.local/bin/devspace-auth-admin window 10
~/.local/bin/devspace-auth-admin close
```

The wrapper discovers the installed systemd runtime and config, including when
the service is stopped. It never prints secrets or replaces the database.
`window 10` permits one completed new connection, for at most ten minutes.
It automatically closes when a newly issued access token is first authenticated
by MCP, rather than merely when tokens are issued. Thus loss of a token response
still leaves time for a new authorization attempt. Existing client requests do
not close the pending window. Refresh and existing bearer grants survive closure.
Direct CLI `oauth window 10 --once` enables the same behavior after a local lock.

The public connector remains `https://devspace.yuezhihuafou.dpdns.org/mcp`.
Gateway's Cloudflare service and watchdog timer are disabled; a `ConditionHost=swy1`
drop-in prevents its watchdog or manual service starts from reviving that connector.
Gateway keeps its computation service and private SSH relay to swy1.

Synrex's OAuth implementation uses an owner secret and bearer tokens. It does **not**
receive or verify a signed ChatGPT account identity. A ChatGPT OAuth client ID is
an application identifier, **not** proof of which workspace member is using it.

## Production lockdown

On the gateway and on each independent Synrex worker, run:

```bash
cd ~/Synrex
node dist/cli.js oauth lock
node dist/cli.js oauth status
```

Lockdown rejects new dynamic client registrations, `/authorize` requests, and
authorization-code exchanges. Existing bearer access tokens and **refresh token
rotations** continue to work. No credentials, OAuth clients, or token rows are
rewritten. This applies even if a new OAuth code was obtained before lockdown.

In locked mode `pnpm deploy:live` intentionally skips synthetic production
OAuth client/token creation. It verifies the HTTP OAuth challenge and compiled
schema, but **cannot** verify authenticated live tools by itself. Validate via
an existing ChatGPT MCP connection and disclose any remaining verification gap.

The policy is kept in `oauth-enrollment.json` under the configured state
directory. It is written atomically with owner-only permissions. Removing this
file would restore the *legacy open* behavior, so keep the file in place; the
status command explicitly labels a missing policy as `UNLOCKED (legacy)`.

## Remote recovery without an existing MCP session

Open `https://devspace.yuezhihuafou.dpdns.org/oauth/recovery` in a browser,
enter the configured Owner password, and submit. This opens a persistent
15-minute window which expires automatically, including across restarts.
Then connect the phone using `https://devspace.yuezhihuafou.dpdns.org/mcp`.
The recovery page is independent of bearer authentication and the enrollment
lock; locking enrollment must never disable this page. It requires same-origin
POSTs, limits submissions to five per minute per process, and sends no-store
and frame-blocking headers. It changes only the enrollment policy, never OAuth
clients, access tokens, refresh tokens, or the public authentication requirement.
Do not remove the policy file to recover: absence permits indefinite enrollment.

This fixes loss of the only authenticated MCP session. It still depends on the
public HTTP service and Tunnel. A complete host/network/Tunnel outage needs a
separate reachable administrative channel (SSH/VPN/console); an HTTP recovery
page cannot repair its own unavailable transport. Do not claim remote SSH
recovery is verified merely because the local SSH service is running.

For an administrative-shell fallback on the current public coordinator, use
its actual production config and release (not an obsolete peer database):

```bash
export DEVSPACE_CONFIG_DIR=/home/swy/.devspace-cutover-20261018
node /home/swy/services/devspace/releases/20261018-password-oauth/dist/cli.js oauth window 15
```

For a deliberate **new** owner connection, an administrative shell can also
open a window and complete the ChatGPT authorization in that window:

```bash
node dist/cli.js oauth window 10
# Complete owner-only sign-in; the window expires automatically after 10 minutes.
node dist/cli.js oauth lock
```

The window accepts integer durations of 1–15 minutes and does not require a
Synrex restart. A service restart does not extend the window. Always re-lock
immediately after authorization if it finishes before expiry. The machine owner
should do this through a trusted administrative shell, not by instructing a
potentially untrusted MCP client to invoke `exec_command`.

## Limits: publishing a workspace app

- An existing bearer token grants access **regardless of the new-enrollment
  lock**. If ChatGPT shares an administrator-managed provider connection or
  its tokens with other workspace members, this server cannot distinguish
  those members. Do not publish using a shared/workspace-wide connection.
- Strong owner-password secrecy and short enrollment windows reduce the
  chance of newly authorized users, but they do not establish per-user
  authorization. Do not promise "only my ChatGPT account" without a trusted
  identity provider whose verified subject can be allowlisted server-side.
- A holder of an existing Synrex token has powerful shell/file access and
  might run the local enrollment CLI itself. True resistance to compromised
  sessions needs a **separate OS/identity-provider security boundary**, not
  another file owned by the Synrex execution account.
- ChatGPT action-confirmation policy is separate from OAuth enrollment. This
  lockdown does not switch ChatGPT to `Never ask`.

If ChatGPT requires a new OAuth connection after publishing, use a brief window
for that connection, then lock again. Keep only one public gateway Tunnel; the
worker should remain unexposed publicly.
