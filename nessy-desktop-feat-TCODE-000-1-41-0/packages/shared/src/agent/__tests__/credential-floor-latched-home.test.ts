/**
 * F1.105 (origin `D1.428`, F1.12 safety-review finding #22, CONFIRMED 3/3,
 * MEDIUM) — the request-side credential read floor must anchor `~` on the same
 * home the credential store is latched to.
 *
 * ## What was wrong
 *
 * `SAFE_MODE_CONFIG.deniedPaths` is a list of `~`-anchored globs — `~/.nessy/**`,
 * `~/.ssh/**`, `~/.aws/**`, `~/.config/gh/**` — and `mode-manager.ts` expanded
 * that `~` with the LIVE `os.homedir()`, on both the pattern side
 * (`normalizeDeniedPathPattern`) and the candidate side
 * (`expandDenyCandidateHome`). The credential store does not: `getCredsPath()`
 * resolves `~/.nessy/dp_auth_creds.json` under `latchedHomeDir()`, and so do the
 * secure store's four key derivations, dp's state root, the Pi floor's four
 * anchors and `config/sandbox-settings.ts`'s own `~` anchor (P3.143 / P3.167 /
 * P3.168).
 *
 * `config/managed-env.ts` classifies `HOME` as a `selector` and `applyManagedEnv`
 * writes a confirmed administrator value into `process.env` mid-session — which
 * is a deliberate operator control, and on Node and Electron `os.homedir()`
 * FOLLOWS it (`config/home-latch.ts` measures all three runtimes). From that
 * moment the floor pointed at the new home while every credential stayed at the
 * old one, so a `Read` of the real `~/.nessy/dp_auth_creds.json` matched no
 * denied pattern and the raw gateway JWT was handed to the model. The same drift
 * un-denied `~/.ssh/**`, `~/.aws/**` and `~/.gnupg/**` at the user's real home.
 *
 * With isolation OFF by standing owner decision (2026-08-12/13) this array is
 * the only read-side credential protection a default install has — which is what
 * makes a silent drift in it worth a row.
 *
 * ## The instrument, and why it is the LATCH that moves and not `HOME`
 *
 * Under `bun test` writing `process.env.HOME` moves `os.homedir()` NOT AT ALL
 * (P3.169; Bun latches it at startup, Node and Electron do not). So the two
 * resolvers are made to disagree the other way round, through the latch's own
 * documented test seam — exactly as `server-core`'s `isolation-home-latch.test.ts`
 * does for the Pi floor, and the rig control below asserts they really differ,
 * because an arm in which they are the same string cannot fail.
 *
 * SAFETY: every path here is DATA handed to a glob matcher. Nothing in this file
 * opens, creates or deletes a file.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { shouldAllowToolInMode } from '../mode-manager.ts';
import { latchedHomeDir, relatchHomeDirForTests } from '../../config/home-latch.ts';

// `mode-manager.ts` is a heavy import and bun's 5 s default sits close to its
// resting cost on a cold module graph — `credential-read-floor.test.ts`'s own
// value and its own reason.
setDefaultTimeout(30_000);

/** A home the session was launched with, which this process's `homedir()` is not. */
const LAUNCH_HOME = join(tmpdir(), 'wjk-f1105-launch-home');

afterEach(() => {
  relatchHomeDirForTests();
});

/**
 * The floor's verdict for a file tool, through the one entry every backend
 * reaches.
 *
 * `Grep` takes its target as `path` and not `file_path`, which is not a detail:
 * handed the wrong key the tool reads NO path at all and the call answers
 * "allowed" for every input, so an arm written that way passes on a broken floor
 * and fails on a working one.
 */
function denied(path: string, tool: 'Read' | 'Edit' | 'Grep' = 'Read'): boolean {
  const input = tool === 'Grep' ? 'path' : 'file_path';
  const result = shouldAllowToolInMode(tool, { [input]: path }, 'default');
  return result.allowed === false && result.denyPathBlocked === true;
}

