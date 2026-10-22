async function update(){
  const {events=[]}=await chrome.storage.local.get("events");
  document.getElementById("count").textContent="本机保留 "+events.length+" 条 / 最多 7 天";
  return events;
}
document.getElementById("export").onclick=async()=>{
  const events=await update();
  const blob=new Blob([JSON.stringify({schema:"synrex.browser.v1",exportedAt:new Date().toISOString(),events},null,2)],
    {type:"application/json"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");link.href=url;link.download="synrex-browser-metadata.json";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
document.getElementById("clear").onclick=async()=>{await chrome.storage.local.remove("events");await update();};
update();
