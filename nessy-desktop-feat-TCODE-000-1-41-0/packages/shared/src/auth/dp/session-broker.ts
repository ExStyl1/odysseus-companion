import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import {
  demoteDpBinary,
  getDpVersion,
  isDpVersionSupported,
  resolveDpRuntime,
  undemoteDpBinary,
  type DpRuntimeRecord,
} from './dp-binary.ts';
import { login, printToken, type DpExecOptions } from './dp-api.ts';
import { DpAuthError, DpAuthServiceError, DpSpawnFailedError } from './errors.ts';

export type DpSessionState =
  | { state: 'ready'; version: string | null; outdated: boolean }
  | { state: 'needs-login'; version: string | null; outdated: boolean }
  | { state: 'unavailable'; code: DpAuthError }
  | { state: 'error'; code: DpAuthError };

export type DpSessionStatus =
  | 'checking'
  | 'login-required'
  | 'waiting-browser'
  | 'ready'
  | 'dp-outdated'
  /**
   * DA1.79 — the ladder is running on a FALLBACK because a dp it found first
   * could not be started. Advisory, exactly like `dp-outdated`: the flow has
   * already succeeded by the time it is emitted. Without it the recovery DA1.77
   * added is completely silent — a user whose system dp is a dead file is signed
   * in by a copy they never chose and never learns the first one is broken,
   * which is the shape AGENTS.md calls indistinguishable from a defect.
   */
  | 'dp-unrunnable'
  | `error:${DpAuthError}` | `auth-url:${string}`;

export interface DpSessionEnsureOptions extends DpExecOptions {
  ownerId?: string;
  interactive?: boolean;
  onStatus?: (status: DpSessionStatus) => void;
}

export interface DpSessionBroker {
  probe(options?: DpExecOptions): Promise<DpSessionState>;
  ensure(
    options?: DpSessionEnsureOptions,
  ): Promise<Extract<DpSessionState, { state: 'ready' }>>;
  withAccessToken<T>(
    operation: (token: string) => Promise<T>,
    options?: DpSessionEnsureOptions,
  ): Promise<T>;
  subscribe(listener: (state: DpSessionState) => void): () => void;
  cancel(ownerId: string): boolean;
  dispose(): void;
}

interface Waiter {
  cancel(): void;
}

/**
 * How long a POSITIVE probe result is reused. One `probe()` costs two `dp`
 * process spawns, and a single turn can reach `materializeRuntime` three times
 * with up to three probes each. Must stay well under the dp access-token
 * lifetime so a real expiry is discovered by the next turn.
 */
const PROBE_CACHE_TTL_MS = 5_000;

interface ActiveRun {
  ownerId: string;
  controller: AbortController;
  promise: Promise<Extract<DpSessionState, { state: 'ready' }>>;
  waiters: Map<string, Waiter>;
}

