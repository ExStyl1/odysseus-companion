import { DEFAULT_SPAWN_RETRY_BASE_DELAY_MS } from './orchestrator/spawner.ts';
// P6.273 · the operator's retry ceiling, resolved by the ONE reader all three
// runtimes share. Reached by relative path, the same route
// `resolveBashDefaultTimeoutMs` already travels from `local-tools/runtime-backed-tools.ts`:
// this package does not declare `@nessy-agent/shared` as a dependency, and a
// second copy of the documented numeric parse is the drift that rule exists to stop.
import { resolveMaxApiRetries } from '../../shared/src/config/api-retry-env.ts';

/**
 * UB2.15 · the PROVIDER-level retry block, stacked UNDER the agent ladders below
 * (upstream craft-agents-oss v0.15.1 `packages/pi-agent-server/src/session-settings.ts`,
 * `CRAFT_PI_RETRY_SETTINGS.provider` / `CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider`;
 * Apache-2.0).
 *
 * Two retry layers live in Pi and they answer different things:
 * - the AGENT ladder (`AgentSession._prepareRetry`, `maxRetries`/`baseDelayMs`)
 *   re-runs a whole failed assistant turn on its own exponential backoff and
 *   never reads `retry-after`;
 * - the PROVIDER block (pi-ai `utils/provider-retry.js` `retryProviderRequest`,
 *   fed by `SettingsManager.getProviderRetrySettings()`) retries one request
 *   BEFORE its stream starts, on 408/409/429/5xx, sleeping what the server's
 *   `retry-after` / `retry-after-ms` asks for (its own jittered ≤8 s backoff when
 *   the header is absent). Pi's default is OFF (`maxRetries ?? 0`).
 *
 * Measured by UB5.3 (`docs/superpowers/specs/2026-10-15-ub5-3-provider-retry-after.md`):
 * with the block, a 429 carrying `retry-after: 7` cost two 7 s provider sleeps
 * inside ONE agent attempt; without it — our wiring until this row — the 429
 * reached the agent ladder and the header was discarded. Endpoint-agnostic on
 * purpose: the gateway limiter and a BYO provider both name their wait, and a
 * BYO endpoint that names none gets pi-ai's short backoff before the ladder.
 *
 * `maxRetryDelayMs` is a CAP, not a wait: a server asking for longer fails the
 * request at once ("Server requested Ns retry delay (max: Ms)…", provider-retry.js
 * `validateServerRetryDelayMs`) with the provider's own message appended, so a
 * 429 still reads as retryable and falls through to the agent ladder. That is
 * also what bounds a hostile header.
 *
 * What the user sees: nothing new. pi-ai's provider sleeps emit no event (no
 * `auto_retry_start`), so a provider-level wait shows as the turn still working;
 * the retry status appears only once the agent ladder takes over — upstream
 * ships the same shape.
 *
 * `NESSY_MAX_API_RETRIES` does NOT move this block: the operator's ceiling is
 * the agent ladder's (P6.273); the provider count is upstream's SDK-mirroring 2.
 */
export interface ProviderRetrySettings {
  maxRetries: number;
  maxRetryDelayMs: number;
}

/**
 * UB2.15 — main chats (and their children): upstream's `{2, 60 s}`, the OpenAI/Anthropic SDK default count.
 *
 * The bound it adds, stated: on the gateway each of the six agent attempts can
 * spend 2 × 60 s here before the ladder's own 225 s, so a limiter that answers
 * EVERY request with a full-minute `retry-after` holds a turn ~16 min (945 s,
 * pinned in the test) where the ladder alone gave up inside 8 — one header-directed
 * wait is the common case. The sleeps honour the turn's abort signal (pi-ai
 * `abortableSleep`), so Stop still ends a waiting turn at once.
 */
export const PI_PROVIDER_RETRY_SETTINGS: Readonly<ProviderRetrySettings> = Object.freeze({
  maxRetries: 2,
  maxRetryDelayMs: 60_000,
});

/**
 * UB2.15 — utility sessions (`call_llm`, titles, summaries): upstream's `{2, 10 s}`,
 * so the provider sleeps stay inside F1.239's one ephemeral deadline (the
 * worst case is pinned in `gateway-retry-settings.test.ts`).
 *
 * The cap must reach the session AT CREATION: pi-agent-core's `Agent`
 * snapshots `getProviderRetrySettings().maxRetryDelayMs` when the SDK builds
 * the session (pi-coding-agent `core/sdk.js`, through the runtime adapter — the
 * one module allowed to name that entry point) and passes that
 * snapshot on every request, where it outranks the live setting
 * (`buildRequestOptions`: `options.maxRetryDelayMs ?? providerRetrySettings…`).
 * `maxRetries` is read live. So the utility site seeds this block through
 * `createSession({ providerRetry })`; an `applyOverrides` after creation would
 * leave Pi's 60 s cap in force. Main needs no seed: its cap IS that 60 s default.
 */
