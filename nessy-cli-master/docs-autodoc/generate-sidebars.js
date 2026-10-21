#!/usr/bin/env node

/**
 * Reads _meta.ts files from docs/ and generates a static sidebars.js
 * for Docusaurus. Run before build or start.
 */

const { readFileSync, existsSync, statSync, writeFileSync } = require('fs');
const { join } = require('path');

const DOCS_ROOT = join(__dirname, '..', 'docs');
const OUTPUT = join(__dirname, '..', 'sidebars.js');

function parseMetaFile(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const body = raw
    .replace(/export\s+default\s+/, '')
    .replace(/;\s*$/, '')
    .trim();
  return new Function('return (' + body + ')')();
}

function isHidden(value) {
  return (
    typeof value === 'object' && value !== null && value.display === 'hidden'
  );
}

function buildSidebarItems(dirPath, docIdPrefix) {
  const meta = parseMetaFile(join(dirPath, '_meta.ts'));
  const items = [];

  for (const [key, value] of Object.entries(meta)) {
    if (isHidden(value)) continue;

    if (
      typeof value === 'object' &&
      value !== null &&
      value.type === 'separator'
    ) {
      items.push({
        type: 'html',
        value: value.title || key,
        className: 'sidebar-separator-item',
      });
      continue;
    }

    if (typeof value === 'object' && value !== null && value.type === 'page')
      continue;

    if (typeof value === 'string') {
      const subDir = join(dirPath, key);
      if (
        existsSync(subDir) &&
        statSync(subDir).isDirectory() &&
        existsSync(join(subDir, '_meta.ts'))
      ) {
        items.push({
          type: 'category',
          label: value,
          items: buildSidebarItems(subDir, docIdPrefix + '/' + key),
        });
      } else {
        items.push(docIdPrefix + '/' + key);
      }
    }
  }
  return items;
}

function buildSidebars() {
  const rootMeta = parseMetaFile(join(DOCS_ROOT, '_meta.ts'));
  const allItems = [];
  for (const [key, value] of Object.entries(rootMeta)) {
    if (isHidden(value)) continue;
    if (typeof value !== 'object' || value.type !== 'page') continue;
    if (existsSync(join(DOCS_ROOT, key, '_meta.ts'))) {
      allItems.push({
        type: 'category',
        label: value.title,
        items: buildSidebarItems(join(DOCS_ROOT, key), key),
      });
    }
  }
  return { '.': allItems };
}

const sidebars = buildSidebars();
const content =
  '// Auto-generated from docs/**/_meta.ts — do not edit manually.\n' +
  '// Regenerate: node generate-sidebars.js\n' +
  'const sidebars = ' +
  JSON.stringify(sidebars, null, 2) +
  ';\n\nmodule.exports = sidebars;\n';

writeFileSync(OUTPUT, content, 'utf-8');
console.log('Generated sidebars.js');
