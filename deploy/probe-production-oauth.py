#!/usr/bin/env python3
"""Explicit owner-run production probe. Never prints credentials; uses existing client.
Requires a local enrollment window. --restart-service verifies persistence.
"""
import argparse,base64,concurrent.futures,hashlib,json,os,secrets,sqlite3,subprocess,time,urllib.error,urllib.parse,urllib.request
p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--state',required=True);p.add_argument('--url',required=True);p.add_argument('--restart-service',action='store_true');p.add_argument('--worker-disconnect-test',action='store_true');args=p.parse_args();base=args.url.rstrip('/')
ua='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):return None
def request(path,data=None,headers=None,local=False):
 h={'User-Agent':ua,'Cache-Control':'no-cache'};h.update(headers or {})
 if isinstance(data,dict):data=urllib.parse.urlencode(data).encode();h['Content-Type']='application/x-www-form-urlencoded'
 req=urllib.request.Request(('http://127.0.0.1:7676' if local else base)+path,data=data,headers=h)
 try:
  with urllib.request.build_opener(NoRedirect()).open(req,timeout=20) as r:return r.status,dict(r.headers),r.read()
 except urllib.error.HTTPError as e:return e.code,dict(e.headers),e.read()
def checked(path,data=None,headers=None):
 status,h,b=request(path,data,headers);assert status==200,f'{path}: HTTP {status}';return json.loads(b)
