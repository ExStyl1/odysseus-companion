/**
 * P2.422 — the correlation header reaches a wire.
 *
 * `telemetry/gateway-headers.ts` builds `x-nessy-session-id` and has its own
 * unit suite; what it did NOT have was a caller. `gatewaySessionFetch` is the
 * exact `typeof fetch` shape the loopback adapter accepts as `fetchImpl`, and
 * until this row neither `claude-agent.ts` nor `codex-agent.ts` passed one, so
 * every gateway turn on both runtimes went out uncorrelated.
 *
 * This suite pins the WIRING rather than the builder: it captures the
 * `fetchImpl` the agent actually hands `startAdapter`, calls it, and reads the
 * headers that arrive at the stubbed transport. Three properties, and the
 * second and third are the ones that make the first safe:
 *
 * 1. a gateway request carries the SESSION'S OWN id;
 * 2. the loopback hop, a BYO endpoint and the gateway's own host on a different
 *    path all stay bare (`AGENTS.md`: Nestor-specific request rewriting stays
 *    scoped to the verified gateway URL prefix);
 * 3. a session with no id sends NO header — never a synthesized `temp-…`, which
 *    would make the gateway aggregate turns under a key matching nothing.
 *
 * Hermetic: the adapter launcher, the credential store, the app-server
 * subprocess and the dp-creds reader are faked, and `fetch` is stubbed. Nothing
 * opens a socket, spawns a process, or reads a credentials file.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as configStorage from '../../config/storage.ts';
import * as credentialsIndex from '../../credentials/index.ts';
import * as llmValidation from '../../config/llm-validation.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import type { AdapterHandle, UpstreamTarget } from '@nessy-agent/codex-responses-adapter';
import type { LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts';
import { NESSY_SESSION_ID_HEADER } from '../../telemetry/gateway-headers.ts';
import { gatewayModelFixture } from '../../config/__tests__/fixtures/gateway-connection-fixture.ts';

// ============================================================
// Fakes
// ============================================================

interface StartCall { upstream?: UpstreamTarget; fetchImpl?: typeof fetch }
const adapterStarts: StartCall[] = [];

let storedConnection: LlmConnection | null = null;
let storedApiKey: string | null = null;

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4242 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-p2422' } } : {};
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

// `mock.module` is process-global and bun runs every file in one process, so
// each seam SPREADS the real module and `afterAll` puts the untouched modules
// back. Without both halves this file amputates these modules for every later
// test file in the run.
const realStorage = { ...configStorage };
const realCredentials = { ...credentialsIndex };
const realValidation = { ...llmValidation };
const realAdapter = { ...adapterPackage };
const realNestorAuth = { ...nestorAuth };
const realCodexAgentServer = { ...codexAgentServer };

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getLlmConnection: (slug: string) => (
    storedConnection && slug === storedConnection.slug
      ? storedConnection
      : realStorage.getLlmConnection(slug)
  ),
}));

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => storedApiKey }),
}));

mock.module('../../config/llm-validation.ts', () => ({
  ...realValidation,
  validateAnthropicConnection: async () => ({ success: true }),
}));

mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (options: StartCall): Promise<AdapterHandle> => {
    adapterStarts.push(options);
    return { port: 45971, close: async () => { /* nothing bound */ } };
  },
}));

/**
 * DA1.29 — this stub covers BOTH readers of the creds file, not just the one
 * a past call graph used. `codex-agent.ts` imports `readNestorCreds` and no
 * longer imports `readNestorJwt` at all (DA1.12), and a spread isolates only
 * the names it lists: the un-stubbed sibling reads the developer's real
 * `~/.nessy/dp_auth_creds.json` (measured by WA-b, now AGENTS.md §Traps).
 * Both are derived from ONE literal so they cannot drift, and neither is
 * reachable on this suite's paths today — which is exactly why it must not
 * depend on that staying true.
 */
mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => ({
  ...realNestorAuth,
  readNestorJwt: () => 'jwt-not-a-real-token',
  readNestorCreds: () => ({ ok: true, jwt: 'jwt-not-a-real-token' }),
}));

mock.module('@nessy-agent/codex-agent-server', () => ({
  ...realCodexAgentServer,
  CodexRuntimeManager: FakeRuntimeManager,
  AppServerClient: FakeAppServerClient,
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('../../config/llm-validation.ts', () => realValidation);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth);
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer);
});

