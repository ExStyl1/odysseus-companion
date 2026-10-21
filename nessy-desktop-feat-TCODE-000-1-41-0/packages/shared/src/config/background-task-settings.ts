/**
 * Background-task governance (doc-verification § R10).
 *
 * One predicate seam consulted by every detach site — the Bash timeout
 * transition, the `run_in_background` start, the `bash_background` manifest
 * filter, and the MCP auto-background threshold — so the off switch cannot
 * drift between surfaces. Claude env names map to ours:
 *
 * - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` → `NESSY_DISABLE_BACKGROUND_TASKS`
 * - `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`   → `NESSY_MCP_AUTO_BACKGROUND_MS`
 * - `CLAUDE_AUTO_BACKGROUND_TASKS`         → `NESSY_AUTO_BACKGROUND_TASKS`
 * - `CLAUDE_CODE_FORK_SUBAGENT`            → `NESSY_FORK_SUBAGENT`
 * - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` → `NESSY_MAX_SUBAGENT_SPAWN_DEPTH`
 *   (reader lives in `subagent-spawn-depth.ts` — the one entry of this family
 *   whose compat alias is read too, so it keeps the aliased-pair module shape)
 */

import { parseBooleanEnv } from '../feature-flags.ts'

export type EnvRecord = Record<string, string | undefined>

function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/**
 * The hard off switch. `env-vars.md`: "Set to `1` to disable all background
 * task functionality, including the `run_in_background` parameter … and
 * auto-backgrounding." Kills auto-background (Bash and MCP),
 * `run_in_background`, and removes `bash_background` from the manifest.
 */
export function backgroundTasksDisabled(env: EnvRecord = process.env): boolean {
  return isTruthyFlag(env.NESSY_DISABLE_BACKGROUND_TASKS)
}

/**
 * Fork mode. `sub-agents.md:1006` — "set `CLAUDE_CODE_FORK_SUBAGENT` to `1` to
 * enable it explicitly or to `0` to disable it" — and `:1052` adds that `0`
 * "disables fork mode everywhere, including any server-side rollout". Our
 * mapping is `NESSY_FORK_SUBAGENT`, parsed with the repo's documented
 * `1/true/yes/on` / `0/false/no/off` reader; anything else falls back to the
 * default.
 *
 * UNSET IS ON, and it was OFF until P6.506 (2026-09-07). The reason recorded
 * for OFF has EXPIRED, and it expired because the page changed rather than
 * because we changed our minds. It read: *"Claude's unset state is a staged
 * server-side rollout of a capability its own docs mark experimental, we have no
 * rollout mechanism to mirror"*. There is no rollout to mirror any more —
 * `sub-agents.md#turn-fork-mode-on-or-off` now states two plain defaults for two
 * plain shapes, verbatim (re-read 2026-09-07, HTTP 200):
 *
 * > Claude Code turns fork mode on by default in interactive sessions and leaves
 * > it off by default in [non-interactive mode](/docs/en/headless) with `-p` and
 * > in the Agent SDK. The interactive default requires Claude Code v2.1.232 or
 * > later.
 *
 * A Nessy Pi session is the INTERACTIVE shape: it is driven by a client that
 * sends turns and reads results, and this fork has no `-p` one-shot Pi entry
 * point for the other default to describe. So the documented interactive default
 * is the one that applies, and the unset state now matches it. **A future
 * non-interactive Pi entry point must pass the flag explicitly rather than
 * inherit this** — the argument exists for exactly that.
 *
 * ## What the flip costs, stated because it is a real behaviour change
 *
 * The second half of the old reason is still TRUE and is now accepted rather
 * than avoided: `:1011` — every named subagent runs in the background, forks and
 * non-forks alike, and the model cannot ask for the foreground, because fork
 * mode removes `run_in_background` from the `subagent` schema
 * (`orchestrator/subagent-tool.ts`). That is the documented consequence of the
 * documented default, not a side effect of ours, and the two pinned model
 * contracts (`subagent` and `subagent:fork-mode`) both already exist — the flip
 * selects between them, it does not move a hash.
 *
 * ## The other two runtimes, so this is not a silent divergence
 *
 * claude-runtime does not read this function at all, so a claude session keeps
 * the SDK's OWN documented default, which the sentence above says is OFF — our
 * value is doc-correct there by not being applied. codex has no subject:
 * `thread/fork` forks a THREAD, not a subagent inheriting the parent's context
 * and prompt cache. The residual difference is declared at the switch, as the
 * `forkSubagent` row in `runtime-switch-costs.ts`, which lands in the same
 * commit as this default for exactly that reason.
 *
 * `:783` — "`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` takes precedence over fork
 * mode and keeps subagents in the foreground" — is a precedence rule about
 * SCHEDULING, not about whether fork mode is on. It is applied where the
 * effective background decision is made, not here.
 */
