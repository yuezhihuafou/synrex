// This is a client-routing preference, not an identity/authentication mechanism.
// OAuth authenticates the caller; client names and user agents can be spoofed.
const CODEX_CLIENT_NAME = /(?:^|[^a-z0-9])(?:openai[ -]?)?codex(?:[^a-z0-9]|$)/i;

export function isCodexMcpClient(values: {
  registeredName?: string;
  userAgent?: string;
  initializeClientName?: string;
}): boolean {
  return [values.registeredName, values.userAgent, values.initializeClientName]
    .some((value) => typeof value === "string" && CODEX_CLIENT_NAME.test(value));
}

export const SYNREX_EXPLICIT_SELECTION_RULE =
  "Synrex is opt-in. Use its tools only when the user explicitly requests Synrex " +
  "for the current task. A generic coding request or a request to use Codex " +
  "is not authorization to switch to Synrex, including on another host. " +
  "If Codex is selected, use Codex's own tools and do not invoke Synrex " +
  "or its durable-task tools as a fallback. ";
