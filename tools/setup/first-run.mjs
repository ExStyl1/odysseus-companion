/** Snapshot native data into private Odysseus profiles; source profiles are read-only. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverNessy } from './discovery.mjs';
import { managedProfiles } from './paths.mjs';
import { bundleData } from './bundle.mjs';
import { noLinks, privateWrite, contained } from '../personal/store.mjs';

const volatileDirectories = new Set([
  'node_modules',
  '.git',
  'cache',
  'Cache',
  'GPUCache',
  'Code Cache',
  'logs',
  'tmp',
  'temp',
  'Crashpad',
]);
const volatileFile = (name) =>
  ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'sync.lock', 'install.lock'].includes(
    name,
  ) ||
  name.endsWith('.pid') ||
  name.endsWith('.runtime.json');
function walk(root, report) {
  noLinks(root);
  const result = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name),
        path = relative(root, file);
      if (entry.isSymbolicLink()) {
        report.skipped.push({ path: file, reason: 'symbolic-link' });
        continue;
      }
      if (entry.isDirectory()) {
        if (volatileDirectories.has(entry.name))
          report.skipped.push({ path: file, reason: 'runtime-cache' });
        else {
          result.push({ file, path, directory: true });
          visit(file);
        }
      } else if (entry.isFile()) {
        if (volatileFile(entry.name)) report.skipped.push({ path: file, reason: 'runtime-lock' });
        else result.push({ file, path });
      } else report.skipped.push({ path: file, reason: 'special-file' });
    }
  };
  visit(root);
  return result;
}
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
function acquire(path) {
  if (existsSync(path)) {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    if (!alive(owner.pid)) rmSync(path, { recursive: true });
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if (e.code === 'EEXIST')
      throw Error(
        'Импорт или синхронизация уже выполняется. Повторите запуск через несколько секунд.',
      );
    throw e;
  }
  privateWrite(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }));
}
function rebase(value, mappings) {
  if (typeof value === 'string') {
    const found = mappings.find(
      ([source]) =>
        value === source || value.startsWith(source + '/') || value.startsWith(source + '\\'),
    );
    return found ? found[1] + value.slice(found[0].length) : value;
  }
  if (Array.isArray(value)) return value.map((item) => rebase(item, mappings));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rebase(item, mappings)]),
    );
  return value;
}
function copyFile(entry, target, mappings, report, { merge = false } = {}) {
  noLinks(entry.file);
  if (entry.directory) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return;
  }
  const before = lstatSync(entry.file);
  if (!before.isFile()) throw Error('Источник изменился во время импорта: ' + entry.file);
  let content = entry.read ? entry.read() : readFileSync(entry.file);
  const after = lstatSync(entry.file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
    throw Error('Источник изменяется. Закройте Nessy и повторите импорт: ' + entry.file);
  // Configuration paths must address the new profile; conversation text stays byte-identical.
  if (
    /(?:^|\/)(?:config|settings|preferences|manifest|\.mcp|mcp|connections)\.json$/.test(
      entry.path.replaceAll('\\', '/'),
    )
  ) {
    try {
      content = Buffer.from(
        JSON.stringify(rebase(JSON.parse(content.toString('utf8')), mappings), null, 2) + '\n',
      );
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      report.warnings.push({ path: entry.file, reason: 'configuration-kept-verbatim' });
    }
  }
  if (existsSync(target)) {
    if (readFileSync(target).equals(content)) return;
    if (merge) {
      report.skipped.push({ path: entry.file, reason: 'existing-workspace-skill-kept' });
      return;
    }
    throw Error('Импорт не заменяет существующий файл: ' + target);
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, {
    mode: entry.executable || before.mode & 0o111 ? 0o700 : 0o600,
    flag: 'wx',
  });
  report.files++;
  report.bytes += content.length;
}
export function ensureFirstRun(root, options = {}) {
  const home = options.home || homedir(),
    env = options.env || process.env;
  const privateDir = resolve(
    options.privateDir || env.ODYSSEUS_DATA_DIR || join(home, '.odysseus'),
  );
  const existing = managedProfiles(privateDir, { allowPending: true });
  if (existing) {
    if (existsSync(join(privateDir, 'profiles/rebased-bridge-state.json'))) {
      if (options.check)
        return { ...existing.state, status: 'recovery-needed', alreadyInstalled: true };
      const installLock = join(privateDir, 'install.lock'),
        personalLock = join(privateDir, 'sync.lock');
      acquire(installLock);
      let locked = false;
      try {
        acquire(personalLock);
        locked = true;
        finishBridgeMigration(privateDir);
      } finally {
        if (locked) rmSync(personalLock, { recursive: true });
        rmSync(installLock, { recursive: true });
      }
    }
    return {
      ...existing.state,
      alreadyInstalled: true,
      profiles: {
        cliHome: existing.cliHome,
        desktopHome: existing.desktopHome,
        cliRuntime: existing.cliRuntime,
      },
    };
  }
  if (existsSync(join(privateDir, 'pending.json'))) {
    if (options.check)
      return {
        status: 'recovery-needed',
        files: 0,
        warnings: [{ reason: 'pending-personal-sync' }],
      };
    throw Error(
      'Сначала восстановите незавершённую синхронизацию профилей (npm run sync:personal), затем повторите импорт.',
    );
  }
  const discovery = discoverNessy({ ...options, root, home, env, privateDir });
  const base = join(privateDir, 'profiles'),
    profiles = {
      cliHome: join(base, 'cli'),
      desktopHome: join(base, 'desktop'),
      cliRuntime: join(base, 'cli-runtime'),
    };
  const report = {
    schemaVersion: 1,
    status: options.check ? 'preview' : 'ready',
    profiles,
    sources: discovery.profiles,
    installations: discovery.installations,
    legacyRoots: discovery.legacyRoots,
    files: 0,
    bytes: 0,
    skipped: [],
    warnings: [],
    completedAt: new Date().toISOString(),
  };
  const plans = [],
    mappings = [];
  for (const kind of ['cli', 'desktop'])
    discovery.profiles[kind].forEach((source, index) => {
      const destination =
        index === 0
          ? profiles[kind === 'cli' ? 'cliHome' : 'desktopHome']
          : join(base, 'imported', kind + '-' + (index + 1));
      mappings.push([source, destination]);
      plans.push({ source, destination });
    });
  discovery.legacyRoots.forEach((source, index) => {
    if (!plans.some((plan) => plan.source === source)) {
      const destination = join(base, 'imported', 'nestor-' + (index + 1));
      mappings.push([source, destination]);
      plans.push({ source, destination });
    }
  });
  const runtime = discovery.cliRuntime;
  if (runtime && runtime !== discovery.profiles.cli[0]) {
    mappings.push([runtime, profiles.cliRuntime]);
    plans.push({ source: runtime, destination: profiles.cliRuntime });
  } else profiles.cliRuntime = profiles.cliHome;
  // Prefer the most specific root if a profile and its runtime are nested.
  mappings.sort((a, b) => b[0].length - a[0].length);
  const inventories = plans.map((plan) => ({ ...plan, entries: walk(plan.source, report) }));
  discovery.installations.desktop.forEach((app, index) => {
    const entries = bundleData(root, app, report);
    if (entries.length)
      inventories.push({
        source: app,
        destination: join(base, 'imported/apps', 'desktop-' + (index + 1)),
        entries,
      });
  });
  const globalSkills = discovery.globalSkills ? walk(discovery.globalSkills, report) : [];
  if (options.check) {
    report.files =
      inventories.reduce((sum, p) => sum + p.entries.filter((f) => !f.directory).length, 0) +
      globalSkills.length;
    report.bytes = inventories.reduce(
      (sum, p) =>
        sum +
        p.entries.reduce((n, f) => n + (f.directory ? 0 : (f.size ?? lstatSync(f.file).size)), 0),
      0,
    );
    return report;
  }
  noLinks(privateDir);
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  chmodSync(privateDir, 0o700);
  const lock = join(privateDir, 'install.lock'),
    syncLock = join(privateDir, 'sync.lock');
  acquire(lock);
  let syncLocked = false,
    stage;
  try {
    acquire(syncLock);
    syncLocked = true;
    if (existsSync(join(privateDir, 'pending.json')))
      throw Error(
        'Обнаружена незавершённая синхронизация профилей. Сначала выполните npm run sync:personal.',
      );
    const installed = managedProfiles(privateDir);
    if (installed)
      return {
        ...installed.state,
        alreadyInstalled: true,
        profiles: {
          cliHome: installed.cliHome,
          desktopHome: installed.desktopHome,
          cliRuntime: installed.cliRuntime,
        },
      };
    if (existsSync(base))
      throw Error(
        'Папка профилей Odysseus уже существует без завершённого импорта. Данные сохранены: ' +
          base,
      );
    stage = join(privateDir, '.profiles-stage-' + randomUUID());
    mkdirSync(stage, { mode: 0o700 });
    const stagePath = (destination) => {
      if (!contained(base, destination)) throw Error('Invalid import destination');
      return join(stage, relative(base, destination));
    };
    for (const path of Object.values(profiles))
      mkdirSync(stagePath(path), { recursive: true, mode: 0o700 });
    // Keep a dedicated runtime directory even if the native profile uses its own projects tree.
    mkdirSync(join(stage, 'cli-runtime'), { recursive: true, mode: 0o700 });
    for (const plan of inventories)
      for (const entry of plan.entries)
        copyFile(entry, join(stagePath(plan.destination), entry.path), mappings, report);
    const workspaceBase = join(stage, 'desktop/workspaces');
    const skillDestinations = [join(stage, 'cli/skills'), join(stage, 'imported/global-skills')];
    if (existsSync(workspaceBase))
      for (const name of readdirSync(workspaceBase))
        if (lstatSync(join(workspaceBase, name)).isDirectory())
          skillDestinations.push(join(workspaceBase, name, 'skills'));
    const appSkills = inventories
      .filter((plan) => plan.source.endsWith('.app'))
      .flatMap((plan) =>
        plan.entries
          .map((entry) => {
            const match = entry.path.match(
              /^(?:resources|app-asar)(?:\/(?:dist|resources|data))*\/skills\/(.+)$/,
            );
            return match ? { ...entry, path: match[1] } : null;
          })
          .filter(Boolean),
      );
    for (const entry of [...globalSkills, ...appSkills])
      for (const destination of skillDestinations)
        copyFile(entry, join(destination, entry.path), mappings, report, { merge: true });
    // Rebase existing bridge bookkeeping before publishing the owned profile atomically.
    const bridgeState = join(privateDir, 'state.json');
    if (existsSync(bridgeState)) {
      const before = readFileSync(bridgeState),
        rebased = Buffer.from(JSON.stringify(rebase(JSON.parse(before), mappings), null, 2) + '\n');
      privateWrite(join(stage, 'previous-bridge-state.json'), before);
      privateWrite(join(stage, 'rebased-bridge-state.json'), rebased);
    }
    report.runtimeShared = profiles.cliRuntime === profiles.cliHome;
    privateWrite(join(stage, 'installation.json'), JSON.stringify(report, null, 2));
    renameSync(stage, base);
    stage = null;
    finishBridgeMigration(privateDir);
    return report;
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (syncLocked) rmSync(syncLock, { recursive: true });
    rmSync(lock, { recursive: true });
  }
}
export function finishBridgeMigration(privateDir) {
  const base = join(privateDir, 'profiles'),
    target = join(privateDir, 'state.json');
  const pending = join(base, 'rebased-bridge-state.json'),
    previous = join(base, 'previous-bridge-state.json');
  if (!existsSync(pending)) return;
  const before = readFileSync(previous),
    next = readFileSync(pending);
  if (
    existsSync(target) &&
    !readFileSync(target).equals(before) &&
    !readFileSync(target).equals(next)
  )
    throw Error(
      'Состояние синхронизации изменилось во время переноса. Предыдущая версия сохранена в профиле импорта.',
    );
  privateWrite(target, next);
  rmSync(pending);
}