export const PI_UTILITY_PROVIDER_RETRY_SETTINGS: Readonly<ProviderRetrySettings> = Object.freeze({
  maxRetries: 2,
  maxRetryDelayMs: 10_000,
});

/** UB2.15 — the provider block for a session purpose; endpoint-agnostic (the same on and off the gateway). */
export function providerRetrySettingsFor(purpose: RetryPurpose): Readonly<ProviderRetrySettings> {
  return purpose === 'utility' ? PI_UTILITY_PROVIDER_RETRY_SETTINGS : PI_PROVIDER_RETRY_SETTINGS;
}

/**
 * Pi session retry profile for the Nestor gateway: the AGENT ladder.
 *
 * The SDK default (3 attempts, 2s base -> 2s/4s/8s) burns every retry inside
 * the same per-minute limiter window and then surfaces the 429 to the user
 * ~14s in. nessy-cli waits 60s x 10 against the same gateway
 * (geminiChat.ts:781). 15s x 5 crosses the minute boundary by attempt 3.
 * Since Pi 0.87 each wait is also capped: pi-ai `retryDelayMs` takes
 * `min(baseDelayMs * 2 ** (attempt - 1), maxAgentDelayMs)`, and this profile
 * leaves `maxAgentDelayMs` at the vendored 60 s default, so the ladder is
 * 15/30/60/60/60s, 225 s of backoff in all (pinned in
 * `gateway-retry-settings.test.ts`). The attempt count bounds how many
 * minute-long waits follow the third.
 *
 * Since UB2.15 this ladder is the SECOND answer to a gateway 429, not the
 * first. The provider block ({@link PI_PROVIDER_RETRY_SETTINGS}) retries the
 * request itself before the stream starts, sleeping the server's `retry-after`
 * when it asks for 60 s or less. A 429 reaches this ladder only once that
 * block has spent its two retries, or refused a longer requested wait.
 */
export const GATEWAY_RETRY_SETTINGS = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 15_000,
  provider: PI_PROVIDER_RETRY_SETTINGS, // UB2.15 — stacked under the ladder
});

/**
 * Pi SDK defaults (settings-manager.js getRetrySettings), re-applied when the
 * runtime leaves the gateway so a mid-session endpoint switch does not keep
 * the long ladder.
 */
export const PI_DEFAULT_RETRY_SETTINGS = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 2_000,
  provider: PI_PROVIDER_RETRY_SETTINGS, // UB2.15 — stacked under the ladder
});

/**
 * Rate-limit backoff base for CHILD-SESSION starts on the gateway.
 *
 * Children share one per-user limiter with the parent, so the spawner's
 * `DEFAULT_SPAWN_RETRY_BASE_DELAY_MS` (250ms) re-hits a hot window before it
 * can reset — three attempts land inside ~750ms. Seconds, not milliseconds.
 * The attempt count stays the spawner's `MAX_ATTEMPTS = 3`, so the whole
 * ladder is 5s + 10s: long enough to outlive a burst, short enough that a
 * genuinely dead gateway still fails a fan-out promptly.
 */
export const GATEWAY_SPAWN_RETRY_BASE_DELAY_MS = 5_000;

/**
 * The spawner's `retryBaseDelayMs` reader body. Kept here, beside the session
 * profile, so both endpoint-dependent retry policies are decided in one place.
 */
export function resolveSpawnRetryBaseDelayMs(gatewayActive: boolean): number {
  return gatewayActive ? GATEWAY_SPAWN_RETRY_BASE_DELAY_MS : DEFAULT_SPAWN_RETRY_BASE_DELAY_MS;
}

export interface RetrySettings {
  maxRetries: number;
  baseDelayMs: number;
  /** UB2.15 — pi-ai's provider-level block; see {@link PI_PROVIDER_RETRY_SETTINGS}. */
  provider: Readonly<ProviderRetrySettings>;
}

/**
 * The profile in force, with the operator's attempt ceiling applied on top.
 *
 * P6.273 — the seam existed and read nothing. `NESSY_MAX_API_RETRIES` (or the
 * documented `CLAUDE_CODE_MAX_RETRIES`) now sets `maxRetries` on either profile;
 * `baseDelayMs` is untouched, because that number is a MEASUREMENT against the
 * Nestor limiter's minute window (see {@link GATEWAY_RETRY_SETTINGS}) and not a
 * preference — an operator who wants to wait longer wants more attempts on the
 * measured ladder, not a different ladder.
 *
 * UNSET IS BYTE-IDENTICAL to before: the frozen objects are returned by
 * reference, so nothing about the shipped ladder moved. Only a set value builds
 * a new object, and a rejected value is reported by name and keeps the profile.
 */
