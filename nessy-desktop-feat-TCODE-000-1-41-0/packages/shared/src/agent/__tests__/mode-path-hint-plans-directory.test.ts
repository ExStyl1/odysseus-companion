/**
 * F1.547 (origin WJ-ba proposed row 1) — the read-only modes' "write blocked"
 * hint must name the SESSION's folders whatever the user set `plansDirectory` to.
 *
 * `getPathHint` derived the session root as `dirname(plansFolderPath)`, on the
 * premise that the plans folder is always `<sessionDir>/plans`. P6.704 made that
 * false (claude and Pi pass `resolvePlansDirectory(workingDirectory) ??
 * getSessionPlansDir(…)`), which is exactly the premise F1.536 (`2b440d4a0`)
 * removed from `sessionScratchTmpDir`. With `plansDirectory: "."` the hint told
 * the model its session was the project's PARENT directory; with
 * `"docs/plans"` it named `docs` as the session. The fix derives the session
 * root from `dataFolderPath` — `getSessionDataPath()`, `<sessionDir>/data`, at
 * every producer, and not a setting — as F1.536 does.
 *
 * Every plans path below comes from `resolvePlansDirectoryIn`, the production
 * resolver. The CONTROL arm is the default plans path (`plansDirectory` unset):
 * its hints are byte-identical before and after, pinned as literal strings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPathHint, shouldAllowToolInMode } from '../mode-manager.ts';
import { resolvePlansDirectoryIn } from '../../config/storage.ts';

const SESSION_ID = 'session-path-hint';

let sandbox: string;
let cwd: string;
let workspaceRoot: string;
let sessionDir: string;
let defaultPlansDir: string;
let dataDir: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-path-hint-plans-dir-')));
  cwd = join(sandbox, 'home', 'project');
  workspaceRoot = join(sandbox, 'workspace');
  sessionDir = join(workspaceRoot, 'sessions', SESSION_ID);
  defaultPlansDir = join(sessionDir, 'plans');
  dataDir = join(sessionDir, 'data');
  for (const dir of [join(cwd, 'docs', 'plans'), defaultPlansDir, dataDir]) mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const SESSION_FOLDER_HINT = 'Hint: Write to the /plans/ or /data/ subfolder, not the session folder directly.';
const MOVED_PLANS_SESSION_FOLDER_HINT = 'Hint: Write to the plans folder (plansFolderPath) or the /data/ subfolder, not the session folder directly.';
const WORKSPACE_ROOT_HINT = 'Hint: Write to the session plans or data folder, not the workspace root.';
const OUTSIDE_HINT = 'Hint: Files must be written to the session plans or data folder. Use plansFolderPath or dataFolderPath from <session_state>.';
const wrongSession = (id: string) => `Hint: Wrong session ID. Current session is "${id}".`;

function hintsFor(plans: string) {
  return {
    sessionRoot: getPathHint(join(sessionDir, 'notes.md'), plans, dataDir),
    otherSession: getPathHint(join(workspaceRoot, 'sessions', 'other-session', 'data', 'x.md'), plans, dataDir),
    workspaceRoot: getPathHint(join(workspaceRoot, 'x.md'), plans, dataDir),
    outside: getPathHint('/definitely/elsewhere/x.md', plans, dataDir),
  };
}

describe('F1.547 getPathHint derives the session from the data folder', () => {
  it('plansDirectory "." (the project root): every hint names the session, not the project parent', () => {
    const plans = resolvePlansDirectoryIn(cwd, '.');
    expect(plans).toBe(cwd);
    expect(hintsFor(plans!)).toEqual({
      sessionRoot: MOVED_PLANS_SESSION_FOLDER_HINT,
      otherSession: wrongSession(SESSION_ID),
      workspaceRoot: WORKSPACE_ROOT_HINT,
      outside: OUTSIDE_HINT,
    });
  });

  it('plansDirectory "docs/plans": the session is not `docs`', () => {
    const plans = resolvePlansDirectoryIn(cwd, 'docs/plans');
    expect(plans).toBe(join(cwd, 'docs', 'plans'));
    expect(hintsFor(plans!)).toEqual({
      sessionRoot: MOVED_PLANS_SESSION_FOLDER_HINT,
      otherSession: wrongSession(SESSION_ID),
      workspaceRoot: WORKSPACE_ROOT_HINT,
      outside: OUTSIDE_HINT,
    });
  });

  // F1.1050 (DN-272) deleted the "hint reaches the Explore-mode rejection" arm: that detailed rejection existed
  // only in the retired explore. Plan still refuses the same write (another session's data folder):
  it('F1.1050: plan refuses a write into another session\'s data folder', () => {
    const plans = resolvePlansDirectoryIn(cwd, '.')!;
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(workspaceRoot, 'sessions', 'other-session', 'data', 'x.md'), content: 'x' },
      'plan',
      { plansFolderPath: plans, dataFolderPath: dataDir },
    );
    expect(result.allowed).toBe(false);
  });

  it('CONTROL: plansDirectory unset (the default <session>/plans) — the hints are byte-identical', () => {
    expect(hintsFor(defaultPlansDir)).toEqual({
      sessionRoot: SESSION_FOLDER_HINT,
      otherSession: wrongSession(SESSION_ID),
      workspaceRoot: WORKSPACE_ROOT_HINT,
      outside: OUTSIDE_HINT,
    });
    // A caller that passes no data folder keeps the plans-derived reading.
    expect(getPathHint(join(sessionDir, 'notes.md'), defaultPlansDir)).toBe(SESSION_FOLDER_HINT);
  });
});
