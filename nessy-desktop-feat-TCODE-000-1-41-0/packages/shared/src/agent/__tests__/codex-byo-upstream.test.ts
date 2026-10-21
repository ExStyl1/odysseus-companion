/**
 * C1 — a `codex-runtime` session honors its connection's endpoint.
 *
 * Before this task the codex runtime was hardwired to the Nessy Gateway in two
 * independent places (the adapter it starts, and `queryLlm`'s direct fetch), so
 * a BYO connection was accepted at setup and dead at runtime. Both paths now
 * take the same `UpstreamTarget`, and the governance rule is what this suite
 * pins: `Nestor-Token` reaches exactly one URL, everything else gets
 * `Authorization: Bearer` and never touches dp creds.
 *
 * Hermetic: the credential store, the adapter launcher, the app-server
 * subprocess and the dp-creds reader are all faked, and `fetch` is stubbed.
 * Nothing here opens a socket, spawns a process, or reads
 * `~/.nessy/dp_auth_creds.json`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeRuntimeWireRouter } from '../backend/internal/drivers/anthropic.ts';
import * as credentialsIndex from '../../credentials/index.ts';
import * as storageModule from '../../config/storage.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import { NESTOR_CHAT_URL } from '@nessy-agent/codex-responses-adapter/nestor-client';
import type { AdapterHandle, UpstreamTarget } from '@nessy-agent/codex-responses-adapter';
import type { LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts';

// ============================================================
// Fakes (mutated per test; installed once at module load)
// ============================================================

let storedApiKey: string | null = null;
let apiKeyReads = 0;
let storedJwt: string | null = 'jwt-gateway';
/**
 * DA1.38 — WHY the stub refuses, when `storedJwt` is null.
 *
 * `readNestorCreds` has TWO refusals (`no_credentials` / `credentials_expired`)
 * and DA1.12 exists because they mean opposite things to the user: one sends
 * them to a first sign-in, the other to a RE-MINT of a credential they already
 * have (Target scheme clause 1). The stub derived both from `storedJwt` alone,
 * so it could only ever produce `no_credentials` and `queryLlm`'s expired branch
 * had no arm in this file at all — the single case below asserted `/credentials/i`,
 * which matches BOTH sentences and therefore discriminates neither.
 */
let storedCredsReason: 'no_credentials' | 'credentials_expired' = 'no_credentials';
/** When false, `getCredentialManager()` throws the way an uninitialized store does. */
let credentialStoreInitialized = true;

interface StartCall { upstream?: UpstreamTarget }
const adapterStarts: StartCall[] = [];
let adapterCloseCount = 0;

interface FetchCall { url: string; headers: Record<string, string>; body: Record<string, unknown> }
const fetchCalls: FetchCall[] = [];

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4242 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-c1' } } : {};
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

// `mock.module` is process-global and bun runs every file in one process, so
// each seam spreads the real module and `afterAll` puts the untouched modules
// back (same discipline as claude-gateway-adapter.test.ts).
const realCredentials = { ...credentialsIndex };
const realStorage = { ...storageModule };
const realGetLlmConnection = storageModule.getLlmConnection;

/**
 * P6.532 — the stored connection `CodexAgent.declaredCodexModelProvider` reads.
 *
 * `null` (the default) is "this slug resolves to nothing", which is what every
 * pre-existing case in this file wants: no declaration, so the loopback pin and
 * the adapter stay exactly as they were.
 */
let storedConnection: LlmConnection | null = null;
const realAdapter = { ...adapterPackage };
const realNestorAuth = { ...nestorAuth };
const realCodexAgentServer = { ...codexAgentServer };

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => {
    // The real one throws on an uninitialized store (credentials/manager.ts:794);
    // reproduced here so a gateway session's independence from it is testable.
    if (!credentialStoreInitialized) {
      throw new Error('Credential manager requires verified storage layout v2 initialization');
    }
    return { getLlmApiKey: async () => { apiKeyReads += 1; return storedApiKey; } };
  },
}));

mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (options: StartCall): Promise<AdapterHandle> => {
    adapterStarts.push(options);
    return { port: 45871, close: async () => { adapterCloseCount += 1; } };
  },
}));

/**
 * BOTH readers, from ONE variable, and that is the whole point.
 *
 * DA1.12 moved `CodexAgent.queryLlm` onto `readNestorCreds` (it needs the REASON
 * so an expired token is not reported as a missing one). Stubbing only
 * `readNestorJwt` no longer isolates: the spread hands the real
 * `readNestorCreds` straight through, and this suite then read the developer's
 * actual `~/.nessy/dp_auth_creds.json` and asserted against a live credential.
 * Measured 2026-09-13 — the case below caught it as a RED rather than passing
 * silently, which is the only reason it is a footnote and not an incident.
 *
 * So the two are derived from the same `storedJwt` and cannot drift: a future
 * change that moves this path back to `readNestorJwt`, or onto
 * `readNestorCreds`, stays isolated either way. Anything added to that module
 * which READS THE FILE must be stubbed here too.
 */
mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => ({
  ...realNestorAuth,
  readNestorJwt: () => storedJwt,
  readNestorCreds: () => (storedJwt
    ? { ok: true, jwt: storedJwt }
    : { ok: false, reason: storedCredsReason }),
}));

mock.module('@nessy-agent/codex-agent-server', () => ({
  ...realCodexAgentServer,
  CodexRuntimeManager: FakeRuntimeManager,
  AppServerClient: FakeAppServerClient,
}));

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getLlmConnection: (slug: string) =>
    (storedConnection && storedConnection.slug === slug ? storedConnection : null),
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => ({
    ...realStorage,
    getLlmConnection: realGetLlmConnection,
  }));
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth);
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer);
});

const { CodexAgent } = await import('../codex-agent.ts');
const { codexDriver, buildCodexRuntimeUpstream } = await import('../backend/internal/drivers/codex.ts');

// ============================================================
// Fixtures
// ============================================================

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
/** The verified gateway endpoint the one-click codex card seeds. */
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
/** Same host, different path — AGENTS.md: this must NOT get Nestor semantics. */
const SAME_HOST_OTHER_PATH = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1';
const BYO_BASE_URL = 'https://byo.example.test/v1';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'nessy-codex',
    name: 'Nessy Codex',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: MODEL,
    createdAt: Date.now(),
    ...overrides,
  } as LlmConnection;
}

/** Populate `config.runtime` exactly the way the connection-resolution path does. */
function runtimeFor(conn: LlmConnection | null): BackendRuntimePayload {
  return codexDriver.buildRuntime({
    context: {
      connection: conn,
      provider: 'codex-runtime',
      resolvedModel: MODEL,
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
  });
}

function agentConfig(conn: LlmConnection | null): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: conn?.slug,
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-codex-byo',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-codex-byo',
      workspaceRootPath: '/tmp/ws-codex-byo',
      sessionRootPath: '/tmp/ws-codex-byo/sessions',
    } as never,
    session: {
      id: 'session-codex-byo',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-codex-byo',
    } as never,
    runtime: runtimeFor(conn),
  } as BackendConfig;
}

type PrivateAgent = { ensureRuntime: () => Promise<void> };

const realFetch = globalThis.fetch;

