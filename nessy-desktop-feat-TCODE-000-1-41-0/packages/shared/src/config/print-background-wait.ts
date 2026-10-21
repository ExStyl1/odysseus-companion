/**
 * The non-interactive run's wait for background work.
 *
 * `env-vars.md:307`, quoted whole:
 *
 * > | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`                  | {/*
 * > min-version: 2.1.182 *\/}Maximum time in milliseconds that
 * > [non-interactive mode](/docs/en/headless#background-tasks-at-exit) with the
 * > `-p` flag waits after the final turn for background subagents and workflows
 * > whose result is part of the output. Default: `600000`, or 10 minutes. When
 * > the cap is exceeded, remaining background tasks are terminated and the
 * > process exits. Set to `0` to wait indefinitely. This cap is separate from
 * > the five-second grace period that applies to plain background shells |
 *
 * ## Non-interactive only
 *
 * The wait applies to the NON-INTERACTIVE path only. Interactive teardown
 * aborts background work on generation disposal, and that is deliberate: an
 * interactive session that swapped its capability generation has no output left
 * for a background result to be part of. Only a `-p`-style run has a final
 * output that a background subagent's result belongs to.
 *
 * Nessy's non-interactive path is `nessy-general-agent run`, which spawns its
 * own server. {@link PRINT_MODE_ENV_VAR} is the marker the CLI exports into
 * that server's environment; it is an inter-process signal, not a user-facing
 * switch, and it is inherited by the agent subprocess the same way
 * `NESSY_SAFE_MODE` is.
 *
 * ## The wait must be unable to hang
 *
 * At the ceiling the run ends with a STATED outcome naming what was still
 * running — never silence. `0` is the one documented way to ask for an
 * unbounded wait, and because that is a request for something that by
 * definition has no ceiling, the caller announces it before waiting rather than
 * blocking without a word.
 */

import { resolveNumericSetting } from './numeric-setting.ts'

export type PrintBackgroundWaitEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the ceiling. */
export const PRINT_BG_WAIT_CEILING_ENV_VAR = 'NESSY_PRINT_BG_WAIT_CEILING_MS'

/** The documented Claude spelling, accepted as a compat alias. */
export const PRINT_BG_WAIT_CEILING_COMPAT_ENV_VAR = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'

/** Marker the CLI exports so the agent subprocess knows it is a `-p`-style run. */
export const PRINT_MODE_ENV_VAR = 'NESSY_PRINT_MODE'

/** Compat alias for the marker, for a wrapper that already speaks Claude's names. */
export const PRINT_MODE_COMPAT_ENV_VAR = 'CLAUDE_CODE_PRINT_MODE'

/** "Default: `600000`, or 10 minutes." */
export const DEFAULT_PRINT_BG_WAIT_CEILING_MS = 600_000

/** The value that means "wait indefinitely", spelled out so readers see it. */
export const PRINT_BG_WAIT_UNBOUNDED_MS = 0

function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/** Whether this process is the non-interactive (`-p`-style) run. */
export function isNonInteractivePrintMode(
  env: PrintBackgroundWaitEnvRecord = process.env,
): boolean {
  if (env[PRINT_MODE_ENV_VAR] !== undefined) return isTruthyFlag(env[PRINT_MODE_ENV_VAR])
  return isTruthyFlag(env[PRINT_MODE_COMPAT_ENV_VAR])
}

/**
 * The ceiling in milliseconds. `0` means wait indefinitely, per the doc.
 *
 * A malformed value falls back to the documented default rather than to `0`:
 * a typo must not silently buy an unbounded wait. Follows the `isCronDisabled`
 * precedent for an aliased pair — the Nessy name wins when both are set.
 *
 * ## THE GENERAL RULE — `2e3` and `600_000` are legal (P6.565, and this REVERSES
 * what this docblock used to argue)
 *
 * `env-vars.md#variables`, the paragraph opening the Variables list, verbatim:
 *
 * > Numeric variables such as timeouts, token budgets, and retry counts accept
 * > scientific notation and digit-separator spellings in addition to plain
 * > digits, except where a variable's row notes it takes plain digits only. For
 * > example, Claude Code reads `2e3` as 2000 and `64_000` as 64000.
 *
 * This variable's own row notes nothing of the kind, so the clause after
 * "except" does not reach it and the general rule applies.
 *
 * **The argument this replaces was an inference from the wrong neighbours, and
 * it is worth naming so it is not made again.** It reasoned from
 * `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`'s row and from
 * `tools-reference.md#memory-limit-on-linux-and-wsl`'s `4e9` example — both of
 * which are keys whose OWN rows note plain digits only. They are the exception,
 * not the house rule, and generalizing from an exception is precisely what the
 * "except where a variable's row notes it" clause exists to stop. The five keys
 * that carry the note are listed in `numeric-setting.ts`; this one is not among
 * them, and neither is `SLASH_COMMAND_TOOL_CHAR_BUDGET`, `BASH_MAX_OUTPUT_LENGTH`
 * or `CLAUDE_STREAM_IDLE_TIMEOUT_MS`. `subagent-limits.ts` keeps `/^\d+$/` and
 * the two now DISAGREE on purpose — because their page rows disagree.
 *
 * A spelling the general rule still refuses — hex, a sign, a stray separator, a
 * unit suffix like `600000ms` — takes the 600000 default AND is said out loud
 * once, which the silent `/^\d+$/` fallback could not do.
 */
export function resolvePrintBackgroundWaitCeilingMs(
  env: PrintBackgroundWaitEnvRecord = process.env,
): number {
  const name = env[PRINT_BG_WAIT_CEILING_ENV_VAR] !== undefined
    ? PRINT_BG_WAIT_CEILING_ENV_VAR
    : PRINT_BG_WAIT_CEILING_COMPAT_ENV_VAR
  return resolveNumericSetting(name, env[name], DEFAULT_PRINT_BG_WAIT_CEILING_MS)
}

/** What the wait did, in the exact words the run prints. */
export interface PrintBackgroundWaitOutcome {
  timedOut: boolean
  /** Task ids still running when the ceiling was reached. Empty on success. */
  outstanding: readonly string[]
  /** How many tasks the wait started with. */
  waitedFor: number
}

/**
 * The line the run ends with. Never empty when a wait happened, so the outcome
 * is stated whichever way it went.
 */
export function formatPrintBackgroundWaitOutcome(
  outcome: PrintBackgroundWaitOutcome,
  ceilingMs: number,
): string {
  if (!outcome.timedOut) {
    return `[background-wait] ${outcome.waitedFor} background task(s) finished before the ${ceilingMs}ms ceiling.`
  }
  return `[background-wait] ceiling of ${ceilingMs}ms reached with `
    + `${outcome.outstanding.length} of ${outcome.waitedFor} background task(s) still running: `
    + `${outcome.outstanding.join(', ')} — terminating them and exiting.`
}

/** The line printed BEFORE an unbounded wait, so `0` is never silent. */
export function formatUnboundedPrintBackgroundWaitNotice(taskIds: readonly string[]): string {
  return `[background-wait] ${PRINT_BG_WAIT_CEILING_ENV_VAR}=0 — waiting indefinitely for `
    + `${taskIds.length} background task(s): ${taskIds.join(', ')}. `
    + `Set a positive value to cap this wait.`
}