export function resolveRetrySettings(
  gatewayActive: boolean,
  env: Record<string, string | undefined> = process.env,
  write?: (message: string) => void,
  purpose: RetryPurpose = 'main',
): RetrySettings {
  if (purpose === 'utility') return resolveUtilityRetrySettings(gatewayActive, env, write);
  const profile = gatewayActive ? GATEWAY_RETRY_SETTINGS : PI_DEFAULT_RETRY_SETTINGS;
  const maxRetries = resolveMaxApiRetries(env, write);
  if (maxRetries === undefined) return profile;
  return { maxRetries, baseDelayMs: profile.baseDelayMs, provider: profile.provider };
}

/**
 * The only structural dependency this policy has on an `AgentSession`.
 * Narrowed so the policy is testable against a real `SettingsManager` without
 * standing up a session.
 */
export interface RetryPolicyTarget {
  settingsManager: { applyOverrides(overrides: { retry: RetrySettings }): void };
}

/**
 * Overlay the retry profile onto a live session's settings.
 *
 * MUST be applied AFTER any compaction toggle: `setCompactionEnabled` ends in
 * `SettingsManager.save()`, which rebuilds the merged settings from
 * global+project and discards every in-memory `applyOverrides`
 * (settings-manager.js:386-387). Pinned by
 * `gateway-retry-settings.test.ts` -> "is wiped by a later compaction toggle".
 */
export function applyRetryPolicy(
  session: RetryPolicyTarget,
  gatewayActive: boolean,
  env: Record<string, string | undefined> = process.env,
  write?: (message: string) => void,
  purpose: RetryPurpose = 'main',
): void {
  session.settingsManager.applyOverrides({ retry: resolveRetrySettings(gatewayActive, env, write, purpose) });
}

/**
 * F1.307 — which session a retry profile is for. `main` is the user's chat
 * (and its children); `utility` is an EPHEMERAL query — the title / summary
 * mini-completions and `call_llm` — which F1.239 runs under ONE deadline,
 * `EPHEMERAL_QUERY_DEADLINE_MS` (115 s, inside the host's 120 s RPC timeout).
 */
export type RetryPurpose = 'main' | 'utility';

/**
 * F1.307 — the gateway ladder for a utility query: the MEASURED base delay kept
 * (the Nestor limiter window, see {@link GATEWAY_RETRY_SETTINGS}), and only the
 * attempts whose whole backoff fits the ephemeral deadline with room left for
 * the attempts themselves: 15 + 30 = 45 s, where the main ladder reaches 105 s
 * by attempt 3 and the deadline cancels the query mid-ladder. The honest
 * residue: 45 s does not outlast a full limiter minute the way the main ladder
 * does, so a utility query on a throttled gateway can still fail — those
 * queries are optional (a title, a summary), and a deadline kill after 115 s is
 * the worse failure. craft-agents-oss v0.13.4 splits main and utility the same
 * way (`session-settings.ts`, `CRAFT_PI_EPHEMERAL_RETRY_SETTINGS`: 2 retries;
 * Apache-2.0).
 */
export const GATEWAY_UTILITY_RETRY_SETTINGS = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 15_000,
  provider: PI_UTILITY_PROVIDER_RETRY_SETTINGS, // UB2.15 — stacked under the ladder
});

/** F1.307 — off the gateway: upstream's utility numbers (2 retries, 2 s base: 6 s of backoff). */
export const PI_UTILITY_RETRY_SETTINGS = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 2_000,
  provider: PI_UTILITY_PROVIDER_RETRY_SETTINGS, // UB2.15 — stacked under the ladder
});

/**
 * F1.307 — the utility profile with the operator's ceiling applied as a CEILING
 * only: `NESSY_MAX_API_RETRIES` can lower the attempts, never raise them past the
 * ones that fit the deadline (a raised count would buy attempts the deadline
 * kills). Unset — or a value at or above the profile — returns the frozen
 * profile by reference.
 */
function resolveUtilityRetrySettings(
  gatewayActive: boolean,
  env: Record<string, string | undefined>,
  write?: (message: string) => void,
): RetrySettings {
  const profile = gatewayActive ? GATEWAY_UTILITY_RETRY_SETTINGS : PI_UTILITY_RETRY_SETTINGS;
  const ceiling = resolveMaxApiRetries(env, write);
  if (ceiling === undefined || ceiling >= profile.maxRetries) return profile;
  return { maxRetries: ceiling, baseDelayMs: profile.baseDelayMs, provider: profile.provider };
}