const { ClaudeAgent } = await import('../claude-agent.ts');
const { CodexAgent } = await import('../codex-agent.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

// ============================================================
// Fixtures
// ============================================================

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
/** The verified gateway prefix — the ONLY audience for a correlation header. */
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
const GATEWAY_MESSAGES_URL = `${GATEWAY_BASE_URL}/messages`;
/** Same host, different path. AGENTS.md: normal provider semantics, no rewrite. */
const SAME_HOST_OTHER_PATH = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli-other/v1/messages';
const BYO_URL = 'https://byo.example.test/v1/messages';
/** What the SDK/app-server child itself talks to. Not a verifiable audience. */
const LOOPBACK_URL = 'http://127.0.0.1:45971/v1/messages';

const CLAUDE_SESSION_ID = 'session-claude-p2422';
const CODEX_SESSION_ID = 'session-codex-p2422';

/**
 * P6.784 — the row comes from the card's own builder, which is what puts
 * `supportsThinking: false` into it. Written by hand the field was absent, and
 * `ModelDefinition` documents it *"Defaults to true when undefined"* while both
 * shipped gateway rows declare `false` — so this fixture stood for a card that
 * reasons, which the shipped one does not.
 */
const GATEWAY_MODELS = [
  { ...gatewayModelFixture({ id: MODEL, contextWindow: 262_144 }), name: 'Qwen 3.5 397B', shortName: 'Qwen Coder' },
] as unknown as LlmConnection['models'];

function claudeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'nessy-claude',
    name: 'Nessy Claude',
    providerType: 'claude-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: MODEL,
    models: GATEWAY_MODELS,
    createdAt: Date.now(),
    ...overrides,
  } as LlmConnection;
}

function claudeConfig(sessionId: string | null): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'claude-runtime',
    connectionSlug: 'nessy-claude',
    model: MODEL,
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-p2422',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-p2422',
      workspaceRootPath: '/tmp/ws-p2422',
      sessionRootPath: '/tmp/ws-p2422/sessions',
    } as never,
    ...(sessionId
      ? {
        session: {
          id: sessionId,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: '/tmp/ws-p2422',
        } as never,
      }
      : {}),
  } as BackendConfig;
}

function codexConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
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

function codexRuntimeFor(conn: LlmConnection | null): BackendRuntimePayload {
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

function codexConfig(conn: LlmConnection, sessionId: string | null): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: conn.slug,
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-p2422-codex',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-p2422-codex',
      workspaceRootPath: '/tmp/ws-p2422-codex',
      sessionRootPath: '/tmp/ws-p2422-codex/sessions',
    } as never,
    ...(sessionId
      ? {
        session: {
          id: sessionId,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: '/tmp/ws-p2422-codex',
        } as never,
      }
      : {}),
    runtime: codexRuntimeFor(conn),
  } as BackendConfig;
}

type PrivateCodexAgent = { ensureRuntime: () => Promise<void> };

// ============================================================
// Transport stub — `gatewaySessionFetch`'s default inner is the GLOBAL fetch,
// resolved when the agent constructs the wrapper, so the stub must be in place
// before the agent runs.
// ============================================================