export function createDpSessionBroker(
  options: {
    /**
     * The full dp record — binary AND the state root it must run against
     * (DA1.6). Every spawn this broker makes derives its `DP_WORKDIR` from the
     * SAME record that named the binary, so the pair can never come apart.
     */
    resolveRuntime?: () => DpRuntimeRecord;
    /**
     * Path-only seam, kept because seven existing arms inject it. A binary with
     * no record means no `DP_WORKDIR`, which is the dominant production case
     * (Target scheme clause 3) and the right default for a test that only cares
     * which binary ran.
     */
    resolveBinary?: () => string;
    now?: () => number;
  } = {},
): DpSessionBroker {
  const pathOnly = options.resolveBinary;
  const resolveRuntime: () => DpRuntimeRecord =
    options.resolveRuntime
    ?? (pathOnly
      ? () => ({ dpPath: pathOnly(), source: 'system' as const })
      : resolveDpRuntime);
  const now = options.now ?? Date.now;
  const subscribers = new Set<(state: DpSessionState) => void>();
  let activeRun: ActiveRun | null = null;
  /** In-flight `probe()`; `ensure()`'s `activeRun` guard does not cover it. */
  let probeInflight: Promise<DpSessionState> | null = null;
  let probeReadyAt = 0;
  let probeReady: Extract<DpSessionState, { state: 'ready' }> | null = null;
  /**
   * FINGERPRINT of the dp the cached result was derived from — path, state
   * root, mtime and SIZE, not the path alone (DA1.6 item 6).
   *
   * **The sentence this replaces was false for the dominant case, and no gate
   * could see it.** It read: *a dp that was replaced, removed or upgraded
   * resolves elsewhere and has to be re-probed*. It does not. The corp channel
   * replaces `/usr/local/bin/dp` IN PLACE — measured 2026-08-23: that directory
   * is root-owned, `rename()` needs directory write, so `dp update` is
   * structurally unavailable to a non-root user and the channel overwrites the
   * same inode instead. A path-only key therefore misses exactly the upgrade
   * that actually happens, and answers `ready` for a binary that is no longer
   * the one that was probed.
   *
   * The state root is in the key for the same reason: a user who creates
   * `~/.dp` mid-session moves dp onto a DIFFERENT session (Target scheme clause
   * 3), and a cached verdict about the old one is not about the new one.
   */
  let probeReadyFingerprint: string | null = null;

  /**
   * Only a POSITIVE result is ever cached, and any later observation that the
   * session is no longer usable must clear it — otherwise a token that stopped
   * working would keep reporting `ready` for the rest of the window.
   */
  const invalidateProbeCache = (): void => {
    probeReady = null;
    probeReadyAt = 0;
    probeReadyFingerprint = null;
  };

  const emitStatus = (
    options: DpSessionEnsureOptions,
    status: DpSessionStatus,
  ): void => {
    try {
      options.onStatus?.(status);
    } catch {
      // Status observers must not change auth outcomes.
    }
  };

  /**
   * The path this broker has demoted `'unrunnable'`, if any — DA1.79's whole
   * state, and it is deliberately a broker field rather than a read of the
   * registry: the registry knows WHICH paths are demoted, not whether THIS
   * flow's ladder stepped over one, and `dpBinaryDemotion` cannot be asked about
   * a candidate the ladder silently skipped.
   */
  let unrunnableDemotion: string | null = null;

  /**
   * The two ADVISORY notices, emitted together everywhere either is emitted.
   * They are siblings by construction: both are true of the dp the flow just
   * used, neither blocks it, and both are re-derived on every run rather than
   * latched in the renderer — so a dp that is fixed in place stops producing
   * them on the next run, which is the property `undemoteDpBinary` exists for.
   */
  const emitLadderNotices = (
    options: DpSessionEnsureOptions,
    outdated: boolean,
  ): void => {
    if (outdated) emitStatus(options, 'dp-outdated');
    if (unrunnableDemotion !== null) emitStatus(options, 'dp-unrunnable');
  };

  const publish = (state: DpSessionState): DpSessionState => {
    for (const listener of subscribers) {
      try {
        listener(state);
      } catch {
        // Subscribers are observational.
      }
    }
    return state;
  };

  /**
   * `path|workdir|mtimeMs|size`. A binary that cannot be statted answers a
   * `missing` fingerprint rather than throwing — it will not match a cached
   * one, which is the conservative direction.
   */
  const fingerprint = (runtime: DpRuntimeRecord): string => {
    try {
      const stat = statSync(runtime.dpPath);
      return `${runtime.dpPath}|${runtime.workdir ?? ''}|${stat.mtimeMs}|${stat.size}`;
    } catch {
      return `${runtime.dpPath}|${runtime.workdir ?? ''}|missing`;
    }
  };

  const errorForState = (
    state: Extract<DpSessionState, { state: 'unavailable' | 'error' }>,
  ): DpAuthServiceError => new DpAuthServiceError(state.code);

  const runProbe = async (execOptions: DpExecOptions): Promise<DpSessionState> => {
    // Hoisted out of the `try` for the catch's sake ONLY: a demotion names a
    // path, and `resolveRuntime()` can itself throw (`DpNotFound`), in which
    // case there is no path and nothing to demote.
    let probedDpPath: string | null = null;
    try {
      const runtime = resolveRuntime();
      const dpPath = runtime.dpPath;
      probedDpPath = dpPath;
      const execOptionsForSpawn = { ...execOptions, workdir: runtime.workdir };
      // C3.391 · CONCURRENT, and the ordering is the whole reason. Both spawns
      // pay dp's own startup hook (`dp version` is a SUBCOMMAND, not the exempt
      // `--version` flag), and both budgets are now sized against that hook —
      // so awaiting them in sequence, as this did, made one probe window cost
      // the SUM of two hung network waits, with the advisory version probe
      // spending its whole budget before the token attempt could start. They
      // depend on nothing of each other's; run together the window is the
      // longer of the two. `getDpVersion` never throws, so the only rejection
      // `Promise.all` can see is `printToken`'s, which is the one the catch
      // below already classifies.
      const [version, token] = await Promise.all([
        getDpVersion(dpPath, execOptionsForSpawn),
        printToken(dpPath, execOptionsForSpawn),
      ]);
      const outdated = !isDpVersionSupported(version);
      // The version floor is a LADDER-PREFERENCE input as well as a warning
      // (DA1.6 item 6): a below-floor dp is skipped while another rung is
      // runnable and still taken when it is the only one, so the floor stays
      // warn-only for usability. Symmetric on purpose — an in-place upgrade of
      // the same path must be able to clear its own demotion.
      if (outdated) demoteDpBinary(dpPath, 'below-floor');
      else undemoteDpBinary(dpPath);
      if (token === undefined) {
        // Never cached: the user can log in between turns.
        invalidateProbeCache();
        return publish({ state: 'needs-login', version, outdated });
      }
      const ready = { state: 'ready' as const, version, outdated };
      probeReady = ready;
      probeReadyAt = now();
      probeReadyFingerprint = fingerprint(runtime);
      return publish(ready);
    } catch (error) {
      // An exec failure is transient — a timed-out spawn must not pin a decision.
      invalidateProbeCache();
      // ...with ONE exception, and it is the whole of DA1.77: a dp that never
      // STARTED is not transient, it is a dead file, and leaving it undemoted
      // pins the ladder on it forever — `resolveDpRuntime`'s runnability test is
      // `accessSync(X_OK)`, which keeps answering yes. `DpSpawnFailedError` is
      // the arm `printToken` narrows for exactly this; `unrunnable` is the
      // further question of whether the errno is about the BINARY or about the
      // machine (`errors.ts` symbol `UNRUNNABLE_SPAWN_ERRNOS`). A NON-ZERO EXIT
      // — a real dp answering something we did not parse — never reaches here as
      // that class and so can never demote, which is the property the old
      // `ExecFailed`-only shape could not express.
      //
      // The recovery is the NEXT resolution, not a retry inside this window: the
      // demotion makes the lower rungs reachable and the following `probe()`
      // takes them. A retry loop here would cost a second pair of dp spawns
      // inside one probe window and would need its own bound; one failed turn
      // is the smaller, visible price.
      if (
        probedDpPath !== null
        && error instanceof DpSpawnFailedError
        && error.unrunnable
      ) {
        demoteDpBinary(probedDpPath, 'unrunnable');
        unrunnableDemotion = probedDpPath;
      }
      const code =
        error instanceof DpAuthServiceError
          ? error.code
          : DpAuthError.ExecFailed;
      return publish(
        code === DpAuthError.DpNotFound
          ? { state: 'unavailable', code }
          : { state: 'error', code },
      );
    }
  };

  const probe = async (execOptions: DpExecOptions = {}): Promise<DpSessionState> => {
    // Reuse a recent READY result. Republish rather than return silently:
    // `observeDpSessionState` is what restores DP servers to a leaser's desired
    // set, and it only runs on a publish.
    // `resolveRuntime` is a PATH scan plus one stat, not a spawn — cheap next to
    // the two dp processes a real probe costs. If it now throws or fingerprints
    // differently, fall through and re-probe instead of answering for a binary
    // that is no longer the one that was probed.
    let currentFingerprint: string | null;
    try {
      currentFingerprint = fingerprint(resolveRuntime());
    } catch {
      currentFingerprint = null;
    }
    if (
      probeReady
      && currentFingerprint !== null
      && probeReadyFingerprint === currentFingerprint
      && now() - probeReadyAt < PROBE_CACHE_TTL_MS
    ) {
      return publish(probeReady);
    }
    // Collapse concurrent callers onto one pair of dp spawns. A cold registry is
    // a guaranteed double probe otherwise: `publish()` fires subscribers
    // synchronously here, moving `dpReadyBoundaryGeneration` before the caller's
    // own await resolves and forcing its retry.
    if (probeInflight) return probeInflight;
    probeInflight = runProbe(execOptions).finally(() => { probeInflight = null; });
    return probeInflight;
  };

  /**
   * F1.2 — the authorization URL of each in-flight login, and the callers who
   * JOINED that login and asked to hear about it. Keyed by the run, so a URL can
   * never outlive the login it belongs to (the run is dropped when it settles).
   *
   * `auth-url:<url>` is ADVISORY like `dp-outdated`: it never changes an
   * outcome, it tells a Sign-in surface which link dp handed its browser so the
   * user can open it when that browser cannot be seen (`dp-api.ts` symbol
   * `createBrowserHook` carries the scope: the callback still lands on
   * `localhost:25565` of this machine).
   */
  const authUrlRelays = new WeakMap<ActiveRun, { url: string | null; listeners: Set<(status: DpSessionStatus) => void> }>();
  const authUrlRelay = (run: ActiveRun) => {
    let relay = authUrlRelays.get(run);
    if (!relay) {
      relay = { url: null, listeners: new Set() };
      authUrlRelays.set(run, relay);
    }
    return relay;
  };
  const relayAuthUrl = (run: ActiveRun, ownerOptions: DpSessionEnsureOptions, url: string): void => {
    const relay = authUrlRelay(run);
    relay.url = url;
    emitStatus(ownerOptions, `auth-url:${url}`);
    for (const listener of relay.listeners) emitStatus({ onStatus: listener }, `auth-url:${url}`);
  };

  const startRun = (
    ownerId: string,
    options: DpSessionEnsureOptions,
  ): ActiveRun => {
    const controller = new AbortController();
    let run: ActiveRun;
    const promise = (async () => {
      try {
        emitStatus(options, 'checking');
        const initial = await probe({ signal: controller.signal });
        if (initial.state === 'ready') {
          emitLadderNotices(options, initial.outdated);
          emitStatus(options, 'ready');
          return initial;
        }
        if (initial.state !== 'needs-login') throw errorForState(initial);
        emitLadderNotices(options, initial.outdated);
        emitStatus(options, 'login-required');
        if (options.interactive === false) {
          const error = new DpAuthServiceError(
            DpAuthError.InteractiveLoginUnavailable,
          );
          invalidateProbeCache();
          publish({ state: 'error', code: error.code });
          throw error;
        }

        emitStatus(options, 'waiting-browser');
        const loginRuntime = resolveRuntime();
        try {
          await login(loginRuntime.dpPath, {
            signal: controller.signal,
            workdir: loginRuntime.workdir,
            timeoutMs: options.timeoutMs,
            onAuthUrl: (url) => relayAuthUrl(run, options, url),
          });
        } catch (error) {
          throw asInvisibleBrowserTimeout(error);
        }
        const state = await probe({ signal: controller.signal });
        if (state.state === 'ready') {
          emitLadderNotices(options, state.outdated);
          emitStatus(options, 'ready');
          return state;
        }
        if (state.state === 'needs-login') {
          throw new DpAuthServiceError(
            DpAuthError.NeedsLogin,
            'dp still not logged in after login',
          );
        }
        throw errorForState(state);
      } catch (error) {
        const serviceError =
          error instanceof DpAuthServiceError
            ? error
            : new DpAuthServiceError(DpAuthError.ExecFailed, 'dp session failed');
        emitStatus(options, `error:${serviceError.code}`);
        throw serviceError;
      }
    })().finally(() => {
      if (activeRun === run) activeRun = null;
    });
    run = {
      ownerId,
      controller,
      promise,
      waiters: new Map<string, Waiter>(),
    };
    activeRun = run;
    return run;
  };

  const waitForRun = (
    run: ActiveRun,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<Extract<DpSessionState, { state: 'ready' }>> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (run.waiters.get(ownerId) === waiter) run.waiters.delete(ownerId);
        operation();
      };
      const waiter: Waiter = {
        cancel: () =>
          finish(() =>
            reject(new DpAuthServiceError(DpAuthError.Cancelled, 'dp login wait cancelled')),
          ),
      };
      const abort = (): void => {
        if (ownerId === run.ownerId) run.controller.abort();
        else waiter.cancel();
      };
      run.waiters.set(ownerId, waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      run.promise.then(
        (state) => finish(() => resolve(state)),
        (error) => finish(() => reject(error)),
      );
    });

  const ensure = async (
    ensureOptions: DpSessionEnsureOptions = {},
  ): Promise<Extract<DpSessionState, { state: 'ready' }>> => {
    const ownerId = ensureOptions.ownerId ?? randomUUID();
    if (activeRun) {
      // F1.2 — a caller meeting a login already in flight is handed THAT
      // login's URL (now, and when it arrives) rather than a second login: two
      // concurrent logins collide on dp's loopback port anyway. A
      // non-interactive caller is still refused — it only learns the link.
      const relay = authUrlRelay(activeRun);
      if (relay.url !== null) emitStatus(ensureOptions, `auth-url:${relay.url}`);
      if (ensureOptions.interactive === false) {
        throw new DpAuthServiceError(DpAuthError.InteractiveLoginUnavailable);
      }
      const listener = ensureOptions.onStatus;
      if (!listener) return waitForRun(activeRun, ownerId, ensureOptions.signal);
      relay.listeners.add(listener);
      return waitForRun(activeRun, ownerId, ensureOptions.signal).finally(() => {
        relay.listeners.delete(listener);
      });
    }
    const run = startRun(ownerId, ensureOptions);
    return waitForRun(run, ownerId, ensureOptions.signal);
  };

  return {
    probe,
    ensure,
    async withAccessToken(operation, ensureOptions = {}) {
      await ensure(ensureOptions);
      try {
        const tokenRuntime = resolveRuntime();
        const token = await printToken(tokenRuntime.dpPath, {
          signal: ensureOptions.signal,
          workdir: tokenRuntime.workdir,
        });
        if (token === undefined) {
          // The token stopped working: a cached `ready` must not outlive it.
          invalidateProbeCache();
          publish({
            state: 'needs-login',
            version: null,
            outdated: false,
          });
          throw new DpAuthServiceError(DpAuthError.NeedsLogin);
        }
        return await operation(token);
      } catch (error) {
        if (error instanceof DpAuthServiceError) {
          invalidateProbeCache();
          publish({ state: 'error', code: error.code });
        }
        throw error;
      }
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    cancel(ownerId) {
      const run = activeRun;
      const waiter = run?.waiters.get(ownerId);
      if (!run || !waiter) return false;
      if (run.ownerId === ownerId) run.controller.abort();
      else waiter.cancel();
      return true;
    },
    dispose() {
      const run = activeRun;
      activeRun = null;
      invalidateProbeCache();
      run?.controller.abort();
      for (const waiter of run?.waiters.values() ?? []) waiter.cancel();
      run?.waiters.clear();
      subscribers.clear();
    },
  };
}

