/**
 * Small shared helpers for the dp-auth module: abort/timeout wiring, the
 * environment every dp exec carries, and error-shape probing. Kept internal so
 * callers stay declarative.
 */

import { latchedHomeDir } from '../../config/home-latch.ts';
import {
  applyLoopbackProxyExemption,
  applyNodeEnvProxy,
  getProxyEnvVars,
} from '../../config/proxy-env.ts';

/**
 * The environment EVERY `dp` exec in this module carries — DA1.6 item 4, and
 * the first of the two live defects that row names.
 *
 * **`HOME` is the session's LATCHED home, and it was missing here.** The two
 * execs in `dp-api.ts` passed `{ ...process.env, DP_NO_WARNINGS: 'true' }` and
 * nothing else, so the process that MINTS the token followed a confirmed
 * managed `HOME` live while `creds-store.ts` symbol `getCredsPath` stayed
 * latched. Under a mid-session managed `HOME` the token was therefore minted
 * against the NEW home's dp state and stored at the OLD home's path — the exact
 * split `dp-runtime.ts` symbol `dpRuntimeEnvironment`'s own docblock says it
 * exists to prevent, on the one path that did not use it. See
 * `config/home-latch.ts` for the measurement and the latch's boundary.
 *
 * **`DP_WORKDIR` rides the same record as the binary** (Target scheme clause
 * 3). `undefined` means "dp uses its own `~/.dp`", which is the dominant and
 * desired case, and the key is then omitted rather than set empty.
 *
 * **The pin is POSIX-only, and by accident rather than by decision.** What is
 * pinned is `HOME`; on win32 `latchedHomeDir()` is `os.homedir()`, which
 * resolves from `USERPROFILE`, and `config/managed-env.ts` classifies
 * `USERPROFILE` as `'selector'` one line below `HOME` — so a CONFIRMED managed
 * `USERPROFILE` rides the `...process.env` spread above while the pin sits
 * inert. It is deliberately NOT pinned here: how dp resolves its own home on
 * win32 is unmeasured, pinning a name the child may not read would be an
 * invented answer, and the platform does not ship (`docs/release-channels.md`
 * — `release-macos` and `publish-macos-dev` are the only live release/publish
 * jobs). Measure dp on win32 first; the pin follows the measurement. The
 * residue is this builder's ALONE — `dp-runtime.ts` symbol
 * `dpRuntimeEnvironment` spreads nothing, so no ambient name can ride it.
 * Sibling posture: the parked Windows decision DA3.7.
 *
 * **Why this is not `dpRuntimeEnvironment`.** That function builds the env for
 * a dp MCP CHILD and carries `DP_AI_MCP_SKIP_LOGIN: 'true'`, whose whole
 * purpose is to make an unauthorized `dp ai mcp` fail fast instead of opening a
 * browser. `dp auth login` is the one command in this module that MUST open a
 * browser, so handing it that switch would be a silent behaviour change on the
 * only interactive path we have. Two small builders, each honest about its own
 * child, beat one builder with a flag.
 *
 * **The app's own `networkProxy` SETTING binds this child too** — DA1.59, owner
 * decision 2026-09-17, one mechanism for every child. This is the same
 * projection `agent/pi-agent.ts` symbol `buildPiSubprocessEnv` and
 * `agent/options.ts` symbol `buildClaudeSubprocessEnv` apply, in the same order:
 * the resolved settings spread OVER the inherited environment (so a Settings
 * proxy wins over an ambient one, the precedence those two already give),
 * then the loopback exemption, then `NODE_USE_ENV_PROXY`.
 *
 * WHY IT WAS MISSING, and it is not that the spread was enough. The packaged
 * desktop never projects the setting into its own `process.env`:
 * `config/network-runtime.ts` symbol `applyProcessNetworkTrustChain` — whose
 * `projectProxyEnv` does that mirroring — is called from
 * `packages/server/src/index.ts` (the headless server) and from that module's
 * own settings-apply path, and from nowhere in `apps/electron/src/main`, which
 * installs an undici dispatcher instead and writes no proxy name into its
 * environment (measured 2026-09-17: zero `process.env.<proxy name>` writes in
 * that tree's non-test sources, with the same grep finding `process.env.` and
 * `HTTPS_PROXY` elsewhere as its control). So `{ ...process.env }` carries the
 * user's login-shell proxy and nothing else. The 1.39.0 release sitting
 * measured both arms end to end (RS-43 B1/B2, `docs/testing/cdp-live-checklist.md`):
 * with the proxy in the SETTING the re-mint reached `as.tbank.ru` outside the
 * operator's proxy, which logged that host zero times; with the same proxy in
 * the ENVIRONMENT the child was refused three times in 121 ms — so dp honours
 * these names, and only the setting was not reaching it.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO. It does not carry the mTLS client
 * identity through a narrower `excludeClientIdentity` projection, the way
 * `getPluginNetworkEnvVars` and `buildShellChildNetworkEnv` do: those exist
 * because the code inside those children is written by a plugin or by the
 * MODEL, while this argv is fixed and first-party, so the owner decision's
 * "one mechanism for every child" is taken literally — the `CLAUDE_CODE_CLIENT_*`
 * trio rides along inert, since dp reads no `CLAUDE_CODE_*` name. And it adds
 * no per-call log: the values are an operator's proxy URL and a key
 * passphrase, and `config/proxy-env.ts`'s own SECURITY note forbids logging the
 * record.
 *
 * THE CA TRAVELS ON THIS SAME SPREAD, AND THAT IS DECIDED RATHER THAN
 * INCIDENTAL — DA1.66, owner decision 2026-09-17, the same sentence as DA1.59's:
 * one mechanism for every child. `buildNetworkEnvVars` emits
 * `NODE_EXTRA_CA_CERTS` regardless of proxy enablement, so on a machine with NO
 * proxy at all the app's extra-CA selection still reaches this child — a
 * user's `tlsCaPath`, an admin's managed CA, or the bundled corporate resource
 * on a packaged build (`config/tls-ca-path.ts` symbol
 * `resolveTlsCaPathSelection`: managed > custom > operator > bundled). It is
 * additive trust on a name dp only reads if it is a Node program — Node and Bun
 * union it with their own roots rather than replacing them — and it is the same
 * trust chain every other child of this app already verifies against.
 *
 * This paragraph used to describe that reach as a SIDE EFFECT of DA1.59
 * ("one change this makes on a machine with no proxy"), and nothing pinned it:
 * DA1.59's four arms are all proxy names. The row that decided it also asked for
 * the pin, and `__tests__/dp-exec-env-proxy.test.ts` now carries two CA arms —
 * the proxy-disabled positive, and the boundary where the stored `tlsCaPath`
 * outranks an operator's ambient `NODE_EXTRA_CA_CERTS` (so the delivery path is
 * the projection, not the spread).
 *
 * WHAT THE PHRASE "the app's CA trust setting" DOES NOT COVER, measured
 * 2026-09-17 rather than assumed: the `certStore` setting (`bundled,system`) is
 * IN-PROCESS ONLY. Its two readers are `apps/electron/src/main/network-proxy.ts`
 * and `config/network-runtime.ts`, both of which hand the composed set to an
 * undici dispatcher inside their own process; `network-proxy-utils.ts` symbol
 * `composeCaTrust` has no env spelling and NO child of this app receives it —
 * not Pi, not the Claude subprocess, not a stdio MCP server, not this exec. So
 * "the way agent children do" resolves to `NODE_EXTRA_CA_CERTS` and to nothing
 * else, and this child is now on exactly that rule.
 */