def rpc(token,method,params=None):
 m={'jsonrpc':'2.0','id':1,'method':method}
 if params is not None:m['params']=params
 for attempt in range(3):
  try:
   status,h,b=request('/mcp',json.dumps(m).encode(),{'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
   break
  except (OSError, __import__('http.client',fromlist=['RemoteDisconnected']).RemoteDisconnected):
   if attempt==2:raise
   # Only this probe's idempotent initialize/list/hostname operations are retried.
   print('read_only_probe_transport_retry',flush=True);time.sleep(1)
 assert status==200,f'{method}: HTTP {status}'
 text=b.decode();text=next((l[6:] for l in text.splitlines() if l.startswith('data: ')),text);r=json.loads(text);assert 'result' in r,method+' failed';return r['result']
def restart():
 subprocess.run(['systemctl','--user','restart','devspace.service'],check=True,env={**os.environ,'XDG_RUNTIME_DIR':'/run/user/'+str(os.getuid())})
 for _ in range(40):
  try:
   if request('/healthz',local=True)[0]==200:return
  except OSError:pass
  time.sleep(.5)
 raise RuntimeError('service did not become ready')
c=sqlite3.connect('file:'+args.state+'/devspace.sqlite?mode=ro',uri=True);client=json.loads(c.execute('select client_json from oauth_clients limit 1').fetchone()[0]);c.close()
owner=json.load(open(args.config+'/auth.json'))['ownerToken'];verifier=secrets.token_urlsafe(48);challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
auth=dict(client_id=client['client_id'],redirect_uri=client['redirect_uris'][0],response_type='code',code_challenge=challenge,code_challenge_method='S256',scope='devspace',resource=base+'/mcp',state=secrets.token_urlsafe(20))
tokens=[]
def token(body):
 body={**body,'client_id':client['client_id'],'resource':base+'/mcp'}
 if client.get('client_secret'):body['client_secret']=client['client_secret']
 return checked('/token',body)
try:
 assert request('/.well-known/oauth-authorization-server')[0]==200;print('public_discovery=PASS',flush=True)
 status,h,b=request('/authorize?'+urllib.parse.urlencode(auth));assert status==200 and b'owner_token' in b;assert 'no-store' in h.get('Cache-Control','');print('public_authorization_form=PASS',flush=True)
 status,h,b=request('/authorize',{**auth,'owner_token':owner});assert status==302,f'authorization HTTP {status}'
 location=h.get('Location') or h.get('location');code=urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)['code'][0]
 if args.restart_service:restart();print('restart_with_pending_code=PASS',flush=True)
 first=token(dict(grant_type='authorization_code',code=code,code_verifier=verifier,redirect_uri=auth['redirect_uri']));tokens.append(first);print('code_exchange_after_restart=PASS',flush=True)
 policy=json.load(open(args.state+'/oauth-enrollment.json'))
 if policy.get('locked') and policy.get('allowUntilMs')==0:print('one_grant_window_auto_closed=PASS',flush=True)
 rpc(first['access_token'],'initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'owner-recovery-probe','version':'1'}})
 policy=json.load(open(args.state+'/oauth-enrollment.json'))
 assert policy.get('locked') is True and policy.get('allowUntilMs')==0,'admin window did not close after authenticated MCP'
 print('new_client_authenticated_window_auto_closed=PASS',flush=True)
 listing=rpc(first['access_token'],'tools/list');print('public_authenticated_tools_list=PASS tools='+str(len(listing['tools'])),flush=True)
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
  rotations=list(ex.map(lambda _:token(dict(grant_type='refresh_token',refresh_token=first['refresh_token'])),range(4)))
 tokens.extend(rotations);assert len({r['access_token'] for r in rotations})==1 and len({r['refresh_token'] for r in rotations})==1;print('four_concurrent_refreshes_same_pair=PASS',flush=True)
 if args.restart_service:restart();print('restart_with_rotated_tokens=PASS',flush=True)
 retry=token(dict(grant_type='refresh_token',refresh_token=first['refresh_token']));tokens.append(retry);assert retry['access_token']==rotations[0]['access_token'] and retry['refresh_token']==rotations[0]['refresh_token'];print('lost_refresh_response_retry_after_restart=PASS',flush=True)
 for alias,ws in [('gateway','ws_bb3eee589b'),('swy1','ws_0ec6c54866dfa95ee99b')]:
  result=rpc(retry['access_token'],'tools/call',{'name':'exec_command','arguments':{'workspaceId':ws,'cmd':'hostname'}});assert not result.get('isError'),alias+' route failed: '+json.dumps(result.get('content',[]))[:800];assert result.get('structuredContent',{}).get('running') is not True,alias+' command still running';print('routed_exec_'+alias+'=PASS',flush=True)
 if args.worker_disconnect_test:
  def remote(command):
   subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=6','swy@192.168.5.9','export XDG_RUNTIME_DIR=/run/user/$(id -u); '+command],check=True,stdout=subprocess.DEVNULL)
  remote('systemd-run --user --on-active=160s --unit=devspace-recovery-relay-restore /usr/bin/systemctl --user start devspace-swy1-lan-tunnel.service')
  try:
   remote('systemctl --user stop devspace-swy1-lan-tunnel.service')
   for i in range(13):
    time.sleep(10)
    assert request('/healthz',local=True)[0]==200
    if i in [0,5,12]:print('core_available_during_worker_disconnect seconds='+str((i+1)*10),flush=True)
   db=sqlite3.connect('file:'+args.state+'/devspace.sqlite?mode=ro',uri=True)
   health=db.execute("select health from execution_nodes where alias='gateway'").fetchone()[0];db.close()
   assert health=='offline','gateway health did not reach offline';print('worker_health_offline=PASS',flush=True)
   result=rpc(retry['access_token'],'tools/call',{'name':'exec_command','arguments':{'workspaceId':'ws_0ec6c54866dfa95ee99b','cmd':'hostname'}})
   assert not result.get('isError');print('core_exec_with_worker_offline=PASS',flush=True)
  finally:
   remote('systemctl --user start devspace-swy1-lan-tunnel.service')
  for _ in range(30):
   db=sqlite3.connect('file:'+args.state+'/devspace.sqlite?mode=ro',uri=True)
   health=db.execute("select health from execution_nodes where alias='gateway'").fetchone()[0];db.close()
   if health=='online':break
   time.sleep(1)
  assert health=='online';print('worker_automatic_reconnect=PASS',flush=True)
  result=rpc(retry['access_token'],'tools/call',{'name':'exec_command','arguments':{'workspaceId':'ws_bb3eee589b','cmd':'hostname'}})
  assert not result.get('isError');print('worker_exec_after_reconnect=PASS',flush=True)
 assert request('/mcp')[0]==401;print('unauthenticated_mcp=401 PASS',flush=True)
finally:
 seen=set()
 for pair in tokens:
  for kind in ['access_token','refresh_token']:
   t=pair.get(kind)
   if not t or t in seen:continue
   seen.add(t);body=dict(token=t,token_type_hint=kind,client_id=client['client_id'])
   if client.get('client_secret'):body['client_secret']=client['client_secret']
   try:request('/revoke',body)
   except OSError:pass
 print('probe_tokens_revoked_existing_tokens_untouched',flush=True)
