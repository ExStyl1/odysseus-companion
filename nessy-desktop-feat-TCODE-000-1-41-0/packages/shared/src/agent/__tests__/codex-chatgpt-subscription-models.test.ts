/**
 * F1.566 (origin WJ-bf P-WJbf-1, 2026-09-24) — the ChatGPT (Codex) card's model
 * list comes from codex's own `model/list` after sign-in, not only from the
 * static seed (`CODEX_CHATGPT_SUBSCRIPTION_MODELS`, codex's bundled
 * `models.json` at `rust-v0.156.1`).
 *
 * Why `model/list` is the right source for THIS card and no other: P3.115
 * measured that it answers codex's OWN catalogue whatever provider the config
 * names. On every other codex card that catalogue describes a provider the
 * session never uses. On this card codex's own `openai` provider IS the one in
 * use, and after sign-in codex resolves the list for the account
 * (`catalog_processor.rs` `list_models`, `RefreshStrategy::OnlineIfUncached`).
 *
 * WHAT EACH ARM KILLS: a card whose list never leaves the seed; a refresh that
 * lists a hidden model, drops the stored context window of a known model, moves
 * a still-valid default, or keeps a default codex no longer lists; a write when
 * nothing changed, when codex answered nothing usable, when the read failed, or
 * over a list the user curated; a gateway card that asks codex for its list
 * (CONTROL: its list is the gateway's, not codex's).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LlmConnection } from '../../config/llm-connections.ts';
import { CODEX_CHATGPT_SUBSCRIPTION_MODELS } from '../../config/llm-connections.ts';
import type { ModelDefinition } from '../../config/models.ts';
import type { BackendConfig } from '../backend/types.ts';
import {
  CODEX_CHATGPT_UNLISTED_CONTEXT_WINDOW,
  CODEX_MODEL_LIST_METHOD,
  refreshCodexChatGptSubscriptionModels,
  type CodexChatGptModelStore,
} from '../backend/codex/chatgpt-subscription-models.ts';
import { CodexAgent } from '../codex-agent.ts';

const SLUG = 'f1566-chatgpt-codex';
const NOW = 1_790_000_000_000;

/** A `model/list` entry in codex's own shape (`generated/v2/Model.ts`), trimmed to what matters. */
const listed = (model: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  id: model, model, displayName, description: `${displayName} from the account.`, hidden: false, isDefault: false,
  upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, supportedReasoningEfforts: [],
  defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: false,
  multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null,
  availableAccessPrograms: null, ...extra,
});

// A card seeded at `rust-v0.156.1`, whose default was codex's priority-1 model
// then; F1.1215 kept that literal because the cases below need a default the
// account list still carries, not the current seed's first entry.
function seededCard(extra: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: SLUG, name: 'ChatGPT (Codex)', providerType: 'codex-runtime', authType: 'oauth', codexModelProvider: 'openai',
    models: CODEX_CHATGPT_SUBSCRIPTION_MODELS.map(model => ({ ...model })), defaultModel: 'gpt-6-astra', createdAt: 0,
    ...extra,
  } as LlmConnection;
}

function memoryStore(connection: LlmConnection | null): CodexChatGptModelStore & { writes: Array<Partial<LlmConnection>> } {
  const writes: Array<Partial<LlmConnection>> = [];
  return {
    writes,
    get: slug => (connection && slug === connection.slug ? connection : null),
    update: (slug, updates) => {
      if (!connection || slug !== connection.slug) return false;
      writes.push(updates);
      Object.assign(connection, updates);
      return true;
    },
  };
}

