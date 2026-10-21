/**
 * NESSY_DP_AUTH_TOKEN env bypass (00-context decision 4).
 *
 * When set, dp is skipped entirely: the value is exchanged DIRECTLY for a
 * Nestor JWT (this is the headless / nessy-server / CI path). An invalid token
 * throws — headless callers must see the error, never a silent fall-through.
 *
 * ## The divergence from nessy-cli, DOCUMENTED rather than aligned — DA1.15
 *
 * The plan's Target scheme clause 5 says *align or DOCUMENT*; this is the
 * document half, and it is written here because this file is the only place a
 * reader meets the variable.
 *
 * **Their shape**, read from their source and not from prose. Their env name is
 * `NESSY_CLI_DP_AUTH_TOKEN`; `dp/dpDelegatedToken.ts` symbol `tryAuthFromEnv`
 * DECODES it as an already-issued Spirit-IAM JWT, checks `exp`, seeds it in
 * memory and never exchanges anything; `dp/nestorAuthHeader.ts` symbol
 * `buildNestorAuthHeaders` then sends it as `Authorization: Bearer` by
 * VALUE-EQUALITY against that same env var, falling back to `Nestor-Token`
 * otherwise. Their own docblock gives the reason: the gateway's oathkeeper runs
 * a `spirit_iam` JWKS authenticator BESIDE the `oauth2_introspection` one that
 * `Nestor-Token` goes through.
 *
 * **Our shape**: this variable, exchanged through the token endpoint, the
 * result carried as `Nestor-Token`. Their name is never exchanged and never
 * sent, and a user may legitimately have exported it for the CLI on the same
 * machine, so its presence must change no outcome — it is a diagnosis, never a
 * credential.
 *
 * That last sentence USED to read "their name is deliberately NOT read here",
 * with a 2026-09-13 reading that nothing under `packages` or `apps` mentioned it
 * except this docblock. DA1.23 made it read — once, on the failure path only —
 * and the constraint it was protecting is unchanged and now enforced by
 * {@link cliEnvTokenIsTheOnlyOne}'s own contract: presence alone changes no
 * outcome.
 *
 * ## Why it is not aligned, and what was actually measured
 *
 * The risk the row states is a HYPOTHESIS, not a reproduction: nobody has ever
 * driven a REAL Spirit-IAM delegated token through `exchangeDpToken`, here or
 * anywhere in the record, so whether the exchange accepts one is unknown. That
 * null stands. Handing it one on a guess is step 4 of read-do-not-invent taken
 * before steps 1 to 3.
 *
 * What CAN be measured was (2026-09-13, fabricated values only, no real token):
 * six probes, three against the exchange endpoint and three against the model
 * catalogue, answered **401 with a byte-identical 207-byte JSON body** —
 * `code` `EUNAUTHORIZED`, `userError` "Access credentials are invalid" — for a
 * JWT-SHAPED bearer, an opaque bearer, a `Nestor-Token` and NO credential at
 * all. The gateway's refusal is shape-blind and header-blind: it never says
 * which authenticator you missed, or whether you sent a credential. The
 * no-credential arm is the positive control that the server, not the network,
 * answered.
 *
 * So the consequence of the divergence is not merely that a delegated token
 * might be refused — it is that **a refusal would be indistinguishable from
 * every other refusal**, and `exchange.ts` symbol `exchangeDpToken` drops the
 * body on 401 by design, leaving only "dp token rejected". A user who exported
 * the CLI's variable and expected this product to read it gets a failure that
 * names nothing. The user-facing half of that sentence is DA1.19's.
 *
 * **Correction to an earlier reading**, kept because it was load-bearing: "no
 * `Authorization: Bearer` path exists in this tree" is FALSE —
 * `exchangeDpToken` already sends a Bearer to the exchange endpoint. What is
 * absent is a Bearer on the CHAT request headers, which is what aligning would
 * have to add.
 */

import { exchangeDpToken } from './exchange.ts';
import { decodeJwtClaims } from './jwt.ts';
import { DpAuthError, DpAuthServiceError } from './errors.ts';
import type { DpCredentials } from './creds-store.ts';

export const NESSY_DP_AUTH_TOKEN_ENV = 'NESSY_DP_AUTH_TOKEN';

