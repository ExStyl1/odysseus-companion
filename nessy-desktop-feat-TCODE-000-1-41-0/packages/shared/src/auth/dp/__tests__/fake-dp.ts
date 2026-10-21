/**
 * Test fixture: a fake `dp` executable written to a temp dir.
 *
 * The script is state-driven via marker files inside its own dir so a single
 * fixture can model the whole flow (needs-login → login → token). It records
 * every invocation to `calls.log` and traps SIGTERM (writing `.got-sigterm`)
 * so cancel/timeout paths are assertable. No real dp, no real SSO.
 */

import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeDpConfig {
  /** Version string emitted by `dp version` (default 13.24.1). */
  version?: string;
  /** Token emitted by `dp auth print-token` once "logged in". */
  token?: string;
  /** Start already logged in (print-token succeeds without a login run). */
  loggedIn?: boolean;
  /**
   * Make `dp auth print-token` hang until cancelled (five minutes, the same
   * shape as `hangVersion`).
   *
   * C3.391 · it used to be `sleep 30`, sized against a 5 s budget that is now
   * 30 s — i.e. a coin flip against its own timeout. Drive the Timeout path
   * with `printToken(..., { timeoutMs })` instead; this knob is for the
   * abort/cancel arms, where the wait is ended by the caller.
   */
  hangPrintToken?: boolean;
  /** Make `dp version` hang until cancelled. */
  hangVersion?: boolean;
  /**
   * C3.391 · SLOW BUT SUCCESSFUL: delay `dp auth print-token` by this many
   * seconds and then print the token normally. The arm that tells a budget
   * sized against dp's startup hook apart from one sized against the token —
   * a delay above the old 5 s and below the new 30 s is a token, not a Timeout.
   */
  printTokenDelaySeconds?: number;
  /** C3.391 · the same, for `dp version`, which pays the same startup hook. */
  versionDelaySeconds?: number;
  /** Make `dp auth login` hang (to exercise cancel/timeout). */
  hangLogin?: boolean;
  /** Make `dp auth login` exit non-zero (to exercise LoginFailed). */
  failLogin?: boolean;
  /**
   * Emit this text to stderr on a successful `dp auth print-token` (simulates
   * dp's update-banner/warning noise) while still exiting 0 with the token on
   * stdout.
   */
  printTokenStderrWarning?: string;
  /**
   * Emit an extra `banner` stdout line before the token on `dp auth
   * print-token`, UNLESS the child's own `DP_NO_WARNINGS` env var is exactly
   * `"true"`. Lets a test prove the env var is actually passed to the child
   * (not just accepted if present).
   */
  printTokenBannerUnlessNoWarnings?: boolean;
  /**
   * F1.360 — the stderr line a NOT-logged-in `dp auth print-token` prints
   * (exit 1). Omitted, it is dp 13.50.0's sentence; dp 13.60.0 also carries
   * "access token not found. you should relogin" (both measured with
   * `grep -aoF` over the 13.60.0 binary), and an unrelated line drives the
   * control arm that must NOT read as needs-login.
   */
  needsLoginStderr?: string;
  /**
   * F1.2 — `dp auth login` invokes `$BROWSER <this URL>` (when `BROWSER` is set
   * in its env) before it waits for the callback, the way dp's opener does:
   * dp prepends `BROWSER` to its candidate list and passes the URL as the first
   * argument (RQ-dp-device, 13.50.0 source). The value of `$BROWSER` the child
   * saw is appended to `browser-path.log` first.
   */
  loginBrowserUrl?: string;
  /**
   * F1.366 — print this line on stdout BEFORE the token on every logged-in
   * `dp auth print-token`, whatever `DP_NO_WARNINGS` says: the update banner
   * that breaks the single-line parse (the row's fourth non-login failure).
   */
  printTokenStdoutBanner?: string;
  /**
   * F1.362 — this dp has `dp auth ensure` (13.60.0 does): `ensure --help`
   * prints the help 13.60.0 prints (its NAME line), and `ensure` behaves as
   * `login` does here (the `$BROWSER` relay, the hang and fail knobs, then
   * logged in) — dp's own help: "If no usable token is available, opens the
   * browser for user login". Omitted, `ensure` is an unknown subcommand, as on
   * a dp that predates it; `ensureHelpLikeParent` instead answers `--help` the
   * way a CLI framework may for an unknown subcommand: the PARENT's help, exit 0.
   */
  hasEnsure?: boolean;
  ensureHelpLikeParent?: boolean;
}

