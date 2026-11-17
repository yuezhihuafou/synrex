# Codex / Synrex opt-in boundary (2026-11-17)

**Decision:** Synrex must not be an implicit fallback when the user selected
Codex. Synrex is chosen only by an explicit user request for the current task,
independently of whether the execution workspace is on swy1, gateway or Windows.

**Implementation:** The MCP `initialize` instructions, service description and
`open_workspace` tool description make Synrex opt-in instead of recommending it
for every coding request. The coordinator (and any other Synrex HTTP ingress)
defaults to denying identifiable Codex MCP clients **before** tool dispatch or
peer routing, including authenticated registered OAuth client names, user-agent
signatures and initialize clientInfo. This default applies on any host because
it is set by `loadConfig()`, not a swy1-specific instruction file.

The owner can explicitly permit *direct Codex MCP clients* by configuring
`DEVSPACE_ALLOW_CODEX_MCP_CLIENTS=1` on the actual Synrex server and restarting
it. This is a **server-wide administrative opt-in**, not a per-task user-consent
signal; leave it unset for normal use. It does not automatically grant OAuth,
root access or permission for physical operations.

Codex's global `~/.codex/AGENTS.md` instruction is applied with
`python3 scripts/codex-opt-in-policy.py --apply` on each accessible host;
the script is idempotent and backs up preexisting instructions. The advisory
instruction cannot replace an enforceable server policy.

**Limits:** The server does not receive the raw conversation instruction from
ChatGPT. A tool call from a GPT host using its existing "ChatGPT" OAuth identity
cannot be cryptographically distinguished from GPT's accidental auto-selection
of Synrex. OAuth client names and user-agent signatures are also declared by
clients, not an attested runtime identity. Therefore this policy is an actual
default denial for *identifiable direct Codex clients* plus stronger GPT tool
routing guidance, **not** a mathematically guaranteed user-intent firewall.
Enforce strict host-side selection by disabling Synrex in Codex's available
tools and explicitly enabling it only when needed.

**Regression checks:** Codex registered OAuth clients are rejected for both
`initialize` and direct `tools/list`; Codex user-agent/initialize identities
are rejected; ordinary ChatGPT access and owner-enabled Codex remain usable.
Preserve existing OAuth issuer, client registrations and multi-node routing.
