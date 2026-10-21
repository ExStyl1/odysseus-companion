import { createHash } from 'node:crypto';
import { reconcile, equivalent, object } from './store.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const defaults = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'dp-auth': 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
};
const compact = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
const keyFor = (auth, url) => `${auth}:${hash(url.replace(/\/+$/, ''))}`;
export const environmentKey = (id) => `ODYSSEUS_MODEL_${hash(id).toUpperCase()}_KEY`;
function endpoint(auth, value) {
  const url = new URL(value || defaults[auth]);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      'Model endpoints must be HTTP(S) URLs without embedded credentials, query or fragment',
    );
  return url.href.replace(/\/+$/, '');
}
const normalizeModel = (m, side) =>
  compact({
    id: typeof m === 'string' ? m : m.id,
    name: typeof m === 'string' ? m : m.name || m.id,
    description: typeof m === 'string' ? undefined : m.description || undefined,
    vision:
      typeof m === 'string'
        ? undefined
        : side === 'cli'
          ? m.capabilities?.vision
          : m.supportsImages,
    wire:
      typeof m === 'string'
        ? undefined
        : side === 'cli'
          ? m.generationConfig?.protocol === 'anthropic_messages'
            ? 'anthropic-messages'
            : undefined
          : m.wire,
    contextWindow:
      typeof m === 'string'
        ? undefined
        : side === 'cli'
          ? m.generationConfig?.contextWindowSize
          : m.contextWindow || undefined,
  });
