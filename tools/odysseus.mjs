#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { runtimePaths as knowledgePaths, registerProject } from './graphify.mjs';
import { syncPersonal } from './personal-sync.mjs';
import { loadConfig, syncProfile } from './profile.mjs';

const HELP = `Odysseus — общий профиль Nessy CLI и Nessy Desktop

  node tools/odysseus.mjs personal-sync [--check]
  node tools/odysseus.mjs status
  node tools/odysseus.mjs attach PROJECT [--import] [--check]
  node tools/odysseus.mjs detach PROJECT
  node tools/odysseus.mjs sync [--check]
  node tools/odysseus.mjs watch
  node tools/odysseus.mjs run cli|desktop --project PROJECT [--source] [-- ARGS]
  node tools/odysseus.mjs updates cli|desktop

--import объединяет существующие MCP, .agents/skills, агентов и правила.
Конфликты останавливают синхронизацию до записи. --check ничего не применяет.
По умолчанию запускаются установленные приложения, --source — исходники.
Обновления остаются штатными и независимыми; updates показывает их способ.`;

export function launchSpec(root, component, project, source = false, args = []) {
  const { config } = loadConfig(root);
  const selected = config.components[component];
  if (!selected) throw new Error('Component must be cli or desktop');
  if (source) {
    const directory = resolve(root, selected.source);
    return { command: process.execPath, args: [join(root, 'tools/run-component.mjs'), component, ...args], cwd: project, env: { ODYSSEUS_PROJECT: project } };
  }
  if (!Array.isArray(selected.command) || !selected.command.length || selected.command.some(value => typeof value !== 'string' || !value)) {
    throw new Error(`Invalid components.${component}.command array`);
  }
  return { command: selected.command[0], args: [...selected.command.slice(1), ...args], cwd: project };
}

function report(result) {
  console.log(`${result.applied ? 'Синхронизировано' : 'Предпросмотр'}: ${result.resources} ресурсов, ${result.projects.length} проектов, ${result.changes.length} изменений файлов.`);
  for (const path of result.changes.slice(0, 12)) console.log(`  ${path}`);
  if (result.changes.length > 12) console.log(`  … ещё ${result.changes.length - 12} файлов`);
}

export async function main(argv, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const separator = argv.indexOf('--');
  const tail = separator < 0 ? [] : argv.slice(separator + 1);
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const [action, target] = options;
  const allowedFlags = new Set(['--import', '--check', '--source', '--project']);
  for (const argument of options) {
    if (argument.startsWith('--') && !allowedFlags.has(argument) && argument !== '--help') throw new Error(`Unknown option: ${argument}`);
  }
  if (!action || action === '--help' || action === 'help') return console.log(HELP);
  if (action === 'status') {
    const { config, shared } = loadConfig(root);
    console.log(`Общий профиль: ${shared}`);
    for (const [name, component] of Object.entries(config.components)) {
      const path = resolve(root, component.source);
      let version = 'исходники недоступны';
      if (existsSync(join(path, 'package.json'))) version = JSON.parse(readFileSync(join(path, 'package.json'))).version;
      console.log(`${name}: snapshot ${version}; source ${path}; launch ${JSON.stringify(component.command)}`);
    }
    console.log('Версии выше относятся к исходникам, а не к установленным приложениям.');
    const state = join(root, '.odysseus/state.json');
    if (existsSync(state)) for (const project of Object.keys(JSON.parse(readFileSync(state)).projects)) console.log(`Проект: ${project}`);
    return;
  }
  if (action === 'attach') {
    if (!target || target.startsWith('--')) throw new Error('attach requires PROJECT');
    const result=syncProfile(root, { attach: resolve(target), importExisting: options.includes('--import'), check: options.includes('--check') });
    if(!options.includes('--check')){const knowledge=knowledgePaths(root);if(existsSync(knowledge.python))registerProject(knowledge,target)}
    return report(result);
  }
  if (action === 'detach') {
    if (!target || target.startsWith('--')) throw new Error('detach requires PROJECT');
    return report(syncProfile(root, { detach: resolve(target), check: options.includes('--check') }));
  }
  if (action === 'personal-sync') {
    const result=syncPersonal(root,{check:options.includes('--check')});
    console.log(JSON.stringify({applied:result.applied,changedFiles:result.changes.length,updatedChats:result.updatedChats.length,conflicts:result.conflicts,unsupported:result.unsupported,deferred:result.deferred},null,2));
    return;
  }
  if (action === 'sync') return report(syncProfile(root, { check: options.includes('--check') }));
  if (action === 'watch') {
    report(syncProfile(root));
    console.log('Наблюдение каждые 2 секунды; Ctrl+C — остановить. Новые локальные ресурсы добавляйте через attach PROJECT --import.');
    let lastError;
    const timer = setInterval(() => {
      try {
        const result = syncProfile(root);
        if (result.changes.length) report(result);
        lastError = undefined;
      } catch (error) {
        if (error.message !== lastError) console.error(`Синхронизация приостановлена: ${error.message}`);
        lastError = error.message;
      }
    }, 2000);
    await new Promise(resolveWait => {
      const stop = () => { clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); resolveWait(); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return;
  }
  if (action === 'updates') {
    if (target === 'cli') console.log('Обновляйте Nessy CLI его штатным способом установки (npm/pnpm/standalone). Odysseus запускает nessy из PATH, поэтому после обновления будет использована новая версия.');
    else if (target === 'desktop') console.log('В Nessy Desktop: Settings → About → Check for updates. Штатный updater обновляет только Desktop. Общий профиль находится вне приложения.');
    else throw new Error('updates requires cli or desktop');
    return;
  }
  if (action === 'run') {
    if (!['cli', 'desktop'].includes(target)) throw new Error('run requires cli or desktop');
    const index = options.indexOf('--project');
    if (index < 0 || !options[index + 1] || options[index + 1].startsWith('--')) throw new Error('run requires --project PROJECT');
    const project = resolve(options[index + 1]);
    const result = syncProfile(root, { attach: project });
    report(result);
    const spec = launchSpec(root, target, project, options.includes('--source'), tail);
    if (target === 'desktop') console.log(`В Desktop откройте/выберите этот проект и подтвердите доверие: ${project}`);
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: 'inherit', shell: false, env: {...process.env,...spec.env} });
    await new Promise((resolveWait, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (signal) process.exitCode = 1;
        else process.exitCode = code ?? 1;
        resolveWait();
      });
    });
    return;
  }
  throw new Error(`Unknown command: ${action}\n${HELP}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(`Odysseus: ${error.message}`); process.exitCode = 1; });
}
