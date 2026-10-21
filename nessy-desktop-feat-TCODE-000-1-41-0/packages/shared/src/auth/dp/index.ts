/**
 * `@nessy-agent/shared/auth/dp` — one-click Nessy Gateway auth.
 *
 * `ensureNessyGatewayAuth()` is the single facade both gateway cards call. It
 * single-flights the whole flow (env bypass → cached creds → dp print-token →
 * browser login if needed → token exchange → save) and emits code-only status
 * updates. Token values never appear in statuses, logs, or errors.
 */

import { createLogger } from '../../utils/debug.ts';
import { onNessyGatewayAuthenticated } from '../../config/managed-delivery.ts';
import { exchangeDpToken } from './exchange.ts';
import { decodeJwtClaims, isUsableJwt } from './jwt.ts';
import { getValidCreds, saveCreds, readCliOauthJwt } from './creds-store.ts';
import { tryEnvToken, diagnoseGatewayAuthFailure } from './env-token.ts';
import { DpAuthError, DpAuthServiceError } from './errors.ts';
import {
  dpSessionBroker,
  type DpSessionBroker,
  type DpSessionStatus,
} from './session-broker.ts';
import { exchangeStoredDpSession, type StoredDpSessionSeam } from './dp-session-file.ts';
/** Codes and booleans only — never a token value or its length. */
const log = createLogger('dp-auth');

export { DpAuthError, DpAuthServiceError } from './errors.ts';
export { isJwtShaped, isUsableJwt } from './jwt.ts';
export {
  getValidCreds,
  getCredsPath,
  getNessyDir,
  NESSY_HOME_ENV,
  saveCreds,
  clearCreds,
  readDpIdentity,
  type DpCredentials,
  type DpIdentity,
} from './creds-store.ts';
export {
  resolveDpBinary,
  /**
   * DA1.6. The seam a caller that is about to SPAWN dp should use: it pairs the
   * binary with the state root that binary must run against, so the two cannot
   * be derived independently. Both hand-pairing consumers took the record in
   * DA1.52 — `packages/shared/src/mcp/builtin-dp-servers.ts` and
   * `packages/shared/src/agent/backend/internal/runtime-resolver.ts` — and the
   * second one is worth reading before writing a third: its `workdir` also
   * becomes a sandbox write grant, so it runs the record's answer through
   * {@link hardenDpStateRoot} rather than granting it raw.
   */
  resolveDpRuntime,
  managedDpBinaryPath,
  managedDpStateRoot,
  nessyCliDpBinaryPath,
  demoteDpBinary,
  undemoteDpBinary,
  dpBinaryDemotion,
  getDpVersion,
  isDpVersionSupported,
  DP_MIN_VERSION,
  NESSY_DP_ENV,
  type DpRuntimeRecord,
  type DpRuntimeSource,
} from './dp-binary.ts';
export {
  /**
   * DA1.48 — rung 5. INERT until the pin table carries values, and it is the
   * one module allowed to write rung 3's path. No caller yet: wiring one is a
   * product decision that follows the pin, not the code.
   */
  ensureManagedDp,
  DP_ASSET_PIN,
  type DpAssetPin,
  type DpAssetPinTable,
  type DpAssetPlatform,
  type DpProvisionOutcome,
  type DpProvisionResult,
} from './dp-provision.ts';
export {
  resolveDpStateRoot,
  dpRuntimeEnvironment,
  // DA1.52 / DA1.49 — the hardening and the deny predicate the two grant
  // sites share. `server-core` cannot reach the leaf module, only this barrel.
  hardenDpStateRoot,
  dpStateRootDeniedBy,
} from './dp-runtime.ts';
export { NESSY_TOKEN_EXCHANGE_URL } from './exchange.ts';
export {
  NESSY_DP_AUTH_TOKEN_ENV,
  NESSY_CLI_DP_AUTH_TOKEN_ENV,
  cliEnvTokenIsTheOnlyOne,
  diagnoseGatewayAuthFailure,
} from './env-token.ts';
export {
  createDpSessionBroker,
  dpSessionBroker,
  type DpSessionBroker,
  type DpSessionEnsureOptions,
  type DpSessionState,
  type DpSessionStatus,
} from './session-broker.ts';

