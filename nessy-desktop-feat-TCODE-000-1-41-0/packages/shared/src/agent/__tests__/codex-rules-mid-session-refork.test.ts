/**
 * F1.928 — a readable DENY (or ASK) rule added while a codex session is running must hold for that
 * session's in-sandbox commands from the NEXT TURN.
 *
 * The rule's only enforcement for a command codex auto-approves (an in-workspace command under
 * `on-request`, every command in Bypass) is the execpolicy projection `CODEX_HOME/rules/nessy.rules`,
 * because no approval request is raised and the host's `consultPermissionRules` never runs. Until this
 * row that file was written once, by `writeCodexConfig` at `createRuntime`.
 *
 * MEASURED FIRST (WJ-crit-iii, 2026-09-25, `work/wjcritiii/f1928-probe.ts`, the shipped
 * `codex-app-server` `rust-v0.156.1`, the product's own `writeCodexConfig` and
 * `collectExecpolicy*Prefixes` over a workspace `permissions.json`, a stub Responses upstream, mode
 * `bypassPermissions`): with NO rule at boot, `touch f1928-a1.txt` ran (control); the host then
 * rewrote `rules/nessy.rules` with a `forbidden` touch rule and a `prompt` mkdir rule, and in the SAME
 * thread `touch f1928-a2.txt` RAN (exit 0) and `mkdir f1928-m2` RAN with no approval request — a
 * rewrite alone reaches nothing; after the host's own `thread/fork`, `touch f1928-a3.txt` was refused
 * (no commandExecution item), `mkdir f1928-m3` raised `item/commandExecution/requestApproval`, and an
 * unmatched `touch f1928-a4.txt` still ran (control). The source agrees (`openai/codex@rust-v0.156.1`
 * `codex-rs/core/src/session/mod.rs` `spawn_internal`): `ExecPolicyManager::load` runs once per
 * session spawn, and `thread/fork` spawns a new session with no inherited policy.
 *
 * So the fix is the turn-head re-fork `applySelectedPluginSkillRuntimePolicy` already owns: re-project
 * the rules, rewrite the file, and re-fork when the projection moved. This file drives that seam with a
 * double for the app-server channel and a REAL `CODEX_HOME` and workspace store on disk.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexConfig } from '@nessy-agent/codex-responses-adapter/config-writer';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import {
  collectExecpolicyAllowPrefixes,
  collectExecpolicyDenyPrefixes,
  collectExecpolicyPromptPrefixes,
  loadRawWorkspacePermissions,
} from '../permissions-config.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-f1928';
const SESSION_ID = 'session-f1928';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

const DENY_TOUCH = { id: 'deny-touch', action: 'deny', match: { kind: 'bash', executable: 'touch', args: ['sit-ah-denied.txt'] } };
const ASK_MKDIR = { id: 'ask-mkdir', action: 'ask', match: { kind: 'bash', executable: 'mkdir', args: ['f1928-m'] } };
const ALLOW_LS = { id: 'allow-ls', action: 'allow', match: { kind: 'bash', executable: 'ls' } };
const FORBIDDEN_TOUCH = 'prefix_rule(pattern=["touch", "sit-ah-denied.txt"], decision="forbidden"';
const PROMPT_MKDIR = 'prefix_rule(pattern=["mkdir", "f1928-m"], decision="prompt"';
const ALLOW_LS_RULE = 'prefix_rule(pattern=["ls"], decision="allow")';

const dirs: string[] = [];
afterEach(() => {
  cleanupModeState(SESSION_KEY);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeRules(root: string, rules: unknown[]): void {
  writeFileSync(join(root, 'permissions.json'), JSON.stringify({ permissionDsl: { version: 1, rules } }));
}

interface Harness {
  agent: CodexAgent;
  home: string;
  root: string;
  forks: () => number;
  rulesFile: () => string | null;
  refork: (timeoutMs?: number) => Promise<void>;
  wedgeFork: (wedged: boolean) => void;
}

/**
 * A session whose runtime was built the way `createRuntime` builds it: `writeCodexConfig` projects the
 * workspace store AS IT IS AT START into `CODEX_HOME/rules/nessy.rules`, with the same three collectors
 * `CodexAgent.collectExecpolicy*Prefixes` call. Then one turn head is run so the recorded thread
 * signature is the live one, and the fork counter is reset — every later fork is one a turn head chose.
 */
