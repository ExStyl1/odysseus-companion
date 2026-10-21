/**
 * The timeout on Glob's file discovery (P6.692, the P6.490 tier-1 key
 * `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS`).
 *
 * Claude env name maps to ours, the way `background-task-settings.ts`,
 * `max-agent-turns.ts` and `file-read-output-limit.ts` record their family:
 *
 * - `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` → `NESSY_GLOB_TIMEOUT_SECONDS`
 *   (the Claude spelling is accepted as a compat alias; the Nessy name wins
 *   when both are set)
 *
 * ## The page, verbatim
 *
 * `env-vars.md#variables`, the row, re-read 2026-09-07: "Timeout in seconds for
 * Glob tool file discovery. Defaults to 20 seconds on most platforms and 60
 * seconds on WSL". So the unit is SECONDS and the default is a documented
 * number, unlike its `FILE_READ` sibling.
 *
 * ## The WSL clause cannot be honoured as written, and that is recorded
 *
 * There is no WSL detection anywhere in this tree — `isWsl`, `WSL_DISTRO_NAME`,
 * `microsoft-standard` and a `/proc/version` read all score **zero** across
 * `packages`, `apps` and `scripts` (measured 2026-09-07). Inventing one for a
 * timeout default would be building a platform probe to serve a number, which
 * is the wrong order. {@link GLOB_TIMEOUT_WSL_SECONDS} carries the documented
 * value so the difference is legible rather than lost, and nothing reads it:
 * an operator on WSL sets the variable, which is the mechanism the page itself
 * offers.
 *
 * ## The parse
 *
 * `env-vars.md#variables`, the paragraph opening the Variables list: "Numeric
 * variables such as timeouts, token budgets, and retry counts accept scientific
 * notation and digit-separator spellings in addition to plain digits, except
 * where a variable's row notes it takes plain digits only." A timeout is named
 * in that sentence and this row notes no restriction, so `2e1` is 20 here.
 *
 * `min: 1`: a zero-second discovery budget is not a configuration, it is a tool
 * that always fails; the page describes a timeout, never a disable. A malformed
 * value falls back to the documented default and says so.
 */

import { resolveNumericSetting } from './numeric-setting'

export type GlobTimeoutEnvRecord = Record<string, string | undefined>

/** The Nessy spelling. */
export const GLOB_TIMEOUT_SECONDS_ENV = 'NESSY_GLOB_TIMEOUT_SECONDS'

/** The documented Claude spelling, accepted as a compat alias. */
export const GLOB_TIMEOUT_SECONDS_COMPAT_ENV = 'CLAUDE_CODE_GLOB_TIMEOUT_SECONDS'

/** "Defaults to 20 seconds on most platforms" — `env-vars.md#variables`. */
export const GLOB_TIMEOUT_DEFAULT_SECONDS = 20

/**
 * "and 60 seconds on WSL" — the same row. Deliberately UNREAD: see the module
 * docblock. Exported so the clause is visible to the next reader rather than
 * silently dropped, and so a lane that adds real WSL detection has the number
 * already sourced.
 */
export const GLOB_TIMEOUT_WSL_SECONDS = 60

/** The effective Glob discovery budget, in seconds. */
export function globTimeoutSeconds(
  env: GlobTimeoutEnvRecord = process.env,
  write?: (message: string) => void,
): number {
  // Presence decides which name is read, and the SAME choice names the value in
  // the rejection sentence.
  const name = env[GLOB_TIMEOUT_SECONDS_ENV] !== undefined
    ? GLOB_TIMEOUT_SECONDS_ENV
    : GLOB_TIMEOUT_SECONDS_COMPAT_ENV
  return resolveNumericSetting(name, env[name], GLOB_TIMEOUT_DEFAULT_SECONDS, { min: 1 }, write)
}

/** The same budget in milliseconds, which is what every timer here takes. */
export function globTimeoutMs(
  env: GlobTimeoutEnvRecord = process.env,
  write?: (message: string) => void,
): number {
  return globTimeoutSeconds(env, write) * 1000
}
