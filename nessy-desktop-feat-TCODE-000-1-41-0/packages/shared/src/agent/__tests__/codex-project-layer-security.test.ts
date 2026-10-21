/**
 * F1.723 — a project folder's `.codex/config.toml` must not turn the codex sandbox off: the host's
 * sandbox, approval and permission choice travels on every thread OPEN and every REFORK as the
 * request `config` layer, which codex ranks ABOVE every project layer.
 *
 * ## The mechanism (read in `github.com/openai/codex` at `rust-v0.156.1`)
 *
 * - `config/src/loader/mod.rs` (`load_config_layers_state`) stacks user (`CODEX_HOME/config.toml`,
 *   the one this host writes) < project (`<cwd>/.codex/config.toml` and the dirs up to the project
 *   root) < `SessionFlags` (CLI `-c` plus the request `config` map, `app-server/src/config_manager.rs`
 *   `load_with_cli_overrides`). A project layer is sanitized only for a provider/URL denylist
 *   (`PROJECT_LOCAL_CONFIG_DENYLIST`); `sandbox_mode`, `approval_policy`, `default_permissions` and
 *   `permissions` all pass.
 * - `core/src/config/mod.rs` (`resolve_permission_config_syntax`) lets the HIGHEST layer that names
 *   `sandbox_mode` or `default_permissions` pick the syntax, except that a `SessionFlags`
 *   `default_permissions` always selects profiles. So a project's bare `sandbox_mode =
 *   "danger-full-access"` discarded the host's `default_permissions = "nessy_runtime"` profile.
 * - `app-server/src/request_processors/thread_processor.rs` (`thread_start_task`) AUTO-TRUSTS the cwd
 *   (writes `[projects."<cwd>"] trust_level = "trusted"` into `CODEX_HOME/config.toml`) whenever the
 *   project has no trust entry, is not projectless and the profile can write it — so the host's
 *   "Keep restricted" never kept a `.codex` layer out. With the home directory as the project the
 *   user's own Codex CLI `~/.codex/config.toml` is that layer (it is not this session's CODEX_HOME).
 *
 * ## Measured on the shipped `codex-app-server` 0.156.1 (`work/wjcritt/f1723-probe.ts`, 2026-09-25)
 *
 * Scratch HOME whose `.codex/config.toml` says `sandbox_mode = "danger-full-access"` and
 * `approval_policy = "never"`, cwd = that HOME, config from the product's `writeCodexConfig`, every
 * approval DECLINED: at HEAD (no `config` on `thread/start`) the agent's write to the workspace's
 * `permissions.json` and to a path outside every root both LANDED with no approval asked; with the
 * host layer as `config` both were refused, on `thread/start` and again after `thread/fork`.
 *
 * ## What this file pins
 *
 * The request the PRODUCT sends: every open leg and both refork legs carry `sandbox_mode`,
 * `approval_policy` and `default_permissions` equal to the values the session's own `config.toml`
 * says, and a resolved approval policy that differs from the host's is SAID as a session fact.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { BackendConfig } from '../backend/types.ts';

interface RecordedRequest { method: string; params: Record<string, unknown> }

let recorded: RecordedRequest[] = [];
let forkRefusal: string | null = null;
let resolvedApprovalPolicy: string | undefined;

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 1723 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string, params?: unknown): Promise<unknown> {
    recorded.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (method === 'thread/fork' && forkRefusal) throw new Error(forkRefusal);
    if (method === 'thread/start') {
      return { thread: { id: `thread-${recorded.length}` }, ...(resolvedApprovalPolicy ? { approvalPolicy: resolvedApprovalPolicy } : {}) };
    }
    if (method === 'thread/fork') return { thread: { id: `fork-${recorded.length}` } };
    return {};
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
  startAdapter: async (): Promise<AdapterHandle> => ({ port: 41723, close: async () => {} }),
}));
// Both creds readers, from one literal — a spread isolates only the names it lists.
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

const { CodexAgent, codexThreadApprovalsReviewer } = await import('../codex-agent.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const WS = '/tmp/ws-f1723';

function agentConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-f1723', name: 'Test Workspace', rootPath: WS, workspaceRootPath: WS, sessionRootPath: `${WS}/sessions`,
    } as never,
    session: { id: 'session-f1723', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: `${WS}/proj` } as never,
    runtime: codexDriver.buildRuntime({
      context: { connection: null, provider: 'codex-runtime', resolvedModel: MODEL, capabilities: { needsHttpPoolServer: false } },
      coreConfig: {} as never,
      hostRuntime: {} as never,
      resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
    }),
  } as BackendConfig;
}

interface PrivateAgent {
  ensureRuntime: () => Promise<void>;
  applySelectedPluginSkillRuntimePolicy: (p: { environment: Record<string, string>; writablePaths: string[] }) => Promise<void>;
  codexHome: string | null;
  sessionFacts: Map<string, string>;
  destroy: () => void;
  // F1.926 — the reviewer state the request layer reads.
  configuredApprovalsReviewer: 'auto_review' | undefined;
  managedApprovalsReviewers: readonly ('user' | 'auto_review')[] | undefined;
  autoReviewSettingOn: () => boolean;
}

const live: PrivateAgent[] = [];
afterEach(() => {
  for (const agent of live.splice(0)) agent.destroy();
  forkRefusal = null;
  resolvedApprovalPolicy = undefined;
});

async function startAgent(): Promise<PrivateAgent> {
  recorded = [];
  const agent = new CodexAgent(agentConfig()) as unknown as PrivateAgent;
  live.push(agent);
  await agent.ensureRuntime();
  return agent;
}

/** The three top-level security keys exactly as the session's own `config.toml` spells them. */
function writtenSecurityKeys(agent: PrivateAgent): Record<string, string> {
  const toml = readFileSync(join(agent.codexHome!, 'config.toml'), 'utf-8');
  const keys: Record<string, string> = {};
  for (const key of ['sandbox_mode', 'approval_policy', 'default_permissions']) {
    const match = new RegExp(`^${key} = "([^"]+)"$`, 'm').exec(toml);
    if (match) keys[key] = match[1]!;
  }
  return keys;
}

