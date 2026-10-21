/**
 * dp exec wrappers: `dp auth print-token` and `dp auth login`.
 *
 * Tokens are NEVER logged or embedded in error messages/causes (00-context
 * "Do not log tokens"). We log only lengths/booleans via the debug logger.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../../utils/debug.ts';
import { DpAuthError, DpAuthServiceError, DpSpawnFailedError } from './errors.ts';
import {
  combineAbort, dpExecEnv, getStderr,
  isAbortError, spawnFailureErrno,
} from './internal.ts';

const execFileAsync = promisify(execFile);
const log = createLogger('dp-auth');

/** dp's needs-login stderr sentences: 13.50.0's, and 13.60.0's second (F1.360 — see `isNeedsLoginStderr`). */
const NEEDS_LOGIN_MARKERS = ['no access token found, you need to authorize user or service account first',
  'access token not found. you should relogin'] as const;
/**
 * C3.391 (2026-09-12) — sized against dp's OWN STARTUP HOOK, not against the
 * token, because the hook is what the budget actually waits for.
 *
 * This was 5_000, and 5 s is the one value that cannot work: nessy-cli measured
 * the hook opening a network connection and giving up BY ITSELF after about
 * five seconds when its host is unreachable, so a five-second budget aborts dp
 * at the moment it would have printed the token. They raised theirs to 30 s for
 * that reason (nessy-cli commit `3e90c2fd7`, `packages/core/src/dp/dpConfig.ts`
 * `printTokenTimeout: 30_000`). Same binary, same subcommand, same budget —
 * dp 13.50.0 — so their reading is evidence about ours.
 *
 * MEASURED HERE, 2026-09-12 on dp 13.50.0 (`/usr/bin/time -p`, wall seconds,
 * stdout discarded so no token is ever read):
 *
 * | arm                          | `dp --version` | `dp version` | `dp auth print-token` |
 * | ---------------------------- | -------------- | ------------ | --------------------- |
 * | host reachable (no proxy)    | 0.11           | 0.41         | 0.41                  |
 * | HTTPS_PROXY at a closed port | 0.99           | 1.30         | 0.88                  |
 * | HTTPS_PROXY at a black hole  | 0.20           | 0.51         | 0.63                  |
 *
 * Two things that reading settles and one it does NOT. It settles that the hook
 * is real and rides the SUBCOMMAND: `dp version` costs `dp --version` plus
 * 0.30/0.31/0.31 s in all three arms, and the flag form does not pay it. It
 * settles that a healthy hook is cheap, so a 30 s ceiling costs nothing on a
 * working machine. It does NOT reproduce the unreachable-host arm: dp's hook
 * ignores `HTTPS_PROXY`, the black-hole arm came back FASTER than the refusing
 * one, and no lever this rig is allowed to pull (no real network change; dp
 * publishes no endpoint env var — `grep -aoE 'DP_[A-Z0-9_]+'` over the shipped
 * binary finds only `DP_NO_WARNINGS`, `DP_WORKDIR`, `DP_LOGGER`,
 * `DP_PLUGIN_WORKDIR`, `DP_LOG_FILE`, `DP_STATIST_DEVICE_ID`,
 * `DP_DEBUG_LOG_FILE`, `DP_AI_MCP_SKIP_LOGIN`) made the hook slow. So the
 * absence of a five-second hook HERE is not a refutation of nessy-cli's
 * measurement — it is a missing positive control, and it is recorded as one.
 */
const PRINT_TOKEN_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface DpExecOptions {
  signal?: AbortSignal;
  /**
   * Override the command's budget. A TEST SEAM: the suite must be able to drive
   * the Timeout path in milliseconds rather than waiting out a budget sized for
   * a hung network hook, and a test that waits 30 s to prove a timeout is a test
   * nobody runs. Production callers pass nothing and get the constant above.
   */
  timeoutMs?: number;
  /**
   * The state root this dp must run against — `resolveDpRuntime().workdir`.
   * Omitted (the dominant case) means dp uses its own `~/.dp`, which is Target
   * scheme clause 3. A caller must never derive this independently of the
   * binary it is about to run; that pairing is the seam's whole job.
   */
  workdir?: string;
}

