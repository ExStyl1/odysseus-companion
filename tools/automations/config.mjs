import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { privateWrite, document, noLinks } from '../personal/store.mjs';
import { readSecrets, writeSecrets } from '../personal/secrets.mjs';
export const N8N_VERSION = '2.35.7';
export function automationPaths(root, env = process.env) {
  const privateDir = resolve(env.ODYSSEUS_DATA_DIR || join(homedir(), '.odysseus'));
  return { root, privateDir, home: join(privateDir, 'automations'), engine: join(privateDir, 'automations/engine'), runtime: join(root, '.odysseus/n8n-runtime'), env };
}
export function loadAutomationConfig(paths) {
  noLinks(paths.home); mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  let secrets = readSecrets(paths.home);
  if (!secrets.bridgeToken || !secrets.encryptionKey) {
    secrets = { ...secrets, bridgeToken: secrets.bridgeToken || randomBytes(32).toString('hex'), encryptionKey: secrets.encryptionKey || randomBytes(32).toString('hex') };
    writeSecrets(paths.home, secrets);
  }
  const config = document(join(paths.home, 'config.json'), { version: 2, port: 5678, bridgePort: 5789, autostart: false, sources: [], connections: [], routes: {} });
  if (!Array.isArray(config.connections)) {
    config.connections = []; config.routes = {};
    if (config.proxy) {
      config.connections.push({ id: 'legacy-proxy', name: 'llm-proxy', kind: 'chat', protocol: 'openai', auth: config.proxy.header === 'Authorization' ? 'bearer' : 'header', ...config.proxy });
      secrets['connection:legacy-proxy'] = secrets.proxyToken || '';
      config.routes.agent = config.routes.answer = 'legacy-proxy';
      if (config.proxy.embeddingsModel) {
        config.connections.push({ ...config.connections[0], id: 'legacy-embeddings', name: 'Embeddings llm-proxy', kind: 'embeddings', model: config.proxy.embeddingsModel });
        secrets['connection:legacy-embeddings'] = secrets.proxyToken || ''; config.routes.embeddings = 'legacy-embeddings';
      }
    }
    config.version = 2; writeSecrets(paths.home, secrets); privateWrite(join(paths.home, 'config.json'), JSON.stringify(config, null, 2));
  }
  config.routes ||= {};
  return { config, secrets };
}
export function validateEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw Error('Укажите HTTP(S)-адрес без ключа, параметров и фрагмента');
  return url.href.replace(/\/+$/, '');
}
export function configureAutomation(paths, input) {
  const { config, secrets } = loadAutomationConfig(paths);
  if (input.proxy) {
    const p = input.proxy;
    if (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 200) throw Error('Укажите модель llm-proxy');
    if (!['Authorization', 'Nestor-Token', 'x-api-key'].includes(p.header || 'Authorization')) throw Error('Неверный заголовок авторизации');
    const nextUrl = validateEndpoint(p.baseUrl);
    if (config.proxy && (config.proxy.baseUrl !== nextUrl || config.proxy.header !== (p.header || 'Authorization'))) delete secrets.proxyToken;
    config.proxy = { baseUrl: nextUrl, model: p.model.trim(), embeddingsModel: String(p.embeddingsModel || '').slice(0, 200), header: p.header || 'Authorization' };
    if (typeof p.token === 'string' && p.token) secrets.proxyToken = p.token;
    if (p.clearToken === true) delete secrets.proxyToken;
  }
  if (input.proxy) {
    const p = config.proxy;
    const legacy = { id: 'legacy-proxy', name: 'llm-proxy', kind: 'chat', protocol: 'openai', auth: p.header === 'Authorization' ? 'bearer' : 'header', ...p };
    config.connections = config.connections.filter(c => !['legacy-proxy', 'legacy-embeddings'].includes(c.id)); config.connections.push(legacy);
    secrets['connection:legacy-proxy'] = secrets.proxyToken || ''; config.routes.agent = config.routes.answer = legacy.id;
    if (p.embeddingsModel) { config.connections.push({ ...legacy, id: 'legacy-embeddings', name: 'Embeddings llm-proxy', kind: 'embeddings', model: p.embeddingsModel }); secrets['connection:legacy-embeddings'] = secrets.proxyToken || ''; config.routes.embeddings = 'legacy-embeddings'; }
    else if (config.routes.embeddings === 'legacy-embeddings') config.routes.embeddings = null;
  }
  if (input.connection) {
    const c = input.connection;
    if (!/^[a-z0-9-]{1,60}$/.test(c.id)) throw Error('ID подключения: латинские буквы, цифры и дефис');
    if (!['chat', 'embeddings'].includes(c.kind) || !['openai', 'anthropic', 'ollama'].includes(c.protocol) || (c.kind === 'embeddings' && c.protocol === 'anthropic')) throw Error('Выберите совместимый протокол и назначение');
    if (typeof c.model !== 'string' || !c.model.trim() || c.model.length > 200) throw Error('Укажите модель');
    const auth = c.auth || 'bearer', header = c.header || 'Authorization'; validateAuth(auth, header);
    const next = { id: c.id, name: String(c.name || c.id).slice(0, 100), kind: c.kind, protocol: c.protocol, baseUrl: validateEndpoint(c.baseUrl), model: c.model.trim(), auth, header };
    const previous = config.connections.find(x => x.id === c.id), key = 'connection:' + c.id;
    if (previous && (previous.baseUrl !== next.baseUrl || previous.header !== next.header || previous.auth !== next.auth)) delete secrets[key];
    if (c.clearToken) delete secrets[key];
    if (c.token) secrets[key] = String(c.token);
    config.connections = [...config.connections.filter(x => x.id !== c.id), next];
    for (const [purpose, id] of Object.entries(config.routes || {})) if (id === c.id && (purpose === 'embeddings' ? c.kind !== 'embeddings' : c.kind !== 'chat')) config.routes[purpose] = null;
  }
  if (input.removeConnection) {
    config.connections = config.connections.filter(c => c.id !== input.removeConnection); delete secrets['connection:' + input.removeConnection];
    for (const [purpose, id] of Object.entries(config.routes || {})) if (id === input.removeConnection) config.routes[purpose] = null;
  }
  if (input.routes) {
    for (const [purpose, id] of Object.entries(input.routes)) {
      if (!['agent', 'answer', 'embeddings'].includes(purpose)) throw Error('Неизвестное назначение подключения');
      if (id !== null && !config.connections.some(c => c.id === id && c.kind === (purpose === 'embeddings' ? 'embeddings' : 'chat'))) throw Error('Подключение не подходит для выбранной задачи');
      config.routes[purpose] = id;
    }
  }
  if (input.source) {
    const s = input.source;
    if (!/^[a-z0-9-]{1,60}$/.test(s.id)) throw Error('Неверное имя API-источника');
    const endpoint = validateEndpoint(s.baseUrl), path = String(s.path || '/');
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#') || path.includes('\\')) throw Error('Путь поиска должен быть относительным /path без параметров');
    if (!/^[\w-]{1,80}$/.test(s.queryParam || 'q') || !/^[\w-]{1,80}$/.test(s.header || 'Authorization')) throw Error('Неверное имя параметра или заголовка');
    validateAuth(s.auth || (s.bearer === false ? 'header' : 'bearer'), s.header || 'Authorization');
    if (s.method && !['GET', 'POST'].includes(s.method)) throw Error('Выберите GET или POST');
    if (s.body && (typeof s.body !== 'object' || Array.isArray(s.body) || JSON.stringify(s.body).length > 20000)) throw Error('Тело API должно быть JSON-объектом');
    const source = { method: s.method || 'GET', body: s.body || {}, auth: s.auth || (s.bearer === false ? 'header' : 'bearer'), id: s.id, name: String(s.name || s.id).slice(0, 100), baseUrl: endpoint, path, queryParam: s.queryParam || 'q', header: s.header || 'Authorization', bearer: s.bearer !== false };
    const previousSource = (config.sources || []).find(x => x.id === s.id);
    if (previousSource && (previousSource.baseUrl !== endpoint || previousSource.header !== source.header || (previousSource.auth || (previousSource.bearer === false ? 'header' : 'bearer')) !== source.auth)) delete secrets['source:' + s.id];
    config.sources = [...(config.sources || []).filter(x => x.id !== s.id), source];
    if (s.clearToken) delete secrets['source:' + s.id];
    if (s.token) secrets['source:' + s.id] = String(s.token);
  }
  if (input.clearProxy === true) { delete config.proxy; delete secrets.proxyToken; config.connections = config.connections.filter(c => !['legacy-proxy','legacy-embeddings'].includes(c.id)); for (const key of ['agent','answer','embeddings']) if (['legacy-proxy','legacy-embeddings'].includes(config.routes[key])) config.routes[key] = null; delete secrets['connection:legacy-proxy']; delete secrets['connection:legacy-embeddings']; }
  if (input.removeSource) { config.sources = (config.sources || []).filter(s => s.id !== input.removeSource); delete secrets['source:' + input.removeSource]; }
  if (input.clearN8nApiKey === true) delete secrets.n8nApiKey;
  if (typeof input.n8nApiKey === 'string' && input.n8nApiKey) secrets.n8nApiKey = input.n8nApiKey;
  if (typeof input.autostart === 'boolean') config.autostart = input.autostart;
  writeSecrets(paths.home, secrets);
  privateWrite(join(paths.home, 'config.json'), JSON.stringify(config, null, 2));
  return publicConfig(config, secrets);
}
export function publicConfig(config, secrets) {
  return { ...config, connections: config.connections.map(c => ({ ...c, hasToken: Boolean(secrets['connection:' + c.id]) })), hasN8nApiKey: Boolean(secrets.n8nApiKey), proxy: config.proxy && { ...config.proxy, hasToken: Boolean(secrets.proxyToken) }, sources: (config.sources || []).map(s => ({ ...s, hasToken: Boolean(secrets['source:' + s.id]) })) };
}

export function validateAuth(auth, header) {
  if (!['bearer','header','basic','none'].includes(auth) || !/^[\w-]{1,80}$/.test(header) || ['host','connection','content-length','transfer-encoding','cookie','origin'].includes(header.toLowerCase())) throw Error('Некорректный способ авторизации');
}
export function selectedConnection(config, purpose, id) {
  const selected = id || config.routes?.[purpose];
  const c = config.connections.find(x => x.id === selected && x.kind === (purpose === 'embeddings' ? 'embeddings' : 'chat'));
  if (!c) throw Error('Выберите подключение для задачи: ' + purpose);
  return c;
}
