/**
 * F1.202 option (a) (OWNER-approved 2026-09-24) — a `codex-runtime` card that
 * runs turns on the user's ChatGPT subscription through codex's OWN provider
 * and codex's OWN external-auth login, fed from the host's one ChatGPT OAuth.
 *
 * WHAT EACH ARM KILLS:
 *  - the provider arms die if a card can declare codex's `openai` provider
 *    without being a `codex-runtime` connection, or if the Bedrock operator
 *    switch reaches the ChatGPT card (it gates only the Bedrock card);
 *  - the writer arm dies if a declared `openai` session keeps the loopback
 *    table, an adapter port or a gateway credential slot;
 *  - the model-target arm dies if the subscription card lands in the
 *    fail-closed `provider-default` class instead of naming the host its tool
 *    schemas actually go to (codex's `CHATGPT_CODEX_BASE_URL`);
 *  - the resolver arms die if a fresh token is refreshed, an expired one is
 *    handed over, two sessions spend one rotating refresh token twice, a
 *    sibling's refresh is repeated, or a refresh failure carries the server's
 *    words (which could echo a token) into the reason.
 *
 * Every token here is FABRICATED (`fakeJwt`) and no store, network or config
 * dir is real: the store and the refresh are injected.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer';
import {
  CODEX_CHATGPT_DEFAULT_MODEL,
  CODEX_CHATGPT_MODEL_PROVIDER,
  CODEX_CHATGPT_SUBSCRIPTION_MODELS,
  isValidProviderAuthCombination,
  resolveCodexModelProvider,
} from '../../config/llm-connections.ts';
import {
  classifyModelTarget,
  modelTargetBaseUrlForConnection,
} from '../backend/internal/drivers/upstream-target.ts';
import { resolveComposerCapabilities } from '../backend/composer-capabilities.ts';
import type { LlmConnection } from '../../config/llm-connections.ts';
import {
  answerCodexChatGptAuthTokensRefresh,
  buildCodexChatGptLoginParams,
  chatgptAccountIdFromJwt,
  resolveCodexChatGptTokens,
  type ChatGptOAuthStore,
  type StoredChatGptOAuth,
} from '../backend/codex/chatgpt-subscription-auth.ts';

/** A structurally valid, fabricated JWT carrying codex's auth claim. */
function fakeJwt(accountId: string | null, marker: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload: Record<string, unknown> = { sub: marker, email: 'user@example.com' };
  if (accountId !== null) {
    payload['https://api.openai.com/auth'] = { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' };
  }
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.${Buffer.from(`sig-${marker}`).toString('base64url')}`;
}

function memoryStore(initial: StoredChatGptOAuth | null): ChatGptOAuthStore & {
  current: StoredChatGptOAuth | null;
  writes: number;
} {
  const store = {
    current: initial,
    writes: 0,
    async get(_slug: string) { return store.current ? { ...store.current } : null; },
    async set(_slug: string, credentials: StoredChatGptOAuth) { store.writes += 1; store.current = { ...credentials }; },
  };
  return store;
}

const NOW = 1_790_000_000_000;
const HOUR = 3_600_000;

describe('F1.202 · the card declares codex\'s own openai provider', () => {
  it('a codex-runtime connection declaring openai routes to it; nothing else does', () => {
    expect(CODEX_CHATGPT_MODEL_PROVIDER).toBe('openai');
    expect(resolveCodexModelProvider({ providerType: 'codex-runtime', codexModelProvider: 'openai' })).toBe('openai');
    // Controls: undeclared keeps the loopback pin; the field on another runtime is read by nothing.
    expect(resolveCodexModelProvider({ providerType: 'codex-runtime' })).toBeUndefined();
    expect(resolveCodexModelProvider({ providerType: 'pi', codexModelProvider: 'openai' })).toBeUndefined();
  });

  it('the Bedrock operator switch gates the Bedrock card only', () => {
    const off = { NESSY_CODEX_BEDROCK_CARD: '0' };
    expect(resolveCodexModelProvider({ providerType: 'codex-runtime', codexModelProvider: 'amazon-bedrock' }, off)).toBeUndefined();
    expect(resolveCodexModelProvider({ providerType: 'codex-runtime', codexModelProvider: 'openai' }, off)).toBe('openai');
  });

  it('codex-runtime accepts oauth; claude-runtime still does not', () => {
    expect(isValidProviderAuthCombination('codex-runtime', 'oauth')).toBe(true);
    expect(isValidProviderAuthCombination('claude-runtime', 'oauth')).toBe(false);
  });

  it('the model seed is codex\'s own list-visible catalogue, default first', () => {
    const ids = CODEX_CHATGPT_SUBSCRIPTION_MODELS.map(model => model.id);
    expect(ids[0]).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    // F1.1215 — the `list`-visible entries of `codex-rs/models-manager/models.json`
    // at `rust-v0.159.3`, in `priority` order: `gpt-6.1-sol` is priority 1 there,
    // so it is codex's own default ("the highest priority available model").
    expect(ids).toEqual([
      'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
    ]);
    for (const model of CODEX_CHATGPT_SUBSCRIPTION_MODELS) expect(model.provider).toBe('codex-runtime');
  });

  it('the writer pins model_provider = "openai" and writes no loopback table', () => {
    const toml = buildCodexConfigToml({
      codexHome: '/tmp/f1202',
      model: CODEX_CHATGPT_DEFAULT_MODEL,
      declaredModelProvider: 'openai',
    });
    expect(toml).toContain('model_provider = "openai"');
    expect(toml).not.toContain('[model_providers.');
    expect(toml).not.toContain('env_key');
    expect(toml).not.toContain('127.0.0.1');
  });

  it('the /quota row is offered on the card, which reads codex\'s own windows; a BYO codex card stays out', () => {
    const subscription = {
      slug: 'chatgpt-codex', name: 'ChatGPT (Codex)', providerType: 'codex-runtime', authType: 'oauth',
      codexModelProvider: 'openai', models: [], createdAt: 0,
    } as unknown as LlmConnection;
    const byo = {
      slug: 'codex-custom', name: 'BYO', providerType: 'codex-runtime', authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.deepseek.com/v1', models: [], createdAt: 0,
    } as unknown as LlmConnection;
    const excluded = (connection: LlmConnection) =>
      resolveComposerCapabilities({ provider: 'codex-runtime', connection }).slash?.excludedCommandIds ?? [];
    expect(excluded(subscription)).not.toContain('quota');
    expect(excluded(byo)).toContain('quota');
  });

  it('the model target names chatgpt.com rather than failing closed as an unnamed default', () => {
    const baseUrl = modelTargetBaseUrlForConnection({ providerType: 'codex-runtime', codexModelProvider: 'openai' });
    expect(baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    const verdict = classifyModelTarget({ baseUrl, model: CODEX_CHATGPT_DEFAULT_MODEL, providerType: 'codex-runtime' });
    expect(verdict.class).not.toBe('provider-default');
    expect(verdict.host).toBe('chatgpt.com');
    // Control: an undeclared endpoint-less codex connection is unchanged.
    expect(modelTargetBaseUrlForConnection({ providerType: 'codex-runtime' })).toBeUndefined();
  });
});

describe('F1.202 · the lift guard: the two protocol members this card stands on', () => {
  // The login variant is marked "[UNSTABLE] FOR OPENAI INTERNAL USE ONLY" upstream
  // (rust-v0.156.1, app-server-protocol/src/protocol/v2/account.rs). A codex lift
  // that drops or renames either member must fail HERE, at regeneration, rather
  // than as a card whose every session stops at sign-in.
  const schema = join(import.meta.dir, '..', '..', '..', '..', 'codex-protocol', 'schema');
  it('LoginAccountParams still carries chatgptAuthTokens with the three fields handed over', () => {
    const login = JSON.parse(readFileSync(join(schema, 'v2', 'LoginAccountParams.json'), 'utf8')) as { oneOf?: unknown[] };
    const variant = (login.oneOf ?? []).find(entry => JSON.stringify(entry).includes('"chatgptAuthTokens"')) as
      { properties?: Record<string, unknown>; required?: string[] } | undefined;
    expect(variant).toBeDefined();
    expect(Object.keys(variant?.properties ?? {})).toEqual(expect.arrayContaining(['accessToken', 'chatgptAccountId', 'chatgptPlanType']));
    expect(variant?.required ?? []).toEqual(expect.arrayContaining(['accessToken', 'chatgptAccountId']));
  });
  it('ServerRequest still carries account/chatgptAuthTokens/refresh', () => {
    expect(readFileSync(join(schema, 'ServerRequest.json'), 'utf8')).toContain('"account/chatgptAuthTokens/refresh"');
  });
});

describe('F1.202 · the token resolver hands codex a good token, from the store', () => {
  it('reads the workspace id out of the auth claim, and nothing out of a malformed token', () => {
    expect(chatgptAccountIdFromJwt(fakeJwt('ws-1', 'a'))).toBe('ws-1');
    expect(chatgptAccountIdFromJwt(fakeJwt(null, 'a'))).toBeNull();
    expect(chatgptAccountIdFromJwt('not-a-jwt')).toBeNull();
    expect(chatgptAccountIdFromJwt(undefined)).toBeNull();
  });

  it('a fresh token is handed over as stored, with no refresh', async () => {
    const access = fakeJwt('ws-1', 'fresh');
    const store = memoryStore({ accessToken: access, refreshToken: 'rt-1', expiresAt: NOW + HOUR });
    let refreshed = 0;
    const result = await resolveCodexChatGptTokens('chatgpt-codex', {
      store, now: () => NOW, refresh: async () => { refreshed += 1; throw new Error('must not refresh'); },
    });
    expect(result).toEqual({ ok: true, tokens: { accessToken: access, chatgptAccountId: 'ws-1', chatgptPlanType: null } });
    expect(refreshed).toBe(0);
    expect(buildCodexChatGptLoginParams(result.ok ? result.tokens : (null as never))).toEqual({
      type: 'chatgptAuthTokens', accessToken: access, chatgptAccountId: 'ws-1', chatgptPlanType: null,
    });
  });

  it('an expired token is refreshed ONCE, the rotation is stored, and two callers share it', async () => {
    const store = memoryStore({ accessToken: fakeJwt('ws-1', 'old'), refreshToken: 'rt-1', expiresAt: NOW - 1 });
    const renewed = fakeJwt('ws-1', 'new');
    const seen: string[] = [];
    const refresh = async (refreshToken: string) => {
      seen.push(refreshToken);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { accessToken: renewed, refreshToken: 'rt-2', expiresAt: NOW + HOUR };
    };
    const [a, b] = await Promise.all([
      resolveCodexChatGptTokens('chatgpt-codex', { store, refresh, now: () => NOW }),
      resolveCodexChatGptTokens('chatgpt-codex', { store, refresh, now: () => NOW }),
    ]);
    expect(seen).toEqual(['rt-1']);
    expect(a.ok && a.tokens.accessToken).toBe(renewed);
    expect(b.ok && b.tokens.accessToken).toBe(renewed);
    expect(store.current?.refreshToken).toBe('rt-2');
    expect(store.writes).toBe(1);
  });

  it('the refresh request: the refused token is renewed; a token a sibling already renewed is not', async () => {
    const refused = fakeJwt('ws-1', 'refused');
    const store = memoryStore({ accessToken: refused, refreshToken: 'rt-1', expiresAt: NOW + HOUR });
    let refreshes = 0;
    const renewed = fakeJwt('ws-1', 'renewed');
    const refresh = async () => { refreshes += 1; return { accessToken: renewed, refreshToken: 'rt-2', expiresAt: NOW + HOUR }; };
    const first = await answerCodexChatGptAuthTokensRefresh('chatgpt-codex', { reason: 'unauthorized', previousAccountId: 'ws-1' }, refused, { store, refresh, now: () => NOW });
    expect(first.accessToken).toBe(renewed);
    expect(refreshes).toBe(1);
    // A second session still holding the OLD token asks again: the store already
    // holds a different one, so it is handed over without spending rt-2.
    const second = await answerCodexChatGptAuthTokensRefresh('chatgpt-codex', { reason: 'unauthorized' }, refused, { store, refresh, now: () => NOW });
    expect(second.accessToken).toBe(renewed);
    expect(refreshes).toBe(1);
  });

  it('a different workspace than codex was using is refused, not substituted', async () => {
    const store = memoryStore({ accessToken: fakeJwt('ws-2', 'x'), refreshToken: 'rt', expiresAt: NOW + HOUR });
    await expect(answerCodexChatGptAuthTokensRefresh('chatgpt-codex', { reason: 'unauthorized', previousAccountId: 'ws-1' }, 'other', { store, now: () => NOW }))
      .rejects.toThrow('different workspace');
  });

  it('a failed refresh names the status and never the server\'s words', async () => {
    const secret = fakeJwt('ws-1', 'echoed-secret');
    const store = memoryStore({ accessToken: fakeJwt('ws-1', 'old'), refreshToken: 'rt-1', expiresAt: NOW - 1 });
    const result = await resolveCodexChatGptTokens('chatgpt-codex', {
      store,
      now: () => NOW,
      refresh: async () => { throw new Error(`Token refresh failed: 401 - bad token ${secret} rt-1`); },
    });
    expect(result.ok).toBe(false);
    const reason = result.ok ? '' : result.reason;
    expect(reason).toContain('HTTP 401');
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain('rt-1');
    expect(store.writes).toBe(0);
  });

  it('no sign-in, no renewable sign-in, and no workspace are three named refusals', async () => {
    const none = await resolveCodexChatGptTokens('chatgpt-codex', { store: memoryStore(null), now: () => NOW });
    expect(none).toEqual({ ok: false, reason: expect.stringContaining('not signed in') });
    const stale = await resolveCodexChatGptTokens('chatgpt-codex', {
      store: memoryStore({ accessToken: fakeJwt('ws-1', 's'), expiresAt: NOW - 1 }), now: () => NOW,
    });
    expect(stale.ok ? '' : stale.reason).toContain('cannot be renewed');
    const noWorkspace = await resolveCodexChatGptTokens('chatgpt-codex', {
      store: memoryStore({ accessToken: fakeJwt(null, 'n'), expiresAt: NOW + HOUR }), now: () => NOW,
    });
    expect(noWorkspace.ok ? '' : noWorkspace.reason).toContain('names no ChatGPT workspace');
  });
});