/**
 * Run `dp auth print-token`. Resolves to the trimmed token on a clean success
 * (exactly one non-empty stdout line — stderr may carry dp's own banners/
 * warnings and is otherwise ignored), or `undefined` when dp reports the user
 * is not logged in. Timeout (`PRINT_TOKEN_TIMEOUT_MS`, 30s — sized against dp's
 * own startup hook, see the constant) → Timeout, caller abort → Cancelled,
 * anything else → ExecFailed. The token value never enters logs or errors.
 *
 * **The failure is narrowed into TWO arms, and one of them is load-bearing
 * (DA1.77).** A dp that never STARTED throws {@link DpSpawnFailedError} — still
 * `ExecFailed`, so every existing reader is unchanged — while a dp that RAN and
 * exited non-zero throws the bare `DpAuthServiceError` this always threw. Only
 * the first arm licenses `session-broker.ts` symbol `runProbe` to demote the
 * rung `'unrunnable'`, because only the first one is evidence about the BINARY:
 * `resolveDpRuntime` tests runnability with `accessSync(X_OK)`, which passes on
 * a file whose X bit is set and which cannot exec (and on a directory), so
 * without this distinction such a path re-wins the ladder on every call and the
 * rungs below it are unreachable for the life of the process. Measured at
 * `61cfc4659`, 2026-09-18, driving this function against a zero-byte dp with
 * its X bit set and against a script exiting 1: both answered
 * `DpAuthServiceError` / `ExecFailed` / `"dp print-token failed"`, identical in
 * name, code and message.
 *
 * `cause` is still dropped on BOTH arms — the raw exec error may carry
 * stdout/stderr, and stdout is where the token would be. The errno is the only
 * thing lifted out of it, and an errno name is not token material.
 */
export async function printToken(
  dpPath: string,
  opts: DpExecOptions = {},
): Promise<string | undefined> {
  const { signal, timeout } = combineAbort(opts.signal, opts.timeoutMs ?? PRINT_TOKEN_TIMEOUT_MS);
  try {
    const { stdout, stderr } = await execFileAsync(dpPath, ['auth', 'print-token'], {
      signal,
      env: dpExecEnv(opts.workdir),
    });
    const stdoutLines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (isNeedsLoginStderr(stderr)) {
      log.info('print-token: needs login');
      return undefined;
    }
    if (stdoutLines.length === 1) {
      log.info('print-token succeeded', {
        tokenLength: stdoutLines[0]!.length,
        hadStderr: stderr.trim().length > 0,
      });
      return stdoutLines[0];
    }
    if (stdoutLines.length > 1) {
      // F1.366 — more than one stdout line (an update banner dp printed despite
      // DP_NO_WARNINGS) is a PARSE failure, not a sign-out: reading it as
      // needs-login sent the user through a login that could not fix it and
      // kept the stored-session fallback shut. The line count is logged, never
      // a line.
      log.info('print-token printed more than one stdout line', { lines: stdoutLines.length });
      throw new DpAuthServiceError(DpAuthError.ExecFailed, 'dp print-token output could not be parsed');
    }
    log.info('print-token returned no token; treating as needs-login');
    return undefined;
  } catch (err) {
    if (err instanceof DpAuthServiceError) throw err;
    if (isNeedsLoginStderr(getStderr(err))) {
      log.info('print-token: needs login');
      return undefined;
    }
    if (isAbortError(err)) {
      throw timeout.aborted
        ? new DpAuthServiceError(DpAuthError.Timeout, 'dp print-token timed out')
        : new DpAuthServiceError(DpAuthError.Cancelled, 'dp print-token cancelled');
    }
    // The spawn-vs-exit split. It must sit AFTER the abort check: an
    // `AbortError` carries a string `code` too, and only `spawnFailureErrno`'s
    // second condition keeps the two apart on its own.
    const spawnErrno = spawnFailureErrno(err);
    if (spawnErrno !== undefined) {
      log.info('print-token: dp did not start', { errno: spawnErrno });
      throw new DpSpawnFailedError('dp print-token could not start dp', spawnErrno);
    }
    // No `cause`: the raw exec error may carry stdout/stderr — keep it out of
    // any surface a caller might stringify.
    throw new DpAuthServiceError(DpAuthError.ExecFailed, 'dp print-token failed');
  }
}