async function openSession(startRules: unknown[] | null): Promise<Harness> {
  cleanupModeState(SESSION_KEY);
  const root = mkdtempSync(join(tmpdir(), 'f1928-ws-'));
  const home = mkdtempSync(join(tmpdir(), 'f1928-home-'));
  dirs.push(root, home);
  if (startRules) writeRules(root, startRules);
  const raw = loadRawWorkspacePermissions(root);
  writeCodexConfig({
    codexHome: home,
    model: 'codex/test-model',
    adapterPort: 1,
    mode: 'bypassPermissions',
    sandboxGloballyEnabled: false,
    deniedReadPaths: [join(root, 'credentials.enc')],
    execpolicyAllowPrefixes: collectExecpolicyAllowPrefixes(raw),
    execpolicyDenyPrefixes: collectExecpolicyDenyPrefixes(raw),
    execpolicyPromptPrefixes: collectExecpolicyPromptPrefixes(raw),
  });

  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: { id: WORKSPACE_ID, name: 'F1.928', rootPath: root, workspaceRootPath: root, sessionRootPath: join(root, 'sessions') } as any,
    session: { id: SESSION_ID, workspaceRootPath: root, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  let forkCount = 0;
  let wedged = false;
  (agent as any).client = {
    request(method: string, _params: unknown, requestOptions?: { timeoutMs?: number }) {
      if (method === 'thread/fork') {
        if (wedged) {
          const ms = requestOptions?.timeoutMs ?? 1_000;
          return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`app-server request thread/fork timed out after ${ms}ms`)), ms));
        }
        forkCount += 1;
        return Promise.resolve({ thread: { id: `thread-forked-${forkCount}` } });
      }
      return Promise.resolve({ thread: { id: 'thread-fresh' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).threadId = 'thread-original';
  (agent as any).codexHome = home;
  (agent as any).runtimeConfigSignature = 'stale-signature';
  const refork = (timeoutMs?: number): Promise<void> => (timeoutMs === undefined
    ? (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] })
    : (agent as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] }, timeoutMs));
  await refork();
  forkCount = 0;
  const file = join(home, 'rules', 'nessy.rules');
  return {
    agent,
    home,
    root,
    forks: () => forkCount,
    rulesFile: () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
    refork,
    wedgeFork: (value: boolean) => { wedged = value; },
  };
}

