import { parseNumericSetting } from './numeric-setting.ts'
import type { NumericSettingOptions } from './numeric-setting.ts'

/**
 * P6.273 — the operator's API retry knobs, for the two runtimes whose retry
 * policy was hard-coded.
 *
 * ## What was wrong
 *
 * Claude reads `CLAUDE_CODE_MAX_RETRIES` and applies an interactive ceiling
 * (`agent/options.ts`'s `applyInteractiveRetryCeiling`). The other two read
 * nothing: Pi's whole retry policy seam exists and is frozen at
 * `{ maxRetries: 5, baseDelayMs: 15_000 }` for the gateway and
 * `{ maxRetries: 3, baseDelayMs: 2_000 }` off it, and codex PUBLISHES three keys
 * on `[model_providers.*]` — `request_max_retries`, `stream_max_retries`,
 * `stream_idle_timeout_ms` (`codex-rs/model-provider-info/src/lib.rs`,
 * `struct ModelProviderInfo`, rust-v0.150.1 — P7.11 corrected a path here that
 * 404s at every tag this repo has shipped) —
 * of which the writer emitted none. So one operator variable meant three
 * different things depending on which runtime read it, and two of the three
 * meanings were "nothing".
 *
 * ## Why this module exists rather than a reader per runtime
 *
 * The value has to be identical on all three or the row buys a new divergence
 * instead of closing one, and the two readers live in different packages —
 * `pi-agent-server` (the subprocess) and `shared/agent/codex-agent.ts`. Putting
 * the names and the parse here is what lets the subprocess reach them by the
 * same relative-import route `resolveBashDefaultTimeoutMs` already travels
 * (`local-tools/runtime-backed-tools.ts`), instead of a second copy of
 * {@link parseNumericSetting} inside a package that does not declare
 * `@nessy-agent/shared` as a dependency.
 *
 * ## The unset case is byte-identical to today, on purpose
 *
 * Every function here returns `undefined` when nothing is set, and each caller
 * keeps its own existing value for that answer. A row that changed the shipped
 * retry ladder while claiming to add a knob would be two changes sold as one.
 */

/** The Nessy spelling of the API retry-attempt ceiling. */
export const MAX_API_RETRIES_ENV_VAR = 'NESSY_MAX_API_RETRIES'

/**
 * The documented Claude spelling, accepted as a compat alias.
 *
 * `env-vars.md#variables`, verbatim: "Override the number of times to retry
 * failed API requests (default: 10). Capped at 15 as of v2.1.186; as of
 * v2.1.199, `CLAUDE_CODE_RETRY_WATCHDOG` raises the default and removes the cap.
 * For unattended sessions that need to wait through longer outages, set
 * `CLAUDE_CODE_RETRY_WATCHDOG` instead."
 *
 * The DEFAULT in that sentence is claude's and is deliberately not adopted here:
 * Pi's 5-attempt/15s ladder was measured against the Nestor limiter
 * (`gateway-retry-settings.ts`) and codex has its own. This variable overrides,
 * it does not seed.
 */
export const MAX_API_RETRIES_COMPAT_ENV_VAR = 'CLAUDE_CODE_MAX_RETRIES'

/**
 * The Nessy spelling of the streaming idle deadline, projected onto codex's
 * `stream_idle_timeout_ms`.
 *
 * **NO CLAUDE ALIAS, and that is a decision rather than an omission.** The
 * documented spelling `CLAUDE_STREAM_IDLE_TIMEOUT_MS` belongs to the
 * byte/stream watchdog family, which open row P6.115 owns and whose close is a
 * RECORD correction rather than a new pin. Aliasing it here would claim a
 * reading that row has not made — that codex's per-provider idle deadline and
 * claude's two watchdogs are one control — and the two have different clamps
 * (claude's row states a 300000 minimum and a 30-minute byte-level cap; codex
 * states neither). One name, one runtime, until P6.115 says otherwise.
 */