/**
 * Run `dp auth login` — interactive corp SSO; dp opens the browser itself.
 * Timeout (5 min) → Timeout, caller abort (UI cancel) → Cancelled with the dp
 * child killed via SIGTERM, non-zero exit → LoginFailed.
 *
 * **A dp that never STARTED is told apart from an SSO refusal (DA1.78), and
 * both stay `LoginFailed`.** The two failures sent the user to opposite places
 * while carrying one code: "login failed" points at corp SSO, and a dead dp file
 * is not an SSO problem at all. This arm throws {@link DpSpawnFailedError} with
 * the errno and the SAME `LoginFailed` code, so the codes-only IPC channel and
 * both locale files are untouched and only a caller asking the narrower question
 * sees more. It is DIAGNOSTIC and not on the demotion path: `runProbe` is what
 * holds a rung, and `login` is reached only after a probe already answered
 * `needs-login` on that same binary.
 *
 * **The budget honours `opts.timeoutMs` (DA3.17), exactly as `printToken`'s
 * twin above already did.** {@link DpExecOptions.timeoutMs} was declared as a
 * test seam for precisely this reason and this function silently ignored it, so
 * the only way to reach the Timeout arm was to wait out five real minutes —
 * i.e. the arm had no instrument, which is why it shipped saying nothing useful.
 * No production caller passes the field (`session-broker.ts` forwards whatever
 * its own caller passed, and every one of those passes nothing), so the default
 * is unchanged; what moved is that the arm is now drivable in milliseconds.
 */
