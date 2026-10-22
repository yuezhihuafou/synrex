import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Resources } from "./types.js";

const exec = promisify(execFile);
export interface PeerReading { sampledAt: string | null; resources: Resources | null; error: string | null; source: "ssh" }
export type PeerReadings = Record<string, PeerReading>;
export type PeerExec = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

// A bounded, read-only probe over the machine's existing authenticated SSH
// connection. No peer daemon, inbound socket, credentials or Synrex RPC changes.
const PROBE = `import json,os,time,subprocess
def cpu():
 s=open('/proc/stat').readline().split()[1:]; a=[int(x) for x in s]; return sum(a),a[3]+a[4]
a,b=cpu();time.sleep(0.12);c,d=cpu();cpu_usage=max(0,min(100,round(100*(1-(d-b)/(c-a)),2))) if c>a else None
m={}
for line in open('/proc/meminfo'):
 p=line.split(':');m[p[0]]=int(p[1].split()[0])*1024
ps=[]
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 try:
  folder='/proc/'+name
  if os.stat(folder).st_uid!=os.getuid():continue
  s=open(folder+'/stat').read();p=s.rfind(')');f=s[p+2:].split()
  ps.append(dict(pid=int(name),ppid=int(f[1]),name=s[s.index('(')+1:p],state=f[0],startTicks=f[19],cpuPercent=None,rssBytes=int(f[21])*os.sysconf('SC_PAGE_SIZE')))
 except (OSError,ValueError,IndexError):pass
ps.sort(key=lambda x:x['rssBytes'],reverse=True)
g=None;ge=None
try:
 raw=subprocess.run(['nvidia-smi','--query-gpu=name,utilization.gpu,memory.used,memory.total','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=0.9)
 if raw.returncode==0:g=[dict(name=v[0],utilization=float(v[1]),usedMiB=float(v[2]),totalMiB=float(v[3])) for line in raw.stdout.splitlines() if len(v:=[x.strip() for x in line.split(',')])==4]
 else:ge='GPU metrics unavailable'
except (OSError,subprocess.TimeoutExpired):ge='GPU metrics unavailable'
print(json.dumps(dict(hostname=os.uname().nodename,sampledAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),cpuPercent=cpu_usage,cores=os.cpu_count() or 1,totalMemory=m.get('MemTotal',0),usedMemory=m.get('MemTotal',0)-m.get('MemAvailable',m.get('MemFree',0)),load=list(os.getloadavg()),processes=ps[:96],processLimitReached=len(ps)>96,gpu=g,gpuSampledAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),gpuError=ge)))`;
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

export function validatePeerConfig(value: string): [string, string] {
  const match = /^([a-zA-Z0-9_-]{1,64})=([a-zA-Z0-9_.-]{1,128})$/.exec(value);
  if (!match) throw new Error("Peer option must be NODE=SSH_HOST_ALIAS");
  return [match[1], match[2]];
}

export class PeerSampler {
  readonly readings: PeerReadings = {};
  private updated = 0;
  private busy = false;
  constructor(readonly hosts: Record<string, string>, readonly run: PeerExec = (cmd, args, options) => exec(cmd, args, options)) {}
  async poll(now = Date.now()): Promise<void> {
    if (this.busy || now - this.updated < 15_000) return;
    this.updated = now;
    this.busy = true;
    try {
      await Promise.all(Object.entries(this.hosts).slice(0, 4).map(async ([id, host]) => {
        try {
          const { stdout } = await this.run("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=2", "-o", "ConnectionAttempts=1", host, `python3 -c ${quote(PROBE)}`], { timeout: 4000, maxBuffer: 90 * 1024 });
          const data = JSON.parse(stdout) as Resources;
          if (!data || typeof data.hostname !== "string" || !Number.isFinite(data.totalMemory) || !Array.isArray(data.processes) || data.processes.length > 96) throw new Error("Invalid peer probe result");
          this.readings[id] = { resources: data, sampledAt: data.sampledAt, error: null, source: "ssh" };
        } catch {
          this.readings[id] = { resources: null, sampledAt: null, error: "节点采集不可用（SSH、Python 或网络异常）", source: "ssh" };
        }
      }));
    } finally { this.busy = false; }
  }
}