/**
 * nessy-cli's name for the same idea, read for ONE purpose only — see
 * {@link cliEnvTokenIsTheOnlyOne}. It is never exchanged, never sent, and never
 * stored: the docblock above records why aligning on it is a null rather than a
 * decision, and a name we do not honour must not become a credential by
 * accident.
 */
export const NESSY_CLI_DP_AUTH_TOKEN_ENV = 'NESSY_CLI_DP_AUTH_TOKEN';

/** The slice of the environment these two names live in. */
type TokenEnv = Record<string, string | undefined>;

/**
 * DA1.23 — true when the machine carries nessy-cli's env token and not ours.
 *
 * This is the one shape where a sign-in failure has a cause we can NAME. The
 * gateway cannot help: six probes on 2026-09-13 (fabricated values, in the
 * docblock above) answered a **byte-identical 207-byte 401** for a JWT-shaped
 * bearer, an opaque bearer, a `Nestor-Token` and no credential at all, and
 * `exchange.ts` symbol `exchangeDpToken` drops the body on 401 by design. So a
 * user who exported nessy-cli's variable and expected this product to read it
 * sees a refusal that names nothing, on every path, forever.
 *
 * **Presence alone changes no outcome**, which is the row's own constraint and
 * the reason this predicate is not consulted anywhere on a SUCCESS path: a user
 * may legitimately have exported that variable for the CLI on the same machine,
 * and it stays a diagnosis rather than a credential. Both halves are required —
 * when OUR variable is also set, the env path above already ran and its failure
 * is about the value, which we cannot diagnose.
 *
 * Read LIVE from `process.env`, for the same reason `creds-store.ts` symbol
 * `getNessyDir` is: a diagnosis frozen at import would describe the environment
 * some earlier module happened to see.
 */
export function cliEnvTokenIsTheOnlyOne(env: TokenEnv = process.env): boolean {
  if (!env[NESSY_CLI_DP_AUTH_TOKEN_ENV]?.trim()) return false;
  return !env[NESSY_DP_AUTH_TOKEN_ENV]?.trim();
}

/**
 * The failures the diagnosis is ABOUT — the allowlist
 * {@link diagnoseGatewayAuthFailure} tests, narrowed by the owner on 2026-09-17
 * (review R2).
 *
 * The rule is the one argument the diagnosis has ever had: re-code exactly the
 * codes the advice RESCUES, because `NESSY_DP_AUTH_TOKEN` skips dp entirely.
 * Each member below names a specific dp outcome the env bypass would not have
 * reached, and each has one producer:
 *
 * - `DpNotFound` — `dp-binary.ts` symbol `resolveDpRuntime`, every rung of the
 *   ladder exhausted. The env token needs no binary at all, so this is the case
 *   where naming the variable turns a dead end into a fix.
 * - `NeedsLogin` — the broker has no usable dp session (`session-broker.ts`,
 *   plus `index.ts` symbol `runEnsure`'s non-interactive conversion). The env
 *   token needs no session.
 * - `LoginFailed` — `dp-api.ts` symbol `login`'s catch: `dp auth login` did not
 *   finish. The env token opens no browser. This is the third member, included
 *   because the same argument covers it verbatim and because `login` is its only
 *   producer, so it is a specific outcome rather than a bucket.
 * - `LoginBrowserTimeout` (DA3.17) — `session-broker.ts` symbol
 *   `asInvisibleBrowserTimeout`, the ONLY producer: `dp auth login` ran its
 *   whole budget with no callback, which on a machine where dp's browser cannot
 *   be seen is the terminal outcome, not a slow one. **It is here and its parent
 *   `Timeout` is not, and that is the point of splitting them**: `Timeout` is a
 *   bucket spanning `print-token` and the exchange, where the advice would be
 *   guesswork, while this member names one dp outcome the env bypass skips
 *   entirely. And the overlap is not theoretical — a user on an SSH or headless
 *   machine is exactly the user who has already exported nessy-cli's variable,
 *   so this is the member most likely to meet the condition.
 *
 * **Everything else is kept, each for its own reason rather than by default.**
 *
 * - `ExchangeFailed` is the one code where the advice DEMONSTRABLY cannot help:
 *   {@link tryEnvToken} calls the same `exchange.ts` symbol `exchangeDpToken`,
 *   so a user who took the advice would land on the identical failure.
 * - `ExecFailed` and `Timeout` are BUCKETS spanning both sides of the seam.
 *   `runEnsure` mints `ExecFailed` for any non-`DpAuthServiceError` thrown
 *   anywhere in its body — including one thrown AFTER dp has already succeeded,
 *   at the credential persist — and `Timeout` is minted by `exchange.ts` as well
 *   as by the two dp execs in `dp-api.ts`. Re-coding a bucket names the variable
 *   for failures the variable would not have avoided.
 * - `Cancelled` keeps the exclusion it has always had, for its original reason:
 *   it is not a failure to find a credential, it is the user or the window
 *   saying stop, and re-labelling that as an environment problem would be a lie
 *   in the one case where the cause is already known.
 * - `InteractiveLoginUnavailable` is covered by the same argument and is absent
 *   anyway, because it cannot reach this function: both producers in
 *   `session-broker.ts` require `interactive === false`, and that is exactly the
 *   case `runEnsure` converts to `NeedsLogin` before its own catch — which IS in
 *   this set. Measured 2026-09-17; `runEnsure` defaults `interactive` to `true`.
 * - An OUTDATED dp is no code at all: the version floor is warn-only and reports
 *   the `dp-outdated` STATUS beside whatever the probe produced, so such a
 *   machine arrives here as `NeedsLogin` (re-coded) or `ExecFailed` (kept) —
 *   correctly either way.
 *
 * **Narrowing loses no diagnosis on a kept code**, which is what makes it safe:
 * `config/doctor-collectors.ts` symbol `collectGatewayAuthInput` reads
 * {@link cliEnvTokenIsTheOnlyOne} unconditionally, so `nessy doctor` prints its
 * "only nessy-cli's env token name is set" line after EVERY failure. The
 * operator surface keeps the whole picture; the card keeps the real reason.
 */
