import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimePaths, registerProject } from '../../tools/graphify.mjs';
import { graphData } from '../../tools/knowledge/graph-store.mjs';
import { indexKnowledge, searchKnowledge, saveKnowledge } from '../../tools/automations/knowledge.mjs';
import { configureAutomation, loadAutomationConfig } from '../../tools/automations/config.mjs';
import { createKnowledgeActions, externalSearch } from '../../tools/automations/gateway.mjs';
const put = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-rag-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { root, home: join(root, 'private/automations'), privateDir: join(root, 'private'), env: {} };
  const kp = runtimePaths(root, {}), a = join(root, 'service-a'), b = join(root, 'service-b'); mkdirSync(a); mkdirSync(b);
  put(join(a, 'contract.md'), '# Refund\nВозврат платежа использует ключ идемпотентности.'); put(join(b, 'private.md'), '# OTHERPRIVATE\nСекретное обсуждение другого проекта');
  const pa = registerProject(kp, a), pb = registerProject(kp, b);
  put(join(kp.output, 'graph.json'), { nodes: [
    { id: 'project:' + pa.id, label: 'A', type: 'project', source_file: a }, { id: 'project:' + pb.id, label: 'B', type: 'project', source_file: b },
    { id: 'file:a', type: 'document', project_id: pa.id, label: 'Refund', source_file: join(a, 'contract.md') },
    { id: 'file:b', type: 'document', project_id: pb.id, label: 'OTHERPRIVATE', source_file: join(b, 'private.md') },
  ], links: [] });
  loadAutomationConfig(paths); return { root, paths, kp, pa, pb };
}
test('RAG reads only selected project and returns cited chunks; workflow writes Markdown and graph source', async t => {
  const f = fixture(t), input = { collection: 'projects', project: f.pa.id };
  const indexed = await indexKnowledge(f.paths, input); assert.equal(indexed.mode, 'keyword+graph');
  const result = await searchKnowledge(f.paths, { ...input, query: 'ключ идемпотентности' });
  assert.ok(result.matches.some(c => c.source.endsWith('contract.md')));
  assert.ok(!JSON.stringify(result).includes('OTHERPRIVATE'));
  assert.equal((await searchKnowledge(f.paths, { ...input, query: 'OTHERPRIVATE' })).matches.length, 0);
  const saved = saveKnowledge(f.paths, { ...input, title: 'QA result', text: 'Проверены повторные возвраты' });
  assert.ok(existsSync(saved.source));
  assert.ok(graphData(f.kp).graph.nodes.some(n => n.manual && n.source_file === saved.source));
});
test('moving a project to another catalog invalidates a previously indexed collection', async t => {
  const f = fixture(t); await indexKnowledge(f.paths, { collection: 'projects' });
  put(join(f.kp.output, 'collections.json'), { collections: [{ id: 'projects', name: 'A' }, { id: 'other', name: 'B' }], assignments: { ['project:' + f.pb.id]: 'other' } });
  const result = await searchKnowledge(f.paths, { collection: 'projects', query: 'OTHERPRIVATE' });
  assert.equal(result.matches.length, 0);
  await assert.rejects(() => searchKnowledge(f.paths, { collection: 'projects', project: f.pb.id, query: 'x' }), /не принадлежит/);
});
test('proxy configuration keeps keys out of status and clears them when endpoint changes', t => {
  const f = fixture(t);
  let result = configureAutomation(f.paths, { proxy: { baseUrl: 'https://proxy.example/v1', model: 'agent', token: 'private-fixture' } });
  assert.ok(result.proxy.hasToken); assert.ok(!JSON.stringify(result).includes('private-fixture'));
  configureAutomation(f.paths, { proxy: { baseUrl: 'https://other.example/v1', model: 'agent' } });
  assert.equal(loadAutomationConfig(f.paths).secrets.proxyToken, undefined);
  assert.throws(() => configureAutomation(f.paths, { proxy: { baseUrl: 'https://token@proxy.example', model: 'agent' } }), /HTTP/);
});
test('answer sends only scoped context to configured proxy with selected model and token', async t => {
  const f = fixture(t), requests = [];
  configureAutomation(f.paths, { proxy: { baseUrl: 'https://proxy.example/v1', model: 'my-agent', token: 'fixture-key' } });
  const actions = createKnowledgeActions(f.paths, async (url, options) => { requests.push({ url, ...options }); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ответ со ссылкой contract.md' } }] })); });
  const result = await actions.answer({ project: f.pa.id, query: 'Возврат платежа' });
  assert.ok(result.answer.includes('contract.md'));
  assert.equal(requests[0].url, 'https://proxy.example/v1/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer fixture-key');
  assert.equal(JSON.parse(requests[0].body).model, 'my-agent');
  assert.ok(!requests[0].body.includes('OTHERPRIVATE'));
});
test('external search uses configured GET endpoint, encoded query and no credential in result', async t => {
  const f = fixture(t);
  configureAutomation(f.paths, { source: { id: 'wiki', baseUrl: 'https://wiki.example', path: '/search', queryParam: 'q', token: 'api-secret' } });
  const result = await externalSearch(f.paths, { source: 'wiki', query: 'a&b' }, async (url, options) => {
    assert.equal(new URL(url).searchParams.get('q'), 'a&b'); assert.equal(options.headers.Authorization, 'Bearer api-secret'); assert.equal(options.redirect, 'error'); return new Response('{"results":["answer"]}');
  });
  assert.ok(!JSON.stringify(result).includes('api-secret'));
  configureAutomation(f.paths, { source: { id: 'wiki', baseUrl: 'https://different.example', path: '/search' } });
  assert.equal(loadAutomationConfig(f.paths).secrets['source:wiki'], undefined);
});
test('semantic RAG uses cached embeddings and rejects malformed model vectors', async t => {
  const f = fixture(t); let count = 0;
  const embed = async input => { count += input.length; return input.map(() => [0.2, 0.8]); };
  const input = { project: f.pa.id, collection: 'projects', embeddingModel: 'fixture' };
  await indexKnowledge(f.paths, input, embed); const first = count;
  await indexKnowledge(f.paths, input, embed); assert.equal(count, first);
  const r = await searchKnowledge(f.paths, { ...input, query: 'refund' }, embed); assert.equal(r.mode, 'semantic+keyword');
  const actions = createKnowledgeActions(f.paths, async () => new Response('{"data":[{"index":0,"embedding":[null]}]}'));
  configureAutomation(f.paths, { proxy: { baseUrl: 'https://proxy.example', model: 'a', embeddingsModel: 'b' } });
  await assert.rejects(() => actions.index({ project: f.pa.id }), /embeddings/);
});

test('catalog changes during embeddings cannot commit or return an out-of-scope snapshot', async t => {
  const f = fixture(t);
  const move = () => put(join(f.kp.output, 'collections.json'), { collections: [{ id: 'projects', name: 'A' }, { id: 'other', name: 'B' }], assignments: { ['project:' + f.pa.id]: 'other' } });
  const embed = async input => { move(); return input.map(() => [0.2, 0.8]); };
  await assert.rejects(() => indexKnowledge(f.paths, { collection: 'projects', project: f.pa.id, embeddingModel: 'test' }, embed), /Каталог изменился|не принадлежит/);
});

test('MCP installation uses CLI settings, preserves other servers and disabled Desktop source', async t => {
  const f = fixture(t); const { registerAutomationSources } = await import('../../tools/automations/sources.mjs');
  const profiles = { cliHome: join(f.root, 'cli'), desktopHome: join(f.root, 'desktop') };
  put(join(profiles.cliHome, 'settings.json'), { theme: 'custom', mcpServers: { mine: { command: 'mine' } } });
  const source = join(profiles.desktopHome, 'workspaces/test/sources/odysseus-automation/config.json');
  put(source, { id: 'odysseus-automation', enabled: false, createdAt: 1 });
  registerAutomationSources(f.root, profiles, process.execPath);
  const first = readFileSync(join(profiles.cliHome, 'settings.json'), 'utf8');
  registerAutomationSources(f.root, profiles, process.execPath);
  assert.equal(first, readFileSync(join(profiles.cliHome, 'settings.json'), 'utf8'));
  const settings = JSON.parse(first); assert.equal(settings.theme, 'custom'); assert.equal(settings.mcpServers.mine.command, 'mine');
  assert.ok(settings.mcpServers['odysseus-automation'].args[0].endsWith('automation-mcp.mjs'));
  assert.equal(JSON.parse(readFileSync(source)).enabled, false);
});

test('saved workflow notes follow a moved project across catalogs and normalized project IDs', async t => {
  const f = fixture(t);
  saveKnowledge(f.paths, { collection: 'projects', project: 'project:' + f.pa.id, title: 'Result', text: 'workflowcanary retained' });
  await indexKnowledge(f.paths, { collection: 'projects' });
  put(join(f.kp.output, 'collections.json'), { collections: [{ id: 'projects', name: 'A' }, { id: 'other', name: 'B' }], assignments: { ['project:' + f.pa.id]: 'other' } });
  assert.equal((await searchKnowledge(f.paths, { collection: 'projects', query: 'workflowcanary' })).matches.length, 0);
  assert.ok((await searchKnowledge(f.paths, { collection: 'other', project: f.pa.id, query: 'workflowcanary' })).matches.length > 0);
});