/** The same verdict for a shell command, which is where the `$HOME` spelling lives. */
function bashDenied(command: string): boolean {
  const result = shouldAllowToolInMode('Bash', { command }, 'default');
  return result.allowed === false && result.denyPathBlocked === true;
}

describe('F1.105 — the read floor anchors `~` on the LATCHED home', () => {
  it('denies the credential at the home the session was launched with', () => {
    relatchHomeDirForTests(LAUNCH_HOME);
    // THE RIG CONTROL. If the latch and `os.homedir()` were the same string this
    // arm would pass on HEAD's behaviour and prove nothing at all.
    expect(latchedHomeDir()).toBe(LAUNCH_HOME);
    expect(homedir()).not.toBe(LAUNCH_HOME);

    // The file the row is about: `getCredsPath()` resolves it under the latch,
    // so this is where the gateway JWT actually is after a managed `HOME` lands.
    expect(denied(join(LAUNCH_HOME, '.nessy', 'dp_auth_creds.json'))).toBe(true);
    // And the neighbours the same drift un-denied, so the fix is the anchor and
    // not one pattern.
    expect(denied(join(LAUNCH_HOME, '.ssh', 'id_rsa'))).toBe(true);
    expect(denied(join(LAUNCH_HOME, '.aws', 'credentials'))).toBe(true);
    expect(denied(join(LAUNCH_HOME, '.config', 'gh', 'hosts.yml'), 'Grep')).toBe(true);
  });

  it('the `~` and `$HOME` spellings agree with each other on that home', () => {
    relatchHomeDirForTests(LAUNCH_HOME);
    expect(homedir()).not.toBe(LAUNCH_HOME);

    // P6.673 taught the candidate side both spellings a user would call
    // identical; they have to land on the same home as the pattern side, or the
    // pair it closed reopens on exactly the hosts this row is about.
    //
    // This arm cannot fail on the PRE-FIX code — with both sides on the live
    // home they still agree with each other — and it is not dead: the fault it
    // discriminates is a ONE-SIDED fix. Measured 2026-09-20 with the `$HOME`
    // step left on `os.homedir()` while the `~` step took the latch: 3 pass /
    // 1 fail over 1 file, and this is the arm that fails.
    expect(denied('~/.nessy/dp_auth_creds.json')).toBe(true);
    expect(bashDenied('cat $HOME/.aws/credentials')).toBe(true);
    expect(bashDenied('cat ${HOME}/.aws/credentials')).toBe(true);
  });

  it('still refuses everything nothing moved — D1.428 own control', () => {
    // The latch is untouched here, which is every install that never met a
    // managed `HOME`: the floor must be byte-identical to what it always was.
    expect(latchedHomeDir()).toBe(homedir());
    expect(denied(join(homedir(), '.ssh', 'id_rsa'))).toBe(true);
    expect(denied(join(homedir(), '.nessy', 'dp_auth_creds.json'))).toBe(true);
    expect(denied(join(homedir(), '.aws', 'credentials'))).toBe(true);
  });

  it('does not deny a neighbour just for sitting under the latched home', () => {
    relatchHomeDirForTests(LAUNCH_HOME);
    // THE NEGATIVE CONTROL. Without it, "the latched home is denied" would also
    // be satisfied by a floor that refused the whole directory — which would
    // read as a fix and be a much larger fault.
    expect(denied(join(LAUNCH_HOME, 'Documents', 'notes.md'))).toBe(false);
    // A sibling-prefix directory, which the container expansion must not swallow
    // — and its file is deliberately NOT `id_rsa`: `**/id_rsa` is an any-depth
    // entry that denies it at any home, so that pair would have read as this
    // row's doing while being the shipped list working correctly.
    expect(denied(join(LAUNCH_HOME, '.ssh-backup', 'notes.txt'))).toBe(false);
  });
});
