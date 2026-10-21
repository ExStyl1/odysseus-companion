/**
 * F1.532 — the host half: F1.386's projected floor hook is told the session's permission mode, and is
 * projected only when codex's reviewer will actually answer.
 *
 * Found by the 1.41.0 review (B-codex-runtime-1, CONFIRMED LOW), two triggers with one cause — the
 * projection ignored the mode and who answers:
 *
 * 1. **bypassPermissions.** A mode change does not respawn codex (P6.223), so the projection cannot
 *    follow the mode, and the hook payload cannot either (`hook_permission_mode` says `default` for
 *    every `on-request` session, and bypass is `on-request` here). The hook refused an unattended-
 *    automation edit that the host floor (`unattendedAutomationEditFloor`, null in bypass) and the
 *    Pi/claude gate let run. Now the runtime build names a state file in its own `CODEX_HOME` on the
 *    hook's command line, writes the mode into it, and rewrites it on every `setPermissionMode` and
 *    before every `turn/start`; the hook (`session-mcp-server`'s `permission-request-hook.ts`) gives no
 *    verdict in bypass.
 * 2. **The Settings toggle on under an administrator list without `auto_review`.** Codex falls back to
 *    the user (`codexTurnApprovalsReviewer` asks for nothing), so THIS host is asked and its floor
 *    cards a person — but the hook, projected because the written config carried the reviewer,
 *    refused first. Now the projection asks whether the reviewer answers.
 *
 * The hook's own contract over the file is `permission-request-hook-mode.test.ts` in that package.
 *
 * F1.609 moved the file out of `CODEX_HOME` (a `$TMPDIR` root the agent can write) into a per-build
 * directory under the host's config directory, named only when no agent-writable root covers it; its
 * own arms are `codex-floor-hook-forged-state.test.ts`. Here every agent points that root at a rig
 * directory and declares the workspace as the only writable root, so the rig plays "outside".
 *
 * F1.704 — that resolver now takes F1.680's shield too (`codexConfigDirProjectionShields` over the
 * same `configDirProjection()` `newCodexHome` passes): the state root is under the config dir, so
 * where F1.664's projection keeps agent commands out of the config dir (home as the project; the
 * config dir under `$TMPDIR`), the file is named there instead of withheld. The `F1.704` arms run the
 * production roots and state root (the isolate preload's `CONFIG_DIR`, under `$TMPDIR`), no stubs.
 *
 * F1.654 — a host that crashed ran no teardown, so its build directory stayed under the state root
 * forever. Each build directory is now `build-<pid>-XXXXXX`, and every build first removes the ones
 * whose pid names no running process (`backend/codex/host-owned-dirs.ts`). The `F1.654` arms plant a
 * reaped child's pid (dead) and the runner's parent pid (alive) for real — no liveness stub.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodexAgent } from '../codex-agent.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import * as floorHook from '../backend/codex/automation-floor-hook.ts';
import { recordAndPersistCodexManagedApprovalsReviewers } from '../../config/codex-managed-requirement-cache.ts';

const NODE = '/opt/nessy/bun';
const SERVER = '/opt/nessy/session-mcp-server/index.js';
const ROOT = '/work/space';
const HOMES: string[] = [];
/** F1.609 — the rig's stand-in for the host config directory's state root. */
const STATE_ROOT = mkdtempSync(join(tmpdir(), 'wjcrita-f1532-state-'));

afterEach(() => { recordAndPersistCodexManagedApprovalsReviewers(undefined); });
afterAll(() => {
  for (const home of HOMES) rmSync(home, { recursive: true, force: true });
  rmSync(STATE_ROOT, { recursive: true, force: true });
});

function codexHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'wjat-f1532-home-'));
  HOMES.push(home);
  return home;
}

function agentAt(): CodexAgent {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: 'ws-f1532', name: 'F1.532', rootPath: ROOT, workspaceRootPath: ROOT, sessionRootPath: `${ROOT}/sessions` } as any,
    session: { id: `session-f1532-${HOMES.length}`, workspaceRootPath: ROOT, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: SERVER, node: NODE } },
  } as never);
  agent.onDebug = () => {};
  (agent as any).debug = () => {};
  (agent as any).floorHookStateRoot = STATE_ROOT; // F1.609 — see the header
  (agent as any).codexAgentWritableRoots = () => [ROOT];
  // F1.781 — the Settings toggle, re-read at every state write; the arms that plant the reviewer mean it on.
  (agent as any).autoReviewSettingOn = () => true;
  return agent;
}

type Projection = { hooks?: { PermissionRequest?: Array<{ hooks: Array<{ command: string }> }> } };
const commandOf = (projected: Projection) => projected.hooks?.PermissionRequest?.[0]?.hooks[0]?.command;

