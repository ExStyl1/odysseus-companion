/**
 * P3.234 — the consumer half: `BackendConfig.autoCompaction` reaching codex.
 *
 * P6.53 made the host's one auto-compaction policy reach EVERY backend, because
 * switching a session to claude was silently re-enabling compaction the user had
 * turned off. Every backend then read it except this one: `CodexAgent` never
 * looked at the field, and `writeCodexConfig` emitted the window and the derived
 * limit unconditionally — so the identical bug survived on the identical
 * mechanism, one runtime over.
 *
 * The writer's own rows live in the adapter package
 * (`config-writer-auto-compaction.test.ts`). This suite asserts the chain end to
 * end and reads the config **off disk** from the real `CODEX_HOME` the agent
 * built — a capture of the options object would pass for a writer that never
 * emitted it.
 *
 * **P3.234's SECOND close changed what "off" means here, and this paragraph used
 * to state the retracted version.** It said the window had to be withheld and
 * not just the limit; measured, withholding it disabled nothing (codex's
 * production fallback for an unknown slug is `Some(272_000)`, not the `None` of
 * a `#[cfg(test)]` fixture) and only replaced our catalogue figure with one
 * above the endpoint's ceiling. Codex has NO auto-compaction off-switch: the
 * window is now written in both positions and the off position buys the 90 %
 * trigger instead of our 85 %. The one case that pinned the old shape carries
 * the whole measurement.
 *
 * It also pins the compensation, because a fix that quietly costs the user
 * something else is not a fix: codex's `ThreadTokenUsage.modelContextWindow` is
 * this agent's ONLY producer for the context meter and arrives only after the
 * first turn, so the agent seeds `UsageTracker` from the host catalogue.
 *
 * Hermetic: credentials, the adapter launcher and the app-server subprocess are
 * faked. Nothing opens a socket or spawns a process.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { BackendRuntimePayload } from '../backend/internal/driver-types.ts';

// ============================================================
// Fakes
// ============================================================

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4242 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-p3234' } } : {};
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

const realCredentials = { ...credentialsIndex };
const realAdapter = { ...adapterPackage };
const realNestorAuth = { ...nestorAuth };
const realCodexAgentServer = { ...codexAgentServer };

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => null }),
}));

mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => (
    { port: 46181, close: async () => { /* nothing bound */ } }
  ),
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
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth);
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer);
});

const { CodexAgent } = await import('../codex-agent.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

// ============================================================
// Fixtures
// ============================================================

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
const WINDOW = 240_000;

function connection(): LlmConnection {
  return {
    slug: 'nessy-codex',
    name: 'Nessy Codex',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: MODEL,
    createdAt: Date.now(),
  } as LlmConnection;
}

function runtime(): BackendRuntimePayload {
  const built = codexDriver.buildRuntime({
    context: {
      connection: connection(),
      provider: 'codex-runtime',
      resolvedModel: MODEL,
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
  });
  // The catalogue window the host would have synced for this model.
  return { ...built, contextWindow: WINDOW } as BackendRuntimePayload;
}

function agentConfig(autoCompaction: { enabled: boolean } | undefined): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-p3234',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-p3234',
      workspaceRootPath: '/tmp/ws-p3234',
      sessionRootPath: '/tmp/ws-p3234/sessions',
    } as never,
    session: {
      id: 'session-p3234',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-p3234',
    } as never,
    ...(autoCompaction ? { autoCompaction } : {}),
    runtime: runtime(),
  } as BackendConfig;
}

type PrivateAgent = {
  ensureRuntime: () => Promise<void>;
  codexHome: string | null;
  usageTracker: { getContextWindow: () => number | undefined };
};

const live: Array<{ destroy: () => void }> = [];
afterEach(() => { for (const agent of live.splice(0)) agent.destroy(); });
beforeEach(() => { live.length = 0; });

async function bootedAgent(autoCompaction: { enabled: boolean } | undefined) {
  const agent = new CodexAgent(agentConfig(autoCompaction));
  live.push(agent);
  await (agent as unknown as PrivateAgent).ensureRuntime();
  const home = (agent as unknown as PrivateAgent).codexHome;
  expect(typeof home).toBe('string');
  return {
    agent: agent as unknown as PrivateAgent,
    config: Bun.TOML.parse(readFileSync(join(home!, 'config.toml'), 'utf8')) as Record<string, unknown>,
  };
}

// ============================================================

describe('P3.234 — the host auto-compaction off-switch reaches codex', () => {
  it('ON writes the window and the derived limit (the control for the row below)', async () => {
    const { config } = await bootedAgent({ enabled: true });
    expect(config.model_context_window).toBe(WINDOW);
    expect(config.model_auto_compact_token_limit).toBe(204_000);
  });

  it('an ABSENT policy is ON — every caller predating P6.53 keeps its config', async () => {
    const { config } = await bootedAgent(undefined);
    expect(config.model_context_window).toBe(WINDOW);
    expect(config.model_auto_compact_token_limit).toBe(204_000);
  });

  /**
   * P3.234, SECOND CLOSE — this case asserted the RETRACTED premise and went red
   * when the writer was corrected, which is the test working.
   *
   * It read *"OFF withholds BOTH keys, which is what actually stops codex
   * compacting"*, on the reading that a codex without `model_context_window`
   * has no window to take 90 % of. That reading came from a TEST FIXTURE:
   * `openai_models.rs:906-908`'s `context_window: None` is inside
   * `#[cfg(test)] mod tests`, while production is
   * `models-manager/src/model_info.rs:139` → `Some(272_000)`. So withholding
   * the window never disabled anything — it replaced our catalogue figure with
   * a fabricated one 10 000 above what the gateway publishes — and codex
   * compacted anyway (driven: an OFF session compacted at 250 000 usage and did
   * not at 240 000, both arms in one run).
   *
   * The writer now emits the catalogue window in BOTH switch positions and only
   * `model_auto_compact_token_limit` moves, so that is what this pins.
   */
  it('OFF withholds ONLY the limit key; the catalogue window is written either way', async () => {
    const { config } = await bootedAgent({ enabled: false });
    expect(config.model_auto_compact_token_limit).toBeUndefined();
    // The load-bearing half, inverted by the measurement: the window MUST be
    // written, because codex's fallback for this slug is 272 000 — above the
    // endpoint's real ceiling — and every limit codex derives comes off it.
    expect(config.model_context_window).toBe(WINDOW);
    // The rest of the file is intact — this is a withheld key, not a broken write.
    expect(config.model_provider).toBe('nessy_gateway');
    expect(config.model).toBe(MODEL);
  });

  it('the context meter has a denominator from turn zero — seeded from the host catalogue', async () => {
    const { agent } = await bootedAgent({ enabled: false });
    expect(agent.usageTracker.getContextWindow()).toBe(WINDOW);
  });

  it('and is seeded with compaction ON too, so the meter has a denominator from turn zero', async () => {
    const { agent } = await bootedAgent({ enabled: true });
    expect(agent.usageTracker.getContextWindow()).toBe(WINDOW);
  });
});
