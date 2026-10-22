# Chrome/Chromium browser-side metadata observation

Unpacked opt-in Manifest V3 extension. Go to `chrome://extensions`, enable
Developer mode and choose **Load unpacked**, selecting this directory.
The ChatGPT host's private model inference and internal scheduling remain
unobservable. Browser network completion does not prove a model token became
visible, and Chrome webRequest does not surface arbitrary response body chunks.

The extension saves at most 5000 recent sanitized event records locally, seven
days by timestamp. Its popup exports a JSON file, which the operator can load
into the P012 Web Console for approximate client/server time comparison. It
does **not** transmit data automatically, intercept passwords, or modify
network responses. Events with no shared server trace ID are explicitly
inferred by time and may not uniquely identify a request.

After installation, the extension also records the current ChatGPT tab title
(up to 120 characters) whenever it changes. Titles may contain personal
information; the records remain local until exported by the operator.
No URL, prompt, or response body is captured. A browser title alone never
establishes an exact mapping to an MCP request ID.

Manifest host permissions cover only `chatgpt.com` and `chat.openai.com`.
If the browser app moves to a different hostname the extension will not
capture it until the operator reviews and updates the allowlist.

### Validation (version 1.1)

1. Reload the unpacked extension in Chrome and refresh the ChatGPT tab.
2. With the ChatGPT tab active, open the extension popup and choose
   **测试实际页面网络采集**. This sends one credential-free favicon request
   and verifies actual network start/completion events in local storage.
3. Use the chat normally, export the sanitized JSON and import it into P012.
4. Confirm entries include `started`, `headers_received`,
   `first_response` (when Chrome exposes it), `completed` or
   `network_error`, plus any UI `transport_timeout`. A request with
   `started` but no completion remains an **incomplete observation**, not
   necessarily a server failure.

Background capture persists in-flight references in `chrome.storage.session`
to survive service-worker suspension during a stream. Events carry a random
per-browser flowId only; no cross-service request ID is claimed. On systems
where Chrome does not expose response phase callbacks, keep that phase
unknown rather than fabricating timing.
ChatGPT service-worker traffic without a tab ID is saved with an unknown tab
association. WebSocket message frames and socket lifetime are **not** available
through Chrome webRequest. This extension intentionally does not request broad
WebSocket host permissions; a completed HTTPS request is not equivalent to a
completed ChatGPT message.
Network metadata is kept in five-minute local shards, up to 5000 recent
events or seven days (whichever is shorter). High-volume sessions may rotate
well before seven calendar days. Export important incidents promptly.
