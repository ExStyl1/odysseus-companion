/**
 * The one reader for a numeric environment setting.
 *
 * ## What the page actually says, and why this module has TWO modes
 *
 * `env-vars.md#variables`, the paragraph that opens the Variables list,
 * verbatim:
 *
 * > Numeric variables such as timeouts, token budgets, and retry counts accept
 * > scientific notation and digit-separator spellings in addition to plain
 * > digits, except where a variable's row notes it takes plain digits only. For
 * > example, Claude Code reads `2e3` as 2000 and `64_000` as 64000. Before
 * > v2.1.211, these spellings could silently set a much smaller value, such as
 * > `1e6` setting a timeout to 1.
 *
 * The clause after "except" is the whole reason this is not a single rule.
 * Several rows DO note it, verbatim, and for those keys refusing `2e3` is the
 * documented behaviour rather than a defect:
 *
 * - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` — "Accepts a positive whole number
 *   in plain digits; anything else is ignored, so the limit can be adjusted but
 *   not removed."
 * - `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` — "Accepts a positive whole number
 *   in plain digits; anything else is ignored, so the variable can adjust the
 *   cap but can't disable it."
 * - `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS` — "Takes plain digits only; `0`, a
 *   decimal, or any other spelling keeps the default."
 * - the goal check-in interval — "Give whole minutes in plain digits, at most
 *   `10080`, which is one week." Still named in words here, because this file's
 *   own history is why: spelling it in this docblock once made an absence sweep
 *   over `packages/` return a hit and read as an implementation (P6.555). The
 *   reader is elsewhere and is named below.
 *
 *   **THE ABSENCE IS OVER — the owner took the decision on 2026-09-11 (C4.31),
 *   and the reading this paragraph rested on was refuted by the bundle lift.**
 *   The history is worth keeping because both of its reasons died, each in a
 *   different way:
 *
 *   The 2026-09-06 reason (P6.566) was *"there is nothing for it to configure"* —
 *   no check-in scheduler existed on any runtime. P6.322 landed in `57b3f8847`
 *   and closed that half: the check-in this key tunes now exists, host-side, for
 *   all three runtimes at once (`packages/server-core/src/pi-harness/goal-service.ts`).
 *
 *   The 2026-09-11 reason (P6.1053) was *"there is nothing to alias"* — the
 *   vendored `claude` binary carried **0** occurrences of the vendor name. That
 *   was a true reading of 2.1.233 and was **false at 2.1.247** (for the bundle
 *   TODAY read its two self-reports): measured 2026-09-11 the name scored **4**
 *   in the native binary, **1** in `sdk.mjs` (controls: `ANTHROPIC_MODEL` 22/3, a nonsense
 *   key 0/0). What remained was the product posture — whether one runtime's
 *   documented variable may configure a host mechanism all three share — and the
 *   owner took it: accepted as an ALIAS, with the host's own name winning when
 *   both are set. The reader is `readGoalCheckInSetting` beside
 *   `GOAL_CHECKIN_ENV_CLAUDE` in `goal-service.ts`, whose docblock carries the
 *   measurement and the two residues (the host keeps its own default, and its
 *   parse rule is a superset of the page's).
 *
 *   The absence was BOUND, not merely asserted: `numeric-setting.test.ts` re-ran
 *   the sweep, so the day a reader landed this paragraph went red instead of
 *   going stale — twice, once per dead reason. That case now asserts the reader
 *   is PRESENT, which is the same instrument pointed the other way.
 *
 *   Its row-mate in P6.566 was the control for that sweep, and it had readers
 *   from the start: `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS` is read by the vendored
 *   binary AND, since P6.252, by Pi's own fetch.
 * - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — "Accepts a plain integer such as
 *   `500000` only: a value like `500k` reads as `500` and clamps to the 100K
 *   minimum." **A SIXTH row, found by P6.565 and missed here because it does not
 *   use the phrase "plain digits"** — the four above and the one below all do,
 *   so a `grep` for that phrase returns five and reads like a complete answer.
 *   Route a key by READING its row, never by searching for the phrase. Its
 *   reader is `auto-compaction-settings.ts`, whose OTHER key
 *   (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) sits on the general side — one file, two
 *   sides of the same clause.
 * - `CLAUDE_CODE_TOOL_MEMORY_LIMIT` — "Write the size in plain digits, alone
 *   for a number of bytes or with a `K`, `M`, `G`, or `T` suffix." **This line
 *   is a PAGE QUOTE, not a reader**: this fork reads none of it, the enforcement
 *   site is the vendored binary on Linux and WSL, and the name is spelled here
 *   only so the plain-digits exception is recorded beside its four siblings.
 *   Unlike the goal check-in interval above, spelling it is safe — nothing
 *   depends on a COUNT of the name any more (P6.598): the claim it used to
 *   support is now stated by path, over the one site that is load-bearing, and
 *   that site is `OTHER_CEILINGS` in
 *   `agent/__tests__/claude-operator-ceiling-env.test.ts`.
 *
 * So {@link parseNumericSetting} takes `plainDigitsOnly` and a caller states
 * which side of the exception its key sits on. A key whose row is silent gets
 * the general rule; a key whose row notes plain digits gets the strict one, and
 * the option's presence at the call site is the record of that reading.
 *
 * ## The accepted spellings, exactly
 *
 * General mode accepts an unsigned decimal run, optionally carrying `_`
 * separators BETWEEN digits, optionally followed by an exponent — and nothing
 * else. `Number()` cannot be handed the raw string: `Number('64_000')` is
 * `NaN`, because the separator is a JavaScript *literal* grammar and not a
 * parsing one, so the separators are removed before the value is read. Hex
 * (`0x8`), a sign (`+8`, `-1`), a trailing or doubled separator (`1_`, `1__0`)
 * and anything else are refused in both modes: the page's example set is
 * scientific notation and separators, and widening past it would be inventing.
 *
 * The result must be a safe integer. `2.5e3` is therefore accepted (it is
 * 2500), while `1.5` is refused — "a float where an integer is required".
 *
 * ## Every rejection is stated
 *
 * A number that quietly becomes its default is a control that silently stops
 * controlling. {@link describeNumericSettingRejection} turns a rejection into
 * one sentence, and {@link reportNumericSettingRejection} writes it once per
 * process per (name, value) pair — these resolvers sit on paths that run per
 * tool call, and a warning repeated a thousand times is noise, not a report.
 * The sink is injectable, defaulting to `console.warn`, the same discipline
 * `managed-drops.ts` uses for its own drop reports.
 *
 * **P6.708 — and a layer with NO fallback needs its own sentence, not a
 * borrowed one.** The pair above ends *"using <fallback> instead"*, which a
 * caller that deliberately returns `undefined` cannot say truthfully: there is
 * no number to name, because "this layer says nothing" is the whole point of
 * its `undefined` (`auto-compaction-settings.ts`'s `boundedInteger` is the
 * measured case — an operator writing the page's own refused example,
 * `NESSY_AUTO_COMPACT_WINDOW=500k`, was told nothing at all). Rather than
 * inventing a fallback so a sentence fits, {@link describeNumericSettingRefusal}
 * and {@link reportNumericSettingRefusal} are the fallback-free twins: they name
 * the variable, the value, and the ACCEPTED FORM the page states, and they end
 * by saying the setting stays unset. {@link resolveOptionalNumericSetting} is
 * the whole reader for such a key, exactly as {@link resolveNumericSetting} is
 * for a key that has a default. Both twins share the once-per-(name, value)
 * ledger, so a key cannot be reported twice by two spellings of the same
 * complaint.
 */

