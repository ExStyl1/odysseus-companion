/**
 * D1.193 — a refreshed Claude OAuth token reaching a LIVE session.
 *
 * The token reaches the SDK child as `CLAUDE_CODE_OAUTH_TOKEN` in its
 * ENVIRONMENT, written once at `postInit`, and nothing pushed a refreshed one
 * afterwards: `SessionManager.reinitializeAuth` runs at `initialize()` and from
 * the connection-save RPC paths, never from an auth error. Pi has had the other
 * half for a long time (`PiAgent.refreshAndPushTokens` → `token_update` on a
 * 401), so the same expiry was invisible there and fatal here.
 *
 * ## What these arms drive, and what they deliberately do not
 *
 * The seam is `ClaudeAgent.refreshClaudeOAuthTokenForLiveSession`, driven
 * directly. Reaching it through a real turn means an SDK child and a real
 * expired credential, which is a sitting, not a suite — and the arms that matter
 * are the ones a rig could not give honestly anyway: an UNCHANGED token must
 * answer `false` (the guard against a retry loop on a genuinely dead
 * credential), a non-`oauth` connection must be left alone, and a throwing
 * refresher must fail CLOSED onto the pre-row behaviour.
 *
 * `getValidClaudeOAuthToken` is stubbed through `mock.module` with the SPREAD
 * and a restore from the SNAPSHOT, per this repo's measured rule — a restore
 * from the live namespace hands the mock back to every later file in the
 * process.
 *
 * NO REAL CREDENTIAL anywhere: every token here is a fabricated three-segment
 * string, and the assertions read the environment's own value back rather than
 * any length or prefix of a real one.
 */
import { afterAll, afterEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import type { LlmConnection } from '../../config/storage.ts';
import { bracedRegion } from '../../testing/source-regions.ts';

import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import * as authStateNs from '../../auth/state.ts';
import * as configStorage from '../../config/storage.ts';
import * as diagnosticsNs from '../diagnostics.ts';

/** SNAPSHOTS of each module's exports, never the live namespace (AGENTS.md §Traps, the `mock.module` bullet). */
const realAuthState = { ...authStateNs };
const realSdk = { ...claudeAgentSdk };
const realQuery = realSdk.query;
const realStorage = { ...configStorage };
const realDiagnostics = { ...diagnosticsNs };

/** Fabricated, and shaped only enough to be distinguishable from its sibling. */
const TOKEN_BEFORE = 'hdr.oldpayload.sig';
const TOKEN_AFTER = 'hdr.newpayload.sig';

let nextToken: string | null = TOKEN_AFTER;
let refresherThrows = false;
let refreshCalls = 0;
/** F1.964 — which connection each refresh was asked for, and a per-connection answer where one is set. */
const refreshedSlugs: string[] = [];
const tokensBySlug = new Map<string, string>();

mock.module('../../auth/state.ts', () => ({
  ...realAuthState,
  getValidClaudeOAuthToken: async (slug: string) => {
    refreshCalls += 1;
    refreshedSlugs.push(slug);
    if (refresherThrows) throw new Error('refresh endpoint unreachable');
    return { accessToken: tokensBySlug.get(slug) ?? nextToken };
  },
}));

// F1.964's rig: the connection store, the default connection, the diagnosis and
// the SDK `query` are the only stand-ins, each armed only while that describe
// runs — the last `mock.module` for a specifier is live for other files too.
let rigArmed = false;
let defaultSlug: string | null = null;
const connections = new Map<string, LlmConnection>();

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getDefaultLlmConnection: () => (rigArmed ? defaultSlug : realStorage.getDefaultLlmConnection()),
  getLlmConnection: (slug: string) => connections.get(slug) ?? realStorage.getLlmConnection(slug),
}));

/** F1.1112 — what each armed diagnosis was asked about (auth type, base URL, provider type). */
const diagnosisConfigs: Array<Parameters<typeof realDiagnostics.runErrorDiagnostics>[0]> = [];

