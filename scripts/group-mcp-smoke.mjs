import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [mode, packageRoot, configDir, workspacePath, localBase = 'http://127.0.0.1:17677/group', publicBase = 'https://dev.sanqi.org/group'] = process.argv.slice(2);
if (!mode || !packageRoot || !configDir || !workspacePath) throw new Error('Missing probe arguments');
process.env.DEVSPACE_CONFIG_DIR = configDir;

const auth = JSON.parse((await readFile(join(configDir, 'auth.json'), 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(typeof auth.ownerToken, 'string');
const resource = publicBase + '/mcp';
const redirect = 'http://127.0.0.1/callback';
const verifier = randomBytes(32).toString('base64url');
const jsonHeaders = { 'content-type': 'application/json' };
const fetchProbe = async (url, options = {}) => {
  const started = performance.now();
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(150000) });
  const body = await res.text();
  console.log(JSON.stringify({ stage: options.probeStage || new URL(url).pathname, status: res.status, ms: Math.round(performance.now() - started), contentType: res.headers.get('content-type') }));
  return { res, body };
};
for (const base of [...new Set([localBase, publicBase])]) {
  const u = new URL(base);
  for (const path of [u.pathname + '/healthz', '/.well-known/oauth-protected-resource' + u.pathname + '/mcp', '/.well-known/oauth-authorization-server' + u.pathname]) {
    const { res } = await fetchProbe(u.origin + path);
    assert.equal(res.status, 200);
  }
  const { res } = await fetchProbe(base + '/mcp');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata=/);
}
let result = await fetchProbe(localBase + '/register', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ client_name: 'Synrex Group repair acceptance', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
assert.equal(result.res.status, 201);
const clientId = JSON.parse(result.body).client_id;
result = await fetchProbe(localBase + '/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual', body: new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'devspace', resource, state: 'group-repair', owner_token: auth.ownerToken }) });
assert.equal(result.res.status, 302);
const code = new URL(result.res.headers.get('location')).searchParams.get('code');
assert.ok(code);
result = await fetchProbe(localBase + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource }) });
assert.equal(result.res.status, 200);
const token = JSON.parse(result.body).access_token;
assert.ok(token);
console.log(JSON.stringify({ oauth: 'authorization_code+PKCE', resource, scope: JSON.parse(result.body).scope }));
for (const base of [...new Set([localBase, publicBase])]) {
  let session;
  let sequence = 0;
  async function rpc(method, params, notification = false) {
    const response = await fetchProbe(base + '/mcp', { method: 'POST', probeStage: base + ':' + method + (params?.name ? ':' + params.name : ''), headers: { authorization: 'Bearer ' + token, ...jsonHeaders, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++sequence }), method, params }) });
    session = response.res.headers.get('mcp-session-id') || session;
    assert.equal(response.res.status, notification ? 202 : 200);
    if (notification) return;
    const payload = response.body.startsWith('event:') || response.body.startsWith('data:') ? response.body.split('\n').filter(x => x.startsWith('data:')).map(x => JSON.parse(x.slice(5))).find(x => x.id === sequence) : JSON.parse(response.body);
    assert.ok(payload?.result, JSON.stringify(payload?.error));
    assert.notEqual(payload.result.isError, true, 'Tool returned an error');
    return payload.result;
  }
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synrex-group-repair-probe', version: '1' } });
  assert.ok(init.serverInfo);
  await rpc('notifications/initialized', {}, true);
  const list = await rpc('tools/list', {});
  assert.ok(list.tools.some(t => t.name === 'open_workspace'));
  const opened = await rpc('tools/call', { name: 'open_workspace', arguments: { path: workspacePath }, _meta: { 'openai/conversationId': 'group-repair-acceptance-' + Date.now() } });
  const ws = opened.structuredContent?.workspaceId;
  assert.ok(ws);
  const read = await rpc('tools/call', { name: 'read', arguments: { workspaceId: ws, path: 'AGENTS.md', limit: 3 } });
  assert.ok(read.content?.length);
  console.log(JSON.stringify({ base, protocol: init.protocolVersion, toolCount: list.tools.length, workspaceId: ws, read: 'passed', review: opened.structuredContent.review }));
}
console.log(JSON.stringify({ ok: true, mode }));