export function cliConnections(settings, report) {
  const result = new Map();
  for (const [auth, models] of Object.entries(settings.modelProviders || {})) {
    if (!['openai', 'anthropic', 'dp-auth'].includes(auth)) {
      report.unsupported.push(`cli-provider:${auth}`);
      continue;
    }
    if (!Array.isArray(models)) throw Error('Invalid CLI model provider list');
    for (const model of models) {
      if (!object(model) || typeof model.id !== 'string') throw Error('Invalid CLI model');
      const url = endpoint(auth, model.baseUrl),
        id = keyFor(auth, url);
      if (!result.has(id)) result.set(id, { id, auth, url, models: [], refs: [] });
      const connection = result.get(id);
      connection.models.push(normalizeModel(model, 'cli'));
      connection.refs.push(model);
    }
  }
  for (const connection of result.values())
    connection.models.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
export function desktopConnections(config, report) {
  const result = new Map(),
    ambiguous = new Set();
  for (const c of config.llmConnections || []) {
    if (typeof c.slug !== 'string') throw Error('Invalid Desktop connection');
    let auth;
    if (
      (c.providerType === 'pi' && c.piAuthProvider === 'nestor') ||
      (['pi_compat', 'claude-runtime', 'codex-runtime'].includes(c.providerType) &&
        c.baseUrl?.replace(/\/+$/, '') === defaults['dp-auth'])
    )
      auth = 'dp-auth';
    else if (
      ['pi', 'pi_compat', 'anthropic'].includes(c.providerType) &&
      ['api_key', 'api_key_with_endpoint', 'none', 'environment'].includes(c.authType)
    ) {
      auth =
        c.customEndpoint?.api === 'anthropic-messages' ||
        c.providerType === 'anthropic' ||
        c.piAuthProvider === 'anthropic'
          ? 'anthropic'
          : 'openai';
      if (c.piAuthProvider && !['openai', 'anthropic'].includes(c.piAuthProvider)) auth = undefined;
      if (
        c.customEndpoint?.credentialHeader &&
        c.customEndpoint.credentialHeader !== 'authorization' &&
        !(auth === 'anthropic' && c.customEndpoint.credentialHeader === 'x-api-key')
      )
        auth = undefined;
    }
    if (auth !== 'dp-auth' && c.authType === 'none') {
      report.unsupported.push(`desktop-keyless-connection:${c.slug}`);
      continue;
    }
    if (!auth) {
      report.unsupported.push(`desktop-connection:${c.slug}`);
      continue;
    }
    const url = endpoint(auth, c.baseUrl),
      id = keyFor(auth, url);
    if (result.has(id) || ambiguous.has(id)) {
      report.conflicts.push(`duplicate-desktop-endpoint:${id}`);
      result.delete(id);
      ambiguous.add(id);
      continue;
    }
    const models = (c.models || [])
      .map((m) => normalizeModel(m, 'desktop'))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!models.length) {
      report.unsupported.push(`desktop-model-catalogue-empty:${c.slug}`);
      continue;
    }
    if (models.some((m) => !m.id)) throw Error('Invalid Desktop model');
    result.set(id, { id, auth, url, models, ref: c });
  }
  return result;
}
function portable(c) {
  return c && { auth: c.auth, url: c.url, models: c.models };
}
function cliModel(model, c, previous = {}) {
  const next = { ...previous, id: model.id, name: model.name, baseUrl: c.url };
  if (model.description !== undefined) next.description = model.description;
  if (model.vision !== undefined)
    next.capabilities = { ...next.capabilities, vision: model.vision };
  if (model.wire)
    next.generationConfig = {
      ...next.generationConfig,
      protocol: 'anthropic_messages',
    };
  else if (next.generationConfig?.protocol === 'anthropic_messages')
    next.generationConfig = {
      ...next.generationConfig,
      protocol: 'openai_chat_completions',
    };
  if (model.contextWindow !== undefined)
    next.generationConfig = {
      ...next.generationConfig,
      contextWindowSize: model.contextWindow,
    };
  if (c.auth !== 'dp-auth') next.envKey ||= c.envKeyHint || environmentKey(c.id);
  return next;
}
function desktopModel(model, previous = {}) {
  return {
    ...previous,
    id: model.id,
    name: model.name,
    shortName: previous.shortName || model.name,
    description: model.description || '',
    provider: previous.provider || 'pi',
    contextWindow: model.contextWindow || previous.contextWindow || 32000,
    wire: model.wire,
    ...(model.vision === undefined ? {} : { supportsImages: model.vision }),
  };
}
export function syncModels(cli, desktop, state, report) {
  let left = cliConnections(cli, report),
    right = desktopConnections(desktop, report);
  const bindings = [];
  for (const id of new Set([
    ...left.keys(),
    ...right.keys(),
    ...Object.keys(state.connections || {}),
  ])) {
    if (report.conflicts.includes(`duplicate-desktop-endpoint:${id}`)) continue;
    const a = left.get(id),
      b = right.get(id);
    const envKeys = [...new Set((a?.refs || []).map((m) => m.envKey).filter(Boolean))];
    if (
      envKeys.length > 1 &&
      (envKeys.some((k) => !cli.env?.[k]) || new Set(envKeys.map((k) => cli.env[k])).size > 1)
    ) {
      report.conflicts.push(`ambiguous-cli-credentials:${id}`);
      continue;
    }
    if (a && new Set(a.models.map((m) => m.id)).size !== a.models.length) {
      report.conflicts.push(`duplicate-cli-model:${id}`);
      continue;
    }
    // Deleting a provider in one app must not erase another app's configuration.
    if (state.connections?.[id] && (!a || !b)) {
      report.unsupported.push(`removed-connection-retained:${id}`);
      continue;
    }
    const merged = reconcile(state, `model:${id}`, portable(a), portable(b), report);
    if (merged.conflict || !merged.value) continue;
    const value = {
      id,
      ...merged.value,
      envKeyHint:
        b?.ref.authType === 'environment'
          ? b.auth === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'OPENAI_API_KEY'
          : undefined,
    };
    cli.modelProviders ||= {};
    const group = (cli.modelProviders[value.auth] ||= []);
    const originals = a?.refs || [];
    cli.modelProviders[value.auth] = group
      .filter((m) => !originals.includes(m))
      .concat(
        value.models.map((m) =>
          cliModel(
            m,
            value,
            originals.find((old) => old.id === m.id),
          ),
        ),
      );
    desktop.llmConnections ||= [];
    const slug = b?.ref.slug || `odysseus-${hash(id)}`;
    const connection = b?.ref || {
      slug,
      name: `Odysseus · ${new URL(value.url).host}`,
      providerType: 'pi_compat',
      authType: value.auth === 'dp-auth' ? 'none' : 'api_key_with_endpoint',
      customEndpoint: {
        api: value.auth === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
        ...(value.auth === 'anthropic' ? { credentialHeader: 'x-api-key' } : {}),
      },
      createdAt: Date.now(),
      modelSelectionMode: 'userDefined3Tier',
    };
    const updated = {
      ...connection,
      baseUrl: value.url,
      models: value.models.map((m) =>
        desktopModel(
          m,
          connection.models?.find((old) => typeof old !== 'string' && old.id === m.id),
        ),
      ),
    };
    if (!updated.defaultModel || !value.models.some((m) => m.id === updated.defaultModel))
      updated.defaultModel = value.models[0]?.id;
    desktop.llmConnections = desktop.llmConnections.filter((c) => c.slug !== slug).concat(updated);
    // Project again so absent native defaults do not cause a feedback loop.
    const normalizedLeft = cliConnections(cli, {
      unsupported: [],
      conflicts: [],
    }).get(id);
    const normalizedRight = desktopConnections(desktop, {
      unsupported: [],
      conflicts: [],
    }).get(id);
    merged.accept(portable(normalizedLeft), portable(normalizedRight));
    state.connections ||= {};
    state.connections[id] = { slug, auth: value.auth, url: value.url };
    bindings.push({
      id,
      slug,
      auth: value.auth,
      envKeys: [...new Set(normalizedLeft.refs.map((m) => m.envKey).filter(Boolean))],
    });
  }
  left = cliConnections(cli, { unsupported: [], conflicts: [] });
  right = desktopConnections(desktop, { unsupported: [], conflicts: [] });
  const cliSelection = (() => {
    if (!cli.model?.name) return undefined;
    const auth = cli.security?.auth?.selectedType;
    const matches = [...left.values()].filter(
      (c) =>
        (!auth || c.auth === auth) &&
        c.models.some((m) => m.id === cli.model.name) &&
        (!cli.model.baseUrl || c.url === cli.model.baseUrl.replace(/\/+$/, '')),
    );
    return matches.length === 1 ? { id: matches[0].id, model: cli.model.name } : undefined;
  })();
  const desktopSelection = (() => {
    const c = [...right.values()].find((c) => c.ref.slug === desktop.defaultLlmConnection);
    return c?.ref.defaultModel ? { id: c.id, model: c.ref.defaultModel } : undefined;
  })();
  if ((desktop.defaultLlmConnection && !desktopSelection) || (cli.model?.name && !cliSelection)) {
    report.unsupported.push('selected-model-not-portable');
    return bindings;
  }
  const selection = reconcile(state, 'default-model', cliSelection, desktopSelection, report);
  if (!selection.conflict && selection.value) {
    const c = left.get(selection.value.id),
      d = right.get(selection.value.id);
    if (c && d && c.models.some((m) => m.id === selection.value.model)) {
      cli.model = { ...cli.model, name: selection.value.model, baseUrl: c.url };
      cli.security ||= {};
      cli.security.auth = { ...cli.security.auth, selectedType: c.auth };
      desktop.defaultLlmConnection = d.ref.slug;
      desktop.llmConnections.find((x) => x.slug === d.ref.slug).defaultModel =
        selection.value.model;
      selection.accept();
    }
  } else if (!selection.conflict) selection.accept();
  return bindings;
}
