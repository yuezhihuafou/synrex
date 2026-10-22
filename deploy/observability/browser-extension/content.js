// Inspect *only* visible alert/status widgets for a small fixed list of error
// categories; never copy/serialize the text, messages, model output or DOM.
(() => {
  let last = "", lastAt = 0;
  let lastTitle = "";
  const report = code => {
    if(!code)return;
    const now=Date.now();
    if(code===last && now-lastAt<60000)return;
    last=code;lastAt=now;
    chrome.runtime.sendMessage({kind:"synrex_visible_error",code}).catch(()=>{});
  };
  function inspectTitle() {
    const title=(document.title??"").replace(/\s*[-|]\s*ChatGPT\s*$/i,"").trim().slice(0,120);
    if(!title || /^ChatGPT$/i.test(title) || title===lastTitle || /[\x00-\x1f\x7f]/.test(title)) return;
    lastTitle=title;
    chrome.runtime.sendMessage({kind:"synrex_conversation_title",title}).catch(()=>{});
  }
  const classify = value => {
    if (/消息传输超时|message transmission timed out|message transport timed out/i.test(value))return "transport_timeout";
    if (/network error|网络错误|network connection lost/i.test(value))return "network_error";
    return null;
  };
  function inspect() {
    inspectTitle();
    for(const element of document.querySelectorAll('[role="alert"],[role="status"],[aria-live="assertive"],[aria-live="polite"],[data-testid*="toast"]')){
      const content=element.textContent?.slice(0,300)??"";
      report(classify(content));
    }
  }
  // Some ChatGPT banners are ordinary DIVs without role=alert. Inspect only
  // short, newly-added text leaves outside message/prompt containers. Neither
  // the leaf text nor a selector is ever transmitted or persisted.
  let scanScheduled=false;
  function inspectMutations(changes){
    if(!scanScheduled){
      scanScheduled=true;
      setTimeout(()=>{scanScheduled=false;inspect();},250);
    }
    let tested=0;
    for(const change of changes.slice(0,32)){
      for(const added of [...change.addedNodes].slice(0,16)){
        const root=added.nodeType===3?added.parentElement:added;
        if(root?.closest?.('[data-message-author-role], [data-testid*="conversation-turn"], [contenteditable="true"]'))continue;
        const leaves=added.nodeType===3?[added]:added.querySelectorAll
          ?[added,...added.querySelectorAll("span,div,p")].slice(0,25):[];
        for(const node of leaves){
          if(++tested>150)return;
          if(node.children?.length>1)continue;
          const content=node.textContent;
          if(content?.length>150)continue;
          const code=classify(content??"");
          if(!code)continue;
          const element=node.nodeType===3?node.parentElement:node;
          const visuallyError=element?.closest?.('[role="alert"],[role="status"],[aria-live],'+
            '[data-testid*="toast"],[data-testid*="error"],[class*="border-red"],'+
            '[class*="text-red"],[class*="destructive"],[class*="toast"],[class*="error-banner"]');
          if(visuallyError)report(code);
        }
      }
    }
  }
  const observer=new MutationObserver(inspectMutations);
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  inspect();
  new MutationObserver(inspectTitle).observe(document.querySelector("title")??document.head,
    {childList:true,characterData:true,subtree:true});
  document.addEventListener("visibilitychange",()=>{
    chrome.runtime.sendMessage({kind:"synrex_tab_state",state:document.hidden?"hidden":"visible"}).catch(()=>{});
  });
  for(const state of ["pagehide","pageshow"]){
    window.addEventListener(state,()=>chrome.runtime.sendMessage({kind:"synrex_tab_state",state}).catch(()=>{}));
  }
  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message?.kind!=="synrex_selftest_request")return;
    // The test makes a small credential-free browser-tab request to prove
    // webRequest lifecycle capture, not merely message storage.
    fetch("/favicon.ico?_synrex_probe="+Date.now(),{method:"GET",cache:"no-store",credentials:"omit"})
      .then(()=>reply({started:true})).catch(()=>reply({started:true}));
    return true;
  });
})();