/** Serializable status codes emitted during the auth flow (never token data). */
export type GatewayAuthStatus =
  | 'checking'
  | 'waiting-browser'
  | 'exchanging'
  | 'done'
  | 'dp-outdated'
  /** DA1.79 — the ladder is on a fallback; advisory, like `dp-outdated`. */
  | 'dp-unrunnable'
  | `error:${DpAuthError}` | `auth-url:${string}` | 'dp-session-file';

export interface EnsureGatewayAuthOptions {
  onStatus?: (status: GatewayAuthStatus) => void;
  /** Only the FIRST concurrent caller's signal is wired to the shared run. */
  signal?: AbortSignal;
  /** When false, probe cached/dp state without opening the browser login. */
  interactive?: boolean;
  /** Exchange endpoint override — dependency-injection seam for tests only. */
  exchangeUrl?: string;
  /** Creds file path override — dependency-injection seam for tests only. */
  credsPath?: string;
  /** Seed-file path override — dependency-injection seam for tests only. */
  oauthCredsPath?: string;
  /** Test seams only: the raw DP session broker, and (F1.366) dp's own session file. */
  sessionBroker?: DpSessionBroker; dpSessionFile?: StoredDpSessionSeam;
  /**
   * Skip the cached-creds warm path and re-mint through dp. Set by the
   * gateway 401 auth-retry (the cached JWT was just REJECTED — returning it
   * again loops forever; nessy-cli re-mints unconditionally on 401 for the
   * same reason) and by the explicit Sign-in click. Env bypass is unaffected.
   *
   * A forced caller NEVER receives a non-forced run's result (DA1.1). It
   * awaits the run already in flight — discarding both its value and its
   * failure — and then re-mints; two dp flows never overlap, so the user
   * still sees at most one browser login. The note this replaces called the
   * swallow "acceptable, the retry re-fires"; that was measured false.
   * `packages/server-core/src/sessions/SessionManager.ts` symbol
   * `attemptAuthRetry` returns early on `managed.authRetryAttempted`, sets
   * that flag BEFORE dispatching the retry, and resets it only when a new
   * message is sent (its `!_isAuthRetry` guard) — so the retry fires exactly
   * once per message and there is no second firing to close the loop. A
   * swallowed re-mint therefore leaves the just-rejected JWT in place for the
   * rest of that message.
   */
  forceRefresh?: boolean;
}

export interface GatewayAuthResult {
  jwt: string;
  username: string;
}

let inflight: Promise<GatewayAuthResult> | null = null;
/** Whether the run currently owning `inflight` was started with `forceRefresh`. */
let inflightForced = false;
/**
 * Id of the run that owns `inflight`. A chained forced run replaces `inflight`
 * while its predecessor is still settling, so the predecessor's reset must not
 * clear the successor's slot — it clears only when the ids still match.
 */
let inflightRun = 0;

/**
 * Ensure a valid Nessy Gateway JWT exists, running the corp `dp` flow only if
 * needed. Single-flight: concurrent callers share one run.
 *
 * Single-flight rule (00-context "Concurrent triggers"): the first caller's
 * `signal`/`onStatus` drive the shared run; a later caller awaiting the same
 * inflight run cannot cancel it and won't receive status callbacks. This keeps
 * the flow correct without per-caller fan-out (the common case is one trigger).
 *
 * The one caller that must NOT join (DA1.1): `forceRefresh`. Joining answers a
 * caller that asked for a re-mint with the very JWT it is trying to replace —
 * see the `forceRefresh` docblock for why nothing downstream re-fires. Such a
 * caller awaits the non-forced run instead (result and failure both discarded)
 * and then runs its own forced ensure, so two dp flows never overlap.
 * Concurrent forced callers still share ONE forced run.
 */
