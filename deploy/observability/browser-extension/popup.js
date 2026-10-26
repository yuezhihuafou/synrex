async function allEvents(){
  const stored=await chrome.storage.local.get(null);
  const events=[...(Array.isArray(stored.events)?stored.events:[]),
    ...(Array.isArray(stored["synrex.incidents"])?stored["synrex.incidents"]:[])];
  for(const [key,value] of Object.entries(stored)){
    if(key.startsWith("synrex.events.") && Array.isArray(value))events.push(...value);
  }
  const unique=new Map(events.filter(e=>Number.isFinite(e.ts)&&Date.now()-e.ts<7*86400000)
    .map(e=>[[e.kind,e.reason,e.ts,e.tabId,e.flowId].join(":"),e]));
  const values=[...unique.values()].sort((a,b)=>a.ts-b.ts);
  const protectedIncidents=values.filter(e=>e.reason==="transport_timeout"||e.reason==="network_error");
  const normal=values.filter(e=>e.reason!=="transport_timeout"&&e.reason!=="network_error");
  return [...normal.slice(-4000),...protectedIncidents.slice(-1000)].sort((a,b)=>a.ts-b.ts);
}
async function update(){
  const events=await allEvents();
  document.getElementById("count").textContent="本机保留 "+events.length+" 条 / 最多 7 天";
  return events;
}
document.getElementById("export").onclick=async()=>{
  const events=await update();
  const blob=new Blob([JSON.stringify({schema:"synrex.browser.v1",exportedAt:new Date().toISOString(),events})],
    {type:"application/json"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");link.href=url;link.download="synrex-browser-metadata.json";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
document.getElementById("clear").onclick=async()=>{
  const stored=await chrome.storage.local.get(null);
  await chrome.storage.local.remove(["events","synrex.incidents",...Object.keys(stored).filter(k=>k.startsWith("synrex.events."))]);
  await update();
};
document.getElementById("test").onclick=async()=>{
  const output=document.getElementById("test-result");
  output.textContent="检查当前 ChatGPT 标签页...";
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url??"")){
      output.textContent="请先切换到 ChatGPT 对话标签页";return;
    }
    const before=Date.now();
    const response=await chrome.tabs.sendMessage(tab.id,{kind:"synrex_selftest_request"});
    if(!response?.started)throw Error("content script not responding");
    await new Promise(resolve=>setTimeout(resolve,1400));
    const events=await allEvents();
    const probe=events.filter(e=>e.endpointGroup==="self_test"&&e.ts>=before-1500);
    const first=probe.some(e=>e.reason==="started");
    const finished=probe.some(e=>e.reason==="completed"||e.reason==="network_error");
    output.textContent=first&&finished
      ?"通过：已采集真实浏览器请求的开始和结束"
      :first?"部分通过：已记录开始，尚未收到结束事件"
      :"未通过：浏览器请求未进入采集器，请重新加载扩展并刷新 ChatGPT";
    await update();
  }catch{
    output.textContent="测试失败：请重新加载扩展并刷新 ChatGPT 对话页";
  }
};
update();
