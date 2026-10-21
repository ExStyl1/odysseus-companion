/**
 * DA1.77 — a dp that never STARTED is not a dp that ran and answered.
 *
 * WHAT WAS BROKEN, measured at `61cfc4659` before a line was changed, by
 * driving the real `printToken`, the real `resolveDpRuntime` and the real
 * broker against a fabricated dp whose X bit is set and which cannot exec:
 *
 * - `printToken` threw `DpAuthServiceError` / `ExecFailed` /
 *   `"dp print-token failed"` — and a script exiting 1 threw the SAME name, the
 *   SAME code and the SAME message, so the two were indistinguishable.
 * - three consecutive `resolveDpRuntime` calls all answered the dead path
 *   (`accessSync(X_OK)` passes on a zero-byte file with its X bit set),
 * - two consecutive `probe()` calls both answered `{state:'error',
 *   code:'ExecFailed'}` with nothing demoted, and a perfectly good dp on rung 4
 *   was never reached.
 *
 * NOTHING HERE TOUCHES A REAL dp, THE NETWORK OR A CREDENTIAL FILE. Every dp is
 * a `/bin/sh` script or an empty file in a temp directory, and every arm injects
 * `configDir`, `nessyDir`, `homeDir`, `pathEnv` and `fallbackPath` so the ladder
 * underneath cannot walk the developer's `~/.nessy-agent`, their
 * `~/.nessy/dp_latest/dp` (which EXISTS on a machine with nessy-cli and would
 * turn the rung-4 arm green for the wrong reason) or their `~/.dp`.
 * `NESSY_HOME` is deleted per case and restored delete-then-assign (DA1.36, and
 * the Bun env trap: an assignment without the delete is invisible to the spread
 * every subprocess env is built from).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login, printToken } from '../dp-api.ts';
import {
  clearDemotedDpBinaries,
  dpBinaryDemotion,
  resolveDpRuntime,
  type ResolveDpRuntimeOptions,
} from '../dp-binary.ts';
import { createDpSessionBroker } from '../session-broker.ts';
import { DpAuthError, DpAuthServiceError, DpSpawnFailedError } from '../errors.ts';
import { NESSY_HOME_ENV } from '../creds-store.ts';
import { createFakeDp } from './fake-dp.ts';

/**
 * The three shapes `accessSync(X_OK)` says yes to and `posix_spawn` says no to.
 * Every one of them is a file (or directory) the ladder will happily pick.
 */
function unrunnableDp(kind: 'zero-byte' | 'bad-interpreter' | 'directory'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dp-dead-'));
  const path = join(dir, 'dp');
  if (kind === 'directory') {
    mkdirSync(path, { mode: 0o755 });
    return path;
  }
  writeFileSync(path, kind === 'zero-byte' ? '' : '#!/nonexistent/interp-da177\necho hi\n');
  chmodSync(path, 0o755);
  return path;
}

/**
 * A dp that RUNS and exits non-zero, saying something `printToken` does not
 * recognise. The discriminating fixture of the whole row: it is exactly as
 * "failed" as the ones above and must never be treated as a dead binary.
 */
function exitingDp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dp-exit-'));
  const path = join(dir, 'dp');
  writeFileSync(path, '#!/bin/sh\necho "transient corp gateway failure" >&2\nexit 1\n');
  chmodSync(path, 0o755);
  return path;
}

/** The ladder with every rung pinned at a temp path, rung 1 = `dpPath`. */
function ladder(dpPath: string, nessyDir?: string): ResolveDpRuntimeOptions {
  return {
    env: { NESSY_DP: dpPath },
    configDir: mkdtempSync(join(tmpdir(), 'dp-config-')),
    nessyDir: nessyDir ?? mkdtempSync(join(tmpdir(), 'dp-nessy-')),
    homeDir: mkdtempSync(join(tmpdir(), 'dp-home-')),
    pathEnv: '',
    fallbackPath: join(mkdtempSync(join(tmpdir(), 'dp-usrlocal-')), 'dp'),
  };
}

let savedNessyHome: string | undefined;

beforeEach(() => {
  clearDemotedDpBinaries();
  savedNessyHome = process.env[NESSY_HOME_ENV];
  delete process.env[NESSY_HOME_ENV];
});

afterEach(() => {
  clearDemotedDpBinaries();
  delete process.env[NESSY_HOME_ENV];
  if (savedNessyHome !== undefined) process.env[NESSY_HOME_ENV] = savedNessyHome;
});

