/**
 * F1.750 — codex must honour the host's project trust: a project the user kept RESTRICTED (or never
 * trusted) is written `trust_level = "untrusted"` into the session's `CODEX_HOME/config.toml`, and
 * only a project the user trusted is written `trusted`.
 *
 * ## Why the entry has to be written at all (read in `github.com/openai/codex` at `rust-v0.156.1`)
 *
 * `app-server/src/request_processors/thread_processor.rs` `thread_start_task` AUTO-TRUSTS the cwd
 * whenever `config.active_project.trust_level.is_none()` (and the cwd is not projectless and the
 * effective profile can write it): it writes `trust_level = "trusted"` for the git repo root (or
 * the cwd) into `CODEX_HOME/config.toml` and reloads. The host passed no trust decision, so every
 * project — "Keep restricted" included — had its `.codex` layer loaded: its MCP server commands
 * started, its hooks and `rules/*.rules` loaded (WJ-crit-t, F1.723, measured on the shipped 0.156.1).
 * An explicit entry is `Some(..)`, so the auto-trust never fires, and `config/src/loader/mod.rs`
 * `disabled_reason_for_decision` keeps an untrusted layer out.
 *
 * ## The two keys, and why they differ
 *
 * - UNTRUSTED is keyed on the CWD: `get_active_project` (`config/src/config_toml.rs`) looks the cwd
 *   up FIRST, and `decision_for_dir` answers an ancestor `.codex` folder with no entry of its own
 *   as not-trusted, so one entry keeps every layer from the cwd up to the project root out. Keying
 *   it on a repo root would miss a linked worktree, whose repo root codex resolves to the MAIN
 *   checkout — the auto-trust would then fire and the project AGENTS.md would load.
 * - TRUSTED is keyed on the git repo root (the `.git` walk the host already uses for its project
 *   root), else the cwd — codex's own auto-trust key — so a trusted subdirectory keeps its repo
 *   root's `.codex` exactly as before this row.
 *
 * Both keys are the realpath, because codex's lookup keys are the canonical spelling first
 * (`normalized_project_trust_keys`), and a map key is matched as written.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { BackendConfig } from '../backend/types.ts';

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 1750 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    if (method === 'thread/start') return { thread: { id: 'thread-f1750' } };
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
  startAdapter: async (): Promise<AdapterHandle> => ({ port: 41750, close: async () => {} }),
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
  rmSync(RIG, { recursive: true, force: true });
});

const { CodexAgent } = await import('../codex-agent.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
// `$TMPDIR`, which no git checkout encloses, so the `.git` walk stops only where this rig says.
const RIG = mkdtempSync(join(tmpdir(), 'f1750-trust-rig-'));
const REPO = join(RIG, 'repo');
const SUB = join(REPO, 'packages', 'sub');
const PLAIN = join(RIG, 'plain');
mkdirSync(join(REPO, '.git'), { recursive: true });
mkdirSync(SUB, { recursive: true });
mkdirSync(PLAIN, { recursive: true });
const WS = join(RIG, 'ws');
mkdirSync(WS, { recursive: true });

function agentConfig(workingDirectory: string, projectTrusted: boolean | undefined): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    model: MODEL,
    isHeadless: true,
    ...(projectTrusted === undefined ? {} : { projectTrusted }),
    workspace: {
      id: 'ws-f1750', name: 'Test Workspace', rootPath: WS, workspaceRootPath: WS, sessionRootPath: `${WS}/sessions`,
    } as never,
    session: { id: 'session-f1750', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory } as never,
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
  teardownRuntime: () => Promise<void>;
  codexHome: string | null;
  sessionFacts: Map<string, string>;
  destroy: () => void;
  updateWorkingDirectory: (path: string) => void;
  prepareWorkingDirectoryUpdate?: (input: { previousPath: string; path: string; intent: 'keep' | 'bind' | 'unbind'; projectTrusted: boolean }) => Promise<{
    commit: () => Promise<void>; rollback: () => Promise<void>; finalize: () => Promise<void>;
  }>;
}

const live: PrivateAgent[] = [];
afterEach(() => {
  for (const agent of live.splice(0)) agent.destroy();
});

async function startAgent(workingDirectory: string, projectTrusted: boolean | undefined): Promise<PrivateAgent> {
  const agent = new CodexAgent(agentConfig(workingDirectory, projectTrusted)) as unknown as PrivateAgent;
  live.push(agent);
  await agent.ensureRuntime();
  return agent;
}

/** Every `[projects."<key>"]` entry of the session's own config.toml, as `{ key: trust_level }`. */
function trustEntries(agent: PrivateAgent): Record<string, string> {
  const toml = readFileSync(join(agent.codexHome!, 'config.toml'), 'utf-8');
  const entries: Record<string, string> = {};
  const re = /^\[projects\.("(?:[^"\\]|\\.)*")\]\ntrust_level = "([a-z]+)"$/gm;
  for (let m = re.exec(toml); m; m = re.exec(toml)) entries[JSON.parse(m[1]!) as string] = m[2]!;
  return entries;
}

