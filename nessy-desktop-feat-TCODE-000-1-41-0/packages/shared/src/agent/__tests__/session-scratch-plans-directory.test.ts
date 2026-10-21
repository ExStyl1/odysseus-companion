/**
 * F1.536 — the per-session scratch directory's no-prompt exemption must name the
 * SESSION's scratch directory, whatever the user set `plansDirectory` to.
 *
 * `sessionScratchTmpDir` derived `<dirname(plansFolderPath)>/job/tmp` on the
 * premise that the plans folder is always `<sessionDir>/plans`. P6.704 made that
 * false: claude and Pi pass `resolvePlansDirectory(workingDirectory) ??
 * getSessionPlansDir(…)`, and `resolvePlansDirectoryIn` accepts the project root
 * itself (`plansDirectory: "."` resolves to the root, which is "within" it). So a
 * user-configurable setting moved a permission exemption: measured by WJ-aq's
 * probe (`work/wjaq/scratch-probe.ts`, 2026-09-24), `plansDirectory: "."` put the
 * exemption at `<project parent>/job/tmp` — OUTSIDE every root — and a `Write`
 * there answered `allow` in `default` AND `acceptEdits`; `"docs/plans"` put it
 * at `<project>/docs/job/tmp`; and in both, the real `$CLAUDE_JOB_DIR/tmp` lost
 * its exemption.
 *
 * The fix derives the directory from `dataFolderPath` instead — always
 * `getSessionDataPath()` (`<sessionDir>/data`) at every producer, and not a
 * setting — so the pin at the bottom holds it against `getSessionJobDir()`, the
 * value `buildClaudeSubprocessEnv` writes into `CLAUDE_JOB_DIR`.
 *
 * Every plans path below comes from `resolvePlansDirectoryIn`, the production
 * resolver, rather than a hand-written string; the CONTROL arm is the default
 * plans path, which answered the same before and after the fix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  runPreToolUseChecks,
  sessionScratchTmpDir,
  type PermissionManagerLike,
  type PreToolUseInput,
} from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState, setPermissionMode, type PermissionMode } from '../mode-manager.ts';
import { saveWorkspacePermissions } from '../permissions-config.ts';
import { resolvePlansDirectoryIn } from '../../config/storage.ts';
import { getSessionDataPath, getSessionJobDir, getSessionPlansDir } from '../../sessions/storage.ts';

const KEY = { workspaceId: 'ws-scratch-plans-directory', sessionId: 'session-scratch-plans-directory' };

let sandbox: string;
let cwd: string;
let projectParent: string;
let workspaceRoot: string;
let sessionDir: string;
let defaultPlansDir: string;
let dataDir: string;
let scratchDir: string;

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-scratch-plans-dir-')));
  projectParent = join(sandbox, 'home');
  cwd = join(projectParent, 'project');
  workspaceRoot = join(sandbox, 'workspace');
  sessionDir = join(sandbox, 'sessions', KEY.sessionId);
  defaultPlansDir = join(sessionDir, 'plans');
  dataDir = join(sessionDir, 'data');
  scratchDir = join(sessionDir, 'job', 'tmp');
  for (const dir of [cwd, workspaceRoot, defaultPlansDir, dataDir, scratchDir, join(projectParent, 'job', 'tmp')]) {
    mkdirSync(dir, { recursive: true });
  }
  // The redirect arm below needs `echo` to be read-only, which the isolate's
  // empty allowlist does not grant — seeded at this sandbox's WORKSPACE scope
  // only, as `session-scratch-no-prompt.test.ts` does.
  saveWorkspacePermissions(workspaceRoot, {
    version: '2026-09-08',
    allowedBashPatterns: [{ pattern: '^echo\\b', comment: 'Print text to stdout (as the shipped default.json has it)' }],
  } as never);
  cleanupModeState(KEY);
  initializeModeState(KEY, 'default');
});

afterAll(() => {
  cleanupModeState(KEY);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  setPermissionMode(KEY, 'default');
});

const debug: string[] = [];

function check(
  mode: PermissionMode,
  plansFolderPath: string,
  toolName: string,
  input: Record<string, unknown>,
  extra: Partial<PreToolUseInput> = {},
) {
  setPermissionMode(KEY, mode);
  debug.length = 0;
  const ctx: PreToolUseInput = {
    toolName,
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: workspaceRoot,
    workspaceId: KEY.workspaceId,
    workingDirectory: cwd,
    plansFolderPath,
    dataFolderPath: dataDir,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    onDebug: message => { debug.push(message); },
    ...extra,
  };
  return runPreToolUseChecks(ctx);
}

/** No card means the pipeline needs no human: not a prompt, not a block. */
function noCard(result: ReturnType<typeof check>): boolean {
  return result.type === 'allow' || result.type === 'modify';
}