function securityKeysOf(params: Record<string, unknown>): Record<string, unknown> {
  const config = (params.config ?? {}) as Record<string, unknown>;
  const keys: Record<string, unknown> = {};
  for (const key of ['sandbox_mode', 'approval_policy', 'default_permissions']) {
    if (config[key] !== undefined) keys[key] = config[key];
  }
  return keys;
}

const PLUGIN_DRIFT = { environment: { NESSY_TEST_PLUGIN: '1' }, writablePaths: [`${WS}/proj/plugin`] };

describe('F1.723 — the host security layer rides every thread open and refork as `config`', () => {
  it('thread/start carries sandbox_mode, approval_policy and default_permissions equal to config.toml', async () => {
    const agent = await startAgent();
    const written = writtenSecurityKeys(agent);
    // The positive control on the reader: the writer really emits all three here.
    expect(Object.keys(written).sort()).toEqual(['approval_policy', 'default_permissions', 'sandbox_mode']);
    const starts = recorded.filter(r => r.method === 'thread/start');
    expect(starts).toHaveLength(1);
    expect(securityKeysOf(starts[0]!.params)).toEqual(written);
    // The profile TABLE travels with its selector, so a project layer cannot re-point `extends`.
    const permissions = ((starts[0]!.params.config ?? {}) as Record<string, Record<string, unknown>>).permissions ?? {};
    expect(Object.keys(permissions)).toEqual([written.default_permissions!]);
  });

  it('the refork (thread/fork) on a config drift carries the same layer', async () => {
    const agent = await startAgent();
    await agent.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    const forks = recorded.filter(r => r.method === 'thread/fork');
    expect(forks).toHaveLength(1);
    expect(securityKeysOf(forks[0]!.params)).toEqual(writtenSecurityKeys(agent));
  });

  it('the rollout-less thread/start fallback of the refork carries it too', async () => {
    const agent = await startAgent();
    forkRefusal = 'no rollout found for thread id thread-1';
    await agent.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    const starts = recorded.filter(r => r.method === 'thread/start');
    expect(starts).toHaveLength(2);
    expect(securityKeysOf(starts[1]!.params)).toEqual(writtenSecurityKeys(agent));
  });

  it('a resolved approval policy that is not the host\'s is SAID; the host\'s own is not', async () => {
    resolvedApprovalPolicy = 'never';
    const agent = await startAgent();
    expect(writtenSecurityKeys(agent).approval_policy).not.toBe('never');
    expect(agent.sessionFacts.get('codex-resolved-approval-policy') ?? '(no fact)').toContain('"never"');
    agent.destroy();
    live.splice(0);
    resolvedApprovalPolicy = undefined;
    const control = await startAgent();
    resolvedApprovalPolicy = writtenSecurityKeys(control).approval_policy;
    control.destroy();
    live.splice(0);
    const same = await startAgent();
    expect(same.sessionFacts.get('codex-resolved-approval-policy') ?? '(no fact)').toBe('(no fact)');
  });
});