const realFetch = globalThis.fetch;
const seen: { url: string; headers: Record<string, string> }[] = [];

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'NESSY_SESSION_ID', 'NESSY_CUSTOM_HEADERS'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  adapterStarts.length = 0;
  seen.length = 0;
  storedConnection = null;
  storedApiKey = null;
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  // A process-wide session id is exactly what this seam CANNOT rely on (one
  // host process, many sessions). Cleared so a pass can only come from the
  // argument.
  delete process.env.NESSY_SESSION_ID;
  delete process.env.NESSY_CUSTOM_HEADERS;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    seen.push({ url: String(input), headers: Object.fromEntries(headers.entries()) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Drive the captured `fetchImpl` over the four audiences and read one header. */
async function headerAcrossAudiences(
  fetchImpl: typeof fetch | undefined,
  header: string,
): Promise<Record<string, string | undefined>> {
  expect(typeof fetchImpl).toBe('function');
  const impl = fetchImpl as typeof fetch;
  const out: Record<string, string | undefined> = {};
  for (const [label, url] of [
    ['gateway', GATEWAY_MESSAGES_URL],
    ['sameHostOtherPath', SAME_HOST_OTHER_PATH],
    ['byo', BYO_URL],
    ['loopback', LOOPBACK_URL],
  ] as const) {
    seen.length = 0;
    await impl(url, { method: 'POST', body: '{}' });
    expect(seen).toHaveLength(1);
    out[label] = seen[0]?.headers[header];
  }
  return out;
}

/** Drive the captured `fetchImpl` over the four audiences and read the header. */
async function correlationFor(fetchImpl: typeof fetch | undefined): Promise<Record<string, string | undefined>> {
  expect(typeof fetchImpl).toBe('function');
  const impl = fetchImpl as typeof fetch;
  const out: Record<string, string | undefined> = {};
  for (const [label, url] of [
    ['gateway', GATEWAY_MESSAGES_URL],
    ['sameHostOtherPath', SAME_HOST_OTHER_PATH],
    ['byo', BYO_URL],
    ['loopback', LOOPBACK_URL],
  ] as const) {
    seen.length = 0;
    await impl(url, { method: 'POST', body: '{}' });
    expect(seen).toHaveLength(1);
    out[label] = seen[0]?.headers[NESSY_SESSION_ID_HEADER];
  }
  return out;
}

// ============================================================
// claude-runtime
// ============================================================

describe('P2.422 — claude-runtime hands the adapter a session-correlating fetch', () => {
  it('stamps the session id on the gateway and on nothing else', async () => {
    storedConnection = claudeConnection();
    const agent = new ClaudeAgent(claudeConfig(CLAUDE_SESSION_ID));
    try {
      await agent.postInit();

      expect(adapterStarts).toHaveLength(1);
      const headers = await correlationFor(adapterStarts[0]?.fetchImpl);

      expect(headers.gateway).toBe(CLAUDE_SESSION_ID);
      // The scope, and the reason it matters: the SDK child's own hop and a BYO
      // upstream must stay bare. P6.43's second mutant is what this pins.
      expect(headers.sameHostOtherPath).toBeUndefined();
      expect(headers.byo).toBeUndefined();
      expect(headers.loopback).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('carries the OPERATOR\'s own headers on the same seam, and only to the gateway', async () => {
    // P6.43's second half, which had a builder and a caller and no proof that
    // the two met. `gatewayRequestHeaders` merges `customHeaders(env)` with the
    // correlation id and `gatewaySessionFetch` stamps the merged set, so an
    // operator line reaches a claude request through the SAME hop — the one
    // place a claude session can carry it, since the SDK child talks to a
    // loopback port and never to the gateway prefix.
    //
    // `delete` before assign, and the restore path deletes too: in Bun 1.3.14 a
    // plain assignment to a name the runtime pre-creates a slot for stays
    // invisible to `{...process.env}`, and this value is read out of `env`.
    delete process.env.NESSY_CUSTOM_HEADERS;
    process.env.NESSY_CUSTOM_HEADERS = 'X-Tbank-Team: platform';
    storedConnection = claudeConnection();
    const agent = new ClaudeAgent(claudeConfig(CLAUDE_SESSION_ID));
    try {
      await agent.postInit();
      expect(adapterStarts).toHaveLength(1);
      const operator = await headerAcrossAudiences(adapterStarts[0]?.fetchImpl, 'x-tbank-team');

      expect(operator.gateway).toBe('platform');
      // Same audience rule as the correlation id, and for a stronger reason: an
      // operator header channel is where an operator puts a token, so a BYO
      // endpoint or the gateway's own host on another path must never see it.
      expect(operator.sameHostOtherPath).toBeUndefined();
      expect(operator.byo).toBeUndefined();
      expect(operator.loopback).toBeUndefined();

      // Both layers ride the one hop; a fix that carried one and dropped the
      // other would still satisfy the sibling test above.
      const correlation = await headerAcrossAudiences(adapterStarts[0]?.fetchImpl, NESSY_SESSION_ID_HEADER);
      expect(correlation.gateway).toBe(CLAUDE_SESSION_ID);
    } finally {
      agent.destroy();
    }
  });

  it('refuses an operator line that would forge the correlation id, by NAME', async () => {
    // The anti-spoof guard held BY ACCIDENT before P6.43: correlation was
    // applied LAST, so it out-wrote a forged value — but only in a process that
    // HAD an id to write. `parseCustomHeaders` now reserves the name at parse
    // time, unconditionally.
    //
    // THE ARM THAT MATTERS IS THE SECOND ONE, and the first is here to say why:
    // with a session id present, a mutant that deletes the reservation is a
    // DEAD CONTROL — the correlation write overwrites the forgery and this
    // assertion passes either way. Measured, not assumed: that mutant survived
    // until the no-id arm below was added.
    delete process.env.NESSY_CUSTOM_HEADERS;
    process.env.NESSY_CUSTOM_HEADERS = `${NESSY_SESSION_ID_HEADER}: not-this-session`;
    storedConnection = claudeConnection();
    const withId = new ClaudeAgent(claudeConfig(CLAUDE_SESSION_ID));
    try {
      await withId.postInit();
      const correlation = await headerAcrossAudiences(adapterStarts[0]?.fetchImpl, NESSY_SESSION_ID_HEADER);
      expect(correlation.gateway).toBe(CLAUDE_SESSION_ID);
      expect(correlation.gateway).not.toBe('not-this-session');
    } finally {
      withId.destroy();
    }

    // No id to write, which is the ordinary shape of a host serving many
    // sessions from one process. Without the parse-time reservation the
    // operator's line would BE the key the gateway aggregates on.
    adapterStarts.length = 0;
    const withoutId = new ClaudeAgent(claudeConfig(null));
    try {
      await withoutId.postInit();
      const correlation = await headerAcrossAudiences(adapterStarts[0]?.fetchImpl, NESSY_SESSION_ID_HEADER);
      expect(correlation.gateway).toBeUndefined();
    } finally {
      withoutId.destroy();
    }
  });

  it('sends no header at all when the session has no id, rather than a synthesized one', async () => {
    storedConnection = claudeConnection();
    const agent = new ClaudeAgent(claudeConfig(null));
    try {
      await agent.postInit();

      expect(adapterStarts).toHaveLength(1);
      const headers = await correlationFor(adapterStarts[0]?.fetchImpl);
      // `modeSessionId` would have produced `temp-<Date.now()>` here. An id the
      // gateway can aggregate nothing under is worse than no id.
      expect(headers.gateway).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });
});

// ============================================================
// codex-runtime — the same seam, on the runtime P6.43 could not reach
// ============================================================

describe('P2.422 — codex-runtime hands the adapter a session-correlating fetch', () => {
  it('stamps the session id on the gateway and on nothing else', async () => {
    const agent = new CodexAgent(codexConfig(codexConnection(), CODEX_SESSION_ID));
    try {
      await (agent as unknown as PrivateCodexAgent).ensureRuntime();

      expect(adapterStarts).toHaveLength(1);
      const headers = await correlationFor(adapterStarts[0]?.fetchImpl);

      expect(headers.gateway).toBe(CODEX_SESSION_ID);
      expect(headers.sameHostOtherPath).toBeUndefined();
      expect(headers.byo).toBeUndefined();
      expect(headers.loopback).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('sends no header at all when the session has no id', async () => {
    const agent = new CodexAgent(codexConfig(codexConnection(), null));
    try {
      await (agent as unknown as PrivateCodexAgent).ensureRuntime();

      expect(adapterStarts).toHaveLength(1);
      const headers = await correlationFor(adapterStarts[0]?.fetchImpl);
      expect(headers.gateway).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('keeps a BYO codex connection uncorrelated even though it has a session id', async () => {
    storedApiKey = 'sk-byo-not-a-real-key';
    const agent = new CodexAgent(
      codexConfig(codexConnection({ baseUrl: 'https://byo.example.test/v1' }), CODEX_SESSION_ID),
    );
    try {
      await (agent as unknown as PrivateCodexAgent).ensureRuntime();

      expect(adapterStarts).toHaveLength(1);
      const headers = await correlationFor(adapterStarts[0]?.fetchImpl);
      // The wrapper is handed down on every upstream kind; the URL prefix — not
      // the connection — is what decides whether the id is emitted.
      expect(headers.byo).toBeUndefined();
      expect(headers.gateway).toBe(CODEX_SESSION_ID);
    } finally {
      agent.destroy();
    }
  });
});
