/**
 * The codex agent-role capability, switched on.
 *
 * `7bf2c84d6` built the writer and probed it against the shipped binary, and
 * left it INERT: nothing passed definitions in, so a codex session's
 * `config.toml` carried no `[agents]` section no matter how many agents the
 * workspace held. This file pins the wire itself — that `CodexAgent` hands
 * `this.config.piRuntimeAgentDefinitions` to `writeCodexConfig` and gives it a
 * diagnostic sink — by reading the config the runtime actually wrote into its
 * own managed CODEX_HOME, not by scanning the source.
 *
 * The translation rules (which fields survive, why a denial narrows rather than
 * widens, the `[agents.enabled]` landmine) belong to
 * `codex-responses-adapter/src/__tests__/config-writer-agent-roles.test.ts` and
 * are not re-proved here. What only this file can prove is that a real session
 * reaches that code at all.
 *
 * Hermetic, and modelled on `codex-byo-upstream.test.ts`: the adapter launcher,
 * the app-server subprocess and the credential store are faked, so nothing
 * opens a socket or spawns a process. The CODEX_HOME is real — that is the
 * point — and `destroy()` removes it.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import { CODEX_AGENT_ROLE_DIR } from '@nessy-agent/codex-responses-adapter/config-writer';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { BackendConfig } from '../backend/types.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';
import { AGENT_DEFINITION_RUNTIMES, runtimeDispatchesAgentDefinitions } from '../runtime-agent-support.ts';

// ============================================================
// Fakes
// ============================================================

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 4343 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-roles' } } : {};
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
  startAdapter: async (): Promise<AdapterHandle> => ({ port: 45999, close: async () => {} }),
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
  readNestorJwt: () => 'jwt-roles',
  readNestorCreds: () => ({ ok: true, jwt: 'jwt-roles' }),
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

function definition(over: Partial<PiRuntimeAgentDefinitionDescriptor> = {}): PiRuntimeAgentDefinitionDescriptor {
  return {
    schemaVersion: 2,
    key: 'plugin:review-kit:reviewer',
    name: 'reviewer',
    description: 'Reviews a diff for correctness.',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'You review diffs and report defects.',
    sha256: 'a'.repeat(64),
    provenance: 'plugin',
    capabilityGeneration: 'gen-1',
    definitionDigest: 'b'.repeat(64),
    ...over,
  };
}

function agentConfig(definitions?: readonly PiRuntimeAgentDefinitionDescriptor[]): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-codex-roles',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-codex-roles',
      workspaceRootPath: '/tmp/ws-codex-roles',
      sessionRootPath: '/tmp/ws-codex-roles/sessions',
    } as never,
    session: {
      id: 'session-codex-roles',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-codex-roles',
    } as never,
    runtime: codexDriver.buildRuntime({
      context: {
        connection: null,
        provider: 'codex-runtime',
        resolvedModel: MODEL,
        capabilities: { needsHttpPoolServer: false },
      },
      coreConfig: {} as never,
      hostRuntime: {} as never,
      resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
    }),
    ...(definitions ? { piRuntimeAgentDefinitions: definitions } : {}),
  } as BackendConfig;
}

type PrivateAgent = { ensureRuntime: () => Promise<void>; codexHome: string | null };

interface RuntimeProbe {
  configToml: string;
  roleFile: (role: string) => string | undefined;
  diagnostics: string[];
}

/** Start a runtime, read what it wrote into its own CODEX_HOME, tear it down. */
async function probeRuntime(config: BackendConfig): Promise<RuntimeProbe> {
  const agent = new CodexAgent(config);
  const diagnostics: string[] = [];
  agent.onDebug = (message: string) => { diagnostics.push(message); };
  try {
    await (agent as unknown as PrivateAgent).ensureRuntime();
    const home = (agent as unknown as PrivateAgent).codexHome;
    if (!home) throw new Error('CODEX_HOME was never published');
    return {
      configToml: readFileSync(join(home, 'config.toml'), 'utf8'),
      roleFile: (role: string) => {
        const path = join(home, CODEX_AGENT_ROLE_DIR, `${role}.toml`);
        return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
      },
      diagnostics,
    };
  } finally {
    agent.destroy();
  }
}

