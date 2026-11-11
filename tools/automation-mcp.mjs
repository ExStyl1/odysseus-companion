#!/usr/bin/env node
/** Native stdio MCP; SDK is shipped with the pinned n8n runtime. No tokens in MCP config. */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { automationPaths, loadAutomationConfig } from './automations/config.mjs';
import { n8nLocation } from './automations/runtime.mjs';
const root = process.env.ODYSSEUS_ROOT || resolve(import.meta.dirname, '..'), paths = automationPaths(root);
const location = n8nLocation(paths), require = createRequire(join(location.runtime, 'package.json'));
const { McpServer } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')));
const { StdioServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')));
const { z } = await import(pathToFileURL(require.resolve('zod')));
const server = new McpServer({ name: 'odysseus-automation', version: '1.0.0' });
const scope = { collection: z.string().default('projects'), project: z.string().optional() };
const definitions = [
  ['knowledge_catalogs', 'catalogs', 'Выбрать каталог, проект и настроенный API-источник по имени и ID', {}],
  ['knowledge_search', 'search', 'Найти источники в локальной базе знаний выбранного каталога', { ...scope, query: z.string(), limit: z.number().optional() }],
  ['knowledge_answer', 'answer', 'Ответ через выбранный llm-proxy по найденным материалам', { ...scope, query: z.string(), externalSources: z.array(z.string()).optional() }],
  ['knowledge_index', 'index', 'Обновить индекс выбранного каталога или проекта', scope],
  ['knowledge_save', 'save', 'Сохранить результат в Markdown и Graphify', { ...scope, title: z.string(), text: z.string() }],
  ['knowledge_graph', 'graph', 'Прочитать узлы и связи выбранного каталога', scope],
  ['external_search', 'externalSearch', 'Поиск во внешнем API по ID настроенного источника', { source: z.string(), query: z.string() }],
  ['n8n_workflow_list', 'workflowList', 'Список локальных процессов n8n', {}],
  ['n8n_workflow_get', 'workflowGet', 'Получить JSON процесса перед изменением', { id: z.string() }],
  ['n8n_workflow_save', 'workflowSave', 'Создать процесс либо сохранить изменения как черновик без публикации', { id: z.string().optional(), workflow: z.object({ name: z.string(), nodes: z.array(z.record(z.string(), z.any())), connections: z.record(z.string(), z.any()), settings: z.record(z.string(), z.any()).optional() }) }],
  ['n8n_workflow_activate', 'workflowActivate', 'Явно включить или выключить процесс и его триггеры', { id: z.string(), active: z.boolean() }],
  ['n8n_executions', 'executions', 'Последние запуски локальных процессов', {}],
];
for (const [name, mode, description, inputSchema] of definitions) server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: ['search','graph','catalogs','workflowList','workflowGet','executions','externalSearch'].includes(mode), destructiveHint: mode === 'workflowActivate' } }, async input => {
  try {
    const { config, secrets } = loadAutomationConfig(paths);
    const r = await fetch('http://127.0.0.1:' + config.bridgePort + '/knowledge/' + mode, { method: 'POST', headers: { Authorization: 'Bearer ' + secrets.bridgeToken, 'Content-Type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(240000) });
    const result = await r.json(); return { isError: !r.ok, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch { return { isError: true, content: [{ type: 'text', text: 'Откройте n8n или базу знаний в Odysseus, либо запустите od n8n start. Проверьте настройки подключения.' }] }; }
});
await server.connect(new StdioServerTransport());