beforeEach(() => {
  storedConnection = null;
  storedApiKey = null;
  apiKeyReads = 0;
  storedJwt = 'jwt-gateway';
  storedCredsReason = 'no_credentials';
  credentialStoreInitialized = true;
  adapterStarts.length = 0;
  adapterCloseCount = 0;
  fetchCalls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'pong' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ============================================================
// (a)/(b)/(c) — which upstream the session's adapter is started with
// ============================================================

describe('CodexAgent runtime — upstream selection', () => {
  it('(a) starts the adapter in gateway mode for the verified gateway endpoint', async () => {
    const agent = new CodexAgent(agentConfig(connection()));
    try {
      await (agent as unknown as PrivateAgent).ensureRuntime();
      // `toMatchObject`, not `toEqual`: the adapter also receives an
      // `onUpstreamAuth` sink now, and these cases pin the UPSTREAM choice.
      expect(adapterStarts).toHaveLength(1);
      expect(adapterStarts[0]).toMatchObject({ upstream: { kind: 'nestor' } });
      // Gateway mode resolves dp creds inside the adapter; the connection
      // credential store must not be consulted at all.
      expect(apiKeyReads).toBe(0);
    } finally {
      agent.destroy();
    }
  });

  it('(b) starts the adapter against a BYO endpoint with the stored key', async () => {
    storedApiKey = 'sk-byo-secret';
    const agent = new CodexAgent(agentConfig(connection({ baseUrl: BYO_BASE_URL })));
    try {
      await (agent as unknown as PrivateAgent).ensureRuntime();
      expect(adapterStarts).toHaveLength(1);
      expect(adapterStarts[0]).toMatchObject({
        upstream: { kind: 'openai-compatible', baseUrl: BYO_BASE_URL, apiKey: 'sk-byo-secret' },
      });
      expect(apiKeyReads).toBe(1);
    } finally {
      agent.destroy();
    }
  });

  it('(c) falls back to the gateway when the session carries no connection', async () => {
    // Byte-identical to pre-C1 behavior: every codex session used to be nestor.
    const agent = new CodexAgent(agentConfig(null));
    try {
      await (agent as unknown as PrivateAgent).ensureRuntime();
      expect(adapterStarts).toHaveLength(1);
      expect(adapterStarts[0]).toMatchObject({ upstream: { kind: 'nestor' } });
      expect(apiKeyReads).toBe(0);
    } finally {
      agent.destroy();
    }
  });

  it('treats the gateway host with a different path as BYO, not as Nestor', async () => {
    storedApiKey = 'sk-not-a-gateway-token';
    const agent = new CodexAgent(agentConfig(connection({ baseUrl: SAME_HOST_OTHER_PATH })));
    try {
      await (agent as unknown as PrivateAgent).ensureRuntime();
      expect(adapterStarts[0]?.upstream).toEqual({
        kind: 'openai-compatible',
        baseUrl: SAME_HOST_OTHER_PATH,
        apiKey: 'sk-not-a-gateway-token',
      });
    } finally {
      agent.destroy();
    }
  });

  it('runs a gateway session with NO credential manager at all — the thunk is load-bearing', async () => {
    // `attachUpstreamCredential` takes a thunk, not an instance, precisely so
    // `getCredentialManager()` is never CALLED in gateway mode — it throws when
    // the store is uninitialized (headless / pre-unlock), which every codex
    // gateway session survived before C1 and must keep surviving.
    // `apiKeyReads === 0` elsewhere only proves the method went unused; this
    // proves the manager is never even constructed, so "simplifying" the thunk
    // into an eager parameter fails here rather than in production.
    credentialStoreInitialized = false;
    const agent = new CodexAgent(agentConfig(connection()));
    try {
      await (agent as unknown as PrivateAgent).ensureRuntime();
      expect(adapterStarts).toHaveLength(1);
      expect(adapterStarts[0]).toMatchObject({ upstream: { kind: 'nestor' } });

      // The one-shot path resolves through the same method, so it must be free
      // of the credential store too.
      await agent.queryLlm({ prompt: 'ping' });
      expect(fetchCalls[0]?.url).toBe(NESTOR_CHAT_URL);
    } finally {
      agent.destroy();
    }
  });

  it('POSITIVE CONTROL: the same uninitialized store does stop a BYO session', async () => {
    // Without this row the one above could pass because the fake never throws.
    credentialStoreInitialized = false;
    const agent = new CodexAgent(agentConfig(connection({ baseUrl: BYO_BASE_URL })));
    try {
      await expect((agent as unknown as PrivateAgent).ensureRuntime())
        .rejects.toThrow(/storage layout v2/);
      // Fails closed: no adapter was started, so nothing silently fell back to
      // the gateway with the user's dp token.
      expect(adapterStarts).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('omits the Authorization credential for a keyless BYO endpoint', async () => {
    storedApiKey = null;
    const agent = new CodexAgent(agentConfig(connection({
      baseUrl: 'http://localhost:11434/v1',
      authType: 'none',
    })));
    try {
      await (agent as unknown as PrivateAgent).ensureRuntime();
      expect(adapterStarts[0]?.upstream).toEqual({
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
      });
    } finally {
      agent.destroy();
    }
  });
});

// ============================================================
// queryLlm — the second, independently hardwired path
// ============================================================

describe('CodexAgent.queryLlm — upstream + auth', () => {
  it('posts to the gateway with Nestor-Token for a gateway connection', async () => {
    const agent = new CodexAgent(agentConfig(connection()));
    try {
      const result = await agent.queryLlm({ prompt: 'ping', systemPrompt: 'be terse' });

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe(NESTOR_CHAT_URL);
      expect(fetchCalls[0]?.headers['Nestor-Token']).toBe('jwt-gateway');
      expect(fetchCalls[0]?.headers.Authorization).toBeUndefined();
      expect(fetchCalls[0]?.body).toMatchObject({
        model: MODEL,
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'ping' },
        ],
        stream: false,
      });
      expect(result).toMatchObject({ text: 'pong', model: MODEL, inputTokens: 11, outputTokens: 3 });
      expect(apiKeyReads).toBe(0);
    } finally {
      agent.destroy();
    }
  });

  it('posts to the BYO endpoint with Bearer auth and NEVER Nestor-Token', async () => {
    storedApiKey = 'sk-byo-secret';
    const agent = new CodexAgent(agentConfig(connection({ baseUrl: BYO_BASE_URL })));
    try {
      await agent.queryLlm({ prompt: 'ping', model: 'deepseek/v3' });

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe(`${BYO_BASE_URL}/chat/completions`);
      expect(fetchCalls[0]?.headers.Authorization).toBe('Bearer sk-byo-secret');
      expect(fetchCalls[0]?.headers['Nestor-Token']).toBeUndefined();
      expect(fetchCalls[0]?.body).toMatchObject({ model: 'deepseek/v3' });
    } finally {
      agent.destroy();
    }
  });

  it('fails with a credentials error instead of a tokenless gateway call', async () => {
    storedJwt = null;
    const agent = new CodexAgent(agentConfig(connection()));
    try {
      // Narrowed by DA1.38: `/credentials/i` matched the expired sentence too,
      // so this row could not tell the two refusals apart. It now names the
      // absent-credential one and REFUSES the other, which is what makes the
      // case below a control rather than a second copy of this one.
      await expect(agent.queryLlm({ prompt: 'ping' })).rejects.toThrow(/credentials not found/);
      await expect(agent.queryLlm({ prompt: 'ping' })).rejects.not.toThrow(/token is expired/);
      expect(fetchCalls).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('DA1.38 — an EXPIRED credential sends the user to the re-mint, not to a first sign-in', async () => {
    // The arm that had no test. Same absent `jwt`, different REASON: the user
    // already signed in, so telling them their credentials are "not found"
    // points at the wrong remedy, and the expired sentence carries the
    // `token is expired` substring the shared auth-retry heuristic matches.
    storedJwt = null;
    storedCredsReason = 'credentials_expired';
    const agent = new CodexAgent(agentConfig(connection()));
    try {
      await expect(agent.queryLlm({ prompt: 'ping' })).rejects.toThrow(/token is expired/);
      await expect(agent.queryLlm({ prompt: 'ping' })).rejects.not.toThrow(/credentials not found/);
      expect(fetchCalls).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('never reads dp creds for a BYO endpoint — POSITIVE CONTROL for the row above', async () => {
    // The gateway row proves a missing JWT blocks the call; this proves the same
    // missing JWT is irrelevant to a BYO turn, i.e. the file is not read at all.
    storedJwt = null;
    storedApiKey = 'sk-byo-secret';
    const agent = new CodexAgent(agentConfig(connection({ baseUrl: BYO_BASE_URL })));
    try {
      await agent.queryLlm({ prompt: 'ping' });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.headers.Authorization).toBe('Bearer sk-byo-secret');
    } finally {
      agent.destroy();
    }
  });
});

// ============================================================
// Driver: the derivation itself
// ============================================================

// ============================================================
// P6.532 — a connection that DECLARES codex's own `model_provider`
// ============================================================

/** The `config.toml` this session actually wrote, read before teardown removes the home. */
function writtenConfig(agent: unknown): string {
  const home = (agent as { codexHome: string | null }).codexHome;
  if (!home) throw new Error('the session wrote no CODEX_HOME');
  return readFileSync(join(home, 'config.toml'), 'utf8');
}

/**
 * Set a name for the duration of `run`, then put the environment back.
 *
 * `delete` before the assignment on BOTH legs: assigning to `process.env.X` in
 * Bun 1.3.14 can leave the name readable by property and invisible to
 * `Object.keys`/`{...process.env}` (AGENTS.md §Traps), and every codex child is
 * built by spreading `process.env`.
 */
async function withEnv(
  values: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const before = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    delete process.env[name];
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      delete process.env[name];
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/**
 * P6.532 — the PRODUCER half. The host resolver landed at `8bdf9d061` and the
 * writer projection at `3a1ee181a`; until this suite nothing joined them, so a
 * connection could declare Bedrock and every session still wrote the loopback
 * pin.
 *
 * The negative arm is the row's whole safety property: Q-den 72 refused option
 * (c) — honouring codex's own ambient AWS chain — because an `AWS_*` in someone's
 * shell would then reroute a session pinned to the gateway, on the one runtime
 * whose child already inherits the variable.
 */
describe('CodexAgent runtime — declared model provider (P6.532)', () => {
  const BEDROCK_CONNECTION = connection({ codexModelProvider: 'amazon-bedrock' });
  /** Obviously fake: this file must never carry a value that could be a real credential. */
  const AMBIENT_AWS = {
    AWS_BEARER_TOKEN_BEDROCK: 'not-a-real-bedrock-token',
    AWS_ACCESS_KEY_ID: 'AKIANOTAREALKEYID000',
    AWS_PROFILE: 'not-a-real-profile',
  };

  it('routes a declared session to codex\'s own provider and starts NO loopback adapter', async () => {
    storedConnection = BEDROCK_CONNECTION;
    const agent = new CodexAgent(agentConfig(BEDROCK_CONNECTION));
    try {
      await (agent as unknown as PrivateAgent).ensureRuntime();
      const toml = writtenConfig(agent);
      expect(toml).toContain('model_provider = "amazon-bedrock"');
      // No adapter, so no port bound and no credential held for a route the
      // written config does not even name.
      expect(adapterStarts).toHaveLength(0);
      expect(apiKeyReads).toBe(0);
      expect(toml).not.toContain('[model_providers.nessy_gateway]');
    } finally {
      agent.destroy();
    }
  });

  it('does NOT reroute a pinned session on a machine exporting a full ambient AWS identity', async () => {
    // The connection declares nothing — only the shell does.
    storedConnection = connection();
    await withEnv(AMBIENT_AWS, async () => {
      const agent = new CodexAgent(agentConfig(connection()));
      try {
        await (agent as unknown as PrivateAgent).ensureRuntime();
        const toml = writtenConfig(agent);
        expect(toml).toContain('model_provider = "nessy_gateway"');
        expect(toml).toContain('[model_providers.nessy_gateway]');
        expect(adapterStarts).toHaveLength(1);
      } finally {
        agent.destroy();
      }
    });
  });

  it('restores the loopback pin when the operator switches the card off', async () => {
    storedConnection = BEDROCK_CONNECTION;
    await withEnv({ NESSY_CODEX_BEDROCK_CARD: '0' }, async () => {
      const agent = new CodexAgent(agentConfig(BEDROCK_CONNECTION));
      try {
        await (agent as unknown as PrivateAgent).ensureRuntime();
        const toml = writtenConfig(agent);
        expect(toml).toContain('model_provider = "nessy_gateway"');
        expect(adapterStarts).toHaveLength(1);
      } finally {
        agent.destroy();
      }
    });
  });
});

describe('codexDriver — upstream construction', () => {
  it('maps the verified gateway base URL to the nestor upstream', () => {
    expect(buildCodexRuntimeUpstream(connection())).toEqual({ kind: 'nestor' });
    expect(buildCodexRuntimeUpstream(connection({ baseUrl: `${GATEWAY_BASE_URL}/` })))
      .toEqual({ kind: 'nestor' });
  });

  it('maps every other endpoint to an openai-compatible upstream', () => {
    expect(buildCodexRuntimeUpstream(connection({ baseUrl: SAME_HOST_OTHER_PATH })))
      .toEqual({ kind: 'openai-compatible', baseUrl: SAME_HOST_OTHER_PATH });
  });

  it('defaults to the gateway when no endpoint is configured', () => {
    expect(buildCodexRuntimeUpstream(null)).toEqual({ kind: 'nestor' });
    expect(buildCodexRuntimeUpstream(connection({ baseUrl: '   ' }))).toEqual({ kind: 'nestor' });
  });

  it('publishes the derived upstream on the backend runtime payload', () => {
    expect(runtimeFor(connection({ baseUrl: BYO_BASE_URL })).upstream)
      .toEqual({ kind: 'openai-compatible', baseUrl: BYO_BASE_URL });
  });
});

/**
 * G3 — the per-request wire router.
 */
describe('buildClaudeRuntimeWireRouter', () => {
  const upstream = { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.t-tech.team', apiKey: 'sk-x' } as const

  it('routes a wired model to passthrough on the SAME base and key', () => {
    const route = buildClaudeRuntimeWireRouter(
      { models: ['tgpt/qwen', { id: 'anthropic/claude-opus-5', name: 'x', shortName: 'x', wire: 'anthropic-messages' } as never] },
      upstream,
    )
    expect(route?.('anthropic/claude-opus-5')).toEqual({
      kind: 'anthropic-messages',
      baseUrl: 'https://llm-proxy.t-tech.team',
      apiKey: 'sk-x',
    })
    // A mixed connection: the Qwen keeps the session upstream.
    expect(route?.('tgpt/qwen')).toBeUndefined()
  })

  it('is absent when nothing is wired, so no existing session changes shape', () => {
    expect(buildClaudeRuntimeWireRouter({ models: ['a', 'b'] }, upstream)).toBeUndefined()
    expect(buildClaudeRuntimeWireRouter({ models: undefined }, upstream)).toBeUndefined()
  })

  it('routes NOTHING in gateway mode', () => {
    // The corp gateway publishes no /v1/messages and authenticates by
    // Nestor-Token, not a bearer; a passthrough target there would post to a
    // URL that does not exist, with the wrong auth.
    expect(buildClaudeRuntimeWireRouter(
      { models: [{ id: 'anthropic/x', name: 'x', shortName: 'x', wire: 'anthropic-messages' } as never] },
      { kind: 'nestor' },
    )).toBeUndefined()
  })
})