function fakeClient(answers: Record<string, unknown | Error>) {
  const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
  return {
    requests,
    async request(method: string, params?: unknown, options?: unknown) {
      requests.push({ method, params, options });
      if (!(method in answers)) throw new Error(`fake app-server: unexpected ${method}`);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('F1.566 · codex\'s own model/list replaces the seed on the card', () => {
  it('the live list replaces the seed: visible entries only, known windows kept, the stamp written', async () => {
    const store = memoryStore(seededCard());
    const client = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: {
        data: [
          listed('gpt-6-sol', 'GPT-6-Sol'),
          listed('gpt-6-astra', 'GPT-6-Astra', { isDefault: true }),
          listed('gpt-7-preview', 'GPT-7-Preview'),
          listed('codex-auto-review', 'Auto review', { hidden: true }),
        ],
        nextCursor: null,
      },
    });

    const outcome = await refreshCodexChatGptSubscriptionModels(client, SLUG, store, () => NOW);

    expect(outcome.kind).toBe('replaced');
    expect(client.requests.map(entry => entry.method)).toEqual([CODEX_MODEL_LIST_METHOD]);
    expect(client.requests[0]!.params).toEqual({ includeHidden: false });
    expect(store.writes).toHaveLength(1);
    const written = store.writes[0]!;
    // The writer only ever stores definitions; the field's type also admits bare ids.
    const models = (written.models ?? []) as ModelDefinition[];
    expect(models.map(model => model.id)).toEqual(['gpt-6-sol', 'gpt-6-astra', 'gpt-7-preview']);
    expect(models[0]).toMatchObject({ name: 'GPT-6-Sol', shortName: 'GPT-6-Sol', provider: 'codex-runtime' });
    expect(models[0]?.description).toBe('GPT-6-Sol from the account.');
    // A seeded model keeps the window codex's models.json gave it; a new one gets the stated uniform value.
    expect(models[1]?.contextWindow).toBe(CODEX_CHATGPT_SUBSCRIPTION_MODELS.find(m => m.id === 'gpt-6-astra')!.contextWindow);
    expect(models[2]?.contextWindow).toBe(CODEX_CHATGPT_UNLISTED_CONTEXT_WINDOW);
    expect(written.catalogueRefreshedAt).toBe(NOW);
    // The stored default is still listed, so it is not moved.
    expect('defaultModel' in written).toBe(false);
  });

  it('a default codex no longer lists moves to codex\'s own default', async () => {
    const store = memoryStore(seededCard({ defaultModel: 'gpt-5.5' }));
    const client = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: { data: [listed('gpt-6-sol', 'GPT-6-Sol'), listed('gpt-6-astra', 'GPT-6-Astra', { isDefault: true })], nextCursor: null },
    });
    const outcome = await refreshCodexChatGptSubscriptionModels(client, SLUG, store, () => NOW);
    expect(outcome).toMatchObject({ kind: 'replaced', defaultMoved: { from: 'gpt-5.5', to: 'gpt-6-astra' } });
    expect(store.writes[0]?.defaultModel).toBe('gpt-6-astra');
  });

  it('nothing is written when the list is the same, empty, unreadable, or the user\'s own', async () => {
    const same = memoryStore(seededCard());
    const echo = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: {
        data: CODEX_CHATGPT_SUBSCRIPTION_MODELS.map(model => listed(model.id, model.name, { description: model.description })),
        nextCursor: null,
      },
    });
    expect((await refreshCodexChatGptSubscriptionModels(echo, SLUG, same, () => NOW)).kind).toBe('unchanged');
    expect(same.writes).toEqual([]);

    const empty = memoryStore(seededCard());
    const nothing = fakeClient({ [CODEX_MODEL_LIST_METHOD]: { data: [listed('x', 'X', { hidden: true })], nextCursor: null } });
    expect((await refreshCodexChatGptSubscriptionModels(nothing, SLUG, empty, () => NOW)).kind).toBe('empty');
    expect(empty.writes).toEqual([]);

    const failed = memoryStore(seededCard());
    const refusing = fakeClient({ [CODEX_MODEL_LIST_METHOD]: new Error('failed to load models') });
    const outcome = await refreshCodexChatGptSubscriptionModels(refusing, SLUG, failed, () => NOW);
    expect(outcome).toMatchObject({ kind: 'unreadable' });
    expect(failed.writes).toEqual([]);

    const curated = memoryStore(seededCard({ modelSelectionMode: 'userDefined3Tier' } as Partial<LlmConnection>));
    const live = fakeClient({ [CODEX_MODEL_LIST_METHOD]: { data: [listed('gpt-7-preview', 'GPT-7-Preview')], nextCursor: null } });
    expect((await refreshCodexChatGptSubscriptionModels(live, SLUG, curated, () => NOW)).kind).toBe('user-owned');
    expect(curated.writes).toEqual([]);
    // The user-owned list is not even asked for.
    expect(live.requests).toEqual([]);
  });
});

class RigAgent extends CodexAgent {
  store!: CodexChatGptModelStore;
  protected override chatGptSubscriptionModelStore(): CodexChatGptModelStore { return this.store; }
}