describe('F1.750 — the host project trust reaches codex as an explicit trust entry', () => {
  it('a project the user kept restricted is written untrusted, keyed on the cwd, and the cost is said', async () => {
    const agent = await startAgent(SUB, false);
    expect(trustEntries(agent)).toEqual({ [realpathSync(SUB)]: 'untrusted' });
    const fact = agent.sessionFacts.get('codex-project-trust') ?? '(no fact)';
    expect(fact).toContain('untrusted');
    expect(fact).toContain('AGENTS.md');
    // F1.947 — F1.845 keeps the project's skills out too (`refreshCodexRestrictedRepoSkills`), so the
    // fact names both roots codex scopes `repo`; the trusted arm below pins that no fact is said.
    expect(fact).toContain('`.codex/skills`');
    expect(fact).toContain('`.agents/skills`');
  });

  it('no decision at all (undefined) is the host\'s fail-closed default — untrusted, like false', async () => {
    const agent = await startAgent(PLAIN, undefined);
    expect(trustEntries(agent)).toEqual({ [realpathSync(PLAIN)]: 'untrusted' });
  });

  it('a trusted project is written trusted, keyed on its git repo root (codex\'s own auto-trust key)', async () => {
    const agent = await startAgent(SUB, true);
    expect(trustEntries(agent)).toEqual({ [realpathSync(REPO)]: 'trusted' });
    expect(agent.sessionFacts.has('codex-project-trust')).toBe(false);
  });

  it('CONTROL — a trusted project outside any git checkout is keyed on the cwd itself', async () => {
    const agent = await startAgent(PLAIN, true);
    expect(trustEntries(agent)).toEqual({ [realpathSync(PLAIN)]: 'trusted' });
  });
});

/**
 * F1.769 — a rebind carries the NEW folder's trust. `SessionManager`'s session project mutation hands a runtime its
 * `prepareWorkingDirectoryUpdate({ path, projectTrusted })` when it has one, and otherwise only
 * `updateWorkingDirectory(path)`; restated here so the test drives the same branch. Before this row codex had no such
 * hook, so the trust captured at agent creation stayed and the next runtime build wrote the new folder with it.
 */
async function rebindLikeSessionManager(agent: PrivateAgent, previousPath: string, path: string, projectTrusted: boolean): Promise<{ rollback: () => Promise<void> }> {
  if (agent.prepareWorkingDirectoryUpdate) {
    const transaction = await agent.prepareWorkingDirectoryUpdate({ previousPath, path, intent: 'bind', projectTrusted });
    await transaction.commit();
    await transaction.finalize();
    return transaction;
  }
  agent.updateWorkingDirectory(path);
  return { rollback: async () => { agent.updateWorkingDirectory(previousPath); } };
}

describe('F1.769 — a working-directory rebind carries the new folder\'s trust into the next runtime build', () => {
  it('FAILING ARM: a trusted session rebound to a restricted folder, then rebuilt, writes the NEW folder untrusted', async () => {
    const agent = await startAgent(SUB, true);
    expect(trustEntries(agent)).toEqual({ [realpathSync(REPO)]: 'trusted' });
    await rebindLikeSessionManager(agent, SUB, PLAIN, false);
    await agent.teardownRuntime();
    await agent.ensureRuntime();
    expect(trustEntries(agent)).toEqual({ [realpathSync(PLAIN)]: 'untrusted' });
  });

  it('BOUNDARY: a restricted session rebound to a trusted folder writes it trusted; a rolled-back rebind restores the old folder and its trust', async () => {
    const agent = await startAgent(PLAIN, false);
    await rebindLikeSessionManager(agent, PLAIN, SUB, true);
    await agent.teardownRuntime();
    await agent.ensureRuntime();
    expect(trustEntries(agent)).toEqual({ [realpathSync(REPO)]: 'trusted' });
    const again = await rebindLikeSessionManager(agent, SUB, PLAIN, true);
    await again.rollback();
    await agent.teardownRuntime();
    await agent.ensureRuntime();
    expect(trustEntries(agent)).toEqual({ [realpathSync(REPO)]: 'trusted' });
  });
});
