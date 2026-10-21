/**
 * P6.535 (Pi and codex arms) — the other two runtimes get the scratch directory
 * too, and it is the SAME directory the approval card exempts.
 *
 * The claude arm (`7c8e1f999`) was native-first tier 1: `CLAUDE_JOB_DIR` is a
 * name the SDK already reads. Pi and codex read no name like it — measured, and
 * recorded in `options.ts`'s docblock — so the host supplies one,
 * `SESSION_JOB_DIR_ENV_VAR`, and that is tier 2 rather than a gap.
 *
 * ## The load-bearing property is that the DIRECTORY EXISTS
 *
 * Same as the claude sibling (`claude-session-job-dir.test.ts`): the row's
 * controller decision is that the env line never lands without the mkdir,
 * because naming a path that does not exist turns a promise into a failing
 * command with a confusing message. `ensureSessionJobDir` is the one place both
 * halves happen, which is why the assertion is on `existsSync`.
 *
 * ## And that it is the directory the GATE knows about
 *
 * `buildPiSubprocessEnv` is handed `sessionDir`, and deriving the job directory
 * from that string would be the obvious implementation and WRONG: `sessionDir`
 * is `join(workspace.sessionRootPath, sessionId)` while the approval-card
 * exemption (`6bfd8b318`) honours `getSessionJobDir`, which resolves through
 * `getSessionStoragePath` + `sanitizeSessionId`. The last case drives a session
 * id that the two spellings disagree about, so a future "simplification" back
 * to `sessionDir` is caught rather than shipped.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildPiSubprocessEnv } from '../pi-agent.ts';
import {
  ensureSessionJobDir,
  getSessionJobDir,
  SESSION_JOB_DIR_ENV_VAR,
} from '../../sessions/storage.ts';

const WORKSPACE = 'ws-job-shared';
const SESSIONS = ['pi-job-1', 'pi-job-2', 'codex-job-1', 'nested/pi-job-3'];

afterAll(() => {
  for (const sessionId of SESSIONS) {
    rmSync(getSessionJobDir(WORKSPACE, sessionId), { recursive: true, force: true });
  }
});

const piEnv = (workspaceId: string | undefined, sessionId: string) =>
  buildPiSubprocessEnv({
    processEnv: {},
    proxyEnv: {},
    awsEnv: {},
    ...(workspaceId ? { workspaceId } : {}),
    sessionId,
    debug: false,
  });

describe('P6.535 — the Pi child is told where its scratch space is', () => {
  it('names the session job directory, and CREATES its tmp/ before naming it', () => {
    const env = piEnv(WORKSPACE, 'pi-job-1');
    const expected = getSessionJobDir(WORKSPACE, 'pi-job-1');
    expect(env[SESSION_JOB_DIR_ENV_VAR]).toBe(expected);
    expect(existsSync(join(expected, 'tmp'))).toBe(true);
  });

  it('gives two sessions two directories — the collision the row exists to remove', () => {
    expect(piEnv(WORKSPACE, 'pi-job-1')[SESSION_JOB_DIR_ENV_VAR])
      .not.toBe(piEnv(WORKSPACE, 'pi-job-2')[SESSION_JOB_DIR_ENV_VAR]);
  });

  it('NEGATIVE — a session with no workspace identity gets no variable and no directory', () => {
    // Not an invented path: a child with no identity has nothing to scratch in,
    // and the variable is DELETED rather than left to the `processEnv` spread,
    // so an ambient value cannot put two sessions in one directory.
    const env = buildPiSubprocessEnv({
      processEnv: { [SESSION_JOB_DIR_ENV_VAR]: '/ambient/leak' },
      proxyEnv: {},
      awsEnv: {},
      sessionId: 'pi-job-orphan',
      debug: false,
    });
    expect(env[SESSION_JOB_DIR_ENV_VAR]).toBeUndefined();
  });
});

describe('P6.535 — the shared helper is what both new arms call', () => {
  it('creates the directory and returns the name (the codex arm calls exactly this)', () => {
    const dir = ensureSessionJobDir(WORKSPACE, 'codex-job-1');
    expect(dir).toBe(getSessionJobDir(WORKSPACE, 'codex-job-1'));
    expect(existsSync(join(dir as string, 'tmp'))).toBe(true);
  });

  it('NEGATIVE — no identity, no directory', () => {
    expect(ensureSessionJobDir(undefined, 'codex-job-1')).toBeUndefined();
    expect(ensureSessionJobDir(WORKSPACE, undefined)).toBeUndefined();
  });

  it('is addressed by (workspaceId, sessionId), NOT by the session directory string', () => {
    // `getSessionJobDir` sanitises the session id through `basename`; a raw
    // `join(sessionDir, 'job')` would not, so the two spellings name different
    // directories and only one of them is the one the approval card exempts.
    // Driven with an id `basename` must change.
    const raw = 'nested/pi-job-3';
    const resolved = getSessionJobDir(WORKSPACE, raw);
    expect(resolved.endsWith(join(raw, 'job'))).toBe(false);
    expect(resolved.endsWith(join('pi-job-3', 'job'))).toBe(true);
    expect(piEnv(WORKSPACE, raw)[SESSION_JOB_DIR_ENV_VAR]).toBe(resolved);
  });
});
