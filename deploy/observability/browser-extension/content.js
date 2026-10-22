// Inspect *only* visible alert/status widgets for a small fixed list of error
// categories; never copy/serialize the text, messages, model output or DOM.
(() => {
  let last = "", lastAt = 0;
  const classify = value => {
    if (/消息传输超时|message transmission timed out|message transport timed out/i.test(value))return "transport_timeout";
    if (/network error|网络错误|network connection lost/i.test(value))return "network_error";
    return null;
  };
  function inspect() {
    for(const element of document.querySelectorAll('[role="alert"],[aria-live="assertive"]')){
      const content=element.textContent?.slice(0,300)??"";
      const code=classify(content);
      if(!code)continue;
      const now=Date.now();
      if(code===last && now-lastAt<60000)continue;
      last=code;lastAt=now;
      chrome.runtime.sendMessage({kind:"synrex_visible_error",code}).catch(()=>{});
    }
  }
  const observer=new MutationObserver(inspect);
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  inspect();
})();
