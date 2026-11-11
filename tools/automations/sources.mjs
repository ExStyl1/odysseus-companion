import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { document, privateWrite, noLinks } from '../personal/store.mjs';
export function registerAutomationSources(root, profiles, node) {
  const server = { command: node, args: [join(root, 'tools/automation-mcp.mjs')], env: { ODYSSEUS_ROOT: root } };
  const cli = join(profiles.cliHome, 'settings.json'); noLinks(cli);
  const settings = document(cli); settings.mcpServers ||= {};
  if (!settings.mcpServers['odysseus-automation'] || settings.mcpServers['odysseus-automation'].args?.some(a => a.endsWith('/tools/automation-mcp.mjs'))) {
    if (JSON.stringify(settings.mcpServers['odysseus-automation']) !== JSON.stringify(server)) { settings.mcpServers['odysseus-automation'] = server; privateWrite(cli, JSON.stringify(settings, null, 2)); }
  }
  const workspaces = join(profiles.desktopHome, 'workspaces'); noLinks(workspaces);
  if (!existsSync(workspaces)) return;
  for (const w of readdirSync(workspaces, { withFileTypes: true })) {
    if (!w.isDirectory() || w.isSymbolicLink()) continue;
    const folder = join(workspaces, w.name, 'sources/odysseus-automation'), file = join(folder, 'config.json'); noLinks(file);
    const previous = document(file);
    if (previous.id && previous.id !== 'odysseus-automation') continue;
    const next = { ...previous, id: 'odysseus-automation', slug: 'odysseus-automation', name: 'n8n · База знаний', enabled: previous.enabled !== false, type: 'mcp', provider: 'custom', icon: '🔗', tagline: 'Локальные процессы, RAG, граф и внешние API.', mcp: { transport: 'stdio', ...server, authType: 'none' }, createdAt: previous.createdAt || Date.now() };
    if (JSON.stringify(previous) !== JSON.stringify(next)) privateWrite(file, JSON.stringify(next));
    if (!existsSync(join(folder, 'guide.md'))) privateWrite(join(folder, 'guide.md'), '# n8n и база знаний Odysseus\n\nИспользуй knowledge_search/knowledge_answer для поиска и ответов с источниками, knowledge_save для сохранения. Процессы n8n: n8n_workflow_list/get/save/activate; изменения сохраняются как черновик, активация — отдельное действие. Каталог и project_id задавай явно. Не смешивай проекты. Для внешнего поиска используй только ID подключённого источника. Сначала получи JSON существующего процесса, затем меняй. Не активируй расписания, отправку сообщений или внешние записи без соответствующего поручения пользователя.\n');
  }
}