/** Why a value was not used. */
export type NumericSettingRejection =
  /** Not one of the accepted spellings — hex, a sign, a stray separator, letters. */
  | 'unparseable'
  /** Parsed, but not a safe integer: a float where an integer is required, or too large. */
  | 'not-an-integer'
  /** A safe integer, but outside the range the key documents. */
  | 'out-of-range'

export type NumericSettingResult =
  | { ok: true; value: number }
  | { ok: false; reason: NumericSettingRejection }

export interface NumericSettingOptions {
  /**
   * Set when the key's own row in `env-vars.md` notes it takes plain digits
   * only. Refuses scientific notation and digit separators, which is the
   * DOCUMENTED behaviour for those keys and not an oversight.
   */
  plainDigitsOnly?: boolean
  /** Smallest legal value, inclusive. */
  min?: number
  /** Largest legal value, inclusive. */
  max?: number
}

/** Plain digits after trim: the strict mode, and the general mode's core. */
const PLAIN_DIGITS = /^\d+$/

/**
 * An unsigned decimal with optional `_` separators between digits, optionally
 * followed by an exponent. Separators are allowed in the integer part, the
 * fraction and the exponent, always BETWEEN digits — the JavaScript literal
 * rule, which is what the page's `64_000` example is spelled in.
 */
