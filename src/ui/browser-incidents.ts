import type { BrowserEvent } from "./browser-trace.js";

export type BrowserIncident = { id: string; at: string; trigger: BrowserEvent; events: BrowserEvent[] };
export function detectBrowserIncidents(events: BrowserEvent[]): BrowserIncident[] {
  const ordered = [...events].sort((a,b)=>a.at.localeCompare(b.at));
  const incidents: BrowserIncident[] = [];
  for (const event of ordered) {
    if (!(event.error || event.status===429 || event.status>=500 || event.durationMs>30000)) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const id = [event.at,event.host,event.path,event.status,event.error].join("|");
    if (incidents.some(x=>x.id===id)) continue;
    incidents.push({id,at:event.at,trigger:event,
      events:ordered.filter(x=>Date.parse(x.at)>=at-60000 && Date.parse(x.at)<=at+15000).slice(-250)});
  }
  return incidents.slice(-30);
}