export function forkSubagentModeEnabled(env: EnvRecord = process.env): boolean {
  return parseBooleanEnv(env.NESSY_FORK_SUBAGENT) ?? true
}

/**
 * `tools-reference.md#background-commands` names THREE kinds of command that are
 * stopped at the timeout instead of moved to the background, verbatim:
 *
 * > Claude Code never auto-backgrounds three kinds of command. It stops them at
 * > the timeout instead:
 * >
 * > * A command that starts with `sleep`.
 * > * A command that runs `git` anywhere in it.
 * > * A compound command Claude Code can't fully parse into simple commands.
 *
 * All three are `neverAutoBackgrounds*` predicates below. Until 2026-08-28 only
 * the first existed, which was invisible while nothing could reach a timeout it
 * had not chosen for itself; the `BASH_MAX_TIMEOUT_MS` ceiling
 * (`agent/pi-harness/process-supervisor-port.ts`) made the other two reachable.
 *
 * Every one of them errs toward `kill`. The page states a NEVER-background rule,
 * so a predicate that fires too often costs an auto-background the page did not
 * promise us, while one that fires too rarely backgrounds a command the page
 * says to stop — the divergence being closed here.
 */

/** "A command that starts with `sleep`." First shell token, case-sensitive. */
export function isSleepPrefixedCommand(command: string): boolean {
  return /^\s*sleep(\s|$)/.test(command)
}

/**
 * "A command that runs `git` anywhere in it."
 *
 * `git` as a whole word, anywhere — not just the head, because the page says
 * "anywhere in it" and the case that motivated this row is a `git clone` behind
 * a `cd` or inside a `&&` chain. Word boundaries keep `digit`, `gitlab` and
 * `.gitignore` out (`git` there abuts a word character on one side); a path like
 * `/usr/bin/git`, which does run git, is matched.
 *
 * Deliberately not quote-aware: `echo "git"` runs no git but is stopped anyway.
 * That is the safe side of a never-background rule — see the note above.
 */
export function commandRunsGit(command: string): boolean {
  return /\bgit\b/.test(command)
}

/**
 * "A compound command Claude Code can't fully parse into simple commands."
 *
 * The grammar we can decompose is a list of SIMPLE commands joined by `&&`,
 * `||`, `;`, `|` or a newline, with redirections allowed inside each. Anything
 * that nests a command inside another construct is by definition not a list of
 * simple commands, so it reports "can't parse":
 *
 * - command substitution — `$(…)` and backticks — and arithmetic `$((…))`
 * - process substitution `<(…)` / `>(…)`, and heredocs `<<`
 * - subshells `(…)` and brace groups `{…}`
 * - the shell keywords that open a compound: `if for while until case function`…
 * - the `&` background operator, which schedules rather than sequences
 * - unbalanced single/double quotes, or a trailing backslash continuation, which
 *   mean the string does not parse at all
 *
 * Deliberately structural rather than a real bash AST: importing `bash-parser`
 * here would pull the parser into the Pi subprocess bundle for a predicate that
 * only ever has to answer "did we understand this well enough to background it".
 * Under-approximating what we understand is the safe direction.
 */