const DIGITS_WITH_SEPARATORS = String.raw`\d(?:_?\d)*`
const GENERAL_NUMERIC = new RegExp(
  `^${DIGITS_WITH_SEPARATORS}(?:\\.${DIGITS_WITH_SEPARATORS})?(?:[eE][+-]?${DIGITS_WITH_SEPARATORS})?$`,
)

/**
 * Read one numeric setting.
 *
 * Returns a result rather than a number so the caller can both fall back to its
 * own documented default AND say why — the two things a silent `?? default`
 * cannot do at once.
 */
export function parseNumericSetting(
  raw: string | undefined,
  options: NumericSettingOptions = {},
): NumericSettingResult {
  if (raw === undefined) return { ok: false, reason: 'unparseable' }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'unparseable' }

  const pattern = options.plainDigitsOnly ? PLAIN_DIGITS : GENERAL_NUMERIC
  if (!pattern.test(trimmed)) return { ok: false, reason: 'unparseable' }

  // `Number('64_000')` is NaN — the separator belongs to the literal grammar,
  // not to the parser — so it is removed here, after the shape has been checked
  // and never before, or `1__0` and `_1` would slip through as valid.
  const value = Number(trimmed.replace(/_/g, ''))
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'not-an-integer' }

  if (options.min !== undefined && value < options.min) return { ok: false, reason: 'out-of-range' }
  if (options.max !== undefined && value > options.max) return { ok: false, reason: 'out-of-range' }

  return { ok: true, value }
}

/**
 * Why the value was refused, in one clause. Shared by both describers so the
 * two sentences cannot drift into disagreeing about the same rejection.
 */
function numericRejectionClause(reason: NumericSettingRejection): string {
  return reason === 'unparseable'
    ? 'is not a number this setting accepts'
    : reason === 'not-an-integer'
      ? 'is not a whole number'
      : 'is outside the range this setting allows'
}

/** One sentence naming the setting, its rejected value and the fallback. */
export function describeNumericSettingRejection(
  name: string,
  raw: string,
  reason: NumericSettingRejection,
  fallback: number,
): string {
  return `${name}=${JSON.stringify(raw)} ${numericRejectionClause(reason)}; using ${fallback} instead.`
}

/**
 * What the value should have looked like, in the page's own terms.
 *
 * The two spellings are the two sides of `env-vars.md#variables`'s "except"
 * clause, and the examples are the page's own (`2e3`, `64_000`), so an operator
 * reading this sentence and an operator reading the page are told the same
 * thing.
 */