const DIAGNOSABLE_DP_FLOW_FAILURES: ReadonlySet<DpAuthError> = new Set([
  DpAuthError.DpNotFound,
  DpAuthError.NeedsLogin,
  DpAuthError.LoginFailed,
  DpAuthError.LoginBrowserTimeout,
]);

/**
 * DA1.23 — re-code a FAILED gateway auth into the one failure that can name its
 * own cause, and leave every other failure exactly as it was.
 *
 * The sign-in channel is CODES ONLY (DA1.4's reason line is still a code, not a
 * sentence), so a new `DpAuthError` member is the only way a user-facing string
 * can name the variable. That is what this mints, and it mints it nowhere else:
 * the caller is `index.ts` symbol `runEnsure`'s outer catch, after the dp flow
 * has already failed on its own terms.
 *
 * WHICH codes it re-codes — and why every other one is returned untouched, by
 * identity — is {@link DIAGNOSABLE_DP_FLOW_FAILURES}. Membership is an ALLOWLIST
 * rather than a list of exclusions on purpose: a `DpAuthError` member added
 * later then gets the honest default, its own code, instead of silently
 * inheriting an advice nobody has checked against it.
 *
 * The original code survives in the detail string (variable NAMES and a code —
 * never token material) and in `cause`, so a log line still says what dp itself
 * answered.
 */
export function diagnoseGatewayAuthFailure(
  error: DpAuthServiceError,
  env: TokenEnv = process.env,
): DpAuthServiceError {
  if (!DIAGNOSABLE_DP_FLOW_FAILURES.has(error.code)) return error;
  if (!cliEnvTokenIsTheOnlyOne(env)) return error;
  return new DpAuthServiceError(
    DpAuthError.CliEnvTokenOnly,
    `${NESSY_CLI_DP_AUTH_TOKEN_ENV} is set and ${NESSY_DP_AUTH_TOKEN_ENV} is not (dp flow answered ${error.code})`,
    { cause: error },
  );
}

/**
 * If NESSY_DP_AUTH_TOKEN is set, exchange it and return credentials; otherwise
 * null. Does NOT persist — the env path is transient (headless/CI).
 */
export async function tryEnvToken(opts?: {
  signal?: AbortSignal;
  exchangeUrl?: string;
}): Promise<DpCredentials | null> {
  const token = process.env[NESSY_DP_AUTH_TOKEN_ENV];
  if (!token) return null;

  const { jwt } = await exchangeDpToken(token, {
    signal: opts?.signal,
    url: opts?.exchangeUrl,
  });
  const claims = decodeJwtClaims(jwt);
  return {
    jwt,
    expiresAt: claims.expiresAtMs,
    username: claims.username,
    userId: claims.userId,
  };
}
