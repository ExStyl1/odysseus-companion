#!/usr/bin/env node
import { cliColorEnvironment } from './cli/appearance.mjs';
import { ensureFirstRun } from './setup/first-run.mjs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { runtimePaths as knowledgePaths, registerProject, startWatcher } from './graphify.mjs';
import { collectionForPath } from './knowledge/collections.mjs';
import { syncProfile } from './profile/index.mjs';
import { syncPersonal, personalPaths, readDesktopLease } from './personal-sync.mjs';
import { credentialEnvironment, existingDpToken, launchBindings } from './personal/secrets.mjs';
import { document, contained, noLinks, privateWrite } from './personal/store.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  config = document(join(root, 'odysseus.json'));
const mode = process.argv[2],
  args = process.argv.slice(3);
const helpOnly = args.some((arg) => ['--help', '-h', '--version', '-v'].includes(arg));
let installation;
if (!helpOnly && process.env.ODYSSEUS_SKIP_FIRST_RUN !== '1') {
  installation = ensureFirstRun(root);
  Object.assign(process.env, {
    NESSY_HOME: installation.profiles.cliHome,
    NESSY_CONFIG_DIR: installation.profiles.desktopHome,
    NESSY_RUNTIME_DIR: installation.profiles.cliRuntime,
  });
  if (!installation.alreadyInstalled)
    console.log(
      `Odysseus: перенесено ${installation.files} файлов. Исходные профили Nessy сохранены.`,
    );
}
const paths = personalPaths(root);
const env = {
  ...process.env,
  ODYSSEUS_ROOT: root,
  ODYSSEUS_NODE: process.execPath,
};
for (const key of Object.keys(env))
  if (key.startsWith('CLAUDE_CODE_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
let cwd = process.env.ODYSSEUS_PROJECT || join(root, 'workspace'),
  cliArgs = args,
  receiptPath;
if (args[0] === '--request') {
  const path = resolve(args[1] || '');
  noLinks(path);
  if (!path.endsWith('.json')) throw Error('Invalid launch request filename');
  if (!contained(join(paths.privateDir, 'launch'), path))
    throw Error('Invalid launch request location');
  receiptPath = path.replace(/\.json$/, '.started.json');
  const request = document(path);
  if (!isAbsolute(request.cwd || '') || !statSync(request.cwd).isDirectory())
    throw Error('Project folder is unavailable');
  if (request.cliId && !/^[a-zA-Z0-9_-]+$/.test(request.cliId)) throw Error('Invalid session ID');
  cwd = request.cwd;
  cliArgs = [...(request.cliId ? ['--resume', request.cliId] : []), ...args.slice(2)];
}
let report;
try {
  if (!readDesktopLease(paths).pid) {
    syncProfile(root);
    report = syncPersonal(root);
  } else report = { bindings: launchBindings(paths) };
} catch {
  console.error('Синхронизация отложена: профиль занят или требует проверки.');
}
const component = config.components[mode];
if (!component) throw Error('Expected cli or desktop');
const source = resolve(root, component.source);
if (!contained(root, source)) throw Error('Invalid component source');
let command, childArgs;
if (mode === 'cli') {
  env.NESSY_CLI_SYSTEM_DEFAULTS_PATH ||= join(root, 'integrations/cli/settings.json');
  Object.assign(env, credentialEnvironment(paths, report?.bindings || launchBindings(paths)));
  const dpToken = existingDpToken(paths);
  if (dpToken && !env.NESSY_CLI_DP_AUTH_TOKEN) env.NESSY_CLI_DP_AUTH_TOKEN = dpToken;
  command = process.execPath;
  childArgs = [
    join(source, component.bundled ? 'dist/cli.js' : 'packages/cli/dist/index.js'),
    ...cliArgs,
  ];
} else {
  delete env.VITE_DEV_SERVER_URL;
  env.NESSY_APP_NAME ||= 'Odysseus';
  env.NESSY_DEEPLINK_SCHEME ||= 'nessy';
  command = join(source, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  childArgs = ['apps/electron', ...args];
  cwd = source;
}
if (
  !existsSync(command) ||
  !existsSync(mode === 'cli' ? childArgs[0] : join(source, 'apps/electron/dist/main.cjs'))
) {
  // Some snapshots name the main bundle main.js; Electron validates its own entry.
  if (mode === 'cli' && !existsSync(childArgs[0])) throw Error('CLI is not built');
  if (!existsSync(command)) throw Error('Application runtime is not installed');
}
if (mode === 'cli' && !env.ODYSSEUS_KNOWLEDGE_COLLECTION)
  env.ODYSSEUS_KNOWLEDGE_COLLECTION = collectionForPath(knowledgePaths(root, env), cwd);
const childEnv = mode === 'cli' ? cliColorEnvironment(env, Boolean(process.stdout.isTTY)) : env;
const child = spawn(command, childArgs, { cwd, env: childEnv, stdio: 'inherit' });
try {
  const knowledge = knowledgePaths(root, env);
  if (existsSync(knowledge.python)) {
    registerProject(knowledge, mode === 'cli' ? cwd : source);
    startWatcher(knowledge, child.pid);
  }
} catch (error) {
  console.error('База знаний: ' + error.message);
}
if (mode === 'cli' && receiptPath)
  child.once('spawn', () =>
    privateWrite(receiptPath, JSON.stringify({ pid: child.pid, startedAt: Date.now() })),
  );
const knowledgeTimer = setInterval(() => {
  try {
    startWatcher(knowledgePaths(root, env), child.pid);
  } catch {}
}, 15000);
let syncing = false;
const timer =
  mode === 'cli'
    ? setInterval(() => {
        if (syncing || readDesktopLease(paths).pid) return;
        syncing = true;
        try {
          syncProfile(root);
          syncPersonal(root);
        } catch {
        } finally {
          syncing = false;
        }
      }, 5000)
    : undefined;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  clearInterval(timer);
  clearInterval(knowledgeTimer);
  console.error('Не удалось запустить Odysseus.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  clearInterval(timer);
  clearInterval(knowledgeTimer);
  try {
    if (!readDesktopLease(paths).pid) syncPersonal(root);
  } catch {}
  process.exitCode = code ?? 1;
});