export interface FakeDp {
  /** Directory containing the fake `dp` — prepend to PATH. */
  dir: string;
  /** Absolute path to the fake `dp` binary. */
  binary: string;
  /** Ordered list of sub-commands invoked, e.g. ['version', 'auth print-token']. */
  calls(): string[];
  /** Number of times a given sub-command was invoked. */
  countCalls(sub: string): number;
  /** True once the fixture trapped SIGTERM. */
  gotSigterm(): boolean;
  /**
   * One line per invocation, as the CHILD saw them:
   * `HOME=<v>|DP_WORKDIR=<v>|DP_NO_WARNINGS=<v>`. The only instrument that can
   * tell "the exec env object contained it" from "the subprocess received it" —
   * the distinction AGENTS.md records for the managed-env spread trap.
   */
  childEnv(): string[];
  /** F1.2 — every `$BROWSER` value `dp auth login` invoked, in order. */
  browserPaths(): string[];
}

const SCRIPT = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "$*" >> "$DIR/calls.log"
echo "HOME=$HOME|DP_WORKDIR=$DP_WORKDIR|DP_NO_WARNINGS=$DP_NO_WARNINGS" >> "$DIR/env.log"
case "$1" in
  version)
    trap 'echo term > "$DIR/.got-sigterm"; exit 143' TERM
    if [ -f "$DIR/.delay-version" ]; then sleep "$(cat "$DIR/.delay-version")"; fi
    if [ -f "$DIR/.hang-version" ]; then
      sleep 300 &
      wait $!
    fi
    echo "Spirit CLI Version: $(cat "$DIR/.version" 2>/dev/null || echo 0.0.0) prod (fake)"
    ;;
  auth)
    case "$2" in
      print-token)
        trap 'echo term > "$DIR/.got-sigterm"; exit 143' TERM
        if [ -f "$DIR/.delay-printtoken" ]; then sleep "$(cat "$DIR/.delay-printtoken")"; fi
        if [ -f "$DIR/.hang-printtoken" ]; then
          sleep 300 &
          wait $!
        fi
        if [ -f "$DIR/.logged-in" ]; then
          if [ -f "$DIR/.warn-stderr" ]; then cat "$DIR/.warn-stderr" >&2; fi
          if [ -f "$DIR/.banner-unless-no-warnings" ] && [ "$DP_NO_WARNINGS" != "true" ]; then
            echo "banner"
          fi
          if [ -f "$DIR/.stdout-banner" ]; then cat "$DIR/.stdout-banner"; echo; fi
          cat "$DIR/.token"
        elif [ -f "$DIR/.needs-login-stderr" ]; then
          cat "$DIR/.needs-login-stderr" >&2
          exit 1
        else
          echo "no access token found, you need to authorize user or service account first" >&2
          exit 1
        fi
        ;;
      ensure)
        if [ "$3" = "--help" ]; then
          if [ -f "$DIR/.has-ensure" ]; then
            printf 'NAME:\n   dp auth ensure - Ensures authorization, logging in if needed\n'
            exit 0
          fi
          if [ -f "$DIR/.ensure-help-like-parent" ]; then
            printf 'NAME:\n   dp auth - Authorization commands\n\nCOMMANDS:\n   login        Logs in\n   print-token  Prints the token\n'
            exit 0
          fi
          echo "fake-dp: unknown auth subcommand $2" >&2
          exit 2
        fi
        if [ ! -f "$DIR/.has-ensure" ]; then
          echo "fake-dp: unknown auth subcommand $2" >&2
          exit 2
        fi
        if [ -f "$DIR/.fail-login" ]; then
          echo "fake-dp: ensure failed" >&2
          exit 1
        fi
        trap 'echo term > "$DIR/.got-sigterm"; exit 143' TERM
        if [ -f "$DIR/.login-browser-url" ] && [ -n "$BROWSER" ]; then
          echo "$BROWSER" >> "$DIR/browser-path.log"
          "$BROWSER" "$(cat "$DIR/.login-browser-url")"
        fi
        if [ -f "$DIR/.hang-login" ]; then
          sleep 300 &
          wait $!
        fi
        touch "$DIR/.logged-in"
        echo 'user "fake" is authorized'
        ;;
      login)
        if [ -f "$DIR/.fail-login" ]; then
          echo "fake-dp: login failed" >&2
          exit 1
        fi
        trap 'echo term > "$DIR/.got-sigterm"; exit 143' TERM
        if [ -f "$DIR/.login-browser-url" ] && [ -n "$BROWSER" ]; then
          echo "$BROWSER" >> "$DIR/browser-path.log"
          "$BROWSER" "$(cat "$DIR/.login-browser-url")"
        fi
        if [ -f "$DIR/.hang-login" ]; then
          sleep 300 &
          wait $!
        fi
        touch "$DIR/.logged-in"
        ;;
      *)
        echo "fake-dp: unknown auth subcommand $2" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "fake-dp: unknown command $1" >&2
    exit 2
    ;;
