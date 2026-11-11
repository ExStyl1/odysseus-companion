import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { startGateway } from '../../tools/automations/gateway.mjs';
import { loadAutomationConfig, configureAutomation } from '../../tools/automations/config.mjs';
import { n8nEnvironment } from '../../tools/automations/runtime.mjs';
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-gateway-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runtime: join(root, 'runtime'), privateDir: join(root, 'private'), home: join(root, 'private/automations'), engine: join(root, 'private/automations/engine'), env: {} };
}
test('gateway rejects unauthenticated requests, web origins, forged Host and unknown operations', async t => {
  const p = fixture(t), gateway = await startGateway(p, { port: 0 }); t.after(() => gateway.close());
  const { secrets } = loadAutomationConfig(p);
  const send = headers => fetch(gateway.url + '/knowledge/search', { method: 'POST', headers, body: '{"query":"x"}' });
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ Authorization: 'Bearer ' + secrets.bridgeToken, Origin: 'https://evil.example' })).status, 403);
  const forged = await new Promise((resolve, reject) => { const r = httpRequest(gateway.url + '/knowledge/search', { method: 'POST', headers: { Authorization: 'Bearer ' + secrets.bridgeToken, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject); r.end('{}'); });
  assert.equal(forged, 403);
  const response = await fetch(gateway.url + '/knowledge/constructor', { method: 'POST', headers: { Authorization: 'Bearer ' + secrets.bridgeToken }, body: '{}' });
  assert.equal(response.status, 404);
});
test('n8n receives only the local capability and stable encryption key, never a proxy key', t => {
  const p = fixture(t); configureAutomation(p, { proxy: { baseUrl: 'https://proxy.example', model: 'test', token: 'private-secret' } });
  const a = n8nEnvironment(p, 'http://127.0.0.1:1234'), b = n8nEnvironment(p, 'http://127.0.0.1:1234');
  assert.equal(a.N8N_ENCRYPTION_KEY, b.N8N_ENCRYPTION_KEY);
  assert.equal(a.N8N_LISTEN_ADDRESS, '127.0.0.1');
  assert.ok(!JSON.stringify(a).includes('private-secret'));
  assert.equal(a.N8N_DIAGNOSTICS_ENABLED, 'false');
});
test('n8n workflow edits save drafts and never auto-publish; 429 is preserved without secrets', async t => {
  const p = fixture(t); configureAutomation(p, { n8nApiKey: 'n8n-private', proxy: { baseUrl: 'https://proxy.example', model: 'test', token: 'proxy-private' } });
  let request;
  const gateway = await startGateway(p, { port: 0, fetchImpl: async (url, options) => {
    request = { url, options };
    if (String(url).includes('/api/v1/')) return new Response('{"id":"saved"}');
    return new Response('{"error":"proxy-private"}', { status: 429, headers: { 'Retry-After': '70' } });
  } }); t.after(() => gateway.close());
  await gateway.actions.workflowSave({ id: 'abc', workflow: { name: 'Draft', nodes: [], connections: {}, active: true } });
  assert.ok(request.url.endsWith('/workflows/abc?publishIfActive=false'));
  assert.equal(JSON.parse(request.options.body).active, undefined);
  assert.equal(request.options.headers['X-N8N-API-KEY'], 'n8n-private');
  const { secrets } = loadAutomationConfig(p);
  const response = await fetch(gateway.url + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + secrets.bridgeToken }, body: '{"messages":[]}' });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '70');
  assert.ok(!(await response.text()).includes('proxy-private'));
});

test('stdio MCP advertises knowledge and workflow tools and calls the authenticated local bridge', async t => {
  const p = fixture(t), gateway = await startGateway(p, { port: 0 }); t.after(() => gateway.close());
  const { config } = loadAutomationConfig(p); config.bridgePort = Number(new URL(gateway.url).port);
  writeFileSync(join(p.home, 'config.json'), JSON.stringify(config));
  mkdirSync(join(p.root, '.odysseus'), { recursive: true });
  writeFileSync(join(p.root, '.odysseus/bundled-runtime.json'), JSON.stringify({ n8n: join(process.cwd(), '.odysseus/n8n-runtime') }));
  const child = spawn(process.execPath, ['tools/automation-mcp.mjs'], { env: { ...process.env, ODYSSEUS_ROOT: p.root, ODYSSEUS_DATA_DIR: p.privateDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const messages = []; let buffer = '', stderr = '';
  child.stderr.on('data', b => stderr += b);
  child.stdout.on('data', b => { buffer += b; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) messages.push(JSON.parse(line)); } });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  async function wait(id) { for (let i = 0; i < 200; i++) { const m = messages.find(m => m.id === id); if (m) return m; if (child.exitCode !== null) throw Error('MCP exited: ' + stderr); await new Promise(r => setTimeout(r, 20)); } throw Error('MCP timed out: ' + stderr); }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.ok((await wait(1)).result.serverInfo);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await wait(2); assert.ok(list.result.tools.some(x => x.name === 'n8n_workflow_save')); assert.ok(list.result.tools.some(x => x.name === 'knowledge_search'));
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'knowledge_catalogs', arguments: {} } });
  const result = await wait(3); assert.ok(JSON.parse(result.result.content[0].text).collections.some(c => c.id === 'projects'));
});

test('standard n8n AI model sends tool definitions through the local bridge to selected proxy', async t => {
  const p = fixture(t); configureAutomation(p, { proxy: { baseUrl: 'https://proxy.example/v1', model: 'actual-proxy-model', token: 'private-api-key' } });
  let sent;
  const gateway = await startGateway(p, { port: 0, fetchImpl: async (url, options) => {
    sent = { url, ...options }; return new Response(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'actual-proxy-model', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } }); t.after(() => gateway.close());
  const { createRequire } = await import('node:module'), req = createRequire(join(process.cwd(), 'package.json'));
  const { OdysseusChatModel } = req('./integrations/n8n/nodes/Odysseus/OdysseusChatModel.node.js');
  const keys = ['ODYSSEUS_KNOWLEDGE_URL','ODYSSEUS_AUTOMATION_TOKEN','ODYSSEUS_N8N_RUNTIME'], previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });
  process.env.ODYSSEUS_KNOWLEDGE_URL = gateway.url; process.env.ODYSSEUS_AUTOMATION_TOKEN = loadAutomationConfig(p).secrets.bridgeToken; process.env.ODYSSEUS_N8N_RUNTIME = join(process.cwd(), '.odysseus/n8n-runtime');
  const { response } = await new OdysseusChatModel().supplyData.call({ getNodeParameter: (_name, _index, fallback) => fallback });
  const tools = [{ type: 'function', function: { name: 'search', description: 'Local search', parameters: { type: 'object', properties: {} } } }];
  const answer = await response.bindTools(tools).invoke('Find source');
  assert.equal(answer.content, 'fixture answer');
  const body = JSON.parse(sent.body); assert.equal(body.model, 'actual-proxy-model'); assert.equal(body.tools[0].function.name, 'search');
  assert.equal(sent.headers.Authorization, 'Bearer private-api-key'); assert.ok(!sent.body.includes('private-api-key'));
});