function rigAgent(connection: LlmConnection): { agent: RigAgent; store: ReturnType<typeof memoryStore>; logs: string[] } {
  const agent = new RigAgent({
    provider: 'codex-runtime', providerType: 'codex-runtime', connectionSlug: connection.slug, isHeadless: true,
    workspace: { id: 'ws-f1566', name: 'F1.566', rootPath: '/tmp/nessy-f1566', workspaceRootPath: '/tmp/nessy-f1566', sessionRootPath: '/tmp/nessy-f1566/sessions' },
    session: { id: 'session-f1566', workspaceRootPath: '/tmp/nessy-f1566', createdAt: Date.now(), lastUsedAt: Date.now() },
  } as unknown as BackendConfig);
  const store = memoryStore(connection);
  agent.store = store;
  const logs: string[] = [];
  agent.onDebug = message => { logs.push(message); };
  return { agent, store, logs };
}

describe('F1.566 · CodexAgent refreshes the card\'s list after sign-in', () => {
  it('the card: the list is read from the live app-server and written to the connection', async () => {
    const { agent, store, logs } = rigAgent(seededCard());
    try {
      const client = fakeClient({ [CODEX_MODEL_LIST_METHOD]: { data: [listed('gpt-7-preview', 'GPT-7-Preview', { isDefault: true })], nextCursor: null } });
      await (agent as unknown as { refreshChatGptSubscriptionModels(c: unknown, d: string | undefined): Promise<void> })
        .refreshChatGptSubscriptionModels(client, 'openai');
      expect((store.writes[0]?.models as ModelDefinition[] | undefined)?.map(model => model.id)).toEqual(['gpt-7-preview']);
      expect(logs.join('\n')).toContain('[ChatGPT subscription] model list');
    } finally {
      agent.destroy();
    }
  });

  it('CONTROL: a gateway session never asks codex for its list, and nothing is written', async () => {
    const { agent, store } = rigAgent(seededCard({ codexModelProvider: undefined, baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1' } as Partial<LlmConnection>));
    try {
      const client = fakeClient({});
      await (agent as unknown as { refreshChatGptSubscriptionModels(c: unknown, d: string | undefined): Promise<void> })
        .refreshChatGptSubscriptionModels(client, undefined);
      expect(client.requests).toEqual([]);
      expect(store.writes).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('the runtime build calls it right after the sign-in, without waiting on it', () => {
    const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
    expect(source).toContain('await this.signInCodexChatGptSubscription(client, declaredModelProvider); void this.refreshChatGptSubscriptionModels(client, declaredModelProvider);');
  });
});

/**
 * F1.601 (origin WJ-bl P-WJbl-4, 2026-09-24) — codex's `inputModalities` reaches
 * the card's `supportsImages`. At `rust-v0.156.1` codex strips an image it is
 * handed for a model whose modalities lack `image`
 * (`core/src/context_manager/normalize.rs`, `strip_images_when_unsupported`,
 * a placeholder in its place), so without the copy the composer offered the
 * attachment and codex dropped it without a word. A model codex lists without
 * `image` is declared `supportsImages: false`; one that takes images stays
 * undeclared, which already resolves to images-on on a codex card and is codex's
 * own default when the field is absent (`default_input_modalities`).
 */
describe('F1.601 · codex\'s inputModalities decide the card\'s image attachment', () => {
  it('a text-only model is declared false, an image model stays undeclared, and the composer follows', async () => {
    const { resolveComposerCapabilities } = await import('../backend/composer-capabilities.ts');
    const connection = seededCard();
    const store = memoryStore(connection);
    const client = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: {
        data: [listed('gpt-6-sol', 'GPT-6-Sol'), listed('gpt-7-text', 'GPT-7-Text', { inputModalities: ['text'] })],
        nextCursor: null,
      },
    });
    expect((await refreshCodexChatGptSubscriptionModels(client, SLUG, store, () => NOW)).kind).toBe('replaced');
    const models = (store.writes[0]?.models ?? []) as ModelDefinition[];
    expect(models.find(model => model.id === 'gpt-7-text')?.supportsImages).toBe(false);
    expect('supportsImages' in models.find(model => model.id === 'gpt-6-sol')!).toBe(false);
    const images = (model: string) =>
      resolveComposerCapabilities({ provider: 'codex-runtime', connection, model }).attachments.images;
    expect(images('gpt-7-text')).toBe('no');
    expect(images('gpt-6-sol')).toBe('yes');
  });

  it('a modality change alone is a change: the model regains images when codex lists `image` again', async () => {
    const connection = seededCard({
      models: [{ ...CODEX_CHATGPT_SUBSCRIPTION_MODELS[0]!, supportsImages: false }],
      defaultModel: CODEX_CHATGPT_SUBSCRIPTION_MODELS[0]!.id,
    });
    const store = memoryStore(connection);
    const seed = CODEX_CHATGPT_SUBSCRIPTION_MODELS[0]!;
    const client = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: { data: [listed(seed.id, seed.name, { description: seed.description })], nextCursor: null },
    });
    expect((await refreshCodexChatGptSubscriptionModels(client, SLUG, store, () => NOW)).kind).toBe('replaced');
    expect('supportsImages' in ((store.writes[0]?.models ?? []) as ModelDefinition[])[0]!).toBe(false);
  });

  it('CONTROL: a field codex did not publish declares nothing, and the seed echo still writes nothing', async () => {
    const store = memoryStore(seededCard());
    const client = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: {
        data: CODEX_CHATGPT_SUBSCRIPTION_MODELS.map(model => {
          const entry: Record<string, unknown> = listed(model.id, model.name, { description: model.description });
          delete entry.inputModalities;
          return entry;
        }),
        nextCursor: null,
      },
    });
    expect((await refreshCodexChatGptSubscriptionModels(client, SLUG, store, () => NOW)).kind).toBe('unchanged');
    expect(store.writes).toEqual([]);
  });
});