/** The diagnosis the D1.193 arm is gated on: credential-shaped, as a dead subscription token reads. */
mock.module('../diagnostics.ts', () => ({
  ...realDiagnostics,
  runErrorDiagnostics: async (config: Parameters<typeof realDiagnostics.runErrorDiagnostics>[0]) => {
    if (!rigArmed) return realDiagnostics.runErrorDiagnostics(config);
    diagnosisConfigs.push(config);
    return { code: 'invalid_credentials', title: 'Invalid credentials', message: 'fabricated diagnosis', details: [] };
  },
}));

interface FakeChild {
  env: Record<string, unknown>;
  prompts: number;
}
const children: FakeChild[] = [];
/** How many of the next children die on their first prompt the way an expired credential kills one. */
let childrenToFail = 0;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    if (!rigArmed) return (realQuery as unknown as (arg: unknown) => unknown)(input);
    const child: FakeChild = { env: (input.options.env as Record<string, unknown> | undefined) ?? {}, prompts: 0 };
    children.push(child);
    const fails = childrenToFail > 0;
    if (fails) childrenToFail -= 1;
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        child.prompts += 1;
        // The shape `chatImpl`'s D1.193 arm is reached by: the SDK's own sentence for a child that died.
        if (fails) throw new Error('Claude Code process exited with code 1');
        yield {
          type: 'assistant', session_id: 'fake-f1964-session',
          message: {
            id: `msg-f1964-${Math.random()}`, role: 'assistant', model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        };
        yield {
          type: 'result', subtype: 'success', result: 'ok', is_error: false, num_turns: 1,
          total_cost_usd: 0, session_id: 'fake-f1964-session', stop_reason: null, modelUsage: {},
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & Record<string, unknown>;
    stream.interrupt = async () => ({ still_queued: [] });
    stream.setModel = async () => {};
    stream.setPermissionMode = async () => {};
    stream.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
    stream.supportedModels = async () => [];
    return stream;
  },
}));

