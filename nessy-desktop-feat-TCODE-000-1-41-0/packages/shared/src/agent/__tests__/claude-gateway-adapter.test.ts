/**
 * T6 — the `claude-runtime` local-adapter lifecycle.
 *
 * A `claude-runtime` connection does NOT talk to api.anthropic.com. `postInit`
 * starts the local Anthropic-Messages adapter (T2/T3) on an ephemeral loopback
 * port, points the SDK subprocess at it through the per-session `envOverrides`
 * seam, and the handle dies with the session.
 *
 * Three module seams are faked so the suite is hermetic: the stored connection
 * (`config/storage.ts`), the credential store (`credentials/index.ts`) and the
 * adapter launcher (`@nessy-agent/codex-responses-adapter`). Nothing here opens
 * a socket, reads `~/.nessy/dp_auth_creds.json`, or spawns the Claude SDK.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as configStorage from '../../config/storage.ts';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as llmValidation from '../../config/llm-validation.ts';
import type { AdapterHandle, UpstreamTarget } from '@nessy-agent/codex-responses-adapter';
import type { LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import { NESTOR_GATEWAY_MODEL_WINDOWS } from '../../auth/nestor.ts';
import { gatewayModelFixture } from '../../config/__tests__/fixtures/gateway-connection-fixture.ts';
import { resolveAutoCompactionSettings } from '../../config/auto-compaction-settings.ts';

// ============================================================
// Fakes (mutated per test; installed once at module load)
// ============================================================

let storedConnection: LlmConnection | null = null;
let storedApiKey: string | null = null;
let apiKeyReads = 0;

/**
 * P3.98 — `onUpstreamCall` joins the recorded start options: the row's whole
 * question is whether the agent binds an observer at all, which is invisible
 * unless the fake records the field.
 */
interface StartCall {
  upstream?: UpstreamTarget;
  fetchImpl?: typeof fetch;
  onUpstreamCall?: (call: { system: unknown; model: string; inputTokens: number; outputTokens: number }) => void;
  /**
   * C4.10 — the same reason `onUpstreamCall` is recorded: the row's question is
   * whether the host BINDS its idle abort onto the adapter at all, and that is
   * invisible unless the fake keeps the field.
   */
  readWithIdleTimeout?: (reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(reason?: unknown): Promise<void>;
  }) => AsyncIterable<Uint8Array>;
}
const adapterStarts: StartCall[] = [];
let closeCount = 0;
let startAdapterBehavior: (options: StartCall) => Promise<AdapterHandle> = async (options) => {
  adapterStarts.push(options);
  return { port: 45671, close: async () => { closeCount += 1; } };
};

const validationCalls: unknown[] = [];

// `mock.module` is process-global and bun runs every file in one process, so
// each seam delegates to the real export outside this suite's own fixtures, and
// `afterAll` puts the untouched modules back. (Without that, a later file's
// `getLlmConnection('unknown-slug')` resolves to this file's fixture — which is
// exactly how `factory.test.ts`'s "not found for unknown slug" row was broken.)
const realStorage = { ...configStorage };
const realCredentials = { ...credentialsIndex };
const realAdapter = { ...adapterPackage };
const realValidation = { ...llmValidation };

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
  getCredentialManager: () => ({
    getLlmApiKey: async () => { apiKeyReads += 1; return storedApiKey; },
  }),
}));

mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: (options: StartCall) => startAdapterBehavior(options),
}));

mock.module('../../config/llm-validation.ts', () => ({
  ...realValidation,
  validateAnthropicConnection: async (config: unknown) => {
    validationCalls.push(config);
    return { success: true };
  },
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
  mock.module('../../config/llm-validation.ts', () => realValidation);
});

const { ClaudeAgent } = await import('../claude-agent.ts');
const { buildClaudeSubprocessEnv, getDefaultOptions } = await import('../options.ts');
const { anthropicDriver, buildClaudeRuntimeUpstream } = await import(
  '../backend/internal/drivers/anthropic.ts'
);

// ============================================================
// Fixtures
// ============================================================

/** The verified gateway endpoint a `claude-runtime` gateway card seeds (T7). */
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
/** Same host, different path — AGENTS.md: this must NOT get Nestor semantics. */
const SAME_HOST_OTHER_PATH = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1';

/**
 * P6.784 — the two rows come from the card's own builder, so the tri-states the
 * card declares are in them. Hand-written, they omitted `supportsThinking`,
 * and `ModelDefinition` documents that field as *"Defaults to true when
 * undefined"* while both shipped rows declare `false` — so this fixture used to
 * stand for a gateway card that reasons, which the shipped one does not.
 * `name`/`shortName` stay local because they are this suite's own labels.
 */
const GATEWAY_MODELS = [
  { ...gatewayModelFixture({ id: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 262_144 }), name: 'Qwen 3.5 397B', shortName: 'Qwen Coder' },
  { ...gatewayModelFixture({ id: 'tgpt/qwen36-35b-a3b-fp8', contextWindow: 262_144 }), name: 'Qwen 3.6 35B', shortName: 'Qwen Fast' },
] as unknown as LlmConnection['models'];

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'nessy-claude',
    name: 'Nessy Claude',
    providerType: 'claude-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    models: GATEWAY_MODELS,
    createdAt: Date.now(),
    ...overrides,
  } as LlmConnection;
}

function agentConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'claude-runtime',
    connectionSlug: 'nessy-claude',
    model: 'tgpt/qwen35-397b-a17b-fp8',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-claude-runtime',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-claude-runtime',
      workspaceRootPath: '/tmp/ws-claude-runtime',
      sessionRootPath: '/tmp/ws-claude-runtime/sessions',
    } as never,
    session: {
      id: 'session-claude-runtime',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-claude-runtime',
    } as never,
    ...overrides,
  } as BackendConfig;
}

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  storedConnection = connection();
  storedApiKey = null;
  apiKeyReads = 0;
  adapterStarts.length = 0;
  validationCalls.length = 0;
  closeCount = 0;
  startAdapterBehavior = async (options) => {
    adapterStarts.push(options);
    return { port: 45671, close: async () => { closeCount += 1; } };
  };
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ============================================================
// (a) env trio + resolveAuthEnvVars is skipped
// ============================================================

describe('ClaudeAgent postInit — claude-runtime local adapter', () => {
  it('starts the adapter against the gateway and points the subprocess at loopback', async () => {
    const agent = new ClaudeAgent(agentConfig());
    try {
      const result = await agent.postInit();

      expect(result.authInjected).toBe(true);
      expect(result.authWarning).toBeUndefined();
      // P2.422 added `fetchImpl` to every start, so the shape is asserted
      // field-by-field rather than by whole-object equality.
      expect(adapterStarts.map(c => c.upstream)).toEqual([{ kind: 'nestor' }]);
      expect(typeof adapterStarts[0]?.fetchImpl).toBe('function');

      const overrides = (agent as unknown as { config: BackendConfig }).config.envOverrides ?? {};
      expect(overrides.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:45671');
      expect(overrides.ANTHROPIC_API_KEY).toBe('not-needed');
      expect(overrides.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      // P6.396 — the client-side omission `llm-gateway-protocol.md` prescribes
      // for a gateway that reshapes system content, which is what this adapter
      // does (`systemToInstructions` joins the array into one string, and the
      // positional strip only works on an unchanged array). Without it the
      // client-version + conversation-fingerprint block reaches the gateway's
      // model as prompt. A mutation deleting this line goes RED here.
      expect(overrides.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
      // Neutralized rather than absent — see the production comment.
      expect(overrides.CLAUDE_CODE_OAUTH_TOKEN).toBe('');

      // The connection's own base URL / key must never reach the SDK: that is
      // what "resolveAuthEnvVars application is skipped" means observably.
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      // A gateway upstream reads dp creds inside the adapter, never here.
      expect(apiKeyReads).toBe(0);
    } finally {
      agent.destroy();
    }
  });

  it('says so when the spawn model has no window, instead of silently never compacting', async () => {
    // The real path, not the builder in isolation: a gateway model that reached
    // the catalogue with no `contextWindow` — the shape an hourly `/cli/models`
    // refresh produces for any id `NESTOR_GATEWAY_MODEL_WINDOWS` does not cover,
    // since the API reports no window of its own. Both compaction envs are then
    // absent, the SDK resolves the unknown id to auto-compact window source
    // "auto", and its own gate skips proactive compaction for the whole session.
    // That failure has no error, no boundary and no event; this warning is the
    // only thing that reports it, so it must ride postInit's REAL return.
    storedConnection = connection({
      defaultModel: 'tgpt/unknown-future',
      models: [{ id: 'tgpt/unknown-future', name: 'Future' }] as unknown as LlmConnection['models'],
    });
    const agent = new ClaudeAgent(agentConfig({ model: 'tgpt/unknown-future' }));
    try {
      const result = await agent.postInit();

      // The session still works — one capability is off, not the connection.
      expect(result.authInjected).toBe(true);
      expect(result.authWarningLevel).toBe('warning');
      expect(result.authWarning).toContain('tgpt/unknown-future');
      expect(result.authWarning).toContain('compaction');

      // …and the warning is true: neither env was emitted, which is exactly the
      // condition that turns the SDK's proactive compaction off.
      const overrides = (agent as unknown as { config: BackendConfig }).config.envOverrides ?? {};
      expect(overrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(overrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('recovers the window from the gateway table when the catalogue entry lost it', async () => {
    // Same refresh, a model the table DOES cover: the catalogue entry carries no
    // window either, but the compaction path reads the same table the fetcher
    // stamps from, so the session compacts and there is nothing to warn about.
    // Paired with the case above so the two outcomes are told apart by the
    // model id alone — the only thing that differs between them.
    storedConnection = connection({
      models: [
        { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'Qwen 3.5 397B' },
      ] as unknown as LlmConnection['models'],
    });
    const agent = new ClaudeAgent(agentConfig());
    try {
      const result = await agent.postInit();

      expect(result.authInjected).toBe(true);
      expect(result.authWarning).toBeUndefined();

      // Through the constant, not a literal: the table is half harvested
      // (`scripts/refresh-nestor-model-windows.ts`) and resolves a disagreement
      // downward, so a hand-copied number pins this to one harvest.
      const expected = String(NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen35-397b-a17b-fp8']);
      const overrides = (agent as unknown as { config: BackendConfig }).config.envOverrides ?? {};
      expect(overrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(expected);
      expect(overrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(expected);
    } finally {
      agent.destroy();
    }
  });

  it('deletes an ambient ANTHROPIC_AUTH_TOKEN in the clean-state block', async () => {
    // authentication.md § Authentication precedence: ANTHROPIC_AUTH_TOKEN is
    // tier 2 (`Authorization: Bearer`), ABOVE the tier-3 ANTHROPIC_API_KEY the
    // session resolves — an ambient bearer token surviving postInit would
    // silently outrank the configured credential in the subprocess env spread.
    const agent = new ClaudeAgent(agentConfig());
    try {
      process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-bearer-token';
      await agent.postInit();

      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      const env = buildClaudeSubprocessEnv(
        (agent as unknown as { config: BackendConfig }).config.envOverrides,
      );
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('keeps a subscription OAuth token out of the subprocess even when one is re-set after postInit', async () => {
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      // What `SessionManager.reinitializeAuth` and a concurrent subscription
      // session's postInit both do to this shared object.
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-leaked';

      const env = buildClaudeSubprocessEnv(
        (agent as unknown as { config: BackendConfig }).config.envOverrides,
      );
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
      expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:45671');
    } finally {
      agent.destroy();
    }
  });

  it('the mini/summarize path inherits the adapter URL, so it cannot reach api.anthropic.com', async () => {
    // `runMiniCompletion` and the summarization path both build their SDK options
    // from `this.config.envOverrides` via `getDefaultOptions`. This is the unit
    // half of the transfer-summary fix: postInit is what makes those two paths
    // adapter-bound, which is why every construction site must call it.
    const agent = new ClaudeAgent(agentConfig());
    try {
      // The hazard, made explicit: an ambient host value (this is exactly what a
      // developer machine running Claude Code has exported) no longer reaches
      // even a never-postInit'd agent's child — F1.966, the builder's rule.
      process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
      expect(getDefaultOptions(
        (agent as unknown as { config: BackendConfig }).config.envOverrides,
      ).env?.ANTHROPIC_BASE_URL).toBeUndefined();

      await agent.postInit();

      const options = getDefaultOptions(
        (agent as unknown as { config: BackendConfig }).config.envOverrides,
      );
      expect(options.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:45671');
      expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    } finally {
      agent.destroy();
    }
  });

  it('keeps pre-existing envOverrides and adds the mini model from the connection catalog', async () => {
    const agent = new ClaudeAgent(agentConfig({
      envOverrides: { NESSY_WORKSPACE_ID: 'ws-claude-runtime' },
    }));
    try {
      await agent.postInit();
      const overrides = (agent as unknown as { config: BackendConfig }).config.envOverrides ?? {};
      expect(overrides.NESSY_WORKSPACE_ID).toBe('ws-claude-runtime');
      // WebFetch summarization must never ask the gateway for a Haiku id.
      expect(overrides.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('tgpt/qwen36-35b-a3b-fp8');
    } finally {
      agent.destroy();
    }
  });

  it('resolves the fast model by gateway ALIAS, so a live refresh cannot reorder it away', async () => {
    // The startup refresh replaces `connection.models` wholesale with the
    // `/cli/models` response, in the API's order — the seeded "fast model last"
    // guarantee does not survive it. `fetchNestorModels` maps the API `alias`
    // onto `shortName`, which is what the alias resolver matches.
    storedConnection = connection({
      models: [
        { id: 'tgpt/qwen36-35b-a3b-fp8', name: 'fast (tgpt/qwen36-35b-a3b-fp8)', shortName: 'fast' },
        { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'coder (tgpt/qwen35-397b-a17b-fp8)', shortName: 'coder' },
      ] as unknown as LlmConnection['models'],
    });
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      const overrides = (agent as unknown as { config: BackendConfig }).config.envOverrides ?? {};
      expect(overrides.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('tgpt/qwen36-35b-a3b-fp8');
    } finally {
      agent.destroy();
    }
  });

  it('an explicit config miniModel wins over the connection-derived one', async () => {
    const agent = new ClaudeAgent(agentConfig({ miniModel: 'tgpt/explicit-mini' }));
    try {
      await agent.postInit();
      const overrides = (agent as unknown as { config: BackendConfig }).config.envOverrides ?? {};
      expect(overrides.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('tgpt/explicit-mini');
    } finally {
      agent.destroy();
    }
  });

  it('sends a BYO endpoint the connection credential as a Bearer target, never Nestor', async () => {
    storedConnection = connection({ baseUrl: 'https://byo.example.test/v1' });
    storedApiKey = 'sk-byo-secret';
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      expect(adapterStarts.map(c => c.upstream)).toEqual([
        { kind: 'openai-compatible', baseUrl: 'https://byo.example.test/v1', apiKey: 'sk-byo-secret' },
      ]);
      expect(typeof adapterStarts[0]?.fetchImpl).toBe('function');
      expect(apiKeyReads).toBe(1);
    } finally {
      agent.destroy();
    }
  });

  it('treats the gateway host with a different path as BYO, not as Nestor', async () => {
    // AGENTS.md: "Custom endpoints, even on the same host with a different
    // path, must retain normal provider auth semantics."
    storedConnection = connection({ baseUrl: SAME_HOST_OTHER_PATH });
    storedApiKey = 'sk-not-a-gateway-token';
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      expect(adapterStarts[0]?.upstream).toEqual({
        kind: 'openai-compatible',
        baseUrl: SAME_HOST_OTHER_PATH,
        apiKey: 'sk-not-a-gateway-token',
      });
    } finally {
      agent.destroy();
    }
  });

  it('omits the Authorization credential for a keyless BYO endpoint', async () => {
    storedConnection = connection({ baseUrl: 'http://localhost:11434/v1', authType: 'none' });
    storedApiKey = null;
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      expect(adapterStarts[0]?.upstream).toEqual({
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
      });
    } finally {
      agent.destroy();
    }
  });

  // ============================================================
  // (b) teardown
  // ============================================================

  it('closes the adapter handle when the session is destroyed', async () => {
    const agent = new ClaudeAgent(agentConfig());
    await agent.postInit();
    expect(closeCount).toBe(0);

    agent.destroy();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeCount).toBe(1);

    // Idempotent: a second destroy must not double-close a closed server.
    agent.destroy();
    await Promise.resolve();
    expect(closeCount).toBe(1);
  });

  it('replaces rather than strands the previous adapter when postInit runs again', async () => {
    let port = 45671;
    startAdapterBehavior = async (options) => {
      adapterStarts.push(options);
      return { port: port++, close: async () => { closeCount += 1; } };
    };
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      await agent.postInit();
      await Promise.resolve();
      expect(adapterStarts).toHaveLength(2);
      expect(closeCount).toBe(1);
      expect((agent as unknown as { config: BackendConfig }).config.envOverrides?.ANTHROPIC_BASE_URL)
        .toBe('http://127.0.0.1:45672');
    } finally {
      agent.destroy();
    }
  });

  it('closes an adapter that finished starting after destroy() and never publishes it', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    startAdapterBehavior = async (options) => {
      adapterStarts.push(options);
      await gate;
      return { port: 45999, close: async () => { closeCount += 1; } };
    };

    const agent = new ClaudeAgent(agentConfig());
    const pending = agent.postInit();
    agent.destroy();
    release!();
    const result = await pending;

    expect(result.authInjected).toBe(false);
    expect(closeCount).toBe(1);
    expect((agent as unknown as { localAdapter: AdapterHandle | null }).localAdapter).toBeNull();
  });

  // ============================================================
  // rollback
  // ============================================================

  it('rolls back to the pre-start envOverrides when the adapter fails to start', async () => {
    startAdapterBehavior = async () => { throw new Error('EADDRINUSE loopback'); };
    const agent = new ClaudeAgent(agentConfig({ envOverrides: { NESSY_WORKSPACE_ID: 'ws-claude-runtime' } }));
    try {
      const result = await agent.postInit();
      expect(result.authInjected).toBe(false);
      expect(result.authWarningLevel).toBe('error');
      expect(result.authWarning).toContain('EADDRINUSE loopback');
      expect((agent as unknown as { config: BackendConfig }).config.envOverrides)
        .toEqual({ NESSY_WORKSPACE_ID: 'ws-claude-runtime' });
      expect((agent as unknown as { localAdapter: AdapterHandle | null }).localAdapter).toBeNull();
    } finally {
      agent.destroy();
    }
  });

  it('fails closed — never falls through to api.anthropic.com — when the endpoint is missing', async () => {
    storedConnection = connection({ baseUrl: undefined });
    const agent = new ClaudeAgent(agentConfig());
    try {
      const result = await agent.postInit();
      expect(result.authInjected).toBe(false);
      expect(result.authWarningLevel).toBe('error');
      expect(adapterStarts).toEqual([]);
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  // ============================================================
  // (c) non-gateway connections are untouched — positive control
  // ============================================================

  it('leaves a direct anthropic connection on the resolveAuthEnvVars path', async () => {
    storedConnection = connection({
      slug: 'anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      baseUrl: undefined,
      defaultModel: 'claude-opus-4-8',
      models: undefined,
    });
    storedApiKey = 'sk-ant-direct';
    const agent = new ClaudeAgent(agentConfig({
      providerType: 'anthropic',
      connectionSlug: 'anthropic',
      envOverrides: { NESSY_WORKSPACE_ID: 'ws-claude-runtime' },
    }));
    try {
      const result = await agent.postInit();
      expect(result.authInjected).toBe(true);
      // No adapter, and the SDK child env carries the same credential it did before T6 —
      // since F1.958 through THIS session's overrides, never the shared `process.env`
      // (another session's postInit re-keyed this session's child through it).
      expect(adapterStarts).toEqual([]);
      expect(Object.keys({ ...process.env })).not.toContain('ANTHROPIC_API_KEY');
      expect((agent as unknown as { config: BackendConfig }).config.envOverrides)
        .toEqual({ NESSY_WORKSPACE_ID: 'ws-claude-runtime', ANTHROPIC_API_KEY: 'sk-ant-direct', CLAUDE_CODE_OAUTH_TOKEN: '' });
    } finally {
      agent.destroy();
    }
  });
});

// ============================================================
// Driver: upstream construction + Step 4 (T4-review) fixes
// ============================================================

describe('anthropicDriver — claude-runtime upstream construction', () => {
  it('maps the verified gateway base URL to the nestor upstream', () => {
    expect(buildClaudeRuntimeUpstream(connection())).toEqual({ kind: 'nestor' });
    expect(buildClaudeRuntimeUpstream(connection({ baseUrl: `${GATEWAY_BASE_URL}/` })))
      .toEqual({ kind: 'nestor' });
  });

  it('maps every other endpoint to an openai-compatible upstream', () => {
    expect(buildClaudeRuntimeUpstream(connection({ baseUrl: SAME_HOST_OTHER_PATH })))
      .toEqual({ kind: 'openai-compatible', baseUrl: SAME_HOST_OTHER_PATH });
  });

  it('throws rather than guessing an endpoint', () => {
    expect(() => buildClaudeRuntimeUpstream(connection({ baseUrl: '   ' }))).toThrow(/endpoint/i);
  });
});

describe('anthropicDriver.validateStoredConnection', () => {
  const credentialManager = {
    getLlmApiKey: async () => { apiKeyReads += 1; return storedApiKey; },
  } as never;

  it('never runs the direct Claude SDK against a claude-runtime endpoint', async () => {
    const result = await anthropicDriver.validateStoredConnection!({
      slug: 'nessy-claude',
      connection: connection(),
      credentialManager,
      hostRuntime: {} as never,
      resolvedPaths: {} as never,
    });
    expect(result).toEqual({ success: true });
    expect(validationCalls).toEqual([]);
  });

  it('POSITIVE CONTROL: a direct anthropic connection still runs the SDK probe', async () => {
    storedApiKey = 'sk-ant-direct';
    const result = await anthropicDriver.validateStoredConnection!({
      slug: 'anthropic',
      connection: connection({
        slug: 'anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        baseUrl: undefined,
        defaultModel: 'claude-opus-4-8',
      }),
      credentialManager,
      hostRuntime: {} as never,
      resolvedPaths: {} as never,
    });
    expect(result).toEqual({ success: true });
    expect(validationCalls).toHaveLength(1);
  });

  it('reports missing BYO credentials structurally instead of probing', async () => {
    storedApiKey = null;
    const result = await anthropicDriver.validateStoredConnection!({
      slug: 'nessy-claude',
      connection: connection({ baseUrl: 'https://byo.example.test/v1' }),
      credentialManager,
      hostRuntime: {} as never,
      resolvedPaths: {} as never,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('credentials');
    expect(validationCalls).toEqual([]);
  });

  it('fails with a clear message instead of asserting a defaultModel that is absent', async () => {
    storedApiKey = 'sk-ant-direct';
    const result = await anthropicDriver.validateStoredConnection!({
      slug: 'anthropic',
      connection: connection({
        slug: 'anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        baseUrl: undefined,
        defaultModel: undefined,
      }),
      credentialManager,
      hostRuntime: {} as never,
      resolvedPaths: {} as never,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/model/i);
    expect(validationCalls).toEqual([]);
  });
});

// ============================================================
// P3.235 — THE TWO OPERATOR KNOBS ACTUALLY REACH THE SUBPROCESS.
//
// `claude-auto-compaction-knobs.ts` landed as a projection with its wiring
// deferred to this lane, and a projection nobody spreads is indistinguishable
// from the bug it was written to fix: `NESSY_AUTOCOMPACT_PCT_OVERRIDE` and
// `NESSY_AUTO_COMPACT_WINDOW` bound on Pi and reached claude never. These are
// the call-site assertions the pure tests in
// `claude-auto-compaction-knobs.test.ts` cannot make — the env is read off the
// agent's REAL `envOverrides` after a REAL `postInit`, on both spawn paths.
// ============================================================

describe('P3.235 · the operator knobs on the real spawn paths', () => {
  const knobs = { NESSY_AUTOCOMPACT_PCT_OVERRIDE: '50', NESSY_AUTO_COMPACT_WINDOW: '150000' };

  /**
   * The window the DEFAULT fixture connection carries in its own catalogue,
   * derived from `GATEWAY_MODELS` rather than written out: the model entry here
   * still has a `contextWindow`, so `buildClaudeMaxContextTokensEnv` reads THAT
   * and never reaches `NESTOR_GATEWAY_MODEL_WINDOWS` (which is the fallback the
   * "recovers the window from the gateway table" case above strips it to force,
   * and which resolves to a different number).
   */
  const catalogueWindow = String((GATEWAY_MODELS as unknown as Array<{ id: string; contextWindow?: number }>)
    .find(m => m.id === 'tgpt/qwen35-397b-a17b-fp8')!.contextWindow);

  /** The agent's own `envOverrides`, i.e. what `buildClaudeSubprocessEnv` spreads last. */
  function overridesOf(agent: unknown): Record<string, string> {
    return (agent as { config: BackendConfig }).config.envOverrides ?? {};
  }

  it('crosses to the gateway subprocess, and the operator window WINS over ours', async () => {
    // The ordering assertion, and it is the whole reason the spread is placed
    // after `buildClaudeAutoCompactionEnv`: both write the same variable, and
    // this connection's catalogue window (262144) would otherwise overwrite the
    // number the operator wrote by hand.
    const agent = new ClaudeAgent(agentConfig({
      autoCompaction: resolveAutoCompactionSettings({ env: knobs }),
    }));
    try {
      await agent.postInit();
      const overrides = overridesOf(agent);
      expect(overrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50');
      expect(overrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('150000');
      // …and the catalogue-derived pair is still there for the OTHER variable,
      // which no knob writes, so the readout still names the real window.
      expect(overrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(catalogueWindow);
    } finally {
      agent.destroy();
    }
  });

  it('crosses on the DIRECT Anthropic path too, where no window env exists at all', async () => {
    // The second call site. A `claude-*` id deliberately gets no catalogue
    // window, so before this wiring the direct path emitted nothing compaction
    // related except the off-switch — and an operator knob simply vanished.
    storedConnection = connection({
      slug: 'anthropic-direct',
      providerType: 'anthropic',
      authType: 'api_key',
      baseUrl: undefined,
      defaultModel: 'claude-opus-5',
      models: [{ id: 'claude-opus-5', name: 'Opus 5', contextWindow: 200_000 }] as unknown as LlmConnection['models'],
    });
    storedApiKey = 'sk-ant-direct';
    const agent = new ClaudeAgent(agentConfig({
      connectionSlug: 'anthropic-direct',
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-opus-5',
      autoCompaction: resolveAutoCompactionSettings({ env: knobs }),
    }));
    try {
      const result = await agent.postInit();
      expect(result.authInjected).toBe(true);
      // The adapter is NOT started on this path — proof it is the direct branch.
      expect(adapterStarts).toEqual([]);
      const overrides = overridesOf(agent);
      expect(overrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50');
      expect(overrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('150000');
    } finally {
      agent.destroy();
    }
  });

  it('emits neither knob when the operator turned compaction OFF', async () => {
    // The negative control, and the one that matters: `Uk()` short-circuits
    // before either value is read, so a threshold beside `DISABLE_AUTO_COMPACT`
    // would describe behaviour the session does not have — and a reader who
    // greps the spawn env would conclude the opposite of the truth.
    const agent = new ClaudeAgent(agentConfig({
      autoCompaction: resolveAutoCompactionSettings({ userEnabled: false, env: knobs }),
    }));
    try {
      await agent.postInit();
      const overrides = overridesOf(agent);
      expect(overrides.DISABLE_AUTO_COMPACT).toBe('1');
      expect(overrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
      expect(overrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('leaves a spawn with no knob byte-identical to the one before this wiring', async () => {
    // The regression guard for the DEFAULT path, which is every session that
    // never set either env. Nothing new may appear.
    const agent = new ClaudeAgent(agentConfig({
      autoCompaction: resolveAutoCompactionSettings({ env: {} }),
    }));
    try {
      await agent.postInit();
      const overrides = overridesOf(agent);
      expect(overrides.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBeUndefined();
      expect(overrides.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(catalogueWindow);
    } finally {
      agent.destroy();
    }
  });
});

// ============================================================
// P3.98 + P3.122 — model spend the HOST caused
// ============================================================

/**
 * The contract and the detector were built by W2-i; the PRODUCER and the
 * BINDING were in two other lanes' files and so counted nothing. Three pieces
 * have to meet: the adapter reports every completed non-streaming call and
 * classifies none of them (its own suite is the adapter package's
 * `host-overhead-observation.test.ts`), `classifyHostOverheadSource` decides
 * what a call was, and the agent binds the two.
 *
 * The binding is where both ways of getting it wrong live: report every call
 * and the operator's cost line double-counts the turns the user asked for;
 * report none and the state the rows describe stands — spend on our gateway
 * bill that appears in no accounting this product reports.
 */
describe('ClaudeAgent — the host-overhead observation', () => {
  /** The opening of the classifier's own system prompt, as the binary sends it. */
  const CLASSIFIER_MARKER = 'You are a security monitor for autonomous AI coding agents';

  it('reports a classifier hop as its own usage scope, with the upstream counts', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const agent = new ClaudeAgent(agentConfig({
      onHostOverheadUsage: (turn: unknown) => { recorded.push(turn as Record<string, unknown>); },
    } as Partial<BackendConfig>));
    try {
      await agent.postInit();
      const observe = adapterStarts[0]?.onUpstreamCall;
      expect(observe).toBeDefined();

      observe!({
        // A block array, which is the shape the binary sends.
        system: [{ type: 'text', text: `${CLASSIFIER_MARKER}\n<rules>…</rules>` }],
        model: 'tgpt/qwen35-397b-a17b-fp8',
        inputTokens: 24_231,
        outputTokens: 335,
      });

      expect(recorded.length).toBe(1);
      expect(recorded[0]).toMatchObject({
        backend: 'anthropic',
        scope: 'host-overhead',
        overheadSource: 'auto-mode-classifier',
        model: 'tgpt/qwen35-397b-a17b-fp8',
        inputTokens: 24_231,
        outputTokens: 335,
        // Nothing on this path establishes a USD figure and none is invented.
        costReporting: 'unsupported',
      });
    } finally {
      await agent.destroy?.();
    }
  });

  it('THE CONTROL — an ordinary turn reports nothing on this line', async () => {
    const recorded: unknown[] = [];
    const agent = new ClaudeAgent(agentConfig({
      onHostOverheadUsage: (turn: unknown) => { recorded.push(turn); },
    } as Partial<BackendConfig>));
    try {
      await agent.postInit();
      adapterStarts[0]!.onUpstreamCall!({
        system: 'You are Nessy, a helpful coding assistant.',
        model: 'tgpt/qwen35-397b-a17b-fp8',
        inputTokens: 1_200,
        outputTokens: 90,
      });
      expect(recorded).toEqual([]);
    } finally {
      await agent.destroy?.();
    }
  });

  it('binds no observer when the host supplied no sink', async () => {
    // A backend built without the port starts the adapter exactly as it did
    // before this row, rather than paying for an observation nobody reads.
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      expect(adapterStarts.length).toBe(1);
      expect(adapterStarts[0]!.onUpstreamCall).toBeUndefined();
    } finally {
      await agent.destroy?.();
    }
  });
});

// ============================================================
// C4.10 · the host's idle abort on the passthrough relay
// ============================================================

/**
 * C4.10 (owner answer QF3 = B, 2026-09-11) — the HOST half of the wiring.
 *
 * Native-first was exhausted before this was built, and the reading is in
 * `packages/shared/src/llm/stream-idle.ts`: the SDK's own byte watchdog arms
 * only for an `api.anthropic.com` base URL, and every session here points
 * `ANTHROPIC_BASE_URL` at the loopback adapter, so it cannot fire (P6.114 /
 * P6.115). The adapter is the dependency LEAF of the pair and cannot import the
 * primitive, so the host injects it — and what is asserted here is exactly that
 * injection, because the adapter's own suite
 * (`codex-responses-adapter/src/__tests__/anthropic-passthrough-idle.test.ts`)
 * can only prove what a guard does once it is bound.
 *
 * The WALL-CLOCK arm is deliberately not driven here: the operator knob's floor
 * is 10 000 ms, so a test of the real default deadline would sleep. The
 * primitive's timing is pinned where it lives; this file pins the seam.
 */
describe('C4.10 · the claude loopback relay gets the host idle abort', () => {
  it('binds readWithIdleTimeout, and the bound guard really relays a reader', async () => {
    const agent = new ClaudeAgent(agentConfig());
    try {
      await agent.postInit();
      expect(adapterStarts.length).toBe(1);
      const guard = adapterStarts[0]!.readWithIdleTimeout;
      expect(typeof guard).toBe('function');

      // The discriminator that this is the stream primitive and not a stub: the
      // bound closure, driven over a reader that speaks twice and ends, yields
      // those two chunks and completes.
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
      let index = 0;
      const reader = {
        read: async () => (index < chunks.length
          ? { done: false, value: chunks[index++]! }
          : { done: true, value: undefined }),
        cancel: async () => {},
      };
      const relayed: number[] = [];
      for await (const value of guard!(reader)) relayed.push(...value);
      expect(relayed).toEqual([1, 2, 3]);
    } finally {
      await agent.destroy?.();
    }
  });

  it('and that guard abandons a silent stream instead of waiting on it', async () => {
    // The negative/boundary arm, driven against the SAME primitive the host
    // binds — with an explicit budget, because the operator knob's floor is
    // 10 s. A reader whose `read()` never settles is the exact shape this row
    // exists for: without the guard the relay waits for the SDK's ~9-minute
    // transport timeout, and with it the turn ends named.
    const { readWithIdleTimeout, StreamIdleTimeoutError } = await import('../../llm/stream-idle.ts');
    let cancelled: unknown;
    const silent = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
      cancel: async (reason?: unknown) => { cancelled = reason; },
    };
    let thrown: unknown;
    try {
      for await (const _chunk of readWithIdleTimeout(silent, { idleTimeoutMs: 25 })) { /* never reached */ }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StreamIdleTimeoutError);
    expect((thrown as Error).name).toBe('StreamIdleTimeoutError');
    // The adapter recognises the stall by that NAME — it cannot see the class —
    // and the reader is cancelled, so the upstream stops draining tokens into a
    // turn nobody is reading.
    expect(cancelled).toBe(thrown);
  });
});
