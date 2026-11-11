import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { document, privateWrite, noLinks } from '../personal/store.mjs';
import { writeRunLease } from '../distribution/update-data.mjs';
import { loadAutomationConfig, N8N_VERSION, publicConfig, configureAutomation } from './config.mjs';
import { startGateway } from './gateway.mjs';
import { graphData } from '../knowledge/graph-store.mjs';
import { runtimePaths } from '../graphify.mjs';
import { collectionState } from '../knowledge/collections.mjs';
export function n8nLocation(paths) {
  const runtime = document(join(paths.root, '.odysseus/bundled-runtime.json')).n8n || paths.runtime;
  const pkg = join(runtime, 'node_modules/n8n/package.json');
  return { runtime, entry: join(runtime, 'node_modules/n8n/bin/n8n'), installed: existsSync(pkg), version: existsSync(pkg) ? document(pkg).version : null };
}
export function n8nEnvironment(paths, gatewayUrl) {
  const { config, secrets } = loadAutomationConfig(paths);
  return {
    HOME: paths.engine, USERPROFILE: paths.engine, PATH: join(dirname(process.execPath), 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: join(paths.home, 'tmp'),
    NPM_CONFIG_USERCONFIG: join(paths.home, 'npmrc'), NPM_CONFIG_CACHE: join(paths.home, 'npm-cache'),
    LANG: 'ru_RU.UTF-8', N8N_USER_FOLDER: paths.engine, N8N_HOST: '127.0.0.1', N8N_LISTEN_ADDRESS: '127.0.0.1', N8N_PORT: String(config.port), N8N_PROTOCOL: 'http',
    N8N_EDITOR_BASE_URL: 'http://127.0.0.1:' + config.port, WEBHOOK_URL: 'http://127.0.0.1:' + config.port + '/',
    N8N_SECURE_COOKIE: 'false', N8N_ENCRYPTION_KEY: secrets.encryptionKey, N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
    N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_TEMPLATES_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_CUSTOM_EXTENSIONS: join(paths.root, 'integrations/n8n/nodes'), N8N_RUNNERS_ENABLED: 'true', N8N_RUNNERS_BROKER_PORT: String(config.port + 1), N8N_RUNNERS_BROKER_LISTEN_ADDRESS: '127.0.0.1',
    EXTERNAL_HOOK_FILES: join(paths.root, 'integrations/n8n/desktop-entry.cjs'),
    ODYSSEUS_N8N_RUNTIME: n8nLocation(paths).runtime, ODYSSEUS_KNOWLEDGE_URL: gatewayUrl, ODYSSEUS_AUTOMATION_TOKEN: secrets.bridgeToken,
  };
}
export async function createAutomationRuntime(paths) {
  loadAutomationConfig(paths);
  const gateway = await startGateway(paths);
  let child, starting, engineLease, editorCookie, stopped = false;
  let entrySequence = 0; const entries = new Map();
  const runtimeLease = writeRunLease(paths.privateDir, process.pid);
  const kp = runtimePaths(paths.root, paths.env);
  const status = () => {
    const { config, secrets } = loadAutomationConfig(paths), graph = graphData(kp).graph;
    return { ...publicConfig(config, secrets), engine: { ...n8nLocation(paths), runtime: undefined, entry: undefined, running: Boolean(child && child.exitCode === null), starting: Boolean(starting), editorUrl: child && 'http://127.0.0.1:' + config.port }, gatewayUrl: gateway.url,
      collections: collectionState(kp, graph).collections, projects: graph.nodes.filter(n => n.type === 'project').map(n => ({ id: n.id, name: n.label, collection: collectionState(kp, graph).assignments[n.id] })) };
  };
  async function start() {
    if (starting) return starting;
    if (child && child.exitCode === null) return status();
    starting = (async () => {
      const location = n8nLocation(paths);
      if (!location.installed || location.version !== N8N_VERSION) throw Error('Движок n8n не входит в эту установку. Установите полный выпуск Odysseus с n8n.');
      const { config } = loadAutomationConfig(paths);
      await new Promise((resolve, reject) => { const probe = createNetServer(); probe.once('error', () => reject(Error('Порт n8n ' + config.port + ' занят другим процессом'))); probe.listen(config.port, '127.0.0.1', () => probe.close(resolve)); });
      mkdirSync(paths.engine, { recursive: true, mode: 0o700 }); mkdirSync(join(paths.home, 'tmp'), { recursive: true, mode: 0o700 });
      const logPath = join(paths.home, 'n8n.log'); noLinks(logPath); const log = openSync(logPath, 'a', 0o600);
      const processChild = spawn(process.execPath, [location.entry, 'start'], { env: n8nEnvironment(paths, gateway.url), cwd: paths.engine, stdio: ['ignore', log, log, 'ipc'] });
      child = processChild; closeSync(log);
      processChild.on('message', data => {
        if (data?.type !== 'odysseus-entry' || data.pid !== processChild.pid || typeof data.cookie !== 'string' || typeof data.apiKey !== 'string') return;
        editorCookie = data.cookie; configureAutomation(paths, { n8nApiKey: data.apiKey });
        const pending = entries.get(data.id); if (pending) { clearTimeout(pending.timer); entries.delete(data.id); pending.resolve({ cookie: data.cookie }); }
      });
      processChild.once('error', () => { if (child === processChild) child = undefined; });
      if (processChild.pid) engineLease = writeRunLease(paths.privateDir, processChild.pid);
      processChild.once('exit', () => { if (engineLease) { try { unlinkSync(engineLease); } catch {} engineLease = undefined; } if (child === processChild) child = undefined; });
      for (let i = 0; i < 150; i++) {
        if (stopped || child !== processChild || processChild.exitCode !== null) throw Error('n8n завершил запуск. Диагностика: automations/n8n.log');
        try {
          const origin='http://127.0.0.1:'+config.port;
          const r=await fetch(origin+'/healthz/readiness',{signal:AbortSignal.timeout(800)});
          if(r.ok&&editorCookie){
            // Readiness may precede generation of the authenticated custom-node catalog.
            const types=await fetch(origin+'/types/nodes.json',{headers:{Cookie:'n8n-auth='+editorCookie},signal:AbortSignal.timeout(5000)});
            if(types.ok){const catalog=await types.text();if(catalog.includes('CUSTOM.odysseus')&&catalog.includes('CUSTOM.odysseusChatModel'))return status();}
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await stop(); throw Error('n8n не стал готов за 75 секунд. Проверьте локальный порт и журнал запуска.');
    })().finally(() => { starting = undefined; });
    return starting;
  }
  async function stop() {
    const current = child; if (!current) return status();
    editorCookie = undefined; current.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(() => { current.kill('SIGKILL'); }, 12000); current.once('exit', () => { clearTimeout(timer); resolve(); }); if (current.exitCode !== null) { clearTimeout(timer); resolve(); } });
    return status();
  }
  let closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => { stopped = true; await stop(); await gateway.close(); try { unlinkSync(runtimeLease); } catch {} })();
    return closing;
  }
  async function dispatch(mode, input = {}) {
    if (mode === 'editorSession') {
      if (!editorCookie || !child?.connected || child.exitCode !== null) throw Error('Запустите n8n');
      const id = ++entrySequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { entries.delete(id); reject(Error('Локальный вход n8n ещё не готов')); }, 5000); entries.set(id, { resolve, reject, timer }); child.send({ type: 'odysseus-editor-session', id }); });
    }
    if (mode === 'status') return status();
    if (mode === 'configure') { configureAutomation(paths, input); return status(); }
    if (mode === 'start') return start();
    if (mode === 'stop') return stop();
    if (Object.hasOwn(gateway.actions, mode)) return gateway.actions[mode](input);
    throw Error('Неизвестная операция n8n');
  }
  if (loadAutomationConfig(paths).config.autostart) { try { await start(); } catch (error) { await close(); throw error; } }
  return { dispatch, close, status, start, stop };
}