/**
 * F1.926 — `approvals_reviewer` is a top-level key `PROJECT_LOCAL_CONFIG_DENYLIST` does not strip (read at
 * `rust-v0.156.1`), so a TRUSTED project layer naming `auto_review` outranked the host's user layer, which names
 * no reviewer while the Settings toggle is off; a turn then asks for nothing either, so codex's reviewer — not
 * the host — answered every escalated approval. The request layer now names the host's reviewer on every leg.
 */
function reviewerOf(params: Record<string, unknown>): unknown {
  return ((params.config ?? {}) as Record<string, unknown>).approvals_reviewer ?? '(none)';
}

describe('F1.926 — the request layer restates who reviews an escalated approval', () => {
  it('toggle off: every open and refork leg names codex\'s `user` reviewer, so a project layer cannot hand approvals to its own', async () => {
    const agent = await startAgent();
    // The premise, positively: the user layer the host writes names no reviewer, so nothing else outranks a project's.
    expect(readFileSync(join(agent.codexHome!, 'config.toml'), 'utf-8')).not.toMatch(/^approvals_reviewer\b/m);
    await agent.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    const legs = recorded.filter(r => r.method === 'thread/start' || r.method === 'thread/fork');
    expect(legs.map(r => `${r.method}=${String(reviewerOf(r.params))}`)).toEqual(['thread/start=user', 'thread/fork=user']);
    const fallback = await startAgent();
    forkRefusal = 'no rollout found for thread id thread-1';
    await fallback.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    const starts = recorded.filter(r => r.method === 'thread/start');
    expect(starts.map(r => reviewerOf(r.params))).toEqual(['user', 'user']);
  });

  it('the host\'s own `auto_review` is restated, the toggle is re-read, and an administrator list that forbids the wanted reviewer is left to codex', async () => {
    const agent = await startAgent();
    agent.configuredApprovalsReviewer = 'auto_review';
    agent.autoReviewSettingOn = () => true;
    await agent.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    agent.autoReviewSettingOn = () => false; // F1.781 — turned off in a live session
    await agent.applySelectedPluginSkillRuntimePolicy({ ...PLUGIN_DRIFT, environment: { NESSY_TEST_PLUGIN: '2' } });
    agent.configuredApprovalsReviewer = undefined;
    agent.managedApprovalsReviewers = ['auto_review']; // F1.482 — the administrator's reviewer stands, and F1.514 says so
    await agent.applySelectedPluginSkillRuntimePolicy({ ...PLUGIN_DRIFT, environment: { NESSY_TEST_PLUGIN: '3' } });
    const forks = recorded.filter(r => r.method === 'thread/fork');
    expect(forks.map(r => reviewerOf(r.params))).toEqual(['auto_review', 'user', '(none)']);
  });

  it('the pure rule: codex\'s enum spelling, the toggle, and the administrator list', () => {
    expect(codexThreadApprovalsReviewer(undefined, undefined, false)).toEqual({ approvals_reviewer: 'user' });
    expect(codexThreadApprovalsReviewer(undefined, undefined, true)).toEqual({ approvals_reviewer: 'user' });
    expect(codexThreadApprovalsReviewer('auto_review', undefined, true)).toEqual({ approvals_reviewer: 'auto_review' });
    expect(codexThreadApprovalsReviewer('auto_review', undefined, false)).toEqual({ approvals_reviewer: 'user' });
    expect(codexThreadApprovalsReviewer(undefined, ['user', 'auto_review'], false)).toEqual({ approvals_reviewer: 'user' });
    expect(codexThreadApprovalsReviewer('auto_review', ['user'], true)).toEqual({});
    expect(codexThreadApprovalsReviewer(undefined, ['auto_review'], false)).toEqual({});
  });
});
