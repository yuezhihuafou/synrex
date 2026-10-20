#!/usr/bin/env python3
"""Local SSH recovery. Uses the installed service runtime/config; never prints secrets."""
import os,shlex,subprocess,sys,re
os.environ.setdefault('XDG_RUNTIME_DIR','/run/user/'+str(os.getuid()))
def prop(name):return subprocess.check_output(['systemctl','--user','show','devspace.service','-p',name,'--value'],text=True).strip()
match=re.search(r'argv\[\]=([^;]+)',prop('ExecStart'))
if not match:raise SystemExit('Cannot identify installed production ExecStart; no state modified.')
argv=shlex.split(match.group(1).strip())
if len(argv)<3 or argv[-1]!='serve' or not argv[1].endswith('/dist/cli.js'):raise SystemExit('Unexpected production entrypoint; no state modified.')
env=os.environ.copy()
for item in shlex.split(prop('Environment')):
 if item.startswith('DEVSPACE_CONFIG_DIR='):env['DEVSPACE_CONFIG_DIR']=item.split('=',1)[1]
if not env.get('DEVSPACE_CONFIG_DIR'):raise SystemExit('Production config directory is not explicit; no state modified.')
args=sys.argv[1:]
if args==['status']:cmds=[['status']]
elif args==['close']:cmds=[['lock']]
elif len(args)==2 and args[0]=='window' and args[1].isdigit() and 1<=int(args[1])<=15:cmds=[['lock'],['window',args[1],'--once']]
else:raise SystemExit('Usage: devspace-auth-admin status | window <1-15 minutes> | close')
for cmd in cmds:subprocess.run(argv[:2]+['oauth']+cmd,env=env,check=True,cwd=os.path.dirname(os.path.dirname(argv[1])))