export function dpExecEnv(workdir?: string, browser?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...getProxyEnvVars(),
    HOME: latchedHomeDir(),
    DP_NO_WARNINGS: 'true',
    ...(workdir ? { DP_WORKDIR: workdir } : {}),
    // F1.2 — `dp auth login` ONLY: the helper `dp-api.ts` symbol
    // `createBrowserHook` writes, which records dp's authorization URL and
    // forwards it to the user's own browser. Omitted, the user's `BROWSER`
    // (if any) rides the spread above untouched.
    ...(browser ? { BROWSER: browser } : {}),
  };
  // Both are no-ops unless a proxy is actually in effect, so a machine without
  // one gets a byte-identical environment; and the order is load-bearing for
  // the reason `applyNodeEnvProxy`'s docblock gives.
  applyLoopbackProxyExemption(env);
  applyNodeEnvProxy(env);
  return env;
}

/** True for an AbortSignal-driven cancellation (caller signal or timeout). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { name?: unknown }).name === 'AbortError' ||
      (err as { name?: unknown }).name === 'TimeoutError' ||
      (err as { code?: unknown }).code === 'ABORT_ERR')
  );
}

/** Read a `stderr` string off a child-process error, if present. */
export function getStderr(err: unknown): string {
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { stderr?: unknown }).stderr === 'string'
  ) {
    return (err as { stderr: string }).stderr;
  }
  return '';
}

/**
 * Combine an optional caller signal with a fresh timeout signal. Returns the
 * merged signal to pass to fetch/execFile plus the timeout signal so the caller
 * can tell "timed out" from "cancelled" after an abort.
 */
export function combineAbort(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  return { signal, timeout };
}

/**
 * The errno name when the OS REFUSED TO START the process, or `undefined` when
 * the error is anything else — including a child that ran and exited non-zero.
 *
 * **The two are indistinguishable without this, and that was DA1.77's whole
 * defect.** `execFile` reports both through one rejected promise, and the only
 * field that separates them is the TYPE of `code` — measured 2026-09-18 on bun
 * 1.3.14 / darwin arm64, driving a real `execFile` against six fabricated
 * targets:
 *
 * | target (X bit set unless noted)      | `code`     | `syscall`        |
 * | ------------------------------------ | ---------- | ---------------- |
 * | zero-byte file                       | `ENOEXEC`  | `posix_spawn`    |
 * | binary garbage                       | `ENOEXEC`  | `posix_spawn`    |
 * | script with a bad interpreter line   | `ENOENT`   | `spawn <path>`   |
 * | a DIRECTORY (`accessSync(X_OK)` PASSES on one) | `EACCES` | `spawn <path>` |
 * | a path that does not exist           | `ENOENT`   | `spawn <path>`   |
 * | a script that exits 3                | `3` (number) | — (absent)     |
 *
 * So a SPAWN failure carries a string errno plus a `syscall`, and a NON-ZERO
 * EXIT carries the numeric exit status and no `syscall` at all. Both spellings
 * of `syscall` are required in the test because bun emits `posix_spawn` for the
 * ENOEXEC family and `spawn <path>` for the other two, and neither is a prefix
 * of the other.
 *
 * `syscall` is demanded as well as the string `code` deliberately: an
 * `AbortError` also carries a STRING code (`ABORT_ERR`) and no `syscall`, so a
 * `typeof code === 'string'` test alone would misclassify a cancellation as a
 * dead binary. The callers check abort first anyway; this is the second lock on
 * a door whose first lock is somebody else's ordering.
 */
export function spawnFailureErrno(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  if (typeof code !== 'string' || typeof syscall !== 'string') return undefined;
  return syscall === 'posix_spawn' || syscall.startsWith('spawn') ? code : undefined;
}
