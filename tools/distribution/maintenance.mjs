/** Recovery entry point intentionally runs before prepare/migrations, including after failed upgrades. */
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { privateWrite, document, noLinks } from '../personal/store.mjs';
import { recoverCodeUpdate } from './update-runtime.mjs';
import { processIsAlive } from '../graphify.mjs';
import { ensureFirstRun } from '../setup/first-run.mjs';
import { installedRoot, privateDataDirectory, listBackups, verifyBackup, snapshotData, restoreData, recoverRestore, assertUpdateIdle } from './update-data.mjs';
export function maintenance(args, { home = homedir() } = {}) {
  const root = installedRoot(home), privateDir = privateDataDirectory(home), [command = 'status', id] = args;
  const release = document(join(root, 'distribution.json'));
  if (command === 'status') return {
    installed: { version: release.version, buildId: release.buildId, dataSchemaVersion: release.dataSchemaVersion ?? 1, updateBackup: release.updateBackup, sharedConflicts: release.sharedConflicts || [] }, data: privateDir, backups: listBackups(privateDir),
    restorePending: existsSync(join(privateDir, 'updates/pending-restore.json')),
    codeUpdatePending: existsSync(join(root, '.update-transaction.json')),
  };
  if (command === 'verify') { const checked = verifyBackup(privateDir, id); return { verified: id, createdAt: checked.manifest.createdAt }; }
  if (!['backup', 'restore', 'recover', 'repair-plugins'].includes(command)) throw Error('Команды: od maintenance status | backup | verify ID | restore ID | recover | repair-plugins');
  noLinks(root); mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, '.distribution.lock'); noLinks(lock);
  if (existsSync(lock) && !processIsAlive(document(join(lock, 'owner.json')).pid)) {
    // Never remove a creator's not-yet-published owner record.
    if (existsSync(join(lock, 'owner.json'))) rmSync(lock, { recursive: true });
  }
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw Error('Odysseus обновляется. Повторите позже.'); }
  privateWrite(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  try {
    assertUpdateIdle(root, privateDir);
    const codePending = existsSync(join(root, '.update-transaction.json'));
    if (command === 'recover') {
      recoverCodeUpdate(root);
      return { codeRecovered: codePending, ...recoverRestore(root, privateDir) };
    }
    if (codePending) throw Error('Сначала выполните od maintenance recover: замена кода была прервана');
    if (command === 'restore') return restoreData(root, privateDir, id);
    if (existsSync(join(privateDir, 'updates/pending-restore.json'))) throw Error('Сначала выполните od maintenance recover');
    if (command === 'repair-plugins') {
      const backup = snapshotData(root, privateDir, { reason: 'before-plugin-repair' });
      ensureFirstRun(root, { home, repairPlugins: true });
      return { backup: backup.id, repair: document(join(privateDir, 'profiles/plugin-cache-recovery-v1.json')) };
    }
    return snapshotData(root, privateDir, { reason: 'manual', version: document(join(root, 'distribution.json')).version });
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