export const dpSessionBroker = createDpSessionBroker();

/**
 * DA3.17 — re-code a `login()` Timeout as {@link DpAuthError.LoginBrowserTimeout}
 * so the card can say what to do instead of "sign-in timed out".
 *
 * Only `Timeout` is touched. `Cancelled` is the user's own cancel,
 * `LoginFailed` is dp running and being refused, and `DpSpawnFailedError` is dp
 * never starting — each already sends the user somewhere specific, and widening
 * this would blame an invisible browser for three failures that are not it. The
 * re-code carries the original as `cause`. The ONE producer of the new code is
 * this function, reached only from `startRun`'s INTERACTIVE path: the
 * `interactive === false` branch throws `InteractiveLoginUnavailable` before any
 * dp is spawned, and `ensure`'s contention branch throws the same code without
 * reaching `startRun` at all — both stay exactly as they were.
 *
 * `error` is returned rather than thrown so the call site reads as one `throw`:
 * a helper that throws makes the control flow invisible to a reader skimming for
 * what leaves `startRun`.
 *
 * **It lives at the BOTTOM of the file on purpose.** Function declarations
 * hoist, so position is free here — and four specs cite this file by LINE in the
 * first 171 (`DpSessionState`, `DpSessionStatus`, the probe cache, the
 * spawn-collapsing `runProbe`). A 20-line docblock above them would have blanked
 * every one of those anchors, which is the cost AGENTS.md prices for a comment
 * edit in a cited file. Put the next module-scope helper here too.
 */
function asInvisibleBrowserTimeout(error: unknown): unknown {
  if (!(error instanceof DpAuthServiceError) || error.code !== DpAuthError.Timeout) {
    return error;
  }
  return new DpAuthServiceError(
    DpAuthError.LoginBrowserTimeout,
    'dp auth login ended with no callback on localhost:25565 — the browser dp opened may not be visible on this machine',
    { cause: error },
  );
}