export async function login(dpPath: string, opts: DpLoginOptions = {}): Promise<void> {
  const { signal, timeout } = combineAbort(opts.signal, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  // F1.2 — only a caller that LISTENS gets the helper; without one, `BROWSER` is the user's own.
  const hook = opts.onAuthUrl
    ? createBrowserHook(opts.forwardBrowser ?? defaultBrowserForward(), opts.onAuthUrl)
    : null;
  try {
    // F1.362 — dp's own `ensure` when this dp has it (see {@link supportsAuthEnsure}).
    const sub = await supportsAuthEnsure(dpPath, { signal, workdir: opts.workdir }) ? 'ensure' : 'login';
    log.info(`starting dp auth ${sub} (browser SSO)`, { urlHook: hook !== null });
    await execFileAsync(dpPath, ['auth', sub], {
      signal,
      env: dpExecEnv(opts.workdir, hook?.helperPath),
    });
    log.info(`dp auth ${sub} completed`);
  } catch (err) {
    if (isAbortError(err)) {
      throw timeout.aborted
        ? new DpAuthServiceError(DpAuthError.Timeout, 'dp login timed out')
        : new DpAuthServiceError(DpAuthError.Cancelled, 'dp login cancelled');
    }
    // After the abort check, for the reason `printToken`'s twin gives.
    const spawnErrno = spawnFailureErrno(err);
    if (spawnErrno !== undefined) {
      log.info('login: dp did not start', { errno: spawnErrno });
      throw new DpSpawnFailedError(
        'dp login could not start dp',
        spawnErrno,
        DpAuthError.LoginFailed,
      );
    }
    throw new DpAuthServiceError(DpAuthError.LoginFailed, 'dp login failed');
  } finally {
    hook?.close();
  }
}

/**
 * F1.360 — true when dp's stderr says the user is not signed in.
 *
 * **Two sentences, not one.** dp 13.60.0 (installed by corporate device
 * management on 2026-09-23) carries both `NEEDS_LOGIN_MARKERS` — each measured
 * once in the binary with `grep -aoF`, with neighbouring bytes read to confirm
 * they are separate string constants — and until this row only the first was
 * matched, so a user whose dp printed the second one was told "Developer
 * Platform command failed" (`ExecFailed`) instead of being asked to sign in.
 * WHICH sentence dp prints when (never logged in, refresh token expired) is not
 * yet measured — F1.364 item 1 — so both are needs-login until it is.
 *
 * A substring match, not an equality, for the reason the first marker always
 * was one: dp's CLI layer may prefix the line (`Error: …`) and may print other
 * lines around it. An unrelated stderr line on a non-zero exit still falls
 * through to `ExecFailed` — the control arm in `__tests__/dp-api.test.ts`.
 */
function isNeedsLoginStderr(stderr: string): boolean {
  return NEEDS_LOGIN_MARKERS.some((marker) => stderr.includes(marker));
}

/**
 * F1.2 — `login`'s options: the exec options plus the authorization-URL relay.
 */
export interface DpLoginOptions extends DpExecOptions {
  /**
   * Called at most ONCE with the http(s) URL dp handed its browser. dp never
   * PRINTS that URL on any path (RQ-dp-device, 13.50.0 source); its opener
   * prepends `BROWSER` to its candidate list and passes the URL as the first
   * argument, which is the one lever — nessy-cli pulls the same one
   * (`dpApi.ts` `dpLogin` sets `BROWSER=wslview` under WSL). Omitted, no helper
   * is written and dp opens the browser exactly as before.
   */
  onAuthUrl?: (url: string) => void;
  /**
   * The command the helper forwards the URL to. A TEST SEAM: production passes
   * nothing and gets {@link defaultBrowserForward} — the user's own `BROWSER`,
   * else the platform opener — so the tab still opens. An empty string forwards
   * nowhere.
   */
  forwardBrowser?: string;
}

/** How often the relay looks for the helper's record while dp waits. */
const AUTH_URL_POLL_MS = 100;
/** A URL longer than this is not relayed (dp's own is a few hundred bytes). */
const AUTH_URL_MAX_LENGTH = 8_192;

/**
 * F1.2 — where the helper forwards the URL so the tab still opens: the user's
 * own `BROWSER` when set (they chose it; it is the forward TARGET, never
 * overwritten), else `/usr/bin/open` on macOS — dp's own opener there — and
 * `xdg-open` on Linux. Anything else forwards nowhere (the platform does not
 * ship; `login` installs no helper on win32 at all).
 */
export function defaultBrowserForward(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const user = env.BROWSER?.trim();
  if (user) return user;
  if (platform === 'darwin') return '/usr/bin/open';
  if (platform === 'linux') return 'xdg-open';
  return '';
}

/** The trimmed URL when it is an http(s) URL of sane length, else `undefined`. */
function acceptAuthUrl(raw: string): string | undefined {
  const url = raw.trim();
  if (url.length === 0 || url.length > AUTH_URL_MAX_LENGTH) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * F1.2 — the temporary `BROWSER` helper for ONE `dp auth login`.
 *
 * A private `mkdtemp` directory (0700) holding a POSIX `sh` script (0700) that:
 * writes its first argument to `url` at 0600 (`umask 077`, written to a temp
 * name and renamed, so the reader never sees half a URL); forwards the URL to
 * `forwardTo` in the BACKGROUND, so the tab still opens and a browser command
 * that blocks until its window closes cannot hold dp; and exits 0 at once —
 * inside dp's 3 s window, so dp treats the browser as opened and never falls
 * through to a second candidate. The parent polls for `url` while dp waits and
 * hands a valid http(s) URL to `onUrl` exactly once; `close()` (always, in
 * `login`'s `finally`) looks one last time, stops polling and deletes the
 * directory.
 *
 * **What is logged: that a URL was captured, and its ORIGIN.** Never the path's
 * query — dp's authorization URL carries `state` and the PKCE challenge there —
 * and never the helper's record. `__tests__/dp-api.test.ts` reads a CHILD's
 * debug sink to pin it, with the capture line as the positive control.
 *
 * **Scope, stated where the posture is taken:** the OAuth callback still lands
 * on `localhost:25565` of the machine running dp, so this helps a browser that
 * could not be SEEN, never a machine with no browser that can reach that port
 * (true headless stays `NESSY_DP_AUTH_TOKEN`, `env-token.ts`). Relaying another
 * tool's auth URL through its documented-by-precedent `BROWSER` lever is a
 * product posture, decided 2026-09-23 (`docs/superpowers/specs/2026-09-23-dp-auth-approach.md`
 * §C, F1.2 un-gated by nessy-cli's own use of it).
 *
 * `null` when the helper cannot be written (or on win32) — dp then opens the
 * browser itself, exactly as before.
 */
function createBrowserHook(
  forwardTo: string,
  onUrl: (url: string) => void,
): { readonly helperPath: string; close(): void } | null {
  if (process.platform === 'win32') return null;
  let dir: string;
  let helperPath: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'nessy-dp-browser-'));
    helperPath = join(dir, 'browser');
    const urlTmp = shellQuote(join(dir, 'url.tmp'));
    const script = [
      '#!/bin/sh',
      '# Nessy Desktop (F1.2): record the URL dp hands its browser, forward it, exit 0 at once.',
      'umask 077',
      `printf '%s' "$1" > ${urlTmp} && mv -f ${urlTmp} ${shellQuote(join(dir, 'url'))}`,
      ...(forwardTo ? [`( sh -c ${shellQuote(`${forwardTo} "$1"`)} nessy-dp-browser "$1" >/dev/null 2>&1 & )`] : []),
      'exit 0',
      '',
    ].join('\n');
    writeFileSync(helperPath, script, { mode: 0o700 });
  } catch {
    log.info('dp auth login: browser hook could not be written; dp opens the browser itself');
    return null;
  }
  const urlFile = join(dir, 'url');
  let settled = false;
  const check = (): void => {
    if (settled) return;
    let raw: string;
    try {
      raw = readFileSync(urlFile, 'utf-8');
    } catch {
      return;
    }
    settled = true;
    const url = acceptAuthUrl(raw);
    if (url === undefined) {
      log.info('dp auth login: the browser hook received a target that is not an http(s) URL; not relayed');
      return;
    }
    log.info('dp auth login: authorization URL captured', { origin: new URL(url).origin });
    try {
      onUrl(url);
    } catch {
      // A relay observer must not change the login's outcome.
    }
  };
  const timer = setInterval(check, AUTH_URL_POLL_MS);
  timer.unref?.();
  return {
    helperPath,
    close() {
      clearInterval(timer);
      check();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A temp directory the OS will reap; nothing in it outlives the login.
      }
    },
  };
}

