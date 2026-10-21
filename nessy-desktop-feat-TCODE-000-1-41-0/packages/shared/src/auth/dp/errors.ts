/**
 * Error types for the Nessy Gateway dp-auth module.
 *
 * `code` is the stable, serializable discriminator forwarded across IPC and
 * mapped to a localized string in the UI. Detail strings MUST never contain
 * token material (dp token or JWT) — see 00-context "Do not log tokens".
 */

export enum DpAuthError {
  DpNotFound = 'DpNotFound',
  NeedsLogin = 'NeedsLogin',
  LoginFailed = 'LoginFailed',
  ExecFailed = 'ExecFailed',
  ExchangeFailed = 'ExchangeFailed',
  Timeout = 'Timeout',
  /**
   * DA3.17 — `dp auth login` ran its full budget without the browser ever
   * calling back, which on this machine almost always means the browser dp
   * opened cannot be SEEN.
   *
   * **Why it is not simply `Timeout`.** `Timeout` is a BUCKET spanning three
   * unrelated waits — `dp auth print-token` (30 s), the token exchange, and
   * this one — and the card renders `chat.dpAuth.errors.<code>`, one sentence
   * per code. The other two are "something is slow, try again"; this one has an
   * ACTION, and the action is specific: dp's loopback callback listens on
   * `http://localhost:25565/auth` of the machine running dp, so the sign-in has
   * to be finished in a browser that can reach that address here (an SSH user
   * can forward the port). Re-using `Timeout` would have to put that sentence
   * in front of a slow print-token too, which is false advice; a subclass
   * cannot help, because the IPC channel to the card is codes-only
   * ({@link DpSpawnFailedError} exists for the opposite case, where the extra
   * distinction is for a CALLER and not for the user).
   *
   * Measured by lane RQ-dp-device, 2026-09-18, against dp 13.50.0 and the
   * source clones pinned to that build: dp logs `opening browser tab for user
   * to authorize...`, never prints the authorization URL on any path, DISCARDS
   * the boolean its browser-open helper returns, and then blocks in
   * `WaitForAuthCallback` with no timeout of its own. On darwin the opener is
   * `/usr/bin/open`, which exits 0 even over SSH, so there is no failure signal
   * at all — only our own five minutes.
   *
   * `session-broker.ts` symbol `startRun` is the ONLY site that mints it, from
   * a `Timeout` that `dp-api.ts` symbol `login` raised; the non-interactive
   * branch still refuses with `InteractiveLoginUnavailable` and never reaches
   * here.
   */
  LoginBrowserTimeout = 'LoginBrowserTimeout',
  Cancelled = 'Cancelled',
  InteractiveLoginUnavailable = 'InteractiveLoginUnavailable',
  /**
   * DA1.23 — the dp flow failed AND the only token variable on the machine is
   * nessy-cli's `NESSY_CLI_DP_AUTH_TOKEN`, ours being unset.
   *
   * It is a re-code of a failure that already happened, never a refusal of its
   * own: `env-token.ts` symbol `diagnoseGatewayAuthFailure` is the only site
   * that mints it, and the presence of that variable on a SUCCESSFUL sign-in
   * changes nothing. It exists because the channel carrying this value to the
   * card is codes-only, so naming the variable in a sentence requires a code of
   * its own.
   */
  CliEnvTokenOnly = 'CliEnvTokenOnly',
}

export class DpAuthServiceError extends Error {
  constructor(
    public readonly code: DpAuthError,
    detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = 'DpAuthServiceError';
  }
}

/**
 * Errno names that mean THIS PATH WILL NOT EXECUTE, however often it is tried.
 *
 * All three are measured (`internal.ts` symbol `spawnFailureErrno` carries the
 * table): `ENOEXEC` is a file that is not a program, `ENOENT` is a missing file
 * or a missing interpreter named by its shebang, `EACCES` is a directory, a
 * `noexec` mount or an X bit lost between the ladder's `accessSync` and the
 * spawn.
 *
 * **What is deliberately NOT here, and why the set is not simply "every spawn
 * errno".** `ETXTBSY` (someone is writing the file right now), `EAGAIN`,
 * `ENOMEM` and their family are the MACHINE refusing, not the binary being
 * dead — and the demotion this set gates is process-lifetime, so treating a
 * transient resource failure as "this dp is broken" would move a healthy system
 * dp off the ladder until the app restarts. That is the worse-than-the-bug
 * outcome `dp-binary.ts` symbol `demoteDpBinary`'s docblock names, so those
 * errnos stay a plain `ExecFailed` with no demotion, exactly as today.
 */
const UNRUNNABLE_SPAWN_ERRNOS: ReadonlySet<string> = new Set(['ENOEXEC', 'ENOENT', 'EACCES']);

/**
 * A dp exec that never STARTED — the OS refused to create the process.
 *
 * **It is a `DpAuthServiceError` carrying `ExecFailed`, on purpose.** Every
 * surface that reads this module reads `code`: the IPC channel is codes-only,
 * the card maps `chat.dpAuth.errors.<code>` to a localized string, and
 * `error-paths.test.ts` asserts that every `DpAuthError` member sits in exactly
 * one of its two narrowing tables. A new enum member would therefore need a
 * locale key in both files and would change what a user sees, to say something
 * no user can act on. A SUBCLASS adds the distinction for the one caller that
 * can act on it — `session-broker.ts` symbol `runProbe`, which demotes the rung
 * — and is invisible to everyone else; `name` stays `'DpAuthServiceError'`
 * because the base constructor sets it and nothing here overrides it.
 *
 * `unrunnable` is the half that licenses a demotion. A spawn failure is not by
 * itself proof the binary is dead (see {@link UNRUNNABLE_SPAWN_ERRNOS}), so the
 * two questions stay separate: this class answers *did it start*, the flag
 * answers *will it ever*.
 *
 * **`code` is a PARAMETER, defaulting to `ExecFailed` (DA1.78).** The same
 * distinction is worth making on `dp auth login`, whose bucket is `LoginFailed`
 * — a dp that never started and a dp that ran and was refused by corp SSO send
 * the user to two completely different places. One class with a defaulted code
 * was chosen over a second class deliberately: the codes-only IPC channel, the
 * locale keys and every `instanceof` reader stay exactly as they are, and the
 * default keeps `printToken`'s call site unchanged.
 */
export class DpSpawnFailedError extends DpAuthServiceError {
  constructor(
    detail: string,
    public readonly errno: string,
    code: DpAuthError = DpAuthError.ExecFailed,
  ) {
    super(code, `${detail} (${errno})`);
  }

  /** True when the errno means the path itself cannot be executed. */
  get unrunnable(): boolean {
    return UNRUNNABLE_SPAWN_ERRNOS.has(this.errno);
  }
}
