import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { skillLink, skillPrompt } from '../../tools/desktop-catalog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = JSON.parse(
  readFileSync(new URL('../../shared/skills-catalog.json', import.meta.url)),
);
const html = readFileSync(
  new URL('../../workspace/Каталог навыков Nessy.html', import.meta.url),
  'utf8',
);

test('standalone desktop catalog contains all skills, role selections and executable JavaScript', () => {
  const embedded = html.match(
    /<script id="catalog-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  assert.ok(embedded);
  const data = JSON.parse(embedded[1]);
  assert.deepEqual(
    data.entries.map((entry) => entry.name),
    catalog.entries.map((entry) => entry.name),
  );
  assert.deepEqual(
    data.roles.map((role) => role.id),
    ['general', 'qa', 'dev', 'analysts'],
  );
  for (const role of data.roles)
    for (const [name] of role.skills) assert.ok(data.entries.some((entry) => entry.name === name));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
  assert.ok(!html.includes('/* CATALOG_DATA */null'));
  assert.ok(
    !/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html),
    'Catalog must remain self-contained',
  );
  for (const entry of data.entries) {
    assert.ok(entry.description && entry.when && entry.how && entry.dependencies);
    assert.equal(new URL(entry.link).searchParams.get('input'), entry.prompt);
  }
});

test('native Markdown has a valid application link for each skill, preserving a real custom task', () => {
  const markdown = readFileSync(
    new URL('../../workspace/Каталог навыков Nessy.md', import.meta.url),
    'utf8',
  );
  const links = [...markdown.matchAll(/\*\*\[Применить в Nessy ↗\]\((nessy:[^)]+)\)\*\*/g)];
  assert.equal(links.length, catalog.entries.length);
  for (let i = 0; i < links.length; i++) {
    const url = new URL(links[i][1]);
    assert.equal(url.hostname, 'action');
    assert.equal(url.pathname, '/new-session');
    assert.ok(url.searchParams.get('input').includes('$'));
    for (const field of ['send', 'mode', 'model', 'systemPrompt', 'workdir'])
      assert.equal(url.searchParams.has(field), false);
  }
  const entry = catalog.entries.find((entry) => entry.name === 'pdf');
  const task = 'Извлеки таблицы из «Отчёт & план.pdf»\nСохрани в CSV + проверь строки.';
  const url = new URL(skillLink(entry, root, task));
  assert.equal(url.searchParams.get('input'), skillPrompt(entry, root, task));
  assert.ok(url.searchParams.get('input').endsWith(task));
});

test('the real Desktop deep-link policy accepts catalog links as editable drafts', () => {
  const module = pathToFileURL(
    fileURLToPath(
      new URL(
        '../../nessy-desktop-feat-TCODE-000-1-41-0/apps/electron/src/renderer/contexts/deep-link-policy.ts',
        import.meta.url,
      ),
    ),
  ).href;
  const urls = catalog.entries.map((entry) => skillLink(entry, root));
  const code = `import {resolveDeepLinkAction,EXTERNAL_INPUT_MAX_CHARS} from ${JSON.stringify(module)};
    for (const raw of ${JSON.stringify(urls)}) {
      const url = new URL(raw), params = Object.fromEntries(url.searchParams);
      const result = resolveDeepLinkAction('new-session', params, 'external');
      if (result.blocked || result.send || result.trusted || result.input !== params.input || params.input.length > EXTERNAL_INPUT_MAX_CHARS) throw new Error('Invalid catalog draft');
    }`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', code],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
