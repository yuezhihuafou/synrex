// Read-only page bridge; the extension never receives ChatGPT page contents.
let active = true;
function poll(){
  if(!active)return;
  chrome.runtime.sendMessage({type:"synrex-browser-trace-read"},response=>{
    if(chrome.runtime.lastError || !response?.events)return;
    window.postMessage({type:"synrex-browser-trace-v1",events:response.events},location.origin);
  });
}
poll();
const interval=setInterval(poll,3000);
window.addEventListener("pagehide",()=>{active=false;clearInterval(interval);},{once:true});
