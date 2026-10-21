/**
 * The process a `worktree.setupScript` turns into, and the line it leaves in
 * the transcript.
 *
 * Same reason `worktree-git-plan.ts` exists: the mapping from a setting to an
 * argv is the part that can silently be wrong, and building it here rather than
 * inline in the caller makes it assertable without a repository, a supervisor
 * and a session.
 *
 * Two properties are load-bearing:
 *
 *  - The interpreter is HOST-SELECTED and the script is ONE argv element. We
 *    never build a command line by concatenating the setting into a string, so
 *    there is no quoting rule here to get wrong. The script's contents are of
 *    course arbitrary shell — that is what the key is for, and what the consent
 *    card gates; the property being protected is that nothing AROUND it can be
 *    changed by its contents.
 *  - `cwd` is the new worktree, never the repository. A setup script that ran
 *    in the main checkout would be the opposite of what the key means, and the
 *    caller passes both paths, so this is a real mistake to be able to make.
 */

/** How much script output one transcript line may carry. */
const MAX_REPORTED_OUTPUT = 8_000

/**
 * The budget for one setup script.
 *
 * Deliberately far above `runWorktreeGit`'s 60s default: installing
 * dependencies is the reason this key exists, and a cap that kills every real
 * setup script would make the feature look broken rather than bounded.
 */
export const WORKTREE_SETUP_TIMEOUT_MS = 600_000

export interface WorktreeSetupCommand {
  /** Matches the `operation` vocabulary the git plan uses for its commands. */
  operation: 'setup-script'
  /** The NEW worktree. Never the repository root. */
  cwd: string
  /** Host-selected interpreter; never taken from the setting. */
  program: string
  /** Interpreter flags plus the script as a single trailing element. */
  args: string[]
  timeoutMs: number
}

/**
 * Build the command for one setup script.
 *
 * `platform` is an input rather than a read of `process.platform` so the
 * Windows mapping is assertable from a mac test run. `cmd.exe /d /s /c` is the
 * spelling that skips AutoRun (`/d`) and keeps the quoting of the single
 * trailing argument intact (`/s`) — the same trio Node's own shell spawn uses.
 *
 * This single branch is why `worktree.setupScript` has exactly two buckets and
 * not one per `NodeJS.Platform` (P6.60): `windows` is this arm, `posix` is the
 * other, and `selectWorktreeSetupScript` makes the same `=== 'win32'` decision
 * over the setting that this function makes over the interpreter. If a third
 * interpreter ever appears here, that selector grows a bucket in the same
 * change — the two must never disagree about how many arms exist.
 */
export function worktreeSetupCommand(input: {
  worktreePath: string
  script: string
  platform?: NodeJS.Platform
}): WorktreeSetupCommand {
  const script = input.script.trim()
  const windows = (input.platform ?? process.platform) === 'win32'
  return {
    operation: 'setup-script',
    cwd: input.worktreePath,
    program: windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
    args: windows ? ['/d', '/s', '/c', script] : ['-c', script],
    timeoutMs: WORKTREE_SETUP_TIMEOUT_MS,
  }
}

export type WorktreeSetupOutcome =
  /** The user has not approved this script for this project, and said no. */
  | { kind: 'refused' }
  /** The script ran. `exitCode` is `null` when the process was killed. */
  | { kind: 'ran'; output: string; exitCode: number | null }
  /** Something around the script failed — never the script's own exit code. */
  | { kind: 'failed'; reason: string }

/**
 * What the session is told, in the transcript, about the setup script.
 *
 * Every branch says something. A silent refusal reads as a setup script that
 * ran and did nothing, and a silent failure reads as one that succeeded — both
 * are worse than an extra line, because the next thing the session does is
 * assume its dependencies are installed.
 *
 * Output is tail-truncated: the end of an install log is where the failure is,
 * and an untruncated `bun install` would put megabytes into the transcript.
 */
export function describeWorktreeSetupOutcome(input: {
  worktreePath: string
  script: string
  outcome: WorktreeSetupOutcome
}): string {
  const head = `Worktree setup script (${input.worktreePath}):`
  if (input.outcome.kind === 'refused') {
    return `${head} not run — you declined. The worktree was created without it.`
  }
  if (input.outcome.kind === 'failed') {
    return `${head} not run — ${input.outcome.reason}. The worktree was created without it.`
  }
  const { exitCode } = input.outcome
  const status = exitCode === 0
    ? 'exit 0'
    : exitCode === null
      ? 'killed before it exited'
      : `exit ${exitCode}`
  const raw = input.outcome.output.trimEnd()
  const output = raw.length > MAX_REPORTED_OUTPUT
    ? `…(${raw.length - MAX_REPORTED_OUTPUT} earlier characters omitted)\n${raw.slice(-MAX_REPORTED_OUTPUT)}`
    : raw
  return [
    `${head} ${status}.`,
    `$ ${input.script.trim()}`,
    ...(output ? [output] : ['(no output)']),
  ].join('\n')
}