/** F1.362 — the budget of the `dp auth ensure --help` probe: dp's startup hook, not a login. */
const ENSURE_PROBE_TIMEOUT_MS = 15_000;
/** F1.362 — `ensure`'s own NAME line in its help (13.60.0: "dp auth ensure - Ensures authorization, logging in if needed"). */
const ENSURE_HELP_NAME = /\bdp auth ensure\s+-/;

/**
 * F1.362 — whether this dp has `dp auth ensure`, by asking it: `dp auth ensure --help`.
 *
 * Native-first: dp's own command "reuses an existing user or service account
 * token and refreshes it when needed. If no usable token is available, opens the
 * browser for user login" and, across processes, "one performs the login and
 * the others reuse the saved token" (its `--help`, 13.60.0, read 2026-10-09).
 * {@link login} runs it in place of `dp auth login` when present, so a Sign-in
 * click beside another process already logging in (nessy-cli, an MCP server)
 * waits for that login instead of opening a second browser.
 *
 * Detected by the probe, never by version (13.50.0 is unknown; nessy-cli's
 * 13.27.0 copy lacks it), and by `ensure`'s own NAME line rather than the exit
 * code alone: a CLI framework may answer `--help` after an UNKNOWN subcommand
 * with the parent's help and exit 0. Any failure — no such subcommand, a
 * timeout, a dp that will not start — answers `false`, so the caller falls back
 * to `dp auth login` exactly as before. A caller abort propagates as the abort
 * error it is (the login is being cancelled or ran out of its own budget). Not
 * cached: it runs once per interactive Sign-in, whose browser round trip dwarfs
 * it, and a dp updated in place is read fresh.
 *
 * RESIDUE (F1.364 items 3b/3c, owner's dp login sitting): ensure's failure
 * exits and whether it calls `$BROWSER` (F1.2's URL relay) on a real SSO are
 * unmeasured; {@link login} maps them as it maps `login`'s.
 */
export async function supportsAuthEnsure(
  dpPath: string,
  opts: Pick<DpExecOptions, 'signal' | 'workdir' | 'timeoutMs'> = {},
): Promise<boolean> {
  const { signal, timeout } = combineAbort(opts.signal, opts.timeoutMs ?? ENSURE_PROBE_TIMEOUT_MS);
  try {
    const { stdout } = await execFileAsync(dpPath, ['auth', 'ensure', '--help'], {
      signal,
      env: dpExecEnv(opts.workdir),
    });
    return ENSURE_HELP_NAME.test(String(stdout));
  } catch (err) {
    // The CALLER's abort (a cancel, or `login`'s own budget) propagates as the abort it is, for
    // `login`'s catch to map; only this probe's own budget reads as "no ensure".
    if (isAbortError(err) && !timeout.aborted) throw err;
    return false;
  }
}