/** The state file the projected command names, read back as the hook will read it. */
function stateNamedBy(command: string | undefined): { v?: number; permissionMode?: string; reviewerRequiredByPolicy?: boolean; reviewerAnswers?: boolean } | null {
  const at = command?.indexOf("'--state-file' '") ?? -1;
  if (!command || at < 0) return null;
  const path = command.slice(at + "'--state-file' '".length, command.indexOf("'", at + "'--state-file' '".length));
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}

describe('F1.532 · the floor hook is told the session mode', () => {
  it('the runtime build names a state file (F1.609: in its own directory under the state root, never in CODEX_HOME) and writes the current mode into it', () => {
    const agent = agentAt();
    const home = codexHome();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      agent.setPermissionMode('auto'); // F1.1169: Auto is a mode the reviewer answers
      const command = commandOf((agent as any).hostAuthoredHookProjection(home));
      expect(command).toContain(`'--state-file' '${realpathSync(STATE_ROOT)}/build-`);
      expect(command).toContain(`/nessy-automation-floor-state.json'`);
      expect(command).not.toContain(home);
      expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: 'auto', reviewerRequiredByPolicy: false });
    } finally { agent.destroy(); }
  });

  it('a mode change rewrites it — no respawn needed, and bypassPermissions reaches the hook', () => {
    const agent = agentAt();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      agent.setPermissionMode('default');
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      agent.setPermissionMode('bypassPermissions');
      expect(stateNamedBy(command)?.permissionMode).toBe('bypassPermissions');
      agent.setPermissionMode('acceptEdits');
      expect(stateNamedBy(command)?.permissionMode).toBe('acceptEdits');
    } finally { agent.destroy(); }
  });

  it('the file records the mode the session ENDS on when the change callback clamps it (the root-host bypass clamp)', () => {
    const agent = agentAt();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      agent.setPermissionMode('default');
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      // SessionManager's agent-mode callback may clamp an arriving bypass and write the
      // mode-state singleton directly, not through the agent — the same shape, here.
      agent.onPermissionModeChange = (mode) => {
        if (mode === 'bypassPermissions') (agent as any).permissionManager.setPermissionMode('default');
      };
      agent.setPermissionMode('bypassPermissions');
      expect(agent.getPermissionMode()).toBe('default');
      expect(stateNamedBy(command)?.permissionMode).toBe('default');
    } finally { agent.destroy(); }
  });

  it('every turn/start rewrites it first, so a mode set around the agent reaches the hook by the next turn (source pin)', () => {
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf-8');
    const turnStart = source.indexOf("void this.client!.request('turn/start', {");
    const write = source.lastIndexOf('this.writeFloorHookState();', turnStart);
    expect(turnStart).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    // Nothing but the turn's input sits between the write and the request.
    expect(source.slice(write, turnStart)).not.toContain('await ');
  });

  it('an administrator list that requires the reviewer is recorded, so the refusal names the policy', () => {
    recordAndPersistCodexManagedApprovalsReviewers(['auto_review']);
    const agent = agentAt();
    try {
      (agent as any).noteConfiguredApprovalsReviewer({});
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      expect(command).toBeDefined();
      expect(stateNamedBy(command)?.reviewerRequiredByPolicy).toBe(true);
    } finally { agent.destroy(); }
  });

  it('CONTROL — built without a CODEX_HOME (no state file possible), the command is F1.386\'s, and the hook keeps the floor', () => {
    const agent = agentAt();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      expect(commandOf((agent as any).hostAuthoredHookProjection())).toBe(floorHook.codexAutomationFloorHookCommand(NODE, SERVER, ROOT));
    } finally { agent.destroy(); }
  });
});

describe('F1.781 · the Settings toggle turned off in a live session reaches the hook', () => {
  it('turned off: the state says the reviewer no longer answers, so the hook steps aside; back on: F1.532\'s text', () => {
    const agent = agentAt();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      let settingOn = true;
      (agent as any).autoReviewSettingOn = () => settingOn;
      agent.setPermissionMode('auto'); // F1.1169: the two modes the reviewer answers, so the toggle is what moves
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      settingOn = false;
      agent.setPermissionMode('bypassPermissions');
      expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: 'bypassPermissions', reviewerRequiredByPolicy: false, reviewerAnswers: false });
      settingOn = true;
      agent.setPermissionMode('auto');
      expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: 'auto', reviewerRequiredByPolicy: false });
    } finally { agent.destroy(); }
  });

  it('CONTROL — an administrator list that requires the reviewer keeps the floor with the toggle off', () => {
    recordAndPersistCodexManagedApprovalsReviewers(['auto_review']);
    const agent = agentAt();
    try {
      (agent as any).autoReviewSettingOn = () => false;
      (agent as any).noteConfiguredApprovalsReviewer({});
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: agent.getPermissionMode(), reviewerRequiredByPolicy: true });
    } finally { agent.destroy(); }
  });
});

