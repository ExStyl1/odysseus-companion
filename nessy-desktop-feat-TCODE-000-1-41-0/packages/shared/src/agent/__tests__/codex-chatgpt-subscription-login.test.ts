/**
 * F1.202 option (a) — the ChatGPT (Codex) card's sign-in, driven through the
 * REAL `CodexAgent` over a fake app-server: the login round trip, the refresh
 * request answered from the store, and no token in any log.
 *
 * The connections are seeded through the real storage API into the preload's
 * isolated config dir (AGENTS.md: a module-body `NESSY_CONFIG_DIR` isolates
 * nothing), and the controls after the writes prove the fixture landed — so
 * the gateway arm is a gateway card and not a "no connection" that passes for
 * the wrong reason. The credential store and the token refresh are the agent's
 * own seam (`chatGptSubscriptionAuthDeps`), overridden: no real store, no
 * network. Every token is fabricated.
 *
 * WHAT EACH ARM KILLS:
 *  - round trip: a card that never logs in, logs in with the wrong shape, or
 *    answers codex's refresh request with `{}` (or with the stale token);
 *  - gateway: a `codex-gateway` session that sends `account/login/start`, or
 *    whose refresh answer stops being the structural `{}`;
 *  - no sign-in: a runtime that opens a thread with no credential, or says so
 *    nowhere a user can see;
 *  - one-shot: a subscription session whose title prompt goes to the gateway;
 *  - every arm: a token in a debug line, a session fact, an auth-required
 *    reason or the console.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { addLlmConnection, getLlmConnection, type LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { ResolveCodexChatGptTokensDeps, StoredChatGptOAuth } from '../backend/codex/chatgpt-subscription-auth.ts';
import { CodexAgent } from '../codex-agent.ts';

const SUBSCRIPTION_SLUG = 'f1202-chatgpt-codex';
const GATEWAY_SLUG = 'f1202-codex-gateway';
const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
let previousConfigJson: string | null = null;

function fakeJwt(accountId: string, marker: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: marker,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' },
  })}.${Buffer.from(`sig-${marker}`).toString('base64url')}`;
}

const ACCESS = fakeJwt('ws-f1202', 'first-access');
const RENEWED = fakeJwt('ws-f1202', 'renewed-access');
const REFRESH_1 = 'rt-f1202-first-refresh-token-value';
const REFRESH_2 = 'rt-f1202-rotated-refresh-token-value';
const SECRETS = [ACCESS, RENEWED, REFRESH_1, REFRESH_2];

beforeAll(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const configPath = join(CONFIG_DIR, 'config.json');
  previousConfigJson = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (previousConfigJson === null) {
    writeFileSync(configPath, JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }), 'utf-8');
  }
  addLlmConnection({
    slug: SUBSCRIPTION_SLUG, name: 'ChatGPT (Codex)', providerType: 'codex-runtime', authType: 'oauth',
    codexModelProvider: 'openai', models: [], createdAt: 0,
  } as unknown as LlmConnection);
  addLlmConnection({
    slug: GATEWAY_SLUG, name: 'Codex (Nessy Gateway)', providerType: 'codex-runtime', authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_URL, models: [], createdAt: 0,
  } as unknown as LlmConnection);
  // The fixture controls: without them a lost write reads as "no connection".
  expect(getLlmConnection(SUBSCRIPTION_SLUG)?.codexModelProvider).toBe('openai');
  expect(getLlmConnection(GATEWAY_SLUG)?.baseUrl).toBe(GATEWAY_URL);
});

afterAll(() => {
  if (previousConfigJson === null) {
    rmSync(join(CONFIG_DIR, 'config.json'), { force: true });
    return;
  }
  writeFileSync(join(CONFIG_DIR, 'config.json'), previousConfigJson, 'utf-8');
});

function config(slug: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: slug,
    isHeadless: true,
    workspace: { id: 'ws-f1202', name: 'F1.202', rootPath: '/tmp/nessy-f1202', workspaceRootPath: '/tmp/nessy-f1202', sessionRootPath: '/tmp/nessy-f1202/sessions' },
    session: { id: 'session-f1202', workspaceRootPath: '/tmp/nessy-f1202', createdAt: Date.now(), lastUsedAt: Date.now() },
  } as unknown as BackendConfig;
}

interface Rig {
  agent: CodexAgent;
  store: { current: StoredChatGptOAuth | null; writes: number };
  refreshes: string[];
  logs: string[];
  authRequired: string[];
}

class RigAgent extends CodexAgent {
  deps!: ResolveCodexChatGptTokensDeps;
  protected override chatGptSubscriptionAuthDeps(): ResolveCodexChatGptTokensDeps { return this.deps; }
}

function rig(slug: string, stored: StoredChatGptOAuth | null): Rig {
  const agent = new RigAgent(config(slug));
  const store = { current: stored, writes: 0 };
  const refreshes: string[] = [];
  agent.deps = {
    store: {
      get: async () => (store.current ? { ...store.current } : null),
      set: async (_slug, credentials) => { store.writes += 1; store.current = { ...credentials }; },
    },
    refresh: async (refreshToken) => {
      refreshes.push(refreshToken);
      return { accessToken: RENEWED, refreshToken: REFRESH_2, expiresAt: Date.now() + 3_600_000 };
    },
  };
  const logs: string[] = [];
  const authRequired: string[] = [];
  agent.onDebug = message => { logs.push(message); };
  agent.onBackendAuthRequired = reason => { authRequired.push(reason); };
  return { agent, store, refreshes, logs, authRequired };
}

function fakeClient(answers: Record<string, unknown>) {
  const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
  return {
    requests,
    async request(method: string, params?: unknown, options?: unknown) {
      requests.push({ method, params, options });
      if (!(method in answers)) throw new Error(`fake app-server: unexpected ${method}`);
      return answers[method];
    },
  };
}

const consoleLines: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  consoleLines.length = 0;
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); }));
});
afterEach(() => { for (const spy of spies) spy.mockRestore(); });

function expectNoSecret(r: Rig, extra: string[] = []): void {
  const haystack = [...r.logs, ...r.authRequired, r.agent.getRecentStderr(), ...consoleLines, ...extra].join('\n');
  for (const secret of SECRETS) expect(haystack).not.toContain(secret);
}

describe('F1.202 · the ChatGPT (Codex) card signs codex in and answers its refresh', () => {
  it('the login round trip: tokens in, the refresh answered from the store, no token in any log', async () => {
    const r = rig(SUBSCRIPTION_SLUG, { accessToken: ACCESS, refreshToken: REFRESH_1, expiresAt: Date.now() + 3_600_000 });
    const client = fakeClient({ 'account/login/start': { type: 'chatgptAuthTokens' } });

    await (r.agent as any).signInCodexChatGptSubscription(client, 'openai');

    expect(client.requests.map(entry => entry.method)).toEqual(['account/login/start']);
    expect(client.requests[0]!.params).toEqual({
      type: 'chatgptAuthTokens', accessToken: ACCESS, chatgptAccountId: 'ws-f1202', chatgptPlanType: null,
    });
    expect(client.requests[0]!.options).toEqual({ timeoutMs: 15_000 });
    expect(r.refreshes).toEqual([]);
    expect(r.agent.getRecentStderr()).toContain('[ChatGPT subscription] codex is signed in');

    // codex met a 401 with ACCESS and asks for a fresh token.
    const answer = await (r.agent as any).handleServerRequest(
      'account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: 'ws-f1202' });
    expect(answer).toEqual({ accessToken: RENEWED, chatgptAccountId: 'ws-f1202', chatgptPlanType: null });
    expect(r.refreshes).toEqual([REFRESH_1]);
    expect(r.store.current?.accessToken).toBe(RENEWED);
    expect(r.store.current?.refreshToken).toBe(REFRESH_2);
    expect(r.authRequired).toEqual([]);
    expectNoSecret(r);
  });

  it('the gateway card never logs in, and its refresh answer stays the structural {}', async () => {
    const r = rig(GATEWAY_SLUG, { accessToken: ACCESS, refreshToken: REFRESH_1, expiresAt: Date.now() + 3_600_000 });
    const client = fakeClient({});
    const declared = (r.agent as any).declaredCodexModelProvider();
    expect(declared).toBeUndefined();

    await (r.agent as any).signInCodexChatGptSubscription(client, declared);

    expect(client.requests).toEqual([]);
    expect(await (r.agent as any).handleServerRequest('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' }))
      .toEqual({});
    expect(r.refreshes).toEqual([]);
    expect(r.store.writes).toBe(0);
    expectNoSecret(r);
  });

  it('no sign-in stops the runtime with the reason on the auth card, and nothing is sent', async () => {
    const r = rig(SUBSCRIPTION_SLUG, null);
    const client = fakeClient({ 'account/login/start': { type: 'chatgptAuthTokens' } });

    await expect((r.agent as any).signInCodexChatGptSubscription(client, 'openai')).rejects.toThrow('not signed in');
    expect(client.requests).toEqual([]);
    expect(r.authRequired).toEqual([expect.stringContaining('not signed in to ChatGPT')]);
  });

  it('codex refusing the sign-in is quoted without the token', async () => {
    const r = rig(SUBSCRIPTION_SLUG, { accessToken: ACCESS, refreshToken: REFRESH_1, expiresAt: Date.now() + 3_600_000 });
    const client = {
      async request() { throw new Error(`failed to set external auth: invalid token ${ACCESS}`); },
    };
    let said = '';
    try {
      await (r.agent as any).signInCodexChatGptSubscription(client, 'openai');
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    expect(said).toContain('Codex refused this connection\'s ChatGPT sign-in: failed to set external auth');
    expectNoSecret(r, [said]);
  });

  it('a one-shot on the subscription card is refused by name, before any upstream is resolved', async () => {
    const r = rig(SUBSCRIPTION_SLUG, { accessToken: ACCESS, refreshToken: REFRESH_1, expiresAt: Date.now() + 3_600_000 });
    // Refuses rather than passes through: a regression here must fail loudly,
    // never reach a network or a real credential.
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('F1.202 rig: the network must not be reached');
    }) as unknown as typeof fetch);
    try {
      await expect(r.agent.queryLlm({ prompt: 'title this' } as never)).rejects.toThrow('not available on this connection');
      expect(await r.agent.runMiniCompletion('title this')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
