/** Materialize bundled code in a writable user runtime; preserve user resources on upgrades. */
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { noLinks, privateWrite } from '../personal/store.mjs';
import { runtimePaths, connectDesktopSources, refresh } from '../graphify.mjs';
import { installKnowledgeHooks } from '../setup/knowledge-hooks.mjs';
import { assertUpdateIdle, snapshotData, privateDataDirectory, writeRunLease } from './update-data.mjs';
import { assertCompatibleRelease, recoverCodeUpdate, replaceCode } from './update-runtime.mjs';
import { registerAutomationSources } from '../automations/sources.mjs';
import { initializeLanguage } from './language.mjs';
import { ensureFirstRun } from '../setup/first-run.mjs';
const json = (file, fallback = {}) =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export function installCommand({ home, node, entry }) {
  const bin = join(home, '.local/bin'),
    command = join(bin, 'od'),
    marker = '# Odysseus managed CLI';
  noLinks(bin);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  noLinks(command);
  if (existsSync(command) && !readFileSync(command, 'utf8').includes(marker))
    return ['Команда od уже занята: ' + command];
  privateWrite(command, `#!/bin/sh\n${marker}\nexec ${quote(node)} ${quote(entry)} "$@"\n`);
  chmodSync(command, 0o700);
  const warnings = [];
  for (const name of ['.zprofile', '.zshrc', '.bash_profile']) {
    const file = join(home, name);
    try {
      noLinks(file);
      const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!before.includes('# >>> Odysseus CLI >>>'))
        writeFileSync(
          file,
          before +
            '\n# >>> Odysseus CLI >>>\ncase "$PATH" in "$HOME/.local/bin"|"$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n# <<< Odysseus CLI <<<\n',
          { mode: 0o600 },
        );
    } catch {
      warnings.push('Добавьте ~/.local/bin в PATH: ' + file);
    }
  }
  return warnings;
}
export function prepareDistribution(payload, { home = homedir(), install = true, owner } = {}) {
  payload = resolve(payload);
  const release = json(join(payload, 'release.json'));
  if (!release.buildId) throw Error('Invalid distribution');
  const root = join(home, 'Library/Application Support/Odysseus/runtime');
  noLinks(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = join(root, 'distribution.json'), lock = join(root, '.distribution.lock');
  noLinks(lock);
  if (existsSync(lock)) {
    const owner = json(join(lock, 'owner.json'));
    let alive = true;
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    } else if (Date.now() - statSync(lock).mtimeMs > 30000) alive = false;
    if (!alive) rmSync(lock, { recursive: true });
  }
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw Error('Odysseus обновляется. Повторите запуск через несколько секунд.'); }
  privateWrite(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  try {
    const privateDir = privateDataDirectory(home);
    // An interrupted restore must be resolved explicitly before any app writes.
    if (existsSync(join(privateDir, 'updates/pending-restore.json')))
      throw Error('Восстановление данных прервано. Выполните od maintenance recover при закрытом Desktop и CLI.');
    if (existsSync(join(root, '.update-transaction.json'))) {
      assertUpdateIdle(root, privateDir);
      recoverCodeUpdate(root);
    }
    const previous = json(marker);
    assertCompatibleRelease(previous, release);
    if (previous.buildId !== release.buildId) {
      assertUpdateIdle(root, privateDir);
      const hasData = previous.buildId || existsSync(join(privateDir, 'profiles')) || existsSync(join(root, 'workspace'));
      const backup = hasData ? snapshotData(root, privateDir, { reason: 'before-update', from: previous.version || 'unknown', to: release.version, fromBuild: previous.buildId, toBuild: release.buildId }) : null;
      replaceCode(root, payload, previous, release, backup);
      mkdirSync(join(root, 'workspace'), { recursive: true, mode: 0o700 });
    }
    const imported = ensureFirstRun(root, { home });
    initializeLanguage(imported.profiles);
    const node = join(payload, 'node');
    installKnowledgeHooks(root, imported.profiles, node);
    if (existsSync(join(payload, 'n8n/node_modules/n8n/package.json'))) registerAutomationSources(root, imported.profiles, node);
    const warnings = install
      ? installCommand({ home, node, entry: join(payload, 'tools/distribution/cli.mjs') })
      : [];
    const environment = {
      ODYSSEUS_ROOT: root,
      ODYSSEUS_NODE: node,
      NESSY_HOME: imported.profiles.cliHome,
      NESSY_RUNTIME_DIR: imported.profiles.cliRuntime,
      NESSY_CONFIG_DIR: imported.profiles.desktopHome,
      NESSY_APP_NAME: 'Odysseus',
      ODYSSEUS_INSTALL_WARNINGS: warnings.join('\n'),
    };
    const python = join(payload, 'python/run');
    if (existsSync(python)) {
      environment.ODYSSEUS_PYTHON = python;
      privateWrite(join(root, '.odysseus/bundled-runtime.json'), JSON.stringify({ python, ...(existsSync(join(payload, 'n8n/node_modules/n8n/package.json')) ? { n8n: join(payload, 'n8n') } : {}) }));
      const paths = runtimePaths(root, { ...process.env, ...environment });
      connectDesktopSources(paths, home, { rebind: previous.buildId !== release.buildId });
      if (!existsSync(join(paths.output, 'graph.json'))) refresh(paths, { quiet: true });
    }
    if (owner !== undefined) environment.ODYSSEUS_RUN_LEASE = writeRunLease(privateDir, owner);
    return environment;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(prepareDistribution(process.argv[2], { owner: process.argv[3] ? Number(process.argv[3]) : undefined })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
