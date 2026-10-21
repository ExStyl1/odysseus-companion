import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function skillPrompt(entry, root, task = '') {
  return `Используй навык $${entry.name}.\nЕсли навык не найден в текущем проекте, прочитай локальное руководство ${join(root, 'shared', 'skills', entry.name, 'SKILL.md')} и применяй его в рамках моей задачи.\n\n${task.trim() ? `Задача: ${task.trim()}` : 'Сначала помоги уточнить мою задачу и необходимые исходные данные для этого навыка.'}`;
}
export function skillLink(entry, root, task = '') {
  const url = new URL('nessy://action/new-session');
  url.searchParams.set('name', `Навык: ${entry.name}`);
  url.searchParams.set('input', skillPrompt(entry, root, task));
  return url.href;
}
export function buildDesktopCatalog(catalog, roles, root) {
  const entries = catalog.entries.map(entry => ({ ...entry, prompt: skillPrompt(entry, root), link: skillLink(entry, root) }));
  const payload = JSON.stringify({ entries, roles }).replace(/</g, '\\u003c');
  const template = readFileSync(new URL('./desktop-catalog.html', import.meta.url), 'utf8');
  writeFileSync(join(root, 'workspace', 'Каталог навыков Nessy.html'), template.replace('/* CATALOG_DATA */null', payload));
  const markdown = readFileSync(join(root, 'docs', 'skills-catalog-ru.md'), 'utf8');
  const native = markdown.replace('# Справочник общих навыков Odysseus', '# Навыки Nessy · прочитать и применить\n\n> Открой этот файл в Nessy Desktop. Ссылка «Применить в Nessy» откроет новый чат с выбранным навыком. Допиши свою задачу, выбери рабочий проект и нажми Enter. Внешняя ссылка сама запрос не отправляет.\n\n[Интерактивный каталог с поиском](Каталог%20навыков%20Nessy.html)')
    .replace(/^### ([a-z0-9-]+)$/gm, (heading, name) => {
      const entry = entries.find(entry => entry.name === name);
      return entry ? `${heading}\n\n**[Применить в Nessy ↗](${entry.link})**` : heading;
    });
  writeFileSync(join(root, 'workspace', 'Каталог навыков Nessy.md'), native);
}
