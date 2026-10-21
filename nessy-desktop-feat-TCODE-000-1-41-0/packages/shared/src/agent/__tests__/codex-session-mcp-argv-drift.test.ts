/**
 * F1.116 (origin WI-by, D1.426's stated residue) and F1.138 (origin SIT-10,
 * P-SIT10-1) — a mid-session flip of HOST STATE reaches codex's RUNNING
 * session-MCP child, not the next runtime start.
 *
 * ## The mechanism, and why one file covers two rows
 *
 * `buildSessionMcpSpec` puts three pieces of per-chat host state on the child's
 * argv, and the child parses argv ONCE: `--memory-scope-write` (this chat's own
 * memory write axis, D1.426), `--working-directory` (this session's project
 * directory, D1.372) and `--advisor-consult` (P3.13). P3.28 already re-spawns
 * that child without a runtime restart — `config/value/write` +
 * `config/mcpServer/reload`, measured at 7-32 ms against the real binary — and
 * `refreshSessionMcpAdvisorAdvertisement` already runs at the head of every
 * turn. What it could not see is any drift other than the advisor's: it
 * recorded ONE BOOLEAN (`spec.args.includes(CODEX_ADVISOR_CONSULT_FLAG)`) and
 * compared that, so a memory flip or a project change produced no request at
 * all and landed at the next runtime start.
 *
 * SIT-10 met the user-visible half of that on dmg #4 and filed it as F1.138:
 * on codex, unticking "Remember from this chat" refuses correctly (the child
 * was spawned at the first turn, with the flag), and then RE-ENABLING does not
 * restore writing — `Memory is disabled for this workspace.` on the same chat,
 * where pi and claude save immediately, because the running child is still
 * holding `--memory-scope-write false`. It is the same defect as F1.116 read
 * from the other end, so it is closed by the same comparison and its own arm
 * is the `false` -> reset -> `true` sequence below.
 *
 * ## What each proposition separates
 *
 * 1. **A RESET restores writing on the SAME thread** — F1.138's own sequence.
 * 2. **A CLOSE reaches a chat that started open** — the other direction, which
 *    a one-directional refresh would pass proposition 1 forever without.
 * 3. **The project directory is carried too** — WJ-c's `--working-directory`
 *    (F1.75) is the third argv that goes stale in a running child, and it went
 *    in AFTER the drift check was written.
 * 4. **No drift -> NO requests**, which is this row's own control: the check
 *    runs at the head of every turn, and a version that fired on anything but
 *    an actual difference would re-spawn every configured MCP server on every
 *    message.
 * 5. **What is written is the WHOLE fresh argv**, and the record is updated to
 *    it, so a second turn after the same flip is silent.
 *
 * No `mock.module` anywhere in this file, deliberately: the harness runs with
 * NO callback bridge, so `buildSessionMcpSpec` emits neither
 * `--host-callback-port` nor `--advisor-consult` and the advisor setting cannot
 * enter the comparison. `codex-advisor-advertisement.test.ts` is the file that
 * owns the advisor axis, and it stays green.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CodexAgent } from '../codex-agent.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../../config/paths.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionMemoryScopeOverride } from '../memory/session-memory-scope.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

const WORKSPACE_ID = 'ws-argv-drift';
const SESSION_ID = 'session-argv-drift';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

interface Recorded { method: string; params: any }

/** The mutable half of the session record — what a user moves mid-chat. */
interface SessionState {
  memoryScopeOverride?: SessionMemoryScopeOverride;
  workingDirectory?: string;
}

interface Harness {
  agent: any;
  requests: Recorded[];
  /** The live session record, mutated between "turns" the way the host does. */
  session: SessionState;
  /** Drive the private seam directly, the way the advisor file's own rows do. */
  refresh: () => Promise<void>;
  /** The argv the LIVE app-server is recorded as serving. */
  advertised: () => readonly string[] | null;
  /** The argv a spawn would write RIGHT NOW. */
  freshArgs: () => string[];
}

/**
 * `record: 'spawn'` (the default) plants the argv a runtime spawned with, which
 * is what `createRuntime` does at the end of a successful start; `null` is the
 * "no runtime is up" state, where there is nothing live to correct.
 */
