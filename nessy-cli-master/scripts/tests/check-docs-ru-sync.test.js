import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectSyncIssues, mapSourcePath } from '../check-docs-ru-sync.js';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'docs-ru-sync-'));
  const sourceRoot = join(root, 'docs');
  const targetRoot = join(root, 'docs-ru');
  mkdirSync(join(sourceRoot, 'users', 'features'), { recursive: true });
  mkdirSync(join(targetRoot, 'users', 'work', 'features'), {
    recursive: true,
  });
  writeFileSync(
    join(sourceRoot, 'users', 'features', 'example.md'),
    '# Example\n',
  );
  writeFileSync(
    join(targetRoot, 'users', 'work', 'features', '_category_.yml'),
    "'label': 'Функции'\n",
  );
  return { sourceRoot, targetRoot };
}

function manifest(overrides = {}) {
  return {
    excludedSources: [],
    protected: {},
    localOnly: [],
    pathOverrides: {},
    aliases: {},
    sourceHashes: {},
    ...overrides,
  };
}

describe('docs-ru sync check', () => {
  it('maps the different public directory layout', () => {
    expect(mapSourcePath('users/features/example.md', manifest())).toBe(
      'users/work/features/example.md',
    );
    expect(mapSourcePath('developers/sdk-python.md', manifest())).toBe(
      'developers/sdk/sdk-python.md',
    );
  });

  it('accepts a mapped Docusaurus document and a valid local link', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.targetRoot, 'users', 'work', 'features', 'example.md'),
      '---\ntitle: Пример\n---\n\n[Пример](./example.md)\n',
    );

    expect(
      collectSyncIssues({
        ...fixture,
        manifest: manifest(),
        checkHashes: false,
      }),
    ).toEqual([]);
  });

  it('reports a missing translation', () => {
    const fixture = createFixture();
    const issues = collectSyncIssues({
      ...fixture,
      manifest: manifest(),
      checkHashes: false,
    });

    expect(issues).toContain(
      'Нет русского документа для users/features/example.md: users/work/features/example.md',
    );
  });

  it('keeps protected documents out of format checks', () => {
    const fixture = createFixture();
    const source = 'users/features/example.md';
    const target = 'users/work/features/example.md';
    writeFileSync(join(fixture.targetRoot, target), '# Защищённый документ\n');

    expect(
      collectSyncIssues({
        ...fixture,
        manifest: manifest({ protected: { [source]: target } }),
        checkHashes: false,
      }),
    ).toEqual([]);
  });

  it('allows declared Russian-only pages', () => {
    const fixture = createFixture();
    const target = 'users/work/features/local.md';
    writeFileSync(
      join(fixture.targetRoot, target),
      '---\ntitle: Локальная страница\n---\n',
    );
    writeFileSync(
      join(fixture.targetRoot, 'users', 'work', 'features', 'example.md'),
      '---\ntitle: Пример\n---\n',
    );

    expect(
      collectSyncIssues({
        ...fixture,
        manifest: manifest({ localOnly: [target] }),
        checkHashes: false,
      }),
    ).toEqual([]);
  });

  it('reports a changed source hash', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.targetRoot, 'users', 'work', 'features', 'example.md'),
      '---\ntitle: Пример\n---\n',
    );
    const issues = collectSyncIssues({
      ...fixture,
      manifest: manifest({
        sourceHashes: { 'users/features/example.md': 'old-hash' },
      }),
    });

    expect(issues).toContain(
      'Английский источник изменился после перевода: users/features/example.md',
    );
  });

  it('reports a broken local link', () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.targetRoot, 'users', 'work', 'features', 'example.md'),
      '---\ntitle: Пример\n---\n\n[Нет страницы](./missing.md)\n',
    );
    const issues = collectSyncIssues({
      ...fixture,
      manifest: manifest(),
      checkHashes: false,
    });

    expect(issues).toContain(
      'Битая локальная ссылка в users/work/features/example.md: ./missing.md',
    );
  });

  it('accepts an alias with the canonical marker', () => {
    const fixture = createFixture();
    const canonical = 'users/work/features/example.md';
    const alias = 'users/work/features/example-old.md';
    writeFileSync(
      join(fixture.targetRoot, canonical),
      '---\ntitle: Пример\n---\n',
    );
    writeFileSync(
      join(fixture.targetRoot, alias),
      `---\ntitle: Старый маршрут\n---\n\n<!-- docs-ru-alias: ${canonical} -->\n\n[Новый маршрут](./example.md)\n`,
    );

    expect(
      collectSyncIssues({
        ...fixture,
        manifest: manifest({
          aliases: { 'users/features/example.md': [alias] },
        }),
        checkHashes: false,
      }),
    ).toEqual([]);
  });
});
