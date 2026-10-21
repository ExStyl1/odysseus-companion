/**
 * The token ceiling on a FILE READ's output (P6.693, the P6.490 tier-1 key
 * `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`).
 *
 * Claude env name maps to ours, the way `background-task-settings.ts` and
 * `max-agent-turns.ts` record their family:
 *
 * - `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` → `NESSY_FILE_READ_MAX_OUTPUT_TOKENS`
 *   (the Claude spelling is accepted as a compat alias; the Nessy name wins
 *   when both are set)
 *
 * ## What the page says, and what it does NOT say
 *
 * `env-vars.md#variables`, the row verbatim (re-read 2026-09-07):
 * "Override the default token limit for file reads. Useful when you need to
 * read larger files in full". `tools-reference.md#read-tool-behavior` describes
 * the CONSEQUENCE — "When a whole-file read exceeds the token limit, Read
 * returns the first page with a `PARTIAL view` notice …" — and likewise names
 * no number.
 *
 * **So the documented default is: there is none published.** Searched, and
 * recorded rather than invented: the `env-vars.md` row above; the Read section
 * of `tools-reference.md`; and the vendored `2.1.247` binary, where the name
 * occurs 4 lines / 4 occurrences (re-measured 2026-09-12, C3.252, both
 * instruments named because they disagree on a minified artefact — C3.294; it
 * read "three times" at `2.1.233`) and every occurrence is inside an env-NAME
 * allowlist, not beside a literal.
 *
 * ## Therefore the default here is a BEHAVIOUR, not a number
 *
 * Unset, this reader answers `undefined` and the caller keeps doing exactly
 * what it did before — `tokenLimitFor(contextWindow)`, the model-aware
 * threshold every Pi tool result already goes through. Nothing is invented and
 * an unset environment is byte-identical to HEAD. Set, the value REPLACES that
 * computation for the read tool only, which is precisely what
 * `resolveResultTokenLimit` already means by an explicit `tokenLimit`
 * (`utils/large-response.ts`: an explicit limit "REPLACES the model-aware
 * computation outright rather than seeding it").
 *
 * Inventing a number instead would have been the worse failure available here:
 * a ceiling picked out of the air either truncates reads that work today or
 * advertises a limit that matches nothing.
 *
 * ## The parse
 *
 * `env-vars.md#variables`, the paragraph opening the Variables list: "Numeric
 * variables such as timeouts, token budgets, and retry counts accept scientific
 * notation and digit-separator spellings in addition to plain digits, except
 * where a variable's row notes it takes plain digits only." A token budget is
 * named in that sentence and this row notes no restriction, so `2e3` is 2000
 * here — the same reading `mcp-output-settings.ts` takes for its sibling.
 *
 * `min: 1`: the page offers only an override, never a disable, so `0` is not a
 * legal ceiling and never means "unlimited". A malformed value falls back to
 * the unset behaviour and SAYS SO through the caller's diagnostic sink rather
 * than being swallowed.
 */

import { describeNumericSettingRejection, parseNumericSetting } from './numeric-setting'

export type FileReadOutputLimitEnvRecord = Record<string, string | undefined>

/** The Nessy spelling. */
export const FILE_READ_MAX_OUTPUT_TOKENS_ENV = 'NESSY_FILE_READ_MAX_OUTPUT_TOKENS'

/** The documented Claude spelling, accepted as a compat alias. */
export const FILE_READ_MAX_OUTPUT_TOKENS_COMPAT_ENV = 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS'

/**
 * The configured file-read token ceiling, or `undefined` when none is set.
 *
 * `undefined` is the load-bearing return: it means "leave the model-aware
 * threshold alone", not "use zero". Pass the result through as an optional
 * `tokenLimit` — spreading a `{ tokenLimit: undefined }` would be the same
 * thing, but only because `resolveResultTokenLimit` guards on `!== undefined`,
 * and depending on that is how a ceiling of nothing becomes a ceiling of zero.
 */
export function fileReadOutputTokenLimit(
  env: FileReadOutputLimitEnvRecord = process.env,
  write?: (message: string) => void,
): number | undefined {
  // Presence decides which name is read, and the SAME choice names the value in
  // the rejection sentence.
  const name = env[FILE_READ_MAX_OUTPUT_TOKENS_ENV] !== undefined
    ? FILE_READ_MAX_OUTPUT_TOKENS_ENV
    : FILE_READ_MAX_OUTPUT_TOKENS_COMPAT_ENV
  const raw = env[name]
  if (raw === undefined || raw.trim().length === 0) return undefined
  // `parseNumericSetting` rather than `resolveNumericSetting`, and the reason is
  // the SENTENCE: the shared reader ends its rejection with "using <fallback>
  // instead", and there is no number to put there — the fallback is a
  // behaviour. Everything else (the accepted spellings, the rejection reasons)
  // is the shared parse, unchanged.
  const parsed = parseNumericSetting(raw, { min: 1 })
  if (parsed.ok) return parsed.value
  const say = write ?? ((message: string) => { console.warn(message) })
  say(
    `${describeNumericSettingRejection(name, raw, parsed.reason, 0).replace(/; using 0 instead\.$/, '')}`
    + '; keeping the model-aware file-read threshold.',
  )
  return undefined
}
