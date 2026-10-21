/**
 * P2.436 — the producer half: a project's standing `Compact Instructions`
 * reaching codex's own `compact_prompt`.
 *
 * The writer half has its own suite in the adapter package. This one asserts the
 * chain: the session's instruction resources → P6.54's composer → the config the
 * app-server is actually spawned against, read back OFF DISK from the real
 * `CODEX_HOME` the agent built. A capture of the options object would pass for a
 * writer that never emitted the key.
 *
 * Two filters ride along and are pinned here rather than only in the composer's
 * own tests, because they are what makes this safe on codex specifically:
 * codex compacts SERVER-SIDE, so anything that steers it does so where we cannot
 * see the result. `agent-instruction` resources only, and **anything with an
 * `mcp:` provenance is dropped** — a connected server deciding what survives
 * compaction is a channel nobody asked for, and here nobody could even audit it.
 *
 * Hermetic: credentials, the adapter launcher, the app-server subprocess and the
 * dp-creds reader are faked. Nothing opens a socket or spawns a process.
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
import type { PiContextResourceDescriptor } from '../pi-harness/context-resource.ts';

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
    return method === 'thread/start' ? { thread: { id: 'thread-p2436' } } : {};
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
    { port: 46171, close: async () => { /* nothing bound */ } }
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

const PROJECT_SECTION = 'Keep the "API contract" decisions and any \\ escaped paths.';
const MCP_SECTION = 'Preserve only what the connected server considers important.';

function resource(
  over: Partial<PiContextResourceDescriptor> & Pick<PiContextResourceDescriptor, 'kind' | 'content' | 'provenance'>,
): PiContextResourceDescriptor {
  return {
    schemaVersion: 1,
    id: `res-${over.provenance}`,
    sha256: 'x'.repeat(64),
    ...over,
  } as PiContextResourceDescriptor;
}

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

function runtimeFor(conn: LlmConnection): BackendRuntimePayload {
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

function agentConfig(
  resources: readonly PiContextResourceDescriptor[] | undefined,
): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    connectionSlug: 'nessy-codex',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-p2436',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-p2436',
      workspaceRootPath: '/tmp/ws-p2436',
      sessionRootPath: '/tmp/ws-p2436/sessions',
    } as never,
    session: {
      id: 'session-p2436',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-p2436',
    } as never,
    ...(resources ? { piContextResources: resources } : {}),
    runtime: runtimeFor(connection()),
  } as BackendConfig;
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null };

const live: Array<{ destroy: () => void }> = [];
afterEach(() => { for (const agent of live.splice(0)) agent.destroy(); });
beforeEach(() => { live.length = 0; });

/** Boot the runtime and parse the config.toml the app-server would be given. */
async function configFor(
  resources: readonly PiContextResourceDescriptor[] | undefined,
): Promise<Record<string, unknown>> {
  const agent = new CodexAgent(agentConfig(resources));
  live.push(agent);
  await (agent as unknown as PrivateAgent).ensureRuntime();
  const home = (agent as unknown as PrivateAgent).codexHome;
  expect(typeof home).toBe('string');
  return Bun.TOML.parse(readFileSync(join(home!, 'config.toml'), 'utf8')) as Record<string, unknown>;
}

// ============================================================

describe('P2.436 — the project section reaches codex’s compact_prompt', () => {
  it('writes the composed steering into the config the app-server is spawned against', async () => {
    const config = await configFor([
      resource({
        kind: 'agent-instruction',
        provenance: 'AGENTS.md@gen-1',
        content: `# Project\n\nsome prose\n\n## Compact Instructions\n\n${PROJECT_SECTION}\n`,
      }),
    ]);

    expect(String(config.compact_prompt)).toContain(PROJECT_SECTION);
    // Read off disk and parsed, so the quote and the backslash in the section
    // survived the TOML escaping — the failure that would otherwise take the
    // whole config down with it.
    expect(String(config.compact_prompt)).toContain('"API contract"');
    expect(String(config.compact_prompt)).toContain('\\ escaped');
    // The rest of the file is intact: this IS the whole-file failure mode.
    expect(config.model_provider).toBe('nessy_gateway');
  });

  it('drops an mcp: provenance even when it carries the section', async () => {
    const config = await configFor([
      resource({
        kind: 'agent-instruction',
        provenance: 'mcp:some-server:prompt:aa@gen-1',
        content: `## Compact Instructions\n\n${MCP_SECTION}\n`,
      }),
      resource({
        kind: 'agent-instruction',
        provenance: 'AGENTS.md@gen-1',
        content: `## Compact Instructions\n\n${PROJECT_SECTION}\n`,
      }),
    ]);

    expect(String(config.compact_prompt)).toContain(PROJECT_SECTION);
    // Worse here than on Pi: codex compacts server-side, so a server steering
    // what survives would do it where nothing can observe the result.
    expect(String(config.compact_prompt)).not.toContain(MCP_SECTION);
  });

  it('ignores a memory resource, which arrives under a different kind', async () => {
    const config = await configFor([
      resource({
        kind: 'context',
        provenance: 'memory.md@gen-1',
        content: `## Compact Instructions\n\n${MCP_SECTION}\n`,
      }),
    ]);

    expect(config.compact_prompt).toBeUndefined();
  });

  it('leaves codex its own prompt when no instruction file carries the section', async () => {
    const config = await configFor([
      resource({ kind: 'agent-instruction', provenance: 'AGENTS.md@gen-1', content: '# Project\n\njust prose\n' }),
    ]);

    expect(config.compact_prompt).toBeUndefined();
  });

  it('writes nothing when the host materialized no resources for this session', async () => {
    // The standing residue: the host builds `piContextResources` for
    // `provider === 'pi'` only, so this is what a codex session looks like
    // today. codex keeps its own default prompt — unchanged behaviour, not a
    // silently empty one.
    const config = await configFor(undefined);

    expect(config.compact_prompt).toBeUndefined();
    expect(config.model_provider).toBe('nessy_gateway');
  });
});
