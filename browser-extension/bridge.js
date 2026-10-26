// Read-only page bridge; the extension never receives ChatGPT page contents.
let active = true;
let lastSignature = "";
function poll(){
  if(!active)return;
  chrome.runtime.sendMessage({type:"synrex-browser-trace-read"},response=>{
    if(chrome.runtime.lastError || !response?.events)return;
    // A stable snapshot does not need another full page postMessage every 3s.
    const last=response.events[response.events.length-1];
    const signature=[response.events.length,last?.at,last?.path,last?.durationMs].join(":");
    if(signature===lastSignature)return;
    lastSignature=signature;
    window.postMessage({type:"synrex-browser-trace-v1",events:response.events},location.origin);
  });
}
poll();
const interval=setInterval(poll,3000);
window.addEventListener("pagehide",()=>{active=false;clearInterval(interval);},{once:true});