function write(mode: PermissionMode, plansFolderPath: string, target: string) {
  return check(mode, plansFolderPath, 'Write', { file_path: target, content: 'x' });
}

describe('F1.536 — plansDirectory "." (the project root itself)', () => {
  const plans = () => resolvePlansDirectoryIn(cwd, '.');

  it('the resolver really does accept the project root — the premise the old derivation broke', () => {
    expect(plans()).toBe(cwd);
  });

  for (const mode of ['default', 'acceptEdits'] as const) {
    it(`${mode}: a write to <project parent>/job/tmp is NOT exempt — it is outside every root`, () => {
      const result = write(mode, plans(), join(projectParent, 'job', 'tmp', 'x.txt'));
      expect(result.type).toBe('prompt');
      expect(debug.some(message => message.includes('session scratch directory'))).toBe(false);
    });

    it(`${mode}: the session's own scratch directory keeps its exemption`, () => {
      expect(noCard(write(mode, plans(), join(scratchDir, 'draft.txt')))).toBe(true);
      expect(debug.find(message => message.includes('session scratch directory'))).toContain(scratchDir);
    });
  }

  it('resolves `$CLAUDE_JOB_DIR` to the session job directory, the value the child is given', () => {
    // F1.899 — the claude caller's answer: its shell has the variable. A caller
    // that does not say so gets no resolution (`session-scratch-no-prompt.test.ts`).
    check('default', plans(), 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, { shellHasClaudeJobDir: true });
    expect(debug.find(message => message.includes('session scratch directory'))).toContain(scratchDir);
  });
});

describe('F1.536 — plansDirectory "docs/plans" (a folder inside the project)', () => {
  const plans = () => resolvePlansDirectoryIn(cwd, 'docs/plans');

  it('default: a write to <project>/docs/job/tmp is NOT exempt', () => {
    expect(plans()).toBe(join(cwd, 'docs', 'plans'));
    const result = write('default', plans(), join(cwd, 'docs', 'job', 'tmp', 'x.txt'));
    expect(result.type).toBe('prompt');
    expect(debug.some(message => message.includes('session scratch directory'))).toBe(false);
  });

  it('default: the session\'s own scratch directory keeps its exemption', () => {
    expect(noCard(write('default', plans(), join(scratchDir, 'draft.txt')))).toBe(true);
  });
});

describe('CONTROL — the default plans path (unset plansDirectory) answers as it always did', () => {
  for (const mode of ['default', 'acceptEdits'] as const) {
    it(`${mode}: <project parent>/job/tmp prompts, the session scratch does not`, () => {
      expect(write(mode, defaultPlansDir, join(projectParent, 'job', 'tmp', 'x.txt')).type).toBe('prompt');
      expect(noCard(write(mode, defaultPlansDir, join(scratchDir, 'draft.txt')))).toBe(true);
    });
  }
});

describe('the derivation is pinned to the data folder, which no setting moves', () => {
  it('derives exactly `getSessionJobDir()/tmp` from `getSessionDataPath()`', () => {
    const ws = 'ws-drift';
    const session = 'session-drift';
    expect(sessionScratchTmpDir(getSessionDataPath(ws, session)))
      .toBe(join(getSessionJobDir(ws, session), 'tmp'));
    // The data folder and the default plans folder are siblings — the premise
    // the old derivation relied on, true only while plansDirectory is unset.
    expect(dirname(getSessionDataPath(ws, session))).toBe(dirname(getSessionPlansDir(ws, session)));
  });

  it('names no directory at all without a data folder — fail closed, keep prompting', () => {
    expect(sessionScratchTmpDir(undefined)).toBeUndefined();
  });
});