esac
`;

export function createFakeDp(config: FakeDpConfig = {}): FakeDp {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dp-'));
  const binary = join(dir, 'dp');
  writeFileSync(binary, SCRIPT, { encoding: 'utf-8' });
  chmodSync(binary, 0o755);

  writeFileSync(join(dir, '.version'), config.version ?? '13.24.1');
  writeFileSync(join(dir, '.token'), config.token ?? 'fake-dp-token');
  if (config.loggedIn) writeFileSync(join(dir, '.logged-in'), '');
  if (config.hangVersion) writeFileSync(join(dir, '.hang-version'), '');
  if (config.hangPrintToken) writeFileSync(join(dir, '.hang-printtoken'), '');
  if (config.printTokenDelaySeconds !== undefined) {
    writeFileSync(join(dir, '.delay-printtoken'), String(config.printTokenDelaySeconds));
  }
  if (config.versionDelaySeconds !== undefined) {
    writeFileSync(join(dir, '.delay-version'), String(config.versionDelaySeconds));
  }
  if (config.hangLogin) writeFileSync(join(dir, '.hang-login'), '');
  if (config.failLogin) writeFileSync(join(dir, '.fail-login'), '');
  if (config.printTokenStderrWarning) {
    writeFileSync(join(dir, '.warn-stderr'), config.printTokenStderrWarning);
  }
  if (config.printTokenBannerUnlessNoWarnings) {
    writeFileSync(join(dir, '.banner-unless-no-warnings'), '');
  }
  if (config.needsLoginStderr !== undefined) {
    writeFileSync(join(dir, '.needs-login-stderr'), config.needsLoginStderr);
  }
  if (config.loginBrowserUrl !== undefined) {
    writeFileSync(join(dir, '.login-browser-url'), config.loginBrowserUrl);
  }
  if (config.hasEnsure) writeFileSync(join(dir, '.has-ensure'), '');
  if (config.ensureHelpLikeParent) writeFileSync(join(dir, '.ensure-help-like-parent'), '');
  if (config.printTokenStdoutBanner !== undefined) {
    writeFileSync(join(dir, '.stdout-banner'), config.printTokenStdoutBanner);
  }

  const calls = (): string[] => {
    const log = join(dir, 'calls.log');
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  };

  const childEnv = (): string[] => {
    const log = join(dir, 'env.log');
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  };

  return {
    dir,
    binary,
    calls,
    countCalls: (sub: string) => calls().filter((c) => c === sub).length,
    gotSigterm: () => existsSync(join(dir, '.got-sigterm')),
    childEnv,
    browserPaths: () => {
      const log = join(dir, 'browser-path.log');
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    },
  };
}
