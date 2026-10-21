#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = join(repositoryRoot, 'docs');
const docsRuRoot = join(repositoryRoot, 'docs-ru');
const manifestPath = join(docsRuRoot, '.sync-manifest.json');

function listFiles(root, predicate, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(root, predicate, path));
    } else if (predicate(path)) {
      files.push(relative(root, path).split(/[/\\]/).join('/'));
    }
  }
  return files.sort();
}

function readManifest(path = manifestPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function mapSourcePath(sourcePath, manifest) {
  if (manifest.pathOverrides[sourcePath]) {
    return manifest.pathOverrides[sourcePath];
  }

  const directoryMappings = [
    ['users/features/', 'users/work/features/'],
    ['users/configuration/', 'users/work/configuration/'],
    ['users/extension/', 'users/work/extension/'],
    ['users/reference/', 'users/work/reference/'],
    ['users/support/', 'users/work/support/'],
    ['users/ide-integration/', 'users/ide/'],
    ['developers/tools/', 'developers/work/tools/'],
    ['developers/development/', 'developers/work/development/'],
    ['developers/examples/', 'developers/work/examples/'],
    ['developers/daemon/', 'developers/work/daemon/'],
    [
      'developers/daemon-client-adapters/',
      'developers/work/daemon-client-adapters/',
    ],
    ['developers/daemon-ui/', 'developers/work/daemon-ui/'],
  ];

  for (const [sourcePrefix, targetPrefix] of directoryMappings) {
    if (sourcePath.startsWith(sourcePrefix)) {
      return targetPrefix + sourcePath.slice(sourcePrefix.length);
    }
  }

  if (
    /^users\/integration-(vscode|zed|jetbrains(?:-alt)?|github-action)\.md$/.test(
      sourcePath,
    )
  ) {
    return sourcePath.replace('users/', 'users/ide/');
  }
  if (/^users\/nessy-serve(?:-deploy-local)?\.md$/.test(sourcePath)) {
    return sourcePath.replace('users/', 'users/work/features/');
  }
  if (
    /^developers\/sdk-(?:typescript|python|java|publishing)\.md$/.test(
      sourcePath,
    )
  ) {
    return sourcePath.replace('developers/', 'developers/sdk/');
  }

  return sourcePath;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hasFrontMatter(content) {
  return content.startsWith('---\n') && content.indexOf('\n---\n', 4) !== -1;
}

function withoutCodeFences(content) {
  return content.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

function localLinks(content) {
  const links = [];
  const markdown = withoutCodeFences(content);
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const value = match[1].replace(/^<|>$/g, '');
    if (!/^(?:[a-z]+:|#)/i.test(value)) links.push(value);
  }
  return links;
}

function linkExists(documentPath, link, targetRoot) {
  const cleanLink = decodeURIComponent(link.split(/[?#]/, 1)[0]);
  if (!cleanLink) return true;

  const base = link.startsWith('/')
    ? join(targetRoot, cleanLink.slice(1))
    : resolve(dirname(documentPath), cleanLink);
  const candidates = [base];
  if (!extname(base)) candidates.push(`${base}.md`, join(base, 'index.md'));
  return candidates.some(existsSync);
}

export function collectSyncIssues({
  sourceRoot = docsRoot,
  targetRoot = docsRuRoot,
  manifest = readManifest(),
  checkHashes = true,
} = {}) {
  const issues = [];
  const sourceFiles = listFiles(sourceRoot, (path) => path.endsWith('.md'));
  const targetFiles = listFiles(targetRoot, (path) => path.endsWith('.md'));
  const excluded = new Set(manifest.excludedSources);
  const protectedSources = new Set(Object.keys(manifest.protected));
  const expectedTargets = new Map();

  for (const source of sourceFiles) {
    if (excluded.has(source)) continue;
    const target =
      manifest.protected[source] ?? mapSourcePath(source, manifest);
    if (expectedTargets.has(target)) {
      issues.push(
        `Несколько источников сопоставлены с ${target}: ${expectedTargets.get(target)} и ${source}`,
      );
    }
    expectedTargets.set(target, source);

    if (!existsSync(join(targetRoot, target))) {
      issues.push(`Нет русского документа для ${source}: ${target}`);
    }

    if (checkHashes && !protectedSources.has(source)) {
      const expectedHash = manifest.sourceHashes[source];
      const actualHash = sha256(join(sourceRoot, source));
      if (!expectedHash) {
        issues.push(`Не зафиксирован хеш источника: ${source}`);
      } else if (expectedHash !== actualHash) {
        issues.push(`Английский источник изменился после перевода: ${source}`);
      }
    }
  }

  for (const source of Object.keys(manifest.sourceHashes)) {
    if (!sourceFiles.includes(source) || excluded.has(source)) {
      issues.push(`В манифесте остался удалённый источник: ${source}`);
    }
  }

  const allowedTargets = new Set([
    ...expectedTargets.keys(),
    ...manifest.localOnly,
    ...Object.values(manifest.aliases).flat(),
  ]);
  for (const target of targetFiles) {
    if (!allowedTargets.has(target)) {
      issues.push(`Русская страница не описана в карте: ${target}`);
    }
  }

  const protectedTargets = new Set(Object.values(manifest.protected));
  for (const target of targetFiles) {
    if (protectedTargets.has(target)) continue;
    const absoluteTarget = join(targetRoot, target);
    const content = readFileSync(absoluteTarget, 'utf8');
    if (!hasFrontMatter(content)) {
      issues.push(`Нет Docusaurus front matter: ${target}`);
    }
    if (/^> \[!(?:NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]/im.test(content)) {
      issues.push(`Остался GFM admonition: ${target}`);
    }
    for (const link of localLinks(content)) {
      if (!linkExists(absoluteTarget, link, targetRoot)) {
        issues.push(`Битая локальная ссылка в ${target}: ${link}`);
      }
    }
  }

  const directoriesWithDocuments = new Set(
    targetFiles.map(posix.dirname).filter((directory) => directory !== '.'),
  );
  for (const directory of directoriesWithDocuments) {
    if (!existsSync(join(targetRoot, directory, '_category_.yml'))) {
      issues.push(`Нет _category_.yml для каталога: ${directory}`);
    }
  }

  for (const [source, aliases] of Object.entries(manifest.aliases)) {
    const canonicalTarget = mapSourcePath(source, manifest);
    for (const alias of aliases) {
      const aliasPath = join(targetRoot, alias);
      if (!existsSync(aliasPath)) continue;
      const marker = `<!-- docs-ru-alias: ${canonicalTarget} -->`;
      if (!readFileSync(aliasPath, 'utf8').includes(marker)) {
        issues.push(`Дублирующая страница не оформлена как alias: ${alias}`);
      }
    }
  }

  return issues;
}

function recordHashes(manifest) {
  const issues = collectSyncIssues({ manifest, checkHashes: false });
  if (issues.length > 0) return issues;

  const excluded = new Set(manifest.excludedSources);
  const protectedSources = new Set(Object.keys(manifest.protected));
  const sources = listFiles(docsRoot, (path) => path.endsWith('.md'));
  manifest.sourceHashes = Object.fromEntries(
    sources
      .filter(
        (source) => !excluded.has(source) && !protectedSources.has(source),
      )
      .map((source) => [source, sha256(join(docsRoot, source))]),
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return [];
}

function main() {
  const manifest = readManifest();
  const issues = process.argv.includes('--record')
    ? recordHashes(manifest)
    : collectSyncIssues({ manifest });
  if (issues.length > 0) {
    for (const issue of issues) console.error(`- ${issue}`);
    console.error(
      `\nПроверка docs-ru завершилась с ошибками: ${issues.length}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    process.argv.includes('--record')
      ? 'Состояние синхронизации docs-ru записано.'
      : 'docs-ru синхронизирована с docs.',
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
