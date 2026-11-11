/** Local update snapshots contain credentials: private permissions, no network and no link traversal. */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, mkdirSync, copyFileSync, chmodSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { noLinks, privateWrite, document, contained } from '../personal/store.mjs';
import { processIsAlive } from '../graphify.mjs';
const excluded = new Set(['updates', 'backups', 'sync.lock', 'install.lock', 'desktop-lease.json', 'run-owners', 'launch']);
const transient = new Set(['watch.pid', 'refresh.pid', 'watch-parents', 'workflow-worker.json']);
export const privateDataDirectory = home => resolve(process.env.ODYSSEUS_DATA_DIR || join(home, '.odysseus'));
export const installedRoot = home => join(home, 'Library/Application Support/Odysseus/runtime');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(root, privateFiles = false, prefix = '') {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const name of readdirSync(root).sort()) {
    if ((!prefix && privateFiles && excluded.has(name)) || transient.has(name)) continue;
    const path = join(root, name), key = prefix + name, stat = lstatSync(path);
    if (stat.isSymbolicLink()) entries.push({ path: key, kind: 'link', target: readlinkSync(path) });
    else if (stat.isDirectory()) entries.push({ path: key, kind: 'directory' }, ...inventory(path, privateFiles, key + '/'));
    else if (stat.isFile()) entries.push({ path: key, kind: 'file', size: stat.size, hash: digest(readFileSync(path)), executable: Boolean(stat.mode & 0o111) });
    else throw Error('Резервная копия не поддерживает специальный файл: ' + path);
  }
  return entries;
}
function copyInventory(source, target, entries) {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const file = join(target, entry.path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (entry.kind === 'directory') mkdirSync(file, { mode: 0o700 });
    else if (entry.kind === 'link') symlinkSync(entry.target, file);
    else { copyFileSync(join(source, entry.path), file); chmodSync(file, entry.executable ? 0o700 : 0o600); }
  }
}
export function assertUpdateIdle(root, privateDir) {
  const check = file => {
    noLinks(file);
    if (existsSync(file) && processIsAlive(document(file).pid))
      throw Error('Закройте Odysseus Desktop и все сеансы od; дождитесь завершения синхронизации и повторите запуск.');
  };
  check(join(privateDir, 'desktop-lease.json'));
  for (const folder of [join(privateDir, 'run-owners'), join(root, '.odysseus/graphify/watch-parents')]) {
    noLinks(folder);
    if (existsSync(folder)) for (const file of readdirSync(folder)) if (file.endsWith('.json')) check(join(folder, file));
  }
  for (const name of ['sync.lock', 'install.lock']) {
    const lock = join(privateDir, name);
    if (existsSync(lock)) {
      const owner = join(lock, 'owner.json');
      if (!existsSync(owner) || !Number.isInteger(document(owner).pid)) throw Error('Синхронизация или импорт ещё занимает профиль. Повторите позже.');
      check(owner);
    }
  }
  for (const name of ['refresh.pid', 'workflow-worker.json']) check(join(root, '.odysseus/graphify', name));
}
export function snapshotData(root, privateDir, metadata = {}) {
  noLinks(root); noLinks(privateDir);
  const base = join(privateDir, 'updates/backups'); noLinks(base);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  const stage = join(base, '.' + id), destination = join(base, id);
  mkdirSync(stage, { mode: 0o700 });
  const sources = { private: privateDir, workspace: join(root, 'workspace'), knowledge: join(root, '.odysseus'), shared: join(root, 'shared') };
  for (const [name, source] of Object.entries(sources)) if (name !== 'private' && contained(source, base)) {
    rmSync(stage, { recursive: true, force: true });
    throw Error('Папка резервных копий не должна находиться внутри рабочей папки, графа или общих навыков');
  }
  const groups = {};
  try {
    for (const [name, source] of Object.entries(sources)) {
      noLinks(source);
      if (!existsSync(source)) continue;
      const before = inventory(source, name === 'private');
      copyInventory(source, join(stage, name), before);
      const copied = inventory(join(stage, name));
      if (JSON.stringify(before) !== JSON.stringify(copied) || JSON.stringify(before) !== JSON.stringify(inventory(source, name === 'private')))
        throw Error('Данные изменились во время резервного копирования. Закройте приложение и повторите обновление.');
      groups[name] = before;
    }
    privateWrite(join(stage, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, createdAt: new Date().toISOString(), metadata: { ...metadata, dataSchemaVersion: document(join(root, 'distribution.json')).dataSchemaVersion ?? 1 }, groups }, null, 2));
    renameSync(stage, destination);
    return { id, path: destination };
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
export function backupPath(privateDir, id) {
  if (typeof id !== 'string' || !/^[\dTZa-f-]+$/.test(id) || id.length > 100) throw Error('Неверный идентификатор резервной копии');
  return join(privateDir, 'updates/backups', id);
}
export function verifyBackup(privateDir, id) {
  const path = backupPath(privateDir, id); noLinks(path);
  const manifest = document(join(path, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.id !== id || !manifest.groups || typeof manifest.groups !== 'object' || Array.isArray(manifest.groups)) throw Error('Неверный манифест резервной копии');
  for (const [name, expected] of Object.entries(manifest.groups)) {
    if (!['private', 'workspace', 'knowledge', 'shared'].includes(name) || !Array.isArray(expected)) throw Error('Неверная группа резервной копии');
    const folder = join(path, name); noLinks(folder);
    if (!existsSync(folder) || JSON.stringify(inventory(folder)) !== JSON.stringify(expected)) throw Error('Резервная копия повреждена: ' + name);
  }
  return { path, manifest };
}
export function listBackups(privateDir) {
  const base = join(privateDir, 'updates/backups'); noLinks(base);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(name => !name.startsWith('.')).sort().reverse().map(id => {
    const file = join(backupPath(privateDir, id), 'manifest.json'); noLinks(file);
    const data = document(file);
    return { id, createdAt: data.createdAt, ...data.metadata };
  });
}
function restoreActions(root, privateDir, tx) {
  if (!/^[a-f0-9-]{36}$/.test(tx.id) || !Array.isArray(tx.actions)) throw Error('Неверный журнал восстановления');
  return tx.actions.map((entry, index) => {
    if (!['private', 'workspace', 'knowledge', 'shared'].includes(entry.group) || typeof entry.existed !== 'boolean') throw Error('Неверная группа восстановления');
    let target;
    if (entry.group === 'private') {
      if (typeof entry.name !== 'string' || !entry.name || ['.', '..'].includes(entry.name) || /[\\/]/.test(entry.name) || excluded.has(entry.name)) throw Error('Неверный путь восстановления');
      target = join(privateDir, entry.name);
    } else target = join(root, { workspace: 'workspace', knowledge: '.odysseus', shared: 'shared' }[entry.group]);
    noLinks(target);
    const stage = join(dirname(target), '.restore-' + tx.id + '-' + index);
    noLinks(stage); noLinks(stage + '-previous');
    return { ...entry, target, stage, old: stage + '-previous' };
  });
}
export function recoverRestore(root, privateDir) {
  assertUpdateIdle(root, privateDir);
  const journal = join(privateDir, 'updates/pending-restore.json');
  if (!existsSync(journal)) return { recovered: false };
  const tx = document(journal), actions = restoreActions(root, privateDir, tx);
  if (!['staging', 'swapping', 'committed'].includes(tx.phase)) throw Error('Неверная стадия восстановления');
  if (tx.phase === 'swapping') for (const action of [...actions].reverse()) {
    if (existsSync(action.old)) { rmSync(action.target, { recursive: true, force: true }); renameSync(action.old, action.target); }
    else if (!action.existed && !existsSync(action.stage)) rmSync(action.target, { recursive: true, force: true });
  }
  for (const action of actions) {
    rmSync(action.stage, { recursive: true, force: true });
    if (tx.phase === 'committed') rmSync(action.old, { recursive: true, force: true });
  }
  rmSync(journal);
  return { recovered: true, committed: tx.phase === 'committed' };
}
export function restoreData(root, privateDir, id) {
  assertUpdateIdle(root, privateDir);
  const journal = join(privateDir, 'updates/pending-restore.json');
  if (existsSync(journal)) throw Error('Сначала выполните od maintenance recover');
  const { path, manifest } = verifyBackup(privateDir, id);
  if ((manifest.metadata?.dataSchemaVersion ?? 1) !== 1) throw Error('Эта версия не поддерживает формат данных резервной копии');
  const rescue = snapshotData(root, privateDir, { reason: 'before-restore', restoring: id });
  const entries = [];
  for (const group of Object.keys(manifest.groups)) {
    if (group === 'private') for (const name of readdirSync(join(path, group))) entries.push({ group, name, existed: existsSync(join(privateDir, name)) });
    else entries.push({ group, existed: existsSync(join(root, { workspace: 'workspace', knowledge: '.odysseus', shared: 'shared' }[group])) });
  }
  const tx = { id: randomUUID(), phase: 'staging', actions: entries, rescueBackup: rescue.id };
  const actions = restoreActions(root, privateDir, tx);
  privateWrite(journal, JSON.stringify(tx));
  try {
    for (const action of actions) {
      const source = join(path, action.group, action.name || ''), stat = lstatSync(source);
      if (stat.isDirectory()) copyInventory(source, action.stage, inventory(source));
      else if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), action.stage);
      else { copyFileSync(source, action.stage); chmodSync(action.stage, stat.mode & 0o111 ? 0o700 : 0o600); }
    }
    privateWrite(journal, JSON.stringify({ ...tx, phase: 'swapping' }));
    for (const action of actions) {
      if (action.existed) renameSync(action.target, action.old);
      renameSync(action.stage, action.target);
    }
    privateWrite(journal, JSON.stringify({ ...tx, phase: 'committed' }));
    recoverRestore(root, privateDir);
  } catch (error) {
    recoverRestore(root, privateDir);
    throw Error('Восстановление прервано; текущая копия сохранена: ' + rescue.path + '. ' + error.message);
  }
  return { restored: id, rescueBackup: rescue.id };
}
export function writeRunLease(privateDir, pid) {
  if (!Number.isSafeInteger(pid) || !processIsAlive(pid)) throw Error('Неверный владелец запущенного Odysseus');
  const file = join(privateDir, 'run-owners', String(pid) + '.json');
  privateWrite(file, JSON.stringify({ pid, startedAt: Date.now() }));
  return file;
}
