/**
 * P6.535 (claude arm) — the per-session scratch directory the SDK already knows
 * how to use, created and named.
 *
 * NATIVE-FIRST, tier 1, pure configuration. `CLAUDE_JOB_DIR` is in the vendored
 * SDK's own env-var registry (one hit in `bridge.mjs`, one in `sdk.mjs`) and
 * scored ZERO files across `packages` + `apps` before this row, against a
 * control of 35 for `CLAUDE_CONFIG_DIR`: the runtime reads the name and nothing
 * here ever wrote it. `agent-view.md#where-state-is-stored`, verbatim: *"Each
 * background session has the `CLAUDE_JOB_DIR` environment variable set to its
 * `~/.claude/jobs/<id>` directory, so shell commands the session runs can write
 * temporary files to `$CLAUDE_JOB_DIR/tmp` without colliding with parallel
 * sessions."* Owner D3 = B puts that directory under our own per-session root.
 *
 * THE LOAD-BEARING CASE IS THE `tmp/` ONE. The variable and the directory must
 * land together: the page's promise is that a shell command can write to
 * `$CLAUDE_JOB_DIR/tmp`, and naming a path that does not exist converts that
 * promise into a failing command with a confusing message. So the assertion is
 * on the DIRECTORY existing, not on the string being present.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildClaudeSubprocessEnv } from '../options.ts';
import { getSessionJobDir } from '../../sessions/storage.ts';

// The suite's config root is the isolate preload's temp directory (`bun test`
// reads it from `[test].preload`, and only that form isolates — a `bun <file>`
// run would freeze `CONFIG_DIR` at the real one). Setting `NESSY_CONFIG_DIR`
// here would be too late and would read as isolation while providing none, so
// this only cleans up the directories it caused to be created.
afterAll(() => {
  for (const sessionId of ['session-job-1', 'session-job-a', 'session-job-b', 'session-job-2', 'session-job-blocked']) {
    rmSync(getSessionJobDir('ws-job', sessionId), { recursive: true, force: true });
  }
});

const build = (overrides: Record<string, string>) => buildClaudeSubprocessEnv(overrides);

describe('the claude child is told where its scratch space is', () => {
  it('names the session job directory, and CREATES its tmp/ before naming it', () => {
    const env = build({ NESSY_WORKSPACE_ID: 'ws-job', NESSY_SESSION_ID: 'session-job-1' });
    const expected = getSessionJobDir('ws-job', 'session-job-1');
    expect(env.CLAUDE_JOB_DIR).toBe(expected);
    // The whole point: the page promises a writable `$CLAUDE_JOB_DIR/tmp`.
    expect(existsSync(join(expected, 'tmp'))).toBe(true);
  });

  it('gives two sessions two directories — the collision the page names', () => {
    const a = build({ NESSY_WORKSPACE_ID: 'ws-job', NESSY_SESSION_ID: 'session-job-a' });
    const b = build({ NESSY_WORKSPACE_ID: 'ws-job', NESSY_SESSION_ID: 'session-job-b' });
    expect(a.CLAUDE_JOB_DIR).not.toBe(b.CLAUDE_JOB_DIR);
  });

  it('writes nothing for a session that has no identity of its own', () => {
    // The remote-transfer summary agent is this shape: a synthetic session with
    // no session directory, so there is nothing to point at and no directory to
    // create. Absence, not an invented path.
    expect(build({ NESSY_WORKSPACE_ID: 'ws-job' }).CLAUDE_JOB_DIR).toBeUndefined();
    expect(build({ NESSY_SESSION_ID: 'session-job-orphan' }).CLAUDE_JOB_DIR).toBeUndefined();
  });

  it('outranks an ambient value, so two sessions cannot share one scratch', () => {
    const env = build({
      NESSY_WORKSPACE_ID: 'ws-job',
      NESSY_SESSION_ID: 'session-job-2',
      CLAUDE_JOB_DIR: '/tmp/somebody-elses-scratch',
    });
    expect(env.CLAUDE_JOB_DIR).toBe(getSessionJobDir('ws-job', 'session-job-2'));
  });
});

/**
 * F1.918 — "outranks" has a second half: when there is NO scratch of ours to
 * name, the child must not keep the one the host's own environment named. The
 * app launched from a shell that has `CLAUDE_JOB_DIR` (a Claude Code background
 * session sets it) would otherwise hand that directory — somebody else's scratch,
 * the collision the page names — to a session whose own `tmp/` could not be made,
 * and claude's gate call (F1.899's `shellHasClaudeJobDir: true`) would resolve
 * the literal to a folder the shell does not point at.
 */
describe('F1.918 — no scratch of ours means no CLAUDE_JOB_DIR at all, not an inherited one', () => {
  const INHERITED = '/tmp/f1918-inherited-job-dir';
  let hadLaunch = false;
  let launch: string | undefined;

  const withInherited = <T>(run: () => T): T => {
    hadLaunch = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_JOB_DIR');
    launch = process.env.CLAUDE_JOB_DIR;
    // Bun 1.3.14: delete, then assign (AGENTS.md §Traps, the `process.env` bullet).
    delete process.env.CLAUDE_JOB_DIR;
    process.env.CLAUDE_JOB_DIR = INHERITED;
    try {
      return run();
    } finally {
      delete process.env.CLAUDE_JOB_DIR;
      if (hadLaunch) process.env.CLAUDE_JOB_DIR = launch;
    }
  };

  it('a job dir that cannot be created leaves the name UNSET, and the inherited value is gone', () => {
    // The failure `ensureSessionJobDir` swallows: a FILE where `job/` must be,
    // so `mkdir -p job/tmp` throws and the builder has nothing to name.
    const jobDir = getSessionJobDir('ws-job', 'session-job-blocked');
    mkdirSync(dirname(jobDir), { recursive: true });
    writeFileSync(jobDir, 'not a directory');
    const env = withInherited(() => build({ NESSY_WORKSPACE_ID: 'ws-job', NESSY_SESSION_ID: 'session-job-blocked' }));
    expect(existsSync(join(jobDir, 'tmp'))).toBe(false);
    expect(env.CLAUDE_JOB_DIR).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(env, 'CLAUDE_JOB_DIR')).toBe(false);
  });

  it('BOUNDARY: a session with no identity drops the inherited value too', () => {
    const env = withInherited(() => build({ NESSY_WORKSPACE_ID: 'ws-job' }));
    expect(env.CLAUDE_JOB_DIR).toBeUndefined();
  });

  it('CONTROL: a job dir that WAS created is still named over the inherited value', () => {
    const env = withInherited(() => build({ NESSY_WORKSPACE_ID: 'ws-job', NESSY_SESSION_ID: 'session-job-1' }));
    expect(env.CLAUDE_JOB_DIR).toBe(getSessionJobDir('ws-job', 'session-job-1'));
    expect(existsSync(join(getSessionJobDir('ws-job', 'session-job-1'), 'tmp'))).toBe(true);
  });
});
