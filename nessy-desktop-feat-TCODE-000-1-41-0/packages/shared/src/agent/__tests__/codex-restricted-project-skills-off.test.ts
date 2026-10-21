/**
 * F1.845 — a project the user kept restricted keeps its skills out on codex, through codex's OWN
 * per-skill disable.
 *
 * ## Why (measured by WJ-crit-jjj on the shipped `codex-app-server` 0.156.1, pinned by
 * `packages/codex-responses-adapter/src/__tests__/config-writer-untrusted-project-skills-live.test.ts`)
 *
 * codex builds its skill roots from every config layer INCLUDING a disabled project layer
 * (`ext/skills/src/host_roots.rs` `roots_from_layer_stack`) and probes `.agents/skills` from the
 * project root down to the cwd with no trust check (`repo_agents_skill_roots`), so an `untrusted`
 * trust entry (F1.750) keeps a project's config, hooks and rules out and its skills IN. No key keeps a
 * ROOT out; the one mechanism codex has is per skill — `skills.config = [{ path, enabled }]`, read from
 * the User and SessionFlags layers (`config/src/skills_config.rs` `skill_config_rules_from_stack`).
 *
 * ## What this file pins (the request the PRODUCT sends)
 *
 * For an UNTRUSTED project, codex's own `skills/list { cwds: [cwd], forceReload: true }` runs before
 * every thread OPEN (`thread/start`, the relaunch `thread/resume`, the branch `thread/fork`) and before
 * the refork walk, and every one of those requests carries `skills.config` disabling exactly the
 * skills codex itself reported with `scope: 'repo'` — in the same request `config` map F1.723's
 * security layer rides. A `skills/list` that fails refuses the open (fail closed). CONTROLS: a
 * trusted project sends no `skills` key and lists nothing before the open; the user's and codex's
 * own skills are never named; the F1.723 security keys and the F1.750 trust entry are unchanged.
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

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const WS = '/tmp/ws-f1845';
const CWD = `${WS}/proj`;

let recorded: RecordedRequest[] = [];
let forkRefusal: string | null = null;
let listFailure: string | null = null;
let listCalls = 0;

/** codex's own answer: two project skills (scope `repo`), the user's own and one bundled. */
function listedSkills(): unknown {
  listCalls += 1;
  const repo = [
    { name: 'proj-codex', scope: 'repo', enabled: true, path: `${CWD}/.codex/skills/proj-codex/SKILL.md` },
    { name: 'proj-agents', scope: 'repo', enabled: true, path: `${CWD}/.agents/skills/proj-agents/SKILL.md` },
  ];
  // A skill created after the first read: only a RE-read can name it.
  if (listCalls > 1) repo.push({ name: 'proj-later', scope: 'repo', enabled: true, path: `${CWD}/.agents/skills/proj-later/SKILL.md` });
  return {
    data: [{
      cwd: CWD,
      errors: [],
      skills: [
        ...repo,
        { name: 'mine', scope: 'user', enabled: true, path: '/Users/someone/.agents/skills/mine/SKILL.md' },
        { name: 'skill-creator', scope: 'system', enabled: true, path: '/codex-home/skills/.system/skill-creator/SKILL.md' },
      ],
    }],
  };
}

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 1845 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string, params?: unknown): Promise<unknown> {
    recorded.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (method === 'skills/list') {
      if (listFailure) throw new Error(listFailure);
      return listedSkills();
    }
    if (method === 'thread/fork' && forkRefusal) throw new Error(forkRefusal);
    if (method === 'thread/start') return { thread: { id: `thread-${recorded.length}` } };
    if (method === 'thread/fork') return { thread: { id: `fork-${recorded.length}` } };
    if (method === 'thread/resume') return { thread: { id: `resumed-${recorded.length}` } };
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
  startAdapter: async (): Promise<AdapterHandle> => ({ port: 41845, close: async () => {} }),
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

const { CodexAgent } = await import('../codex-agent.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

function agentConfig(extra: { projectTrusted?: boolean; session?: Record<string, unknown> } = {}): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    model: MODEL,
    isHeadless: true,
    ...(extra.projectTrusted !== undefined ? { projectTrusted: extra.projectTrusted } : {}),
    workspace: {
      id: 'ws-f1845', name: 'Test Workspace', rootPath: WS, workspaceRootPath: WS, sessionRootPath: `${WS}/sessions`,
    } as never,
    session: {
      id: 'session-f1845', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: CWD, ...(extra.session ?? {}),
    } as never,
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
  destroy: () => void;
}

const live: PrivateAgent[] = [];
afterEach(() => {
  for (const agent of live.splice(0)) agent.destroy();
  forkRefusal = null;
  listFailure = null;
});

async function startAgent(extra: Parameters<typeof agentConfig>[0] = {}): Promise<PrivateAgent> {
  recorded = [];
  listCalls = 0;
  const agent = new CodexAgent(agentConfig(extra)) as unknown as PrivateAgent;
  live.push(agent);
  await agent.ensureRuntime();
  return agent;
}

const OPEN_METHODS = ['thread/start', 'thread/resume', 'thread/fork'];
const isPreOpenList = (r: RecordedRequest): boolean => r.method === 'skills/list' && r.params.forceReload === true;
/** `config.skills` read into a local first — never asserted through a matcher on the live object. */
function skillsKeyOf(r: RecordedRequest | undefined): unknown {
  const config = (r?.params.config ?? {}) as Record<string, unknown>;
  return config.skills;
}
const off = (...names: string[]) => names.map(name => ({
  path: name === 'proj-codex' ? `${CWD}/.codex/skills/${name}/SKILL.md` : `${CWD}/.agents/skills/${name}/SKILL.md`,
  enabled: false,
}));
const PLUGIN_DRIFT = { environment: { NESSY_TEST_PLUGIN: '1' }, writablePaths: [`${CWD}/plugin`] };

describe('F1.845 — an untrusted project\'s skills are disabled on every codex thread open, in codex\'s own vocabulary', () => {
  it('thread/start: codex\'s own skills/list for the cwd runs FIRST, and the open disables exactly its repo-scope skills', async () => {
    const agent = await startAgent();
    const listIndex = recorded.findIndex(isPreOpenList);
    const startIndex = recorded.findIndex(r => r.method === 'thread/start');
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(listIndex).toBeLessThan(startIndex);
    expect(recorded[listIndex]!.params.cwds).toEqual([CWD]);
    const skills = skillsKeyOf(recorded[startIndex]);
    expect(skills).toEqual({ config: off('proj-codex', 'proj-agents') });
    // CONTROL: the user's own skill and codex's bundled one are never named.
    expect(JSON.stringify(skills)).not.toContain('/Users/someone/.agents/skills/mine');
    expect(JSON.stringify(skills)).not.toContain('skill-creator');
    // CONTROL (F1.723): the host's security keys still ride the same map.
    const config = recorded[startIndex]!.params.config as Record<string, unknown>;
    expect(typeof config.sandbox_mode).toBe('string');
    expect(typeof config.default_permissions).toBe('string');
    // CONTROL (F1.750): the trust entry is still written, and nothing skill-shaped lands in the user layer.
    const toml = readFileSync(join(agent.codexHome!, 'config.toml'), 'utf-8');
    expect(toml).toContain('trust_level = "untrusted"');
    expect(toml).not.toContain('[[skills.config]]');
  });

  it('a relaunch (thread/resume) and a branch (thread/fork) carry the same disable', async () => {
    await startAgent({ session: { sdkSessionId: 'thread-persisted' } });
    const resume = recorded.find(r => r.method === 'thread/resume');
    expect(resume?.params.threadId).toBe('thread-persisted');
    expect(recorded.findIndex(isPreOpenList)).toBeLessThan(recorded.indexOf(resume!));
    expect(skillsKeyOf(resume)).toEqual({ config: off('proj-codex', 'proj-agents') });
    for (const agent of live.splice(0)) agent.destroy();

    await startAgent({ session: { branchFrom: { sdkSessionId: 'parent-thread', sdkTurnId: 'turn-1' } } });
    const fork = recorded.find(r => r.method === 'thread/fork');
    expect(fork?.params.threadId).toBe('parent-thread');
    expect(skillsKeyOf(fork)).toEqual({ config: off('proj-codex', 'proj-agents') });
  });

  it('the refork RE-reads the list, and both legs (thread/fork and its rollout-less thread/start fallback) carry it', async () => {
    const agent = await startAgent();
    recorded = [];
    await agent.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    const listIndex = recorded.findIndex(isPreOpenList);
    const forkIndex = recorded.findIndex(r => r.method === 'thread/fork');
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(listIndex).toBeLessThan(forkIndex);
    // The skill created after the open is named: the walk read codex's list again.
    expect(skillsKeyOf(recorded[forkIndex])).toEqual({ config: off('proj-codex', 'proj-agents', 'proj-later') });

    const fallback = await startAgent();
    forkRefusal = 'no rollout found for thread id thread-1';
    recorded = [];
    await fallback.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    const start = recorded.find(r => r.method === 'thread/start');
    expect(skillsKeyOf(start)).toEqual({ config: off('proj-codex', 'proj-agents', 'proj-later') });
  });

  it('FAIL CLOSED: a skills/list that fails refuses the open with a legible error, and no thread is opened', async () => {
    listFailure = 'skills/list refused (probe)';
    recorded = [];
    listCalls = 0;
    const agent = new CodexAgent(agentConfig()) as unknown as PrivateAgent;
    live.push(agent);
    let message = '';
    try { await agent.ensureRuntime(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('skills/list refused (probe)');
    expect(message).toContain('not trusted');
    expect(recorded.some(r => OPEN_METHODS.includes(r.method))).toBe(false);
  });

  it('FAIL CLOSED on the refork too: no thread/fork is sent when the re-read fails', async () => {
    const agent = await startAgent();
    listFailure = 'skills/list refused (probe)';
    recorded = [];
    let message = '';
    try { await agent.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('skills/list refused (probe)');
    expect(recorded.some(r => OPEN_METHODS.includes(r.method))).toBe(false);
  });

  it('CONTROL: a trusted project lists nothing before the open and sends no skills key', async () => {
    const agent = await startAgent({ projectTrusted: true });
    expect(recorded.some(isPreOpenList)).toBe(false);
    const start = recorded.find(r => r.method === 'thread/start');
    expect(skillsKeyOf(start)).toBeUndefined();
    recorded = [];
    await agent.applySelectedPluginSkillRuntimePolicy(PLUGIN_DRIFT);
    expect(recorded.some(isPreOpenList)).toBe(false);
    expect(skillsKeyOf(recorded.find(r => r.method === 'thread/fork'))).toBeUndefined();
  });
});