describe('printToken — the spawn arm', () => {
  const cases: Array<[Parameters<typeof unrunnableDp>[0], string]> = [
    ['zero-byte', 'ENOEXEC'],
    ['bad-interpreter', 'ENOENT'],
    ['directory', 'EACCES'],
  ];

  for (const [kind, errno] of cases) {
    it(`a ${kind} dp throws DpSpawnFailedError carrying ${errno}, still coded ExecFailed`, async () => {
      let error: unknown;
      try {
        await printToken(unrunnableDp(kind), { timeoutMs: 5_000 });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DpSpawnFailedError);
      const spawnError = error as DpSpawnFailedError;
      expect(spawnError.errno).toBe(errno);
      expect(spawnError.unrunnable).toBe(true);
      // The contract four suites read is UNCHANGED: same base class, same code,
      // same `name`. Only a caller that asks the narrower question sees more.
      expect(spawnError).toBeInstanceOf(DpAuthServiceError);
      expect(spawnError.code).toBe(DpAuthError.ExecFailed);
      expect(spawnError.name).toBe('DpAuthServiceError');
    });
  }
});

describe('printToken — the exit arm (the negative)', () => {
  it('a dp that RAN and exited non-zero is NOT a spawn failure', async () => {
    let error: unknown;
    try {
      await printToken(exitingDp(), { timeoutMs: 5_000 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DpAuthServiceError);
    expect(error).not.toBeInstanceOf(DpSpawnFailedError);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExecFailed);
  });

  it('a caller-budget abort is not a spawn failure either, though it too carries a string code', async () => {
    // The ordering lock. An `AbortError` has `code: 'ABORT_ERR'` — a STRING —
    // so a `typeof code === 'string'` classifier alone would call a
    // cancellation a dead binary and demote a healthy dp for it.
    const fake = createFakeDp({ loggedIn: true, hangPrintToken: true });
    let error: unknown;
    try {
      await printToken(fake.binary, { timeoutMs: 300 });
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeInstanceOf(DpSpawnFailedError);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.Timeout);
  }, 10_000);

  it('a spawn failure whose errno is the MACHINE refusing is not unrunnable', () => {
    // The boundary of `UNRUNNABLE_SPAWN_ERRNOS`, driven directly because
    // ETXTBSY/EAGAIN cannot be provoked reliably on this rig. A resource errno
    // is a real spawn failure and must still not demote: the registry is
    // process-lifetime, so that would move a healthy system dp off the ladder
    // until the app restarts.
    for (const errno of ['ENOEXEC', 'ENOENT', 'EACCES']) {
      expect(new DpSpawnFailedError('x', errno).unrunnable).toBe(true);
    }
    for (const errno of ['ETXTBSY', 'EAGAIN', 'ENOMEM']) {
      expect(new DpSpawnFailedError('x', errno).unrunnable).toBe(false);
    }
  });
});

describe('login makes the same distinction, under its own code (DA1.78)', () => {
  it('a dp that cannot start throws DpSpawnFailedError, still coded LoginFailed', async () => {
    let error: unknown;
    try {
      await login(unrunnableDp('zero-byte'), { timeoutMs: 5_000 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DpSpawnFailedError);
    const spawnError = error as DpSpawnFailedError;
    expect(spawnError.errno).toBe('ENOEXEC');
    expect(spawnError.unrunnable).toBe(true);
    // The bucket is UNCHANGED, which is the whole point of the code parameter:
    // no new enum member, no new locale key, the card says what it always said.
    expect(spawnError.code).toBe(DpAuthError.LoginFailed);
    expect(spawnError.name).toBe('DpAuthServiceError');
  });

  it('an SSO refusal — dp RAN and exited non-zero — is not a spawn failure', async () => {
    // The negative, and the one the row exists for: this is the failure that
    // really does send the user to corp SSO, and it must stay distinguishable
    // from a dead dp file carrying the same code.
    const fake = createFakeDp({ failLogin: true });
    let error: unknown;
    try {
      await login(fake.binary, { timeoutMs: 5_000 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DpAuthServiceError);
    expect(error).not.toBeInstanceOf(DpSpawnFailedError);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.LoginFailed);
  });

  it('the default code is ExecFailed, so printToken\'s call site is unchanged', () => {
    expect(new DpSpawnFailedError('x', 'ENOEXEC').code).toBe(DpAuthError.ExecFailed);
    expect(new DpSpawnFailedError('x', 'ENOEXEC', DpAuthError.LoginFailed).code)
      .toBe(DpAuthError.LoginFailed);
  });
});

describe('the probe demotes the rung only on the spawn arm', () => {
  it('a dp that cannot start is demoted unrunnable, and the ladder then walks past it', async () => {
    const dead = unrunnableDp('zero-byte');
    const rung4 = createFakeDp({ loggedIn: true, token: 'tok-rung-4', version: '13.99.7' });
    const nessyDir = mkdtempSync(join(tmpdir(), 'dp-nessy-'));
    cpSync(rung4.dir, join(nessyDir, 'dp_latest'), { recursive: true });
    chmodSync(join(nessyDir, 'dp_latest', 'dp'), 0o755);

    const opts = ladder(dead, nessyDir);
    // Before: the dead rung-1 dp wins, which is the defect.
    expect(resolveDpRuntime(opts).dpPath).toBe(dead);
    expect(resolveDpRuntime(opts).source).toBe('override');

    const broker = createDpSessionBroker({ resolveRuntime: () => resolveDpRuntime(opts) });
    try {
      const first = await broker.probe({ timeoutMs: 5_000 });
      expect(first).toEqual({ state: 'error', code: DpAuthError.ExecFailed });
      expect(dpBinaryDemotion(dead)).toBe('unrunnable');
      // After: the same options resolve rung 4, with no other input changed.
      expect(resolveDpRuntime(opts).source).toBe('nessy-cli');

      const second = await broker.probe({ timeoutMs: 5_000 });
      // `version` NAMES the binary that answered: only the rung-4 fake can say
      // 13.99.7, and the dead one cannot say anything at all.
      expect(second).toEqual({ state: 'ready', version: '13.99.7', outdated: false });
    } finally {
      broker.dispose();
    }
  }, 30_000);

  it('a dp that ran and exited non-zero is NOT demoted — the ladder keeps it', async () => {
    // The mutant control for this row: move the demotion from the spawn arm to
    // the exit arm and this case goes red while the one above stays green.
    const noisy = exitingDp();
    const opts = ladder(noisy);
    const broker = createDpSessionBroker({ resolveRuntime: () => resolveDpRuntime(opts) });
    try {
      const state = await broker.probe({ timeoutMs: 5_000 });
      expect(state).toEqual({ state: 'error', code: DpAuthError.ExecFailed });
      expect(dpBinaryDemotion(noisy)).toBeUndefined();
      expect(resolveDpRuntime(opts).dpPath).toBe(noisy);
    } finally {
      broker.dispose();
    }
  }, 30_000);

  it('a real dp saying "not logged in" is not demoted either', async () => {
    // The dominant production failure, and the one a bare-`ExecFailed` demotion
    // would have punished hardest: the fixture exits NON-ZERO with dp's own
    // needs-login marker on stderr, so `printToken` answers `undefined` rather
    // than throwing at all.
    const fake = createFakeDp({ loggedIn: false });
    const opts = ladder(fake.binary);
    const broker = createDpSessionBroker({ resolveRuntime: () => resolveDpRuntime(opts) });
    try {
      const state = await broker.probe({ timeoutMs: 5_000 });
      expect(state).toEqual({ state: 'needs-login', version: '13.24.1', outdated: false });
      expect(dpBinaryDemotion(fake.binary)).toBeUndefined();
    } finally {
      broker.dispose();
    }
  }, 30_000);
});

describe('the fallback is told to the user, not only to the debug log (DA1.79)', () => {
  it('after the ladder steps over a dead dp, ensure() emits dp-unrunnable', async () => {
    const dead = unrunnableDp('zero-byte');
    const rung4 = createFakeDp({ loggedIn: true, token: 'tok-rung-4', version: '13.99.7' });
    const nessyDir = mkdtempSync(join(tmpdir(), 'dp-nessy-'));
    cpSync(rung4.dir, join(nessyDir, 'dp_latest'), { recursive: true });
    chmodSync(join(nessyDir, 'dp_latest', 'dp'), 0o755);

    const opts = ladder(dead, nessyDir);
    const broker = createDpSessionBroker({ resolveRuntime: () => resolveDpRuntime(opts) });
    try {
      // Turn one: the dead rung-1 dp fails and is demoted. The user sees an error
      // — that half was never silent.
      const firstStatuses: string[] = [];
      let firstError: unknown;
      try {
        await broker.ensure({ timeoutMs: 5_000, onStatus: (s) => firstStatuses.push(s) });
      } catch (e) {
        firstError = e;
      }
      expect(firstError).toBeInstanceOf(DpAuthServiceError);
      expect(firstStatuses).not.toContain('dp-unrunnable');

      // Turn two: it works, from a copy the user never chose. THIS is what was
      // silent before this row, and what the status now says out loud.
      const statuses: string[] = [];
      const ready = await broker.ensure({ timeoutMs: 5_000, onStatus: (s) => statuses.push(s) });
      expect(ready.state).toBe('ready');
      expect(statuses).toContain('dp-unrunnable');
      expect(statuses).toContain('ready');
      // The NEGATIVE that keeps the two advisories apart: the dp that answered
      // is 13.99.7, well above the floor, so the version hint must stay silent.
      expect(statuses).not.toContain('dp-outdated');
    } finally {
      broker.dispose();
    }
  }, 30_000);

  it('a ladder that never stepped over anything says nothing', async () => {
    const fake = createFakeDp({ loggedIn: true, token: 'tok-clean', version: '13.99.7' });
    const opts = ladder(fake.binary);
    const broker = createDpSessionBroker({ resolveRuntime: () => resolveDpRuntime(opts) });
    try {
      const statuses: string[] = [];
      const ready = await broker.ensure({ timeoutMs: 5_000, onStatus: (s) => statuses.push(s) });
      expect(ready.state).toBe('ready');
      expect(statuses).toContain('ready');
      expect(statuses).not.toContain('dp-unrunnable');
    } finally {
      broker.dispose();
    }
  }, 30_000);
});