function createHarness(initial: SessionState = {}, options: { record?: 'spawn' | null } = {}): Harness {
  cleanupModeState(SESSION_KEY);
  const requests: Recorded[] = [];

  const session: SessionState & Record<string, unknown> = {
    id: SESSION_ID,
    workspaceRootPath: '/tmp/ws-argv-drift-root',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...initial,
  };

  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Argv Drift Workspace',
      rootPath: '/tmp/ws-argv-drift-root',
      workspaceRootPath: '/tmp/ws-argv-drift-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-argv-drift',
    } as any,
    session: session as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;

  const agent: any = new CodexAgent(config);
  agent.client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      return Promise.resolve(method === 'config/value/write' ? { status: 'ok' } : {});
    },
    notify() {},
    close() {},
  };
  // No bridge: the advisor flag and the callback port are then absent from
  // every argv here, so nothing but the two per-chat values can drift.
  agent.callbackBridge = null;
  agent.sessionMcpAdvertisedArgs = options.record === null
    ? null
    : agent.buildSessionMcpSpec(undefined).args;

  return {
    agent,
    requests,
    session,
    refresh: () => agent.refreshSessionMcpAdvisorAdvertisement(),
    advertised: () => agent.sessionMcpAdvertisedArgs,
    freshArgs: () => agent.buildSessionMcpSpec(undefined).args,
  };
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
/** The bytes this test process had before any arm planted, or `null` for "no file". */
let storedConfigBefore: string | null = null;
let storedConfigPlanted = false;

/**
 * Plant a `config.json` this build's loader accepts, carrying only what an arm
 * needs — a REAL file through the production loader, never `mock.module` on
 * `config/storage.ts`, which would amputate that module for every other file
 * sharing this bun process (AGENTS.md's spread-and-restore trap) to buy nothing
 * a file write does not already give. `loadStoredConfig` reads the file on every
 * call and caches nothing, which is what makes a mid-arm flip visible.
 */
function plantStoredConfig(extra: Record<string, unknown>): void {
  if (!storedConfigPlanted) {
    storedConfigBefore = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
    storedConfigPlanted = true;
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...extra,
  }), 'utf-8');
}

/** Put the config directory back exactly as it was, including "there was no file". */
function restoreStoredConfig(): void {
  if (!storedConfigPlanted) return;
  if (storedConfigBefore === null) rmSync(CONFIG_FILE, { force: true });
  else writeFileSync(CONFIG_FILE, storedConfigBefore, 'utf-8');
  storedConfigPlanted = false;
  storedConfigBefore = null;
}

