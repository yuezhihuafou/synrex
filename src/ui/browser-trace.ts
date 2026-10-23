/** Browser HAR is parsed locally: URLs, headers, cookies and bodies never leave the browser. */
export type BrowserEvent = { at: string; durationMs: number; host: string; path: string; method: string; status: number; error: string; requestId?: string };

export function parseHar(input: unknown): BrowserEvent[] {
  if (!input || typeof input !== "object") throw new Error("Not a HAR document");
  const entries = (input as {log?: {entries?: unknown}}).log?.entries;
  if (!Array.isArray(entries)) throw new Error("HAR log.entries missing");
  if (entries.length > 15000) throw new Error("Too many entries");
  return entries.flatMap((item): BrowserEvent[] => {
    if (!item || typeof item !== "object") return [];
    const entry = item as {startedDateTime?: string; time?: number; request?: {url?: string; method?: string}; response?: {status?: number}; _error?: string};
    const started = Date.parse(entry.startedDateTime ?? "");
    if (!Number.isFinite(started)) return [];
    let url: URL;
    try { url = new URL(entry.request?.url ?? ""); } catch { return []; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return [];
    // Deliberately discard query strings, fragments, raw headers and response payloads.
    const requestId = url.searchParams.get("request_id") ?? undefined;
    return [{at: new Date(started).toISOString(), durationMs: Number.isFinite(entry.time) ? Math.max(0,entry.time!) : 0,
      host:url.host, path:url.pathname.slice(0,180), method:(entry.request?.method ?? "GET").slice(0,12),
      status:entry.response?.status ?? 0, error: (entry._error ?? "").slice(0,100),
      requestId:requestId && /^[\w-]{8,100}$/.test(requestId) ? requestId : undefined}];
  }).sort((a,b)=>a.at.localeCompare(b.at));
}