export function ensureNessyGatewayAuth(
  opts: EnsureGatewayAuthOptions = {},
): Promise<GatewayAuthResult> {
  const forceRefresh = opts.forceRefresh === true;
  if (inflight && (!forceRefresh || inflightForced)) return inflight;
  // Reachable only for a forced caller meeting a NON-forced run in flight.
  const prior = inflight;
  const run = ++inflightRun;
  inflight = (async () => {
    if (prior) {
      try {
        await prior;
      } catch {
        // the earlier run's failure is not this caller's failure
      }
    }
    return runEnsure(opts);
  })().finally(() => {
    if (inflightRun === run) {
      inflight = null;
      inflightForced = false;
    }
  });
  inflightForced = forceRefresh;
  return inflight;
}

async function runEnsure(opts: EnsureGatewayAuthOptions): Promise<GatewayAuthResult> {
  const {
    onStatus,
    signal,
    interactive = true,
    exchangeUrl,
    credsPath,
    oauthCredsPath,
    sessionBroker = dpSessionBroker,
    forceRefresh = false,
  } = opts;
  const emit = (status: GatewayAuthStatus) => {
    try {
      onStatus?.(status);
    } catch {
      // status callbacks must never break the flow
    }
  };
  /**
   * `server-managed-settings.md`, opening paragraph — the page's lead sits above
   * its first heading, so it publishes no section id of its own: "Claude Code
   * clients fetch these settings automatically when users authenticate with an
   * eligible credential on a platform where server-managed delivery is
   * supported." This is that trigger, and it fires on ALL THREE success paths:
   * an env-bypass token, warm cached creds, and a fresh dp login are equally
   * "the user authenticated", and a launch that only ever takes the warm path
   * would otherwise never receive a policy.
   *
   * Fire-and-forget on purpose — `#fetch-and-caching-behavior`: "Claude Code
   * opens the session while the fetch continues", and "If the fetch fails,
   * Claude Code continues without server-managed settings and warns in
   * interactive sessions that no remote policy applies." Sign-in must not fail
   * because an organization has no settings endpoint. The delivery module
   * single-flights and rate-limits, so repeated calls cost one request.
   */
  const deliver = (jwt: string) => {
    try {
      onNessyGatewayAuthenticated(jwt);
    } catch {
      // delivery must never break authentication
    }
  };

  try {
    emit('checking');

    // (1) env bypass — headless / CI (transient, not persisted)
    const envCreds = await tryEnvToken({ signal, exchangeUrl });
    if (envCreds) {
      deliver(envCreds.jwt);
      emit('done');
      return { jwt: envCreds.jwt, username: envCreds.username };
    }

    // (2) cached valid creds — warm path, no dp exec (skipped under forceRefresh)
    if (!forceRefresh) {
      /**
       * DA1.26, and since DA1.50 this is the SECOND of two gates rather than
       * the only one. A value like `a.b.c`, or any hand-edit of this shared
       * file, is three non-empty dot segments with nothing decodable behind
       * them; sent as `Nestor-Token` the gateway answers 401, this facade is not
       * re-entered because the warm path succeeded, and the user is in a loop
       * nothing in the product can break. Refusing it here falls THROUGH to the
       * dp flow, which re-mints and overwrites the file — which is what "signed
       * out" is supposed to do.
       *
       * **`getValidCreds` now gates on `isUsableJwt` itself (DA1.50), so in
       * practice `valid` is already null for such a file and the branch below is
       * unreachable through that function.** It is kept, deliberately and with
       * this sentence rather than silently, for two reasons: it is the only
       * thing that LOGS the distinction ("not a decodable jwt" versus "no
       * credential at all"), which is the difference between a re-mint the user
       * can understand and one they cannot; and this facade must keep its own
       * answer if the reader beneath it is ever narrowed again. A duplicated
       * check that says why it is duplicated is cheaper than the silent
       * divergence its removal would set up.
       */
      const valid = getValidCreds(credsPath);
      if (valid && !isUsableJwt(valid.jwt)) {
        log.info('cached gateway credential is not a decodable jwt; re-minting');
      } else if (valid) {
        deliver(valid.jwt);
        emit('done');
        return { jwt: valid.jwt, username: valid.username };
      }

      // (2b) seed from nessy-cli's oauth_creds.json: the current cli keeps its
      // Nestor JWT there and no longer maintains dp_auth_creds.json. Adopted
      // tokens are persisted into OUR file so every other reader (adapter,
      // electron prefill, Pi env) keeps a single file to read. The cli's file
      // itself is never written. Skipped under forceRefresh — a just-rejected
      // token calls for a fresh dp mint, not another cache.
      const seeded = readCliOauthJwt(oauthCredsPath);
      if (seeded) {
        try {
          const claims = decodeJwtClaims(seeded.jwt);
          saveCreds(
            { jwt: seeded.jwt, expiresAt: claims.expiresAtMs, username: claims.username, userId: claims.userId },
            credsPath,
          );
          deliver(seeded.jwt);
          emit('done');
          return { jwt: seeded.jwt, username: claims.username };
        } catch {
          // fall through to the dp flow
        }
      }
    }

    // (3) broker-owned raw DP session → (4) exchange DP token → Nestor JWT.
    let jwt: string;
    let exchangeStarted = false;
    try {
      ({ jwt } = await sessionBroker.withAccessToken(
        async (token) => {
          exchangeStarted = true;
          emit('exchanging');
          return exchangeDpToken(token, { signal, url: exchangeUrl });
        },
        {
          signal,
          interactive,
          onStatus: (status: DpSessionStatus) => {
            // An ALLOW-LIST, not a pass-through: `checking`/`ready`/`login-required`
            // are the facade's own to sequence. A new advisory status that is not
            // added here reaches no surface at all.
            if (
              status === 'waiting-browser'
              || status === 'dp-outdated'
              || status === 'dp-unrunnable' || status.startsWith('auth-url:') // F1.2
            ) {
              emit(status as GatewayAuthStatus); // the allow-list above is the narrowing
            }
          },
        },
      ));
    } catch (error) {
      if (
        !interactive &&
        error instanceof DpAuthServiceError &&
        error.code === DpAuthError.InteractiveLoginUnavailable
      ) {
        throw new DpAuthServiceError(DpAuthError.NeedsLogin, 'dp is not logged in');
      }
      // F1.366 — the NARROW fallback onto dp's own stored session: only when the
      // print-token path failed for a NON-login reason (and never once the
      // exchange of a print-token value had started — that failure is the
      // gateway's, not dp's). One read, one exchange, and the ORIGINAL error
      // when anything declines; `dp-session-file.ts` carries the six rules.
      const stored = exchangeStarted
        ? null
        : await exchangeStoredDpSession(error, {
          signal,
          exchangeUrl,
          seam: opts.dpSessionFile,
          onUsed: () => {
            emit('dp-session-file');
            emit('exchanging');
          },
        });
      if (stored === null) throw error;
      jwt = stored;
    }

    // (5) decode claims + (6) persist (merge-preserve)
    const claims = decodeJwtClaims(jwt);
    saveCreds(
      {
        jwt,
        expiresAt: claims.expiresAtMs,
        username: claims.username,
        userId: claims.userId,
      },
      credsPath,
    );

    deliver(jwt);
    emit('done');
    return { jwt, username: claims.username };
  } catch (err) {
    /**
     * DA1.23. One diagnosis is applied here and nowhere else: when the dp flow
     * has failed and the only token variable on the machine is nessy-cli's, the
     * code becomes `CliEnvTokenOnly` so the card can name the variable the user
     * actually set. `diagnoseGatewayAuthFailure` returns the error UNCHANGED in
     * every other case, `Cancelled` included, and the emitted status is derived
     * from the same object the caller receives — the two cannot disagree.
     */
    const failure = diagnoseGatewayAuthFailure(
      err instanceof DpAuthServiceError
        ? err
        : new DpAuthServiceError(DpAuthError.ExecFailed, 'gateway auth failed'),
    );
    emit(`error:${failure.code}`);
    throw failure;
  }
}