/**
 * F1.625 (origin WJ-bw P-WJbw-3, 2026-09-24) — the refresh MERGES codex's
 * answer into the stored entry instead of rebuilding it, so a per-model field
 * the refresh does not own survives, a learned image refusal included.
 */
describe('F1.625 · the refresh merges codex\'s answer into the stored entry', () => {
  it('a stored per-model field and a learned image refusal survive a refresh that does not change that model', async () => {
    const seed = CODEX_CHATGPT_SUBSCRIPTION_MODELS[0]!;
    const refusal = 'Model does not support image inputs';
    const connection = seededCard({
      models: [{ ...seed, supportsImages: false, supportsImagesLearnedFrom: refusal, reasoningEffort: 'low' }],
      defaultModel: seed.id,
    });
    const store = memoryStore(connection);
    const echo = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: { data: [listed(seed.id, seed.name, { description: seed.description })], nextCursor: null },
    });
    // Nothing codex owns changed, so nothing is written — the refusal is not a difference.
    expect((await refreshCodexChatGptSubscriptionModels(echo, SLUG, store, () => NOW)).kind).toBe('unchanged');
    expect(store.writes).toEqual([]);

    const grown = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: {
        data: [listed(seed.id, seed.name, { description: seed.description }), listed('gpt-7-preview', 'GPT-7-Preview')],
        nextCursor: null,
      },
    });
    expect((await refreshCodexChatGptSubscriptionModels(grown, SLUG, store, () => NOW)).kind).toBe('replaced');
    const [kept, added] = (store.writes[0]?.models ?? []) as ModelDefinition[];
    expect(kept).toMatchObject({ id: seed.id, supportsImages: false, supportsImagesLearnedFrom: refusal, reasoningEffort: 'low' });
    // A model new to the list inherits nothing from its neighbour.
    expect(added && ('reasoningEffort' in added || 'supportsImages' in added || 'supportsImagesLearnedFrom' in added)).toBe(false);
  });

  it('CONTROL: what the refresh owns is still codex\'s — a renamed model is renamed, its other fields kept', async () => {
    const seed = CODEX_CHATGPT_SUBSCRIPTION_MODELS[0]!;
    const connection = seededCard({
      models: [{ ...seed, descriptionKey: 'model.staleDesc', provider: 'pi', reasoningEffort: 'low' }],
      defaultModel: seed.id,
    });
    const store = memoryStore(connection);
    const client = fakeClient({
      [CODEX_MODEL_LIST_METHOD]: { data: [listed(seed.id, 'GPT-6-Astra Max', { description: 'Renamed by the account.' })], nextCursor: null },
    });
    expect((await refreshCodexChatGptSubscriptionModels(client, SLUG, store, () => NOW)).kind).toBe('replaced');
    const model = ((store.writes[0]?.models ?? []) as ModelDefinition[])[0]!;
    expect(model).toMatchObject({
      id: seed.id, name: 'GPT-6-Astra Max', shortName: 'GPT-6-Astra Max', description: 'Renamed by the account.',
      provider: 'codex-runtime', contextWindow: seed.contextWindow, reasoningEffort: 'low',
    });
    // A translation key would show in place of codex's description, so the refresh owns it too.
    expect('descriptionKey' in model).toBe(false);
  });
});
