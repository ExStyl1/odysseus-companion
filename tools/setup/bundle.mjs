/** Read selected data from an application bundle, without loading its JavaScript. */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { noLinks } from '../personal/store.mjs';
import { createRequire } from 'node:module';
const directories = new Set([
  '.nessy',
  '.nessy-agent',
  '.nestor',
  'skills',
  'agents',
  'rules',
  'sources',
  'themes',
  'plugins',
  'docs',
  'config',
  'settings',
]);
const names = new Set([
  'settings.json',
  'config.json',
  'preferences.json',
  'mcp.json',
  '.mcp.json',
  'connections.json',
]);
function selected(path) {
  const parts = path.split('/').filter(Boolean);
  while (['dist', 'resources', 'data'].includes(parts[0])) parts.shift();
  return (
    (parts.length === 0 ||
      directories.has(parts[0]) ||
      (parts.length === 1 && names.has(parts[0]))) &&
    !parts.includes('node_modules') &&
    !parts.includes('.git')
  );
}
export function bundleData(root, app, report) {
  const resources = join(app, 'Contents/Resources');
  if (!existsSync(resources)) return [];
  try {
    noLinks(resources);
  } catch {
    report.skipped.push({ path: resources, reason: 'bundle-link' });
    return [];
  }
  const entries = [];
  const visit = (folder, relative = '') => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = relative ? relative + '/' + item.name : item.name;
      if (!selected(path)) continue;
      const file = join(folder, item.name);
      if (item.isSymbolicLink()) {
        report.skipped.push({ path: file, reason: 'bundle-link' });
        continue;
      }
      if (item.isDirectory()) visit(file, path);
      else if (item.isFile()) entries.push({ file, path: 'resources/' + path });
    }
  };
  visit(resources);
  const archive = join(resources, 'app.asar');
  if (!existsSync(archive)) return entries;
  try {
    noLinks(archive);
  } catch {
    report.skipped.push({ path: archive, reason: 'bundle-link' });
    return entries;
  }
  let asar;
  try {
    const config = JSON.parse(readFileSync(join(root, 'odysseus.json'), 'utf8'));
    const require = createRequire(join(root, config.components.desktop.source, 'package.json'));
    asar = require('@electron/asar');
  } catch {
    report.warnings.push({ path: archive, reason: 'asar-reader-unavailable' });
    return entries;
  }
  try {
    for (const original of asar.listPackage(archive)) {
      const path = original.replace(/^[/\\]+/, '');
      if (posix.normalize(path) !== path || path.split('/').includes('..') || !selected(path))
        continue;
      const stat = asar.statFile(archive, path);
      if (stat.files) continue;
      if (stat.link) {
        report.skipped.push({ path: archive + '!' + path, reason: 'bundle-link' });
        continue;
      }
      if (stat.unpacked) {
        const unpacked = resolve(archive + '.unpacked', path);
        if (!unpacked.startsWith(resolve(archive + '.unpacked') + '/'))
          throw Error('Invalid unpacked resource');
        try {
          noLinks(unpacked);
        } catch {
          report.skipped.push({ path: unpacked, reason: 'bundle-link' });
          continue;
        }
        if (lstatSync(unpacked).isSymbolicLink()) {
          report.skipped.push({ path: unpacked, reason: 'bundle-link' });
          continue;
        }
      }
      entries.push({
        file: archive,
        path: 'app-asar/' + path,
        size: stat.size,
        executable: !!stat.executable,
        read: () => asar.extractFile(archive, path),
      });
    }
  } catch {
    report.warnings.push({ path: archive, reason: 'asar-could-not-be-read' });
  }
  return entries;
}
