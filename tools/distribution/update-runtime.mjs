/** Replace code as one recoverable transaction; user data is kept outside these paths. */
import { existsSync, mkdirSync, cpSync, renameSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { noLinks, privateWrite, document } from '../personal/store.mjs';
export const codeNames = ['tools', 'integrations', 'cli', 'desktop', 'docs', 'shared', 'odysseus.json', 'distribution.json'];
const sha = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
export function assertCompatibleRelease(previous, next) {
  const schema = next.dataSchemaVersion ?? 1;
  if (!Number.isInteger(schema) || schema !== 1 || (previous.dataSchemaVersion ?? 1) > schema)
    throw Error('Эта версия не поддерживает формат данных профиля. Установите совместимый выпуск Odysseus.');
  const parts = version => /^(\d+)\.(\d+)\.(\d+)-odysseus\.(\d+)$/.exec(version || '')?.slice(1).map(Number);
  const a = parts(previous.version), b = parts(next.version);
  if (a && b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] > b[i]) throw Error('Установлена более новая версия Odysseus. Понижение версии заблокировано для защиты данных.');
      if (a[i] < b[i]) break;
    }
  }
}
export function recoverCodeUpdate(root) {
  const file = join(root, '.update-transaction.json'); noLinks(file);
  if (!existsSync(file)) return;
  const tx = document(file);
  if (!/^[a-f0-9-]{36}$/.test(tx.id) || !Array.isArray(tx.entries) || tx.entries.some(entry => !codeNames.includes(entry.name) || typeof entry.existed !== 'boolean')) throw Error('Неверный журнал обновления; данные сохранены, требуется диагностика.');
  if (!['swapping', 'committed'].includes(tx.phase)) throw Error('Неверная стадия обновления');
  const stage = join(root, '.update-' + tx.id); noLinks(stage);
  if (tx.phase !== 'committed') {
    for (const entry of [...tx.entries].reverse()) {
      const target = join(root, entry.name), old = join(stage, 'previous', entry.name), next = join(stage, 'next', entry.name);
      noLinks(target); noLinks(old); noLinks(next);
      if (existsSync(old)) {
        rmSync(target, { recursive: true, force: true }); renameSync(old, target);
      } else if (!entry.existed && !existsSync(next)) rmSync(target, { recursive: true, force: true });
    }
  }
  rmSync(stage, { recursive: true, force: true }); rmSync(file);
}
export function replaceCode(root, payload, previous, release, backup) {
  const id = randomUUID(), stage = join(root, '.update-' + id), journal = join(root, '.update-transaction.json');
  mkdirSync(join(stage, 'next'), { recursive: true, mode: 0o700 });
  const next = name => join(stage, 'next', name), managed = {}, conflicts = [];
  try {
    for (const name of codeNames.slice(0, 5)) {
      noLinks(join(root, name));
      cpSync(join(payload, name), next(name), { recursive: true, dereference: true });
    }
    // Merge a staged copy, never the live shared directory. Preserve user modifications.
    if (existsSync(join(root, 'shared'))) cpSync(join(root, 'shared'), next('shared'), { recursive: true, dereference: false, verbatimSymlinks: true });
    else mkdirSync(next('shared'), { mode: 0o700 });
    function merge(source, target, prefix = '') {
      noLinks(target);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const item of readdirSync(source, { withFileTypes: true })) {
        const key = prefix + item.name, s = join(source, item.name), t = join(target, item.name);
        noLinks(t);
        if (item.isSymbolicLink()) throw Error('Unexpected bundle link');
        if (item.isDirectory()) merge(s, t, key + '/');
        else {
          const before = sha(t), after = sha(s);
          if (!before || before === previous.shared?.[key] || before === after) { cpSync(s, t); managed[key] = after; }
          else { managed[key] = previous.shared?.[key] || null; conflicts.push(key); }
        }
      }
    }
    merge(join(payload, 'shared'), next('shared'));
    cpSync(join(payload, 'odysseus.json'), next('odysseus.json'));
    privateWrite(next('distribution.json'), JSON.stringify({ ...release, dataSchemaVersion: release.dataSchemaVersion ?? 1, shared: managed, updateBackup: backup?.id, sharedConflicts: conflicts }));
    const tx = { id, phase: 'swapping', entries: codeNames.map(name => ({ name, existed: existsSync(join(root, name)) })) };
    mkdirSync(join(stage, 'previous'), { mode: 0o700 });
    privateWrite(journal, JSON.stringify(tx)); // Durable intent precedes the first live rename.
    for (const entry of tx.entries) {
      if (entry.existed) renameSync(join(root, entry.name), join(stage, 'previous', entry.name));
      renameSync(next(entry.name), join(root, entry.name));
    }
    privateWrite(journal, JSON.stringify({ ...tx, phase: 'committed' }));
    recoverCodeUpdate(root); // Committed transaction only removes old code.
  } catch (error) {
    if (existsSync(journal)) recoverCodeUpdate(root);
    else rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
