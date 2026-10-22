import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// Dependency-free Chrome DevTools QA. Credentials stay inside the test process.
const url = process.argv[2] ?? "http://127.0.0.1:4318/console/";
const authFile = process.argv[3];
if (!authFile) throw new Error("Usage: tsx scripts/console-monitor-browser-qa.ts URL AUTH_JSON [SCREENSHOT_PREFIX]");
const profile = await mkdtemp(path.join(tmpdir(), "synrex-console-browser-"));
const chrome = spawn("/usr/bin/google-chrome", ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {stdio:["ignore","ignore","pipe"]});
let socket: WebSocket | undefined;
const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
let nextId = 1;
try {
  const endpoint = await new Promise<string>((resolve,reject)=>{
    let stderr="";
    const timer=setTimeout(()=>reject(new Error("Chrome startup timeout")),15000);
    chrome.stderr.on("data",chunk=>{stderr+=String(chunk);const match=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    chrome.once("exit",()=>{clearTimeout(timer);reject(new Error("Chrome exited"));});
  });
  socket=new WebSocket(endpoint);
  await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=()=>reject(new Error("DevTools connection failed"));});
  socket.onmessage=message=>{const data=JSON.parse(String(message.data));if(data.id){const p=pending.get(data.id);pending.delete(data.id);if(data.error)p?.reject(new Error(data.error.message));else p?.resolve(data.result);}};
  const call=(method:string,params:Record<string,unknown>={},sessionId?:string)=>new Promise<any>((resolve,reject)=>{
    const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},12000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    socket!.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  const {targetId}=await call("Target.createTarget",{url:"about:blank"});
  const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
  const cdp=(method:string,params:Record<string,unknown>={})=>call(method,params,sessionId);
  await cdp("Page.enable");await cdp("Runtime.enable");
  const evaluate=async(expression:string)=>{const r=await cdp("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
  const waitFor=async(expression:string)=>{for(let i=0;i<80;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error(`DOM condition timed out: ${expression}`);};
  await cdp("Emulation.setDeviceMetricsOverride",{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await cdp("Page.navigate",{url});await waitFor("!!document.querySelector('input[type=password]')");
  const password=JSON.parse(await readFile(authFile,"utf8")).ownerToken;
  const login=await evaluate(`fetch('/console/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.status)`);
  assert.equal(login,200);
  await cdp("Page.reload");await waitFor("!!document.querySelector('.sidebar') && document.body.innerText.includes('实时连接')");
  const checks:string[]=[];
  checks.push("authenticated login and SSE live state");
  const screenshot=async(suffix:string)=>{if(process.argv[4]){const shot=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile(`${process.argv[4]}-${suffix}.png`,Buffer.from(shot.data,"base64"));}};
  await screenshot("desktop");
  for(const label of ["活动执行","主机进程","日志与链路","统计分析","主机节点","项目与工作流"]){
    await evaluate(`Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`);
    await waitFor(`!!document.querySelector('h1') && document.querySelector('h1').textContent===${JSON.stringify(label)}`);
    if(label==="统计分析")await waitFor("!!document.querySelector('.bar-chart')");
    checks.push(`navigation: ${label}`);
  }
  await evaluate("Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent.includes('活动执行')).click()");
  await waitFor("!!document.querySelector('.segments')");
  await evaluate("Array.from(document.querySelectorAll('.segments button')).find(b=>b.textContent==='全部').click()");
  await waitFor("!!document.querySelector('tbody tr[tabindex]')");
  await evaluate("document.querySelector('tbody tr[tabindex]').click()");await waitFor("!!document.querySelector('.drawer .terminal')");
  checks.push("execution detail and output panel");
  await evaluate("document.querySelector('[aria-label=关闭详情]').click();Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent.includes('实时总览')).click()");
  await cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await new Promise(r=>setTimeout(r,300));
  const overflow=await evaluate("document.documentElement.scrollWidth>window.innerWidth");assert.equal(overflow,false);
  await screenshot("mobile");checks.push("390px mobile layout: no page overflow");
  console.log(JSON.stringify({url,checks,passed:checks.length},null,2));
  await cdp("Page.close");
} finally {
  socket?.close();chrome.kill("SIGTERM");
  await new Promise(r=>setTimeout(r,200));await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
