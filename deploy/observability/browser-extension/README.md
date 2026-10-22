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