function describeAcceptedNumericForm(options: NumericSettingOptions): string {
  const spelling = options.plainDigitsOnly
    ? 'a whole number in plain digits'
    : 'a whole number, which may be written in scientific notation (2e3) or with `_` separators (64_000)'
  // `Number.MAX_SAFE_INTEGER` is how a caller spells "the page states no
  // ceiling"; printing it would read as a limit nobody documented.
  const { min } = options
  const max = options.max === Number.MAX_SAFE_INTEGER ? undefined : options.max
  if (min !== undefined && max !== undefined) return `${spelling}, from ${min} to ${max}`
  if (min !== undefined) return `${spelling}, at least ${min}`
  if (max !== undefined) return `${spelling}, at most ${max}`
  return spelling
}

/**
 * The fallback-free twin of {@link describeNumericSettingRejection}: one
 * sentence naming the setting, its rejected value, the accepted form, and the
 * fact that the setting stays unset.
 *
 * It does not name a number to fall back to because this layer has none — see
 * this module's header (P6.708).
 */
export function describeNumericSettingRefusal(
  name: string,
  raw: string,
  reason: NumericSettingRejection,
  options: NumericSettingOptions = {},
): string {
  return `${name}=${JSON.stringify(raw)} ${numericRejectionClause(reason)};`
    + ` it takes ${describeAcceptedNumericForm(options)}.`
    + ' The value is ignored and this setting stays unset.'
}

/** Pairs already reported, so a per-tool-call reader says it once. */
const reported = new Set<string>()

/**
 * Say it once per process, per (name, value).
 *
 * Exported for tests to clear; the sink is injectable for the same reason
 * `reportManagedPolicyDrops` takes one.
 */
export function reportNumericSettingRejection(
  name: string,
  raw: string,
  reason: NumericSettingRejection,
  fallback: number,
  write: (message: string) => void = message => { console.warn(message) },
): void {
  const key = `${name}=${raw}`
  if (reported.has(key)) return
  reported.add(key)
  write(describeNumericSettingRejection(name, raw, reason, fallback))
}

/**
 * Say it once per process, per (name, value) — for a key with no fallback.
 *
 * Shares {@link reportNumericSettingRejection}'s ledger deliberately: the two
 * are two sentences about one refusal, and a key read through both must still
 * be reported once.
 */
export function reportNumericSettingRefusal(
  name: string,
  raw: string,
  reason: NumericSettingRejection,
  options: NumericSettingOptions = {},
  write: (message: string) => void = message => { console.warn(message) },
): void {
  const key = `${name}=${raw}`
  if (reported.has(key)) return
  reported.add(key)
  write(describeNumericSettingRefusal(name, raw, reason, options))
}

/** Test seam: forget what has been said, so a suite can assert it is said. */
export function resetNumericSettingReports(): void {
  reported.clear()
}

/**
 * The whole reader for one key: parse, fall back, and state the rejection.
 *
 * An UNSET name and an EMPTY value both fall back in silence — neither is a
 * mistake to report; the first is the ordinary case and the second is how a
 * settings `env` block spells "leave it alone". Everything else that fails is
 * said out loud exactly once.
 */
export function resolveNumericSetting(
  name: string,
  raw: string | undefined,
  fallback: number,
  options: NumericSettingOptions = {},
  write?: (message: string) => void,
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback
  const parsed = parseNumericSetting(raw, options)
  if (parsed.ok) return parsed.value
  reportNumericSettingRejection(name, raw, parsed.reason, fallback, write)
  return fallback
}

/**
 * The whole reader for one key that has NO default: parse, refuse, and state
 * the refusal.
 *
 * `undefined` means "this layer says nothing", so a caller downstream applies
 * its own documented default — which is why nothing is invented here to fill
 * the hole. An UNSET name and an EMPTY value are silent for the reason
 * {@link resolveNumericSetting} records; a value that was written and refused
 * is said out loud exactly once.
 */
export function resolveOptionalNumericSetting(
  name: string,
  raw: string | undefined,
  options: NumericSettingOptions = {},
  write?: (message: string) => void,
): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const parsed = parseNumericSetting(raw, options)
  if (parsed.ok) return parsed.value
  reportNumericSettingRefusal(name, raw, parsed.reason, options, write)
  return undefined
}