export function isUnparseableCompoundCommand(command: string): boolean {
  if (/(^|[^\\])\\$/.test(command.trimEnd())) return true
  if (!hasBalancedQuotes(command)) return true
  // `(` and `)` subsume `$(`, `<(` and `>(`; `` ` `` is the other substitution.
  if (/[`(){}]|<</.test(command)) return true
  // A lone `&` backgrounds; `&&` sequences and `2>&1` redirects, so both stay.
  if (/[^&>]&(?!&)|^&/.test(command)) return true
  // Keywords only count in COMMAND position — at the head, or right after a
  // `;`, `|`, `&&`, `||` or newline. In argument position they are ordinary
  // words, and `bun run build && echo done` must stay backgroundable.
  if (/(^|[;|&\n])\s*(if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|time|coproc)([\s;|&\n]|$)/
    .test(command)) return true
  return false
}

/** Balanced `'` and `"`, honouring backslash escapes outside single quotes. */
function hasBalancedQuotes(command: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '\\') { i += 1; continue }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '"') inDouble = true
  }
  return !inSingle && !inDouble
}

/**
 * The Bash timeout-expiry decision: only the shell tool transitions, never one
 * of the three commands `tools-reference.md#background-commands` says to stop,
 * and never when background tasks are disabled.
 */
export function resolveBashTimeoutBehavior(input: {
  semanticId?: string
  command: string
  env?: EnvRecord
}): 'kill' | 'background' {
  if (input.semanticId !== 'bash') return 'kill'
  if (isSleepPrefixedCommand(input.command)) return 'kill'
  if (commandRunsGit(input.command)) return 'kill'
  if (isUnparseableCompoundCommand(input.command)) return 'kill'
  if (backgroundTasksDisabled(input.env ?? process.env)) return 'kill'
  return 'background'
}

export const MCP_AUTO_BACKGROUND_DEFAULT_MS = 120_000

/**
 * Headless opt-in. `mcp.md` §Automatic backgrounding of long tool calls: calls
 * in non-interactive mode never move to the background "unless
 * `CLAUDE_AUTO_BACKGROUND_TASKS` is set to `1`, since a one-shot run can end
 * before the result arrives."
 */
export function autoBackgroundTasksForced(env: EnvRecord = process.env): boolean {
  return isTruthyFlag(env.NESSY_AUTO_BACKGROUND_TASKS)
}

/**
 * The MCP auto-background eligibility + threshold in one decision
 * (`mcp.md` §Automatic backgrounding of long tool calls, `env-vars.md`
 * `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` → `NESSY_MCP_AUTO_BACKGROUND_MS`).
 *
 * Returns the delay in milliseconds after which a still-running
 * main-conversation MCP call moves to a background task, or `null` when
 * automatic backgrounding is off for this call:
 * - the hard off switch (`NESSY_DISABLE_BACKGROUND_TASKS=1`);
 * - an explicit `0` threshold;
 * - a subagent session ("Claude Code backgrounds only main-conversation calls");
 * - a headless run without the `NESSY_AUTO_BACKGROUND_TASKS=1` opt-in.
 *
 * A malformed threshold falls back to the 120000 default. (Claude's "IDE
 * servers" exclusion has no Nessy counterpart — N/A.)
 */
export function mcpAutoBackgroundDelayMs(input: {
  sessionDepth?: number
  isHeadless?: boolean
  env?: EnvRecord
} = {}): number | null {
  const env = input.env ?? process.env
  if (backgroundTasksDisabled(env)) return null
  if ((input.sessionDepth ?? 0) > 0) return null
  if (input.isHeadless === true && !autoBackgroundTasksForced(env)) return null
  const raw = (env.NESSY_MCP_AUTO_BACKGROUND_MS ?? '').trim()
  if (raw.length === 0) return MCP_AUTO_BACKGROUND_DEFAULT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return MCP_AUTO_BACKGROUND_DEFAULT_MS
  return value === 0 ? null : value
}
