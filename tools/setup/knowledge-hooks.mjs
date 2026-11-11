/** Install only Odysseus-owned hooks; preserve user hooks, permissions and opt-outs. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noLinks, privateWrite } from '../personal/store.mjs';
const marker = '--odysseus-knowledge-hook-v1';
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const read = file => { noLinks(file); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; };
export function installKnowledgeHooks(root, profiles, node) {
  const script = join(root, 'tools/knowledge-workflow.mjs');
  if (!existsSync(script)) return; // Older distributions remain usable.
  for (const [file, cli] of [[join(profiles.cliHome, 'settings.json'), true], [join(profiles.desktopHome, 'hooks.json'), false]]) {
    const data = read(file), before = JSON.stringify(data);
    // Desktop also accepts automations and a bare event map; keep its active shape.
    const hooks = !cli && !data.hooks
      ? (data.automations || (Object.values(data).some(Array.isArray) ? data : (data.hooks = {})))
      : (data.hooks ||= {});
    for (const [event, mode] of [['UserPromptSubmit', 'before'], ['Stop', 'after']]) {
      const existing = hooks[event] || [];
      if (!Array.isArray(existing)) throw Error('Неверная конфигурация hooks: ' + event);
      const groups = existing.map(group => ({ ...group, hooks: group.hooks?.filter(hook => !hook.command?.includes(marker)) })).filter(group => !Array.isArray(group.hooks) || group.hooks.length);
      const ours = { hooks: [{ type: 'command', command: quote(node) + ' ' + quote(script) + ' ' + mode + ' ' + marker, timeout: cli ? 10000 : 10 }] };
      // Other author-supplied matchers/actions remain byte-equivalent as data.
      hooks[event] = mode === 'before' ? [ours, ...groups] : [...groups, ours];
    }
    if (JSON.stringify(data) !== before) privateWrite(file, JSON.stringify(data, null, 2) + '\n');
  }
}
