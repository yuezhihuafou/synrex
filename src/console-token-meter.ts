import { getEncoding, type Tiktoken } from "js-tiktoken";

// Tool content only: do not claim knowledge of ChatGPT's hidden prompt, reasoning or model tokenizer.
export const TOOL_TOKEN_ENCODING = "o200k_base" as const;
// Bound main-thread encoding and per-request buffering; large results are unmeasured, never guessed.
// Keep this Worker-side guard equal to console-token-policy.ts's main-thread bound.
export const MAX_TOOL_METER_BYTES = 256 * 1024;
let encoder: Tiktoken | undefined;

function tokens(text: string): number | null {
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_METER_BYTES) return null;
  try {
    encoder ??= getEncoding(TOOL_TOKEN_ENCODING);
    return encoder.encode(text).length;
  } catch { return null; } // Metering can never break a real tool call.
}

/** Used by a dedicated worker so BPE encoding never stalls the MCP event loop. */
export function countSerializedToolTokens(text: string): number | null { return tokens(text); }

/** Count the JSON tool arguments actually received, not guessed wire bytes. */
export function countToolInputTokens(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const rpc = body as { method?: unknown; params?: { arguments?: unknown } };
  if (rpc.method !== "tools/call") return null;
  try { return tokens(JSON.stringify(rpc.params?.arguments ?? {})); }
  catch { return null; }
}

/** The host-visible tool result's text blocks; not HTTP/SSE protocol framing. */
function resultText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const data = message as { result?: { content?: unknown; structuredContent?: unknown } };
  if (!data.result || typeof data.result !== "object") return null;
  const blocks = data.result.content;
  if (Array.isArray(blocks) && blocks.length) {
    if (!blocks.every(b => b && b.type === "text" && typeof b.text === "string")) return null;
    return blocks.map((b: { text: string }) => b.text).join("\n");
  }
  if (data.result.structuredContent !== undefined) {
    try { return JSON.stringify(data.result.structuredContent); } catch { return null; }
  }
  return null;
}

/** Count only completed tool results. Unparseable, oversized or non-text output stays unknown. */
export function countToolOutputTokens(body: string, mode: "sse" | "json" | "unknown"): number | null {
  if (Buffer.byteLength(body, "utf8") > MAX_TOOL_METER_BYTES) return null;
  try {
    if (mode === "json") {
      const text = resultText(JSON.parse(body));
      return text === null ? null : tokens(text);
    }
    if (mode !== "sse") return null;
    for (const block of body.split(/\r?\n\r?\n/)) {
      const line = block.split(/\r?\n/).filter(s => s.startsWith("data:")).map(s => s.slice(5).trimStart()).join("\n");
      if (!line || line === "[DONE]") continue;
      let parsed: unknown;
      try { parsed=JSON.parse(line); } catch { continue; }
      const text = resultText(parsed);
      if (text !== null) return tokens(text);
    }
  } catch { /* Never guess from malformed or partially delivered streams. */ }
  return null;
}
