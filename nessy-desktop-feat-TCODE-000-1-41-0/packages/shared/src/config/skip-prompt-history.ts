/**
 * Session persistence for the non-interactive run.
 *
 * `cli-reference.md:105`, quoted whole:
 *
 * > | `--no-session-persistence` | Disable session persistence so sessions are
 * > not saved to disk and cannot be resumed. Print mode only. The
 * > [`CLAUDE_CODE_SKIP_PROMPT_HISTORY`](/docs/en/env-vars) environment variable
 * > does the same in any mode |
 *
 * `best-practices.md:469` fixes the polarity the flag opts out of, and it is
 * the half that is easy to read past: "The run still creates a resumable
 * session unless you pass `--no-session-persistence`." Persistence is the
 * DEFAULT and discarding is the opt-in — the inverse of a `run` that deletes
 * its session on the way out.
 *
 * ## "not saved to disk" is never-written, not written-then-removed
 *
 * That is the whole reason this module maps onto an existing mechanism instead
 * of introducing one. `CreateSessionOptions.ephemeral`
 * (`packages/shared/src/protocol/dto.ts`) already means "In-memory only: no
 * session record or metadata is written to disk", which is exactly the
 * sentence. A delete-after-the-fact would satisfy "cannot be resumed" while
 * failing "are not saved to disk", and it would leave the transcript on disk
 * for the window in between.
 *
 * ## Two spellings
 *
 * Follows the established pair pattern of {@link ../config/safe-mode.ts} and
 * {@link ../config/print-background-wait.ts}: a Nessy-owned name that wins, and
 * the documented Claude name accepted as a compat alias so a wrapper written
 * against Claude Code keeps working.
 */

export type SkipPromptHistoryEnvRecord = Record<string, string | undefined>

/** The Nessy spelling. Set it, or pass `--no-session-persistence`. */
export const SKIP_PROMPT_HISTORY_ENV_VAR = 'NESSY_SKIP_PROMPT_HISTORY'

/** The documented Claude spelling, accepted as a compat alias. */
export const SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR = 'CLAUDE_CODE_SKIP_PROMPT_HISTORY'

function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/**
 * Whether this process tree was asked to keep sessions out of storage.
 *
 * The Nessy name wins when both are set, so an explicit local override beats an
 * inherited compat value — the same precedence
 * `resolvePrintBackgroundWaitCeilingMs` uses.
 */
export function isSkipPromptHistoryEnabled(
  env: SkipPromptHistoryEnvRecord = process.env,
): boolean {
  if (env[SKIP_PROMPT_HISTORY_ENV_VAR] !== undefined) {
    return isTruthyFlag(env[SKIP_PROMPT_HISTORY_ENV_VAR])
  }
  return isTruthyFlag(env[SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR])
}