export const STREAM_IDLE_TIMEOUT_ENV_VAR = 'NESSY_STREAM_IDLE_TIMEOUT_MS'

/**
 * WHO READS WHAT, so an exported reader with no caller is not mistaken for the
 * parse-never-read defect this plan hunts.
 *
 * - {@link resolveMaxApiRetries} — read by Pi's `gateway-retry-settings.ts` and,
 *   since P6.273's codex half landed, by `codex-agent.ts`'s
 *   `codexProviderRetryOptions`, which hands it to the writer's
 *   `providerMaxRetries`.
 * - {@link resolveStreamIdleTimeoutMs} — codex ONLY, through that same method.
 *   Pi's SDK retry seam takes `{maxRetries, baseDelayMs}` and has no idle
 *   deadline to set, so there is nothing on that side to wire — an absence, not
 *   an omission. Both readers now have a caller; this note stays because the
 *   ASYMMETRY is still the thing a reader would otherwise mistake for a gap.
 */

/**
 * The retry-attempt ceiling an operator set, or `undefined`.
 *
 * The general numeric rule applies — the row is silent on plain digits, so
 * `2e3` and `64_000` are read as the page says — and a rejected value is
 * reported by NAME through `write` rather than becoming a default silently,
 * which is the whole difference between a knob and a coin toss.
 *
 * `min: 1`: "the variable can adjust the cap but can't disable it" is the rule
 * this family follows everywhere, and a 0-attempt ladder is a session that fails
 * on the first transient 429.
 */
export function resolveMaxApiRetries(
  env: Record<string, string | undefined> = process.env,
  write?: (message: string) => void,
): number | undefined {
  const name = env[MAX_API_RETRIES_ENV_VAR] !== undefined
    ? MAX_API_RETRIES_ENV_VAR
    : MAX_API_RETRIES_COMPAT_ENV_VAR
  return readOverride(name, env[name], { min: 1 }, write)
}

/**
 * The streaming idle deadline an operator set, or `undefined`.
 *
 * `min: 1000` is ours and is stated as such: codex's schema publishes no bound
 * for `stream_idle_timeout_ms`, and a sub-second idle deadline would abort every
 * stream that pauses to think. Read-don't-invent ran out here — no page, no
 * source bound — so the floor is a decision, visible in the rejection sentence
 * a bad value produces.
 */
export function resolveStreamIdleTimeoutMs(
  env: Record<string, string | undefined> = process.env,
  write?: (message: string) => void,
): number | undefined {
  return readOverride(STREAM_IDLE_TIMEOUT_ENV_VAR, env[STREAM_IDLE_TIMEOUT_ENV_VAR], { min: 1000 }, write)
}

/**
 * One override, or `undefined` — and a rejection sentence that is TRUE.
 *
 * `resolveNumericSetting` is deliberately NOT used here even though it is the
 * house reader, and the reason is legibility rather than taste: its message
 * ends *"using <fallback> instead"*, and this family has no fallback to name.
 * The caller keeps its own ladder, so a sentinel fallback of 0 produced the
 * literal line `NESSY_MAX_API_RETRIES="0" is outside the range this setting
 * allows; using 0 instead.` — a number that is not what happens, printed to the
 * one person trying to find out what happened. The parse itself is still the
 * shared one, so the documented spellings (`2e3`, `64_000`) cannot drift.
 *
 * Unset and empty are silent: the first is the ordinary case, the second is how
 * a settings `env` block spells "leave it alone".
 */
function readOverride(
  name: string,
  raw: string | undefined,
  options: NumericSettingOptions,
  write?: (message: string) => void,
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const parsed = parseNumericSetting(raw, options)
  if (parsed.ok) return parsed.value
  const why = parsed.reason === 'unparseable'
    ? 'is not a number this setting accepts'
    : parsed.reason === 'not-an-integer'
      ? 'is not a whole number'
      : `is below the smallest value this setting allows (${options.min})`
  write?.(`${name}=${JSON.stringify(raw)} ${why}; the retry ladder is unchanged.`)
  return undefined
}