// No `fetch` stub, deliberately: `ensureRuntime` reaches the faked adapter,
// the faked runtime manager and the faked app-server client, and nothing on
// that path makes a request. A stub here would hide a future path that does.

// ============================================================

describe('CodexAgent — the session\'s agent definitions reach config.toml', () => {
  it('writes an [agents.<role>] block and its role layer for a definition it can express', async () => {
    const probe = await probeRuntime(agentConfig([definition()]));

    expect(probe.configToml).toContain('[agents.reviewer]');
    expect(probe.configToml).toContain('description = "Reviews a diff for correctness."');
    expect(probe.configToml).toContain(`${CODEX_AGENT_ROLE_DIR}/reviewer.toml`);

    // The declaration is worthless without the layer on disk: a `config_file`
    // that does not exist when the app-server reads the config costs that role
    // ("agents.<role>.config_file must point to an existing file at <path>").
    const role = probe.roleFile('reviewer');
    expect(role).toContain('name = "reviewer"');
    expect(role).toContain('developer_instructions = "You review diffs and report defects."');
  });

  it('names a definition it had to deny on the runtime\'s own diagnostic channel', async () => {
    // A declared tool grant is the denial codex cannot honour without WIDENING
    // the agent (no per-role tool policy exists), so the role is dropped — and
    // the drop must be visible, which is what the `onDiagnostic` half wires.
    const probe = await probeRuntime(agentConfig([
      definition(),
      definition({
        key: 'plugin:review-kit:read-only',
        name: 'read-only',
        systemPrompt: 'You only read.',
        tools: ['Read', 'Grep'],
      }),
    ]));

    expect(probe.configToml).not.toContain('[agents.read-only]');
    expect(probe.roleFile('read-only')).toBeUndefined();
    expect(probe.diagnostics.some(line => line.includes('plugin:review-kit:read-only')
      && line.includes('tool grant'))).toBe(true);

    // Positive control for the row above: the denial is per-definition, not a
    // writer that gave up on the whole section.
    expect(probe.configToml).toContain('[agents.reviewer]');
  });

  it('POSITIVE CONTROL: a session with no definitions writes no [agents] section at all', async () => {
    // Without this row the two above could pass against a writer that emitted a
    // constant block. It also pins the pre-wiring behaviour as the honest
    // no-agents answer rather than something the wiring broke.
    const probe = await probeRuntime(agentConfig());
    expect(probe.configToml).not.toContain('[agents.');
    // …and the rest of the config is still there, so "no agents" is not "no config".
    expect(probe.configToml).toContain('model_provider = "nessy_gateway"');
  });
});

describe('AGENT_DEFINITION_RUNTIMES — the gate that decides whether they are built', () => {
  it('admits codex-runtime, so SessionManager materializes definitions for a Codex session', () => {
    // The other half of the wire. `SessionManager` builds descriptors only when
    // this answers true, so `CodexAgent`'s pass-through above is unreachable
    // without it — and `capabilities/resolver.ts` reads the same constant, which
    // is why the catalog row and the session path can never disagree.
    expect(runtimeDispatchesAgentDefinitions('codex-runtime')).toBe(true);
    expect(AGENT_DEFINITION_RUNTIMES.has('codex-runtime')).toBe(true);
  });

  it('POSITIVE CONTROL: still refuses the runtime that dispatches nothing locally', () => {
    // A set that admits everything is not a gate. `nestor-cloud-agent` is a
    // remote A2A backend running no local definitions, and it is now the only
    // provider the gate refuses.
    expect(runtimeDispatchesAgentDefinitions('nestor-cloud-agent')).toBe(false);
    // A session-less read stays provider-blind by design.
    expect(runtimeDispatchesAgentDefinitions(undefined)).toBe(true);
  });
});
