/**
 * The per-request output-token ceiling on Pi (P6.702, the P6.490 tier-1 key
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`).
 *
 * Claude env name maps to ours, the way `glob-timeout.ts`,
 * `file-read-output-limit.ts`, `background-task-settings.ts` and
 * `max-agent-turns.ts` record their family:
 *
 * - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` → `NESSY_MAX_OUTPUT_TOKENS`
 *   (the Claude spelling is accepted as a compat alias; the Nessy name wins
 *   when both are set)
 *
 * ## The page, verbatim
 *
 * `env-vars.md#variables`, the row: *"Set the maximum number of output tokens
 * for most requests. Defaults and caps vary by model … Claude Code defaults to
 * 32000 for model IDs it doesn't recognize, such as gateway-specific names, and
 * lowers values above a model's cap to the cap. Increasing this value reduces
 * the effective context window available before auto-compaction triggers"*.
 *
 * ## Two clauses of that row are deliberately NOT implemented, and why
 *
 * **The cap ("lowers values above a model's cap to the cap") is the MODEL's
 * business, not ours.** Honouring it here would mean a per-model maximum-output
 * table this fork does not have and cannot keep true: our model catalogue is
 * assembled from a gateway's `/models`, a BYO endpoint's own list and the Pi SDK
 * registry, none of which publishes that number reliably. A table built from
 * guesses would clamp a request the provider would have accepted — a silent
 * narrowing, which is the defect class this plan exists to remove — while
 * passing the value through means the provider's own refusal reaches the user by
 * name. Read-don't-invent: the page states a behaviour of a runtime that HAS the
 * table; it does not oblige a runtime without one to invent it.
 *
 * **The 32000 default for unrecognised ids is not applied either**, and for a
 * sharper reason: it is a DEFAULT rather than a ceiling, so applying it would
 * change what an UNSET configuration sends. The whole value of an operator
 * ceiling is that it is inert until set — a default here would silently cap
 * every Pi session on a gateway model at 32000 output tokens, which is a product
 * change nobody asked for wearing an env var's clothes.
 *
 * So this module answers exactly one question: *did the operator name a number?*
 * `undefined` means they did not, and the request goes out byte-identical to
 * what it was before this row existed.
 *
 * ## The parse
 *
 * `env-vars.md#variables`, the paragraph opening the Variables list: *"Numeric
 * variables such as timeouts, token budgets, and retry counts accept scientific
 * notation and digit-separator spellings in addition to plain digits, except
 * where a variable's row notes it takes plain digits only."* A token budget is
 * named in that sentence and this row notes no restriction, so `3.2e4` is 32000
 * here and `32_000` is too.
 *
 * `min: 1`: a zero-token output budget is not a configuration, it is a request
 * that cannot answer. A malformed value is refused out loud and the ceiling
 * stays absent, which is the same fail-to-the-documented-behaviour posture the
 * two siblings take.
 */

import { resolveOptionalNumericSetting } from './numeric-setting'

export type MaxOutputTokensEnvRecord = Record<string, string | undefined>

/** The Nessy spelling. */
export const MAX_OUTPUT_TOKENS_ENV = 'NESSY_MAX_OUTPUT_TOKENS'

/** The documented Claude spelling, accepted as a compat alias. */
export const MAX_OUTPUT_TOKENS_COMPAT_ENV = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'

/**
 * *"Claude Code defaults to 32000 for model IDs it doesn't recognize"* — the
 * same row. Deliberately UNREAD: see the module docblock. Exported so the clause
 * is visible to the next reader rather than silently dropped, and so a lane that
 * decides the default IS wanted has the number already sourced.
 */
export const MAX_OUTPUT_TOKENS_UNRECOGNISED_MODEL_DEFAULT = 32000

/**
 * The operator's output ceiling, or `undefined` when none was named.
 *
 * `undefined` is load-bearing rather than a convenience: every caller must leave
 * the request untouched in that case, because "the operator said nothing" and
 * "the operator said zero" are different configurations and only one of them is
 * expressible.
 */
export function maxOutputTokens(
  env: MaxOutputTokensEnvRecord = process.env,
  write?: (message: string) => void,
): number | undefined {
  // Presence decides which name is read, and the SAME choice names the value in
  // the refusal sentence.
  const name = env[MAX_OUTPUT_TOKENS_ENV] !== undefined
    ? MAX_OUTPUT_TOKENS_ENV
    : MAX_OUTPUT_TOKENS_COMPAT_ENV
  return resolveOptionalNumericSetting(name, env[name], { min: 1 }, write)
}