/** The value that follows `flag` on an argv, or `undefined` when it is absent. */
function valueAfter(args: readonly string[] | null, flag: string): string | undefined {
  if (!args) return undefined;
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('F1.116 / F1.138 · a mid-session flip reaches codex\'s running session-MCP child', () => {
  afterEach(() => {
    cleanupModeState(SESSION_KEY);
    restoreStoredConfig();
  });

  it('F1.138 — a chat that unticked memory and RESET it writes again on the same thread', async () => {
    // The runtime started AFTER the untick, which is SIT-10's own sequence: the
    // codex child is spawned at the first turn, so it holds the closed axis.
    const { agent, requests, session, refresh, advertised, freshArgs } =
      createHarness({ memoryScopeOverride: { write: false } });
    expect(valueAfter(advertised(), '--memory-scope-write')).toBe('false');

    // "Reset" — the chat drops its own override and follows the app switch.
    delete session.memoryScopeOverride;

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    const write = requests[0]!;
    expect(write.params.keyPath).toBe('mcp_servers.session.args');
    expect(write.params.mergeStrategy).toBe('replace');
    // The whole argv a spawn would write, never a hand-built list: a `replace`
    // that carried less would truncate the child's surface to whatever this
    // seam remembered to include.
    expect(write.params.value).toEqual(freshArgs());
    expect(write.params.value).not.toContain('--memory-scope-write');
    // The negative control for the line above — the rest of the argv is still
    // there, so "the flag is gone" means the flag and not an empty write.
    expect(write.params.value).toContain('--external-standalone-only');
    // Recorded only after BOTH calls answered, so the next turn is silent.
    expect(advertised()).toEqual(freshArgs());

    agent.destroy();
  });

  it('F1.116 — a chat that CLOSES its axis mid-session is refused on the same thread', async () => {
    const { agent, requests, session, refresh, advertised, freshArgs } = createHarness();
    expect(advertised()).not.toContain('--memory-scope-write');

    session.memoryScopeOverride = { write: false };

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    expect(valueAfter(requests[0]!.params.value, '--memory-scope-write')).toBe('false');
    expect(advertised()).toEqual(freshArgs());

    agent.destroy();
  });

  it('carries the PROJECT directory too — the third argv that goes stale (F1.75)', async () => {
    // `--working-directory` landed in `buildSessionMcpSpec` after the drift
    // check was written, and a check that compares the advisor alone cannot see
    // it: a session that chooses a project mid-chat would keep refusing
    // `scope: "project"` by name until the next runtime start.
    const { agent, requests, session, refresh, advertised, freshArgs } = createHarness();
    expect(advertised()).not.toContain('--working-directory');

    session.workingDirectory = '/tmp/chosen-project-root';

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    expect(valueAfter(requests[0]!.params.value, '--working-directory')).toBe('/tmp/chosen-project-root');
    expect(advertised()).toEqual(freshArgs());

    agent.destroy();
  });

  it('F1.118 — the APP-WIDE switch is on this argv too, so its flip lands on the same thread', async () => {
    // The claim `codexAppMemoryWriteArgs`'s docblock makes, given a guard
    // rather than left as an assertion: the app-wide half of the memory switch
    // now rides the same argv, and the comparison that carries the per-chat half
    // carries it for free. Before F1.116 it could not have — a boolean over the
    // advisor flag is blind to every other value on the line.
    plantStoredConfig({ memoryEnabled: true });
    const { agent, requests, refresh, advertised, freshArgs } = createHarness();
    expect(advertised()).not.toContain('--memory-app-write');

    // The operator turns auto-memory off app-wide, mid-chat.
    plantStoredConfig({ memoryEnabled: false });

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    expect(valueAfter(requests[0]!.params.value, '--memory-app-write')).toBe('false');
    // The negative control: the rest of the argv is still there, so the flag
    // above arrived on a whole spec and not on a truncated one.
    expect(requests[0]!.params.value).toContain('--external-standalone-only');
    expect(advertised()).toEqual(freshArgs());

    agent.destroy();
  });

  it('F1.175 — a mid-session `plansDirectory` move re-advertises too, and that is WANTED', async () => {
    /*
     * THE DIRECTION, decided and pinned rather than left to be discovered.
     *
     * F1.116 widened the drift check from one boolean to the whole argv, which
     * swept in a flag nobody's row named: `--plans-folder` is
     * `resolvePlansDirectory(this.workingDirectory)`, a LIVE operator setting,
     * so a mid-session move of it now reaches the running child instead of
     * waiting for the next runtime start. Nothing pinned that either way, and a
     * behaviour change nothing pins is a behaviour change the next lane will
     * "fix".
     *
     * It is wanted, on P6.704's own reasoning: this child is what actually
     * WRITES a plan on codex, so a configured `plansDirectory` that stopped at
     * the host would move the gate and the prompt while leaving the file in the
     * old place. Re-advertising is what keeps those three in one place.
     *
     * It is also the cheapest possible change of behaviour: the setting moves
     * only when an operator moves it, and the arm below this one proves an
     * untouched session still performs ZERO RPCs.
     */
    const root = '/tmp/ws-argv-drift-root';
    plantStoredConfig({ plansDirectory: 'docs/plans' });
    const { agent, requests, refresh, advertised, freshArgs } = createHarness();
    expect(valueAfter(advertised(), '--plans-folder')).toBe(join(root, 'docs', 'plans'));

    plantStoredConfig({ plansDirectory: 'docs/plans-moved' });

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    expect(valueAfter(requests[0]!.params.value, '--plans-folder')).toBe(join(root, 'docs', 'plans-moved'));
    expect(advertised()).toEqual(freshArgs());

    agent.destroy();
  });

  it('sends NOTHING when nothing moved, on every axis — this runs at every turn', async () => {
    // The row's own control. Three states, each recorded from its own spawn:
    // an untouched chat, one that closed its axis before the runtime started,
    // and one with a project. None of them may cost a request, because the pair
    // re-initialises every configured MCP server.
    for (const state of [
      {},
      { memoryScopeOverride: { write: false } },
      { workingDirectory: '/tmp/chosen-project-root' },
    ] as SessionState[]) {
      const { agent, requests, refresh, advertised, freshArgs } = createHarness(state);
      await refresh();
      expect(requests).toEqual([]);
      expect(advertised()).toEqual(freshArgs());
      agent.destroy();
    }
  });

  it('a second turn after the same flip is silent, because the record moved with it', async () => {
    const { agent, requests, session, refresh } = createHarness();

    session.memoryScopeOverride = { write: false };
    await refresh();
    expect(requests).toHaveLength(2);

    await refresh();
    expect(requests).toHaveLength(2);

    agent.destroy();
  });

  it('no live runtime recorded a surface, so there is nothing to correct', async () => {
    // `null` is not "the advisor is off" and never was: a spawn that could not
    // write a spec at all leaves the record unset, and the next `createRuntime`
    // reads this state for itself.
    const { agent, requests, session, refresh, advertised } = createHarness({}, { record: null });

    session.memoryScopeOverride = { write: false };
    await refresh();

    expect(requests).toEqual([]);
    expect(advertised()).toBeNull();

    agent.destroy();
  });
});