describe('F1.928 · a rule added mid-session reaches the live codex thread at the next turn head', () => {
  it('FAILING ARM: a session opened with NO rule, a deny rule added — the next turn head projects it and re-forks', async () => {
    const h = await openSession(null);
    expect(h.rulesFile()).toBeNull();

    writeRules(h.root, [DENY_TOUCH]);
    await h.refork();

    // The file codex loads at a thread spawn now carries the refusal …
    expect(h.rulesFile()).toContain(FORBIDDEN_TOUCH);
    // … and a thread was spawned to load it: a rewrite alone reaches nothing (measured, header).
    expect(h.forks()).toBe(1);
    expect((h.agent as any).threadId).toBe('thread-forked-1');

    // Once applied, a steady store forks nothing more.
    await h.refork();
    expect(h.forks()).toBe(1);
    h.agent.destroy();
  });

  it('an ASK rule added mid-session is projected as decision="prompt" and re-forks too (F1.870\'s card needs codex to ask)', async () => {
    const h = await openSession(null);
    writeRules(h.root, [ASK_MKDIR]);
    await h.refork();
    expect(h.rulesFile()).toContain(PROMPT_MKDIR);
    expect(h.forks()).toBe(1);
    h.agent.destroy();
  });

  it('CONTROL: a rule present at session start holds with NO fork, and the durable grants\' projection is byte-identical', async () => {
    const h = await openSession([DENY_TOUCH, ALLOW_LS]);
    const atStart = h.rulesFile();
    expect(atStart).toContain(FORBIDDEN_TOUCH);
    expect(atStart).toContain(ALLOW_LS_RULE);

    await h.refork();
    await h.refork();

    expect(h.forks()).toBe(0);
    expect(h.rulesFile()).toBe(atStart);
    h.agent.destroy();
  });

  it('CONTROL: the FIRST turn head of a session whose store did not move forks nothing (the turn-head projection agrees with writeCodexConfig)', async () => {
    const primed = await openSession([DENY_TOUCH, ASK_MKDIR, ALLOW_LS]);
    const liveSignature = (primed.agent as any).runtimeConfigSignature;
    // Re-derived 2026-10-10: since F1.670 (3fe411a98) the recorded signature carries the
    // workspace records' ABSOLUTE read keys (codexReadOnlyPaths), so it is root-bearing and a
    // transplant onto a second openSession's random tmp root could never agree. The fresh
    // agent therefore runs on the PRIMED session's own config (the same root), while the
    // CODEX_HOME below stays the second session's — written by writeCodexConfig ALONE, so the
    // no-fork outcome still proves the turn-head projection agrees with the start-time writer.
    const sameRootConfig = (primed.agent as any).config;
    primed.agent.destroy();

    const h = await openSession([DENY_TOUCH, ASK_MKDIR, ALLOW_LS]);
    // A fresh agent whose recorded signature already matches: only a RULES drift could fork it.
    const fresh = new CodexAgent(sameRootConfig);
    let forks = 0;
    (fresh as any).client = { request: (method: string) => { if (method === 'thread/fork') forks += 1; return Promise.resolve({ thread: { id: 'x' } }); }, notify() {}, close() {} };
    (fresh as any).threadId = 'thread-original';
    (fresh as any).codexHome = h.home;
    (fresh as any).runtimeConfigSignature = liveSignature;
    await (fresh as any).applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] });
    expect(forks).toBe(0);
    fresh.destroy();
    h.agent.destroy();
  });

  it('a deny rule REMOVED mid-session is removed from the file and re-forks (the projection follows the store both ways)', async () => {
    const h = await openSession([DENY_TOUCH]);
    writeRules(h.root, []);
    await h.refork();
    expect(h.rulesFile()).toBeNull();
    expect(h.forks()).toBe(1);
    h.agent.destroy();
  });

  it('FAIL CLOSED: a fork that does not answer fails the turn, and the next turn head re-forks rather than trusting the file', async () => {
    const h = await openSession(null);
    const threadBefore = (h.agent as any).threadId;
    writeRules(h.root, [DENY_TOUCH]);
    h.wedgeFork(true);
    await expect(h.refork(300)).rejects.toThrow(/did not answer within 300ms/);
    expect((h.agent as any).threadId).toBe(threadBefore);

    h.wedgeFork(false);
    await h.refork();
    expect(h.forks()).toBe(1);
    expect(h.rulesFile()).toContain(FORBIDDEN_TOUCH);
    h.agent.destroy();
  });

  it('NEVER LOOSENS on an unreadable store: a malformed permissions.json mid-session keeps the start-time deny and forks nothing', async () => {
    const h = await openSession([DENY_TOUCH]);
    const atStart = h.rulesFile();
    writeFileSync(join(h.root, 'permissions.json'), '{ "permissionDsl": { "version": 1, "rules": [');
    await h.refork();
    expect(h.rulesFile()).toBe(atStart);
    expect(h.forks()).toBe(0);
    h.agent.destroy();
  });

  // F1.939 · the re-fork reaches the PARENT thread only. A `spawn_agent` child still running from an earlier turn
  // (UA12.99) keeps the execpolicy it loaded, and in Bypass — or for any command codex auto-approves — nothing else
  // checks its commands (header). The host cannot re-fork that child, so it says so, once, at the turn head.
  function runningChildren(agent: CodexAgent, count: number): void {
    Object.defineProperty((agent as any).eventAdapter, 'runningSpawnedChildCount', { get: () => count, configurable: true });
  }
  const heldNotices = (agent: CodexAgent): string[] => (agent as any).pendingServerWarningNotices;

  it('FAILING ARM (F1.939): a rule change re-forks while 2 sub-agents still run — the user is told they keep the previous rules', async () => {
    const h = await openSession(null);
    runningChildren(h.agent, 2);
    writeRules(h.root, [DENY_TOUCH]);
    await h.refork();
    expect(h.forks()).toBe(1);
    const notices = heldNotices(h.agent).filter((n) => /sub-agent/.test(n));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('2 sub-agents');
    expect(notices[0]).toContain('previous permission rules');
    h.agent.destroy();
  });

  it('BOUNDARY (F1.939): no running sub-agent, or running sub-agents with a re-fork for a NON-rules reason — no notice', async () => {
    const h = await openSession([DENY_TOUCH]);
    writeRules(h.root, []);
    await h.refork();
    expect(h.forks()).toBe(1);
    runningChildren(h.agent, 3);
    // A model / mode / additionalDirectories switch: the signature drifts, the rules do not. The walk must get PAST
    // the early return and re-fork, or this half never reaches the `rulesDrift &&` conjunct it guards.
    (h.agent as any).runtimeConfigSignature = 'stale-signature';
    await h.refork();
    expect(h.forks()).toBe(2);
    expect(heldNotices(h.agent).filter((n) => /sub-agent/.test(n))).toEqual([]);
    h.agent.destroy();
  });
});
