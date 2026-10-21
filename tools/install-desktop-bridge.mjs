#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contained, privateWrite } from './personal/store.mjs';
export function installDesktopBridge(root, { source, check = false } = {}) {
  const base = join(root, 'integrations/desktop'),
    manifest = JSON.parse(readFileSync(join(base, 'manifest.json'))),
    config = JSON.parse(readFileSync(join(root, 'odysseus.json')));
  const desktop = resolve(root, source || config.components.desktop.source),
    staged = new Map();
  const read = (path) => {
    if (!contained(desktop, path)) throw Error('Invalid integration path');
    return staged.get(path) ?? readFileSync(path, 'utf8');
  };
  const brand = (value) => {
    for (const [from, to] of Object.entries(manifest.brandText || {}))
      value = value.replaceAll(from, to);
    return value.replace(/\bNessy\b(?! Gateway| Cloud| CLI|_)(?![\w-])/g, 'Odysseus');
  };
  // Validate the entire upstream source before writing any patch. A changed seam is an explicit failure.
  for (const p of manifest.patches) {
    const path = join(desktop, p.path),
      text = read(path);
    if (p.append) {
      if (!text.includes(p.append)) staged.set(path, text + p.append);
      continue;
    }
    if (text.includes(p.after)) continue;
    if (text.split(p.before).length !== 2)
      throw Error(`Desktop update needs integration review: ${p.path}`);
    staged.set(path, text.replace(p.before, p.after));
  }
  for (const [name, keys] of Object.entries(manifest.locales)) {
    const path = join(desktop, name),
      text = read(path),
      data = JSON.parse(text);
    if (manifest.brandText)
      for (const key of Object.keys(data))
        if (typeof data[key] === 'string') data[key] = brand(data[key]);
    for (const [key, value] of Object.entries(keys)) {
      if (data[key] !== undefined && data[key] !== value)
        throw Error(`Integration locale key conflict: ${key}`);
      data[key] = value;
    }
    const next =
      JSON.stringify(
        Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        null,
        2,
      ) + '\n';
    if (text !== next) staged.set(path, next);
  }
  for (const [name, template] of Object.entries(manifest.files)) {
    const path = join(desktop, name),
      next = readFileSync(join(base, template), 'utf8');
    if (!contained(desktop, path)) throw Error('Invalid integration path');
    if (existsSync(path) && read(path) !== next)
      throw Error(`Existing integration differs: ${name}`);
    if (!existsSync(path)) staged.set(path, next);
  }
  for (const [name, template] of Object.entries(manifest.binaryFiles || {})) {
    const path = join(desktop, name),
      next = readFileSync(join(base, typeof template === 'string' ? template : template.template));
    if (!contained(desktop, path)) throw Error('Invalid integration path');
    const existing = existsSync(path) ? readFileSync(path) : null;
    if (
      existing &&
      !existing.equals(next) &&
      createHash('sha256').update(existing).digest('hex') !== template.previousSha256
    )
      throw Error(`Existing integration differs: ${name}`);
    if (!existing || !existing.equals(next)) staged.set(path, next);
  }
  if (!check) {
    const backup = join(root, '.odysseus/integration-backups', String(Date.now()));
    for (const [path, text] of staged) {
      if (existsSync(path))
        privateWrite(join(backup, path.slice(desktop.length + 1)), readFileSync(path));
      privateWrite(path, text);
    }
  }
  return { check, changedFiles: [...staged.keys()] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const report = installDesktopBridge(root, {
      check: process.argv.includes('--check'),
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