afterAll(() => {
  mock.module('../../auth/state.ts', () => realAuthState);
  mock.module('../../config/storage.ts', () => realStorage);
  mock.module('../diagnostics.ts', () => realDiagnostics);
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');
const { createMockCapabilityTurnRuntime } = await import('./test-utils.ts');

const WORKSPACE_ROOT = '/tmp/nessy-d1193';
let counter = 0;

/** F1.958 — `envOverrides` seeded as `postInit` leaves them: the session's own copy is the only one. */
function agentConfig(envOverrides?: Record<string, string>): BackendConfig {
  counter += 1;
  return {
    ...(envOverrides ? { envOverrides } : {}),
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-d1193',
      name: 'D1.193',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-d1193-${counter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

type Refresher = (
  connection: { authType?: string } | null,
  slug: string | null | undefined,
) => Promise<boolean>;

function refresherOf(agent: unknown): Refresher {
  return (agent as { refreshClaudeOAuthTokenForLiveSession: Refresher })
    .refreshClaudeOAuthTokenForLiveSession.bind(agent);
}

afterEach(() => {
  // DELETE, never assign-to-undefined: the same Bun env-slot rule the production
  // path follows, so a later read cannot see a name this file left half-present.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  nextToken = TOKEN_AFTER;
  refresherThrows = false;
  refreshCalls = 0;
  refreshedSlugs.length = 0;
  tokensBySlug.clear();
});

describe('D1.193 · a renewed token reaches the next child', () => {
  it('writes the new token to the per-session overrides ONLY — never to the shared process env (F1.958)', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const agent = new ClaudeAgent(agentConfig({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEFORE }));

    const renewed = await refresherOf(agent)({ authType: 'oauth' }, 'claude-max');

    expect(renewed).toBe(true);
    // The per-session copy is the one this session's next spawn reads.
    const overrides = (agent as unknown as { config: BackendConfig }).config.envOverrides;
    expect(overrides?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_AFTER);
    // F1.958 — and NOT `process.env`: it is shared between sessions and every
    // claude child's signature hashes it, so a write there re-keys (and
    // respawns) every OTHER session's child. The spread is the instrument, not
    // `in` — the Bun env-slot rule.
    expect(Object.keys({ ...process.env })).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('NEGATIVE — an UNCHANGED token answers false, which is the anti-loop guard', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    nextToken = TOKEN_BEFORE;
    // F1.958 — "unchanged" is measured against the SESSION's copy: `process.env`
    // carries no token any more, and comparing against it would call every
    // refresh a change and disarm this guard.
    const agent = new ClaudeAgent(agentConfig({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEFORE }));

    expect(await refresherOf(agent)({ authType: 'oauth' }, 'claude-max')).toBe(false);
    expect(refreshCalls).toBe(1);
    // Nothing was written, so the caller falls through to the typed credential
    // error — the behaviour a user met before this row.
    expect((agent as unknown as { config: BackendConfig }).config.envOverrides?.CLAUDE_CODE_OAUTH_TOKEN)
      .toBe(TOKEN_BEFORE);
  });

  it('NEGATIVE — a null token, a non-oauth connection and a missing slug never ask', async () => {
    const agent = new ClaudeAgent(agentConfig());

    nextToken = null;
    expect(await refresherOf(agent)({ authType: 'oauth' }, 'claude-max')).toBe(false);
    expect(refreshCalls).toBe(1);

    // These three must not even reach the refresher: every other authType puts
    // an API key in that env, which this function has nothing to say about.
    refreshCalls = 0;
    expect(await refresherOf(agent)({ authType: 'api_key' }, 'byo')).toBe(false);
    expect(await refresherOf(agent)(null, 'claude-max')).toBe(false);
    expect(await refresherOf(agent)({ authType: 'oauth' }, undefined)).toBe(false);
    expect(refreshCalls).toBe(0);
  });

  it('BOUNDARY — a throwing refresher fails CLOSED and leaves the environment alone', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    refresherThrows = true;
    const agent = new ClaudeAgent(agentConfig({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEFORE }));

    expect(await refresherOf(agent)({ authType: 'oauth' }, 'claude-max')).toBe(false);
    expect((agent as unknown as { config: BackendConfig }).config.envOverrides?.CLAUDE_CODE_OAUTH_TOKEN)
      .toBe(TOKEN_BEFORE);
    expect(Object.keys({ ...process.env })).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('the retry arm is wired, and gated so it cannot loop', () => {
    // A SOURCE window, for the reason the sibling suites record: reaching the
    // real call site needs an SDK child dying on a real expired credential,
    // which is a sitting. What can be pinned cheaply is that the call exists,
    // that it is behind `!_isRetry`, and that the retry it issues passes
    // `isRetry: true` — without which one expiry becomes an infinite turn.
    const agent = require('node:fs').readFileSync(
      require('node:url').fileURLToPath(new URL('../claude-agent.ts', import.meta.url)),
      'utf8',
    ) as string;

    // F1.964 — the SESSION's own connection and slug, never the default's (the diagnosis read the default's until F1.1112).
    const at = agent.indexOf('await this.refreshClaudeOAuthTokenForLiveSession(this.config.connectionSlug ? getLlmConnection(this.config.connectionSlug) : null, this.config.connectionSlug)');
    expect(at).toBeGreaterThan(-1);
    const before = agent.slice(Math.max(0, at - 400), at);
    expect(before).toContain('!_isRetry');
    // D1.111 — the `if` block's own braces: the first `{` at or after this
    // anchor is the condition's block, which is the region the claim is about.
    const after = bracedRegion(agent, at);
    expect(after).toContain('{ isRetry: true }');
    // BOUNDARY CONTROL: the first line BELOW the block, so a runaway scan fails
    // here instead of passing for a match anywhere in a 12 000-line file.
    expect(after).not.toContain('[SESSION_DEBUG] diagnostics.code:');
  });
});

/**
 * F1.964 — the retry arm renews the SESSION's own connection, never the default's.
 *
 * Until then the D1.193 arm passed the connection `chatImpl`'s diagnosis block
 * reads — `getDefaultLlmConnection()` — so an OAuth session on a NON-default
 * connection was handed the DEFAULT connection's renewed token, and a session on
 * an API-key connection got the default's subscription token written into its
 * own child env. Driven through REAL `chatImpl` turns: the SDK `query` (a child
 * that dies with the SDK's own "process exited" sentence, then one that answers),
 * the diagnosis, the connection store and the refresher are the only doubles.
 * Every token is fabricated.
 */
describe('F1.964 · the retry arm renews the session\'s own connection', () => {
  const OAUTH_X = 'f1964-oauth-x';
  const OAUTH_DEFAULT = 'f1964-oauth-default';
  const API_KEY_K = 'f1964-api-key-k';
  /** Fabricated, one per connection, so a child's env names which connection it was renewed from. */
  const RENEWED_X = 'hdr.renewed-x.sig';
  const RENEWED_DEFAULT = 'hdr.renewed-default.sig';
  const KEY_K = 'sk-ant-f1964-FABRICATED-K-0000';

  // Real `chatImpl` turns over the shared module graph: the budget belongs to the file.
  setDefaultTimeout(120_000);

  const agents: Array<{ destroy(): void }> = [];
  const roots: string[] = [];

  function arm(): string {
    rigArmed = true;
    children.length = 0;
    childrenToFail = 1;
    connections.clear();
    connections.set(OAUTH_X, { slug: OAUTH_X, name: 'Subscription X', providerType: 'anthropic', authType: 'oauth', defaultModel: 'claude-sonnet-4-6', createdAt: 1 } as LlmConnection);
    connections.set(OAUTH_DEFAULT, { slug: OAUTH_DEFAULT, name: 'Subscription default', providerType: 'anthropic', authType: 'oauth', defaultModel: 'claude-sonnet-4-6', createdAt: 1 } as LlmConnection);
    connections.set(API_KEY_K, { slug: API_KEY_K, name: 'Key K', providerType: 'anthropic', authType: 'api_key', defaultModel: 'claude-sonnet-4-6', createdAt: 1 } as LlmConnection);
    defaultSlug = OAUTH_DEFAULT;
    tokensBySlug.set(OAUTH_X, RENEWED_X);
    tokensBySlug.set(OAUTH_DEFAULT, RENEWED_DEFAULT);
    const root = mkdtempSync(join(tmpdir(), 'nessy-f1964-'));
    mkdirSync(join(root, 'sessions'), { recursive: true });
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const agent of agents.splice(0)) agent.destroy();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    rigArmed = false;
    defaultSlug = null;
    connections.clear();
    children.length = 0;
    childrenToFail = 0;
    diagnosisConfigs.length = 0;
    tokensBySlug.clear();
  });

  /** A direct-Anthropic claude agent on `connectionSlug`, its overrides seeded as `postInit` leaves them (F1.958). */
  function sessionOn(root: string, connectionSlug: string, auth: Record<string, string>) {
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      connectionSlug,
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      envOverrides: { NESSY_SESSION_ID: `session-${connectionSlug}`, ...auth },
      workspace: {
        id: 'ws-f1964', name: 'F1.964', rootPath: root,
        workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      },
      session: {
        id: `session-${connectionSlug}`, createdAt: Date.now(), lastUsedAt: Date.now(),
        workingDirectory: root, sdkCwd: root,
      },
    } as unknown as BackendConfig);
    agent.setPermissionMode('default');
    agent.setThinkingLevel('low');
    // The retry re-enters through `BaseAgent.chat`, which refuses a turn without one.
    agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
      workspaceId: 'ws-f1964', sessionId: `session-${connectionSlug}`, provider: 'anthropic',
    }));
    agents.push(agent);
    return agent;
  }

  async function runTurn(agent: InstanceType<typeof ClaudeAgent>): Promise<AgentEvent[]> {
    const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
    const events: AgentEvent[] = [];
    for await (const event of chatImpl('turn one')) events.push(event);
    return events;
  }

  /** Which fabricated OAuth token a child carries, by NAME. */
  const tokenOf = (child: FakeChild | undefined): string => {
    const value = child?.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (value === RENEWED_X) return 'renewed-x';
    if (value === RENEWED_DEFAULT) return 'renewed-default';
    if (value === TOKEN_BEFORE) return 'before';
    return value === undefined || value === '' ? 'none' : 'other';
  };
  const renewedNotice = (events: AgentEvent[]): boolean =>
    events.some(event => event.type === 'info' && event.message === 'Your Claude sign-in was renewed. Retrying...');

  it('THE CLAIM — an OAuth session on a NON-default connection is renewed from ITS connection, and the retry child carries that token', async () => {
    const agent = sessionOn(arm(), OAUTH_X, { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEFORE });

    const events = await runTurn(agent);

    expect(refreshedSlugs).toEqual([OAUTH_X]);
    expect(children.map(tokenOf)).toEqual(['before', 'renewed-x']);
    expect(renewedNotice(events)).toBe(true);
  });

  it('NEGATIVE — a session on an API-key connection is never handed the default connection\'s subscription token', async () => {
    const agent = sessionOn(arm(), API_KEY_K, { ANTHROPIC_API_KEY: KEY_K, CLAUDE_CODE_OAUTH_TOKEN: '' });

    const events = await runTurn(agent);

    // Its own connection is not `oauth`, so the refresher is never asked and
    // nothing is retried: the user meets the typed credential error.
    expect(refreshedSlugs).toEqual([]);
    expect(children.map(tokenOf)).toEqual(['none']);
    expect(children.map(child => child.env.ANTHROPIC_API_KEY)).toEqual([KEY_K]);
    expect(renewedNotice(events)).toBe(false);
    expect(events.some(event => event.type === 'typed_error')).toBe(true);
  });

  /**
   * F1.1112 — the diagnosis and D1.194's expired-sign-in card read the SESSION's
   * connection too. Until then both read the DEFAULT's: an API-key session beside
   * an OAuth default was diagnosed as `oauth_token` against the default's base
   * URL, and its typed error was the subscription `expired_oauth_token` card
   * ("sign in again") instead of the key's honest "Update credentials".
   */
  it('F1.1112 — an API-key session beside an OAuth default is diagnosed as ITS connection, and gets the key card, not the sign-in card', async () => {
    const root = arm();
    connections.set(API_KEY_K, { ...connections.get(API_KEY_K)!, baseUrl: 'https://key-k.example.invalid' } as LlmConnection);
    connections.set(OAUTH_DEFAULT, { ...connections.get(OAUTH_DEFAULT)!, baseUrl: 'https://default.example.invalid' } as LlmConnection);
    const agent = sessionOn(root, API_KEY_K, { ANTHROPIC_API_KEY: KEY_K, CLAUDE_CODE_OAUTH_TOKEN: '' });

    const events = await runTurn(agent);

    expect(diagnosisConfigs.map(config => [config.authType, config.baseUrl])).toEqual([['api_key', 'https://key-k.example.invalid']]);
    const typed = events.find(event => event.type === 'typed_error') as { error?: { code?: string } } | undefined;
    expect(typed?.error?.code).toBe('invalid_credentials');
  });

  it('F1.1112 CONTROL — an OAuth session whose sign-in cannot be renewed still gets the expired-sign-in card from its own connection, beside an API-key default', async () => {
    const root = arm();
    defaultSlug = API_KEY_K;
    // Unchanged on refresh → nothing renewed → the typed error reaches the user.
    tokensBySlug.set(OAUTH_X, TOKEN_BEFORE);
    const agent = sessionOn(root, OAUTH_X, { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEFORE });

    const events = await runTurn(agent);

    expect(diagnosisConfigs.map(config => config.authType)).toEqual(['oauth_token']);
    const typed = events.find(event => event.type === 'typed_error') as { error?: { code?: string } } | undefined;
    expect(typed?.error?.code).toBe('expired_oauth_token');
  });

  it('CONTROL — a session ON the default connection is renewed from it, unchanged', async () => {
    const agent = sessionOn(arm(), OAUTH_DEFAULT, { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: TOKEN_BEFORE });

    const events = await runTurn(agent);

    expect(refreshedSlugs).toEqual([OAUTH_DEFAULT]);
    expect(children.map(tokenOf)).toEqual(['before', 'renewed-default']);
    expect(renewedNotice(events)).toBe(true);
  });
});