describe('F1.532 · the hook is projected only when codex\'s reviewer answers', () => {
  it('the Settings toggle on, the remembered administrator list ["user"]: codex asks this host, so no hook', () => {
    recordAndPersistCodexManagedApprovalsReviewers(['user']);
    const agent = agentAt();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      expect((agent as any).hostAuthoredHookProjection(codexHome())).toEqual({});
    } finally { agent.destroy(); }
  });

  it('CONTROL — the toggle on with no list, or a list that allows the reviewer: projected as before', () => {
    for (const list of [undefined, ['auto_review', 'user'] as const]) {
      recordAndPersistCodexManagedApprovalsReviewers(list);
      const agent = agentAt();
      try {
        (agent as any).configuredApprovalsReviewer = 'auto_review';
        expect(commandOf((agent as any).hostAuthoredHookProjection(codexHome()))).toBeDefined();
      } finally { agent.destroy(); }
    }
  });
});

describe('F1.704 · the state file is named where F1.680\'s config-dir projection keeps agent commands out', () => {
  const FACT = 'codex-floor-hook-state';
  const STATE_UNDER_CONFIG = join(CONFIG_DIR, 'codex-floor-hook-state');
  // Under `~/.cache`, never `tmpdir()`: `$TMPDIR` is itself one of the roots (F1.680's rig).
  mkdirSync(join(homedir(), '.cache'), { recursive: true });
  const RIG = realpathSync(mkdtempSync(join(homedir(), '.cache', 'nessy-f1704-')));
  const RIG_TMP = join(RIG, 'tmp');
  const PROJECT = join(RIG, 'proj');
  const WORKSPACE = join(RIG, 'config', 'workspaces', 'ws-f1704');
  for (const dir of [RIG_TMP, PROJECT, WORKSPACE]) mkdirSync(dir, { recursive: true });
  afterAll(() => { rmSync(RIG, { recursive: true, force: true }); });

  /** The production roots and state root; `cwd` is the project folder. */
  function agentIn(cwd: string): CodexAgent {
    const agent = new CodexAgent({
      provider: 'codex-runtime',
      workspace: { id: 'ws-f1704', name: 'F1.704', rootPath: WORKSPACE, workspaceRootPath: WORKSPACE, sessionRootPath: `${WORKSPACE}/sessions` } as any,
      session: { id: `session-f1704-${HOMES.length}`, workspaceRootPath: WORKSPACE, workingDirectory: cwd, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
      model: 'codex/test-model',
      isHeadless: true,
      runtime: { paths: { sessionServer: SERVER, node: NODE } },
    } as never);
    agent.onDebug = () => {};
    (agent as any).debug = () => {};
    (agent as any).configuredApprovalsReviewer = 'auto_review';
    return agent;
  }

  /** The projected command, built with `TMPDIR` at `tmp` when given (restored after). */
  function projectedCommand(agent: CodexAgent, tmp?: string): string | undefined {
    const saved = process.env.TMPDIR;
    if (tmp) process.env.TMPDIR = tmp;
    try {
      if (tmp) expect(tmpdir()).toBe(tmp);
      return commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
    } finally {
      if (tmp) {
        delete process.env.TMPDIR;
        if (saved !== undefined) process.env.TMPDIR = saved;
      }
    }
  }

  it('READ carrier — home as the project (the cwd contains the config dir): named under the config dir, no fact', () => {
    const cwd = dirname(CONFIG_DIR);
    const agent = agentIn(cwd);
    try {
      agent.setPermissionMode('bypassPermissions');
      const command = projectedCommand(agent, RIG_TMP);
      expect(command).toContain(`'--state-file' '${realpathSync(STATE_UNDER_CONFIG)}/build-`);
      expect(stateNamedBy(command)?.permissionMode).toBe('bypassPermissions');
      expect((agent as any).sessionFacts.get(FACT) ?? '(no fact)').toBe('(no fact)');
    } finally { agent.destroy(); }
  });

  it('DENY carrier — the config dir under $TMPDIR (or /tmp), the project beside: named under the config dir, no fact', () => {
    const agent = agentIn(PROJECT);
    try {
      // Non-vacuity: a writable root other than the cwd holds the config dir, and the projection denies it.
      const roots: string[] = (agent as any).codexAgentWritableRoots();
      expect(roots.filter(root => root !== PROJECT).some(root => realpathSync(CONFIG_DIR).startsWith(`${realpathSync(root)}/`))).toBe(true);
      expect((agent as any).configDirProjection().deny.length).toBeGreaterThan(0);
      agent.setPermissionMode('default');
      const command = projectedCommand(agent);
      expect(command).toContain(`'--state-file' '${realpathSync(STATE_UNDER_CONFIG)}/build-`);
      expect(stateNamedBy(command)?.permissionMode).toBe('default');
      expect((agent as any).sessionFacts.get(FACT) ?? '(no fact)').toBe('(no fact)');
    } finally { agent.destroy(); }
  });

  it('CONTROL — a state root under the project folder but OUTSIDE the config dir is still withheld, and the session says so', () => {
    const cwd = dirname(CONFIG_DIR);
    const outside = mkdtempSync(join(cwd, 'nessy-f1704-not-config-'));
    const agent = agentIn(cwd);
    try {
      (agent as any).floorHookStateRoot = join(outside, 'codex-floor-hook-state');
      const command = projectedCommand(agent, RIG_TMP);
      expect(command).toBeDefined();
      expect(command).not.toContain("'--state-file'");
      const fact = (agent as any).sessionFacts.get(FACT) ?? '';
      expect(fact).toContain('F1.609');
      expect(fact).toContain(cwd);
    } finally {
      agent.destroy();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('F1.654 · a runtime build sweeps the state directories a host no longer running left behind', () => {
  /** A build directory as a host with `pid` minted it (`build-<pid>-XXXXXX`), its state file inside. */
  function planted(name: string): string {
    const dir = join(STATE_ROOT, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nessy-automation-floor-state.json'), floorHook.codexAutomationFloorHookState('default', false));
    return dir;
  }

  it('a crashed host\'s directory is removed at the next build, and the new one carries this process\'s pid', () => {
    const deadPid = spawnSync('/usr/bin/true').pid;
    expect(() => process.kill(deadPid, 0)).toThrow(); // the instrument's own control: that pid is gone
    const crashed = planted(`build-${deadPid}-Ab12Cd`);
    const agent = agentAt();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      expect(existsSync(crashed)).toBe(false);
      expect(command).toContain(`'--state-file' '${realpathSync(STATE_ROOT)}/build-${process.pid}-`);
    } finally { agent.destroy(); }
  });

  it('CONTROL — a live runtime\'s directory is kept, as are a live host\'s elsewhere and a name with no pid', () => {
    const first = agentAt();
    const second = agentAt();
    const otherLiveHost = planted(`build-${process.ppid}-Ef34Gh`);
    const noPid = planted('build-Ij56Kl');
    try {
      (first as any).configuredApprovalsReviewer = 'auto_review';
      (second as any).configuredApprovalsReviewer = 'auto_review';
      first.setPermissionMode('auto'); // F1.1169: a mode the reviewer answers, so the state is F1.532's text
      const firstCommand = commandOf((first as any).hostAuthoredHookProjection(codexHome()));
      commandOf((second as any).hostAuthoredHookProjection(codexHome()));
      expect(stateNamedBy(firstCommand)).toEqual({ v: 1, permissionMode: 'auto', reviewerRequiredByPolicy: false });
      expect(existsSync(otherLiveHost)).toBe(true);
      expect(existsSync(noPid)).toBe(true);
    } finally {
      first.destroy();
      second.destroy();
      rmSync(otherLiveHost, { recursive: true, force: true });
      rmSync(noPid, { recursive: true, force: true });
    }
  });
});

/**
 * F1.1169 — the hook follows who answers per MODE, not only per toggle: in Manual and Accept edits every turn asks
 * for 'user', so this host is asked and its floor cards a person, and the hook must step aside there as F1.781 has
 * it do when the toggle is off. In Auto and Bypass permissions the reviewer answers and the hook keeps F1.532's text.
 */
describe('F1.1169 · the floor hook steps aside in the modes the reviewer does not answer', () => {
  it('Manual and Accept edits: reviewerAnswers false with the toggle on; Auto and Bypass: F1.532\'s text', () => {
    const agent = agentAt();
    try {
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      agent.setPermissionMode('auto');
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: 'auto', reviewerRequiredByPolicy: false });
      for (const mode of ['default', 'acceptEdits'] as const) {
        agent.setPermissionMode(mode);
        expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: mode, reviewerRequiredByPolicy: false, reviewerAnswers: false });
      }
      agent.setPermissionMode('bypassPermissions');
      expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: 'bypassPermissions', reviewerRequiredByPolicy: false });
    } finally { agent.destroy(); }
  });

  it('CONTROL — an administrator list that requires the reviewer keeps it answering in Manual too', () => {
    recordAndPersistCodexManagedApprovalsReviewers(['auto_review']);
    const agent = agentAt();
    try {
      (agent as any).noteConfiguredApprovalsReviewer({ approvalsReviewer: 'auto_review' });
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      agent.setPermissionMode('default');
      expect(stateNamedBy(command)).toEqual({ v: 1, permissionMode: 'default', reviewerRequiredByPolicy: true });
    } finally { agent.destroy(); }
  });
});
