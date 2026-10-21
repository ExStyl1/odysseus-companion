/**
 * P6.361 — named workspace actions: a project's own commands, saved once and
 * launched from the app.
 *
 * ## What was missing, measured rather than assumed
 *
 * The row's own words: *"The EXECUTION mechanism exists on all three; the
 * missing piece is a user-invocable entry point."* Re-measured at HEAD before
 * this file existed: `git grep -aln -E 'projectAction|localEnvironment|repeatable
 * action' -- packages apps` → **0 files**, against `powerSaveBlocker` → **3** as
 * the positive control on the same run. So the store is genuinely new; the thing
 * that runs the command is not.
 *
 * ## Native-first, asked of all three and answered
 *
 * - **Claude** carries saved project commands whose body runs shell —
 *   `https://code.claude.com/docs/en/skills.md#how-injected-commands-run`,
 *   verbatim: *"The `` !`<command>` `` syntax runs shell commands before the
 *   skill content is sent to Claude."* — with `allowed-tools` pre-approval and
 *   an operator kill switch, `"disableSkillShellExecution": true`, *"most useful
 *   in managed settings, where users cannot override it"*. **That switch is
 *   honoured here** ({@link workspaceActionsDisabled}), because a host surface
 *   that ran the same class of command around an operator's own off switch would
 *   be a hole in it.
 * - **Codex** exposes `command/exec` (+ `/write`, `/resize`, `/terminate`) on the
 *   app-server (`packages/codex-protocol/generated/ClientRequest.ts:100`,
 *   verified) and **no saved-action or named-command method at all**.
 * - **Pi** is built to Claude's contract and has the same `!`-syntax execution.
 *
 * None of the three has a **top-bar button**, and none of them could: the entry
 * point is the app's, not the runtime's. So this is native-first condition (2)
 * — the host supplies it once — and the action ends up on the SAME approval path
 * the agent's Bash goes through, which is the row's `done_means` and the reason
 * this file stores a command rather than running one.
 *
 * ## The tier is the security boundary, and it is copied from `setupScript`
 *
 * `worktree-settings.ts`'s `setupScript` is the nearest built thing (its own
 * docblock: per-platform by design, and *"a repository you clone must not be
 * able to run a command by being opened"*). Actions inherit that decision
 * unchanged: they are declared in the APP's own settings tier, never in a
 * project's `.nessy-agent/config.toml`, whose recorded invariant is *"A project
 * file can never grant trust, credentials, provider auth, environment,
 * filesystem roots or shell commands"* (`plugins/project-config.ts`).
 *
 * Where `setupScript` differs and why it is not simply reused: a setup script is
 * ONE command that runs ONCE when git creates a worktree, chosen by nobody at
 * the moment it runs. An action is a NAMED command a person picks and launches,
 * so it needs a name, a stable id, and a list — three things a single string
 * cannot carry.
 *
 * ## The per-platform shape is `setupScript`'s, deliberately
 *
 * Two buckets, `windows` and `posix`, because there are exactly two
 * interpreters. That file recorded the read that found NO documented
 * platform-keyed settings shape anywhere in the corpus, so re-deriving one here
 * would be inventing a second spelling of the same undocumented thing. A user
 * who must tell darwin from linux writes one `posix` command that branches on
 * `uname` — the same stated residue.
 */

import { resolve, sep } from 'node:path'

import { DISABLE_SKILL_SHELL_EXECUTION_SETTING_KEY, skillShellExecutionDisabled } from './skill-gates.ts'

/** The settings key the list is declared under. Ours; no vendor counterpart exists (see the header). */
export const WORKSPACE_ACTIONS_SETTING_KEY = 'workspaceActions'

/** A command is a command line, not a program file; anything longer is a mistake. */
export const MAX_ACTION_COMMAND_LENGTH = 4096
/** A name is a label on a button. */
export const MAX_ACTION_NAME_LENGTH = 64
/** More than this is a menu nobody reads, and a list nobody meant to write. */
export const MAX_ACTIONS = 32

/** One command per interpreter. Absent means "no action on that platform". */
export interface WorkspaceActionCommand {
  windows?: string
  posix?: string
}

/** One saved action, as declared. */
export interface WorkspaceAction {
  /**
   * Stable identity, used by the invoking entry point so a rename does not
   * break a keybinding or a caller that saved the choice.
   */
  id: string
  /** What the button says. */
  name: string
  /** A plain string is `posix` and `windows` alike — the common case. */
  command: string | WorkspaceActionCommand
  /**
   * Where it runs, relative to the workspace root. Absent means the root.
   *
   * NOT an absolute path and not an escape: the resolver below refuses `..` and
   * anything absolute, because an action is a project's own command and a path
   * that leaves the project is a different question with a different answer.
   */
  cwd?: string
}

/** One action with the platform choice already made. */
export interface ResolvedWorkspaceAction {
  id: string
  name: string
  /** The command for THIS host's interpreter. */
  command: string
  cwd?: string
}

const ACTION_KEYS = ['id', 'name', 'command', 'cwd'] as const
const COMMAND_KEYS = ['windows', 'posix'] as const

function fail(message: string): never {
  throw new Error(`${WORKSPACE_ACTIONS_SETTING_KEY}: ${message}`)
}

/**
 * One command string, or a refusal naming what was wrong.
 *
 * Refused rather than defaulted, on `setupScript`'s rule: a non-string, a blank
 * string, a value past {@link MAX_ACTION_COMMAND_LENGTH}, or a NUL byte. Blank
 * is a mistake and not "no command" — this parser never drops a bad value to a
 * default — and a NUL cannot cross an argv boundary intact, so it would silently
 * TRUNCATE the command that eventually runs, which is the worst failure a
 * command store can have.
 */
function parseCommandString(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} must be a string`)
  const command = value as string
  if (command.trim().length === 0) fail(`${where} must not be blank`)
  if (command.length > MAX_ACTION_COMMAND_LENGTH) {
    fail(`${where} must be at most ${MAX_ACTION_COMMAND_LENGTH} characters`)
  }
  if (command.includes('\u0000')) fail(`${where} must not contain a NUL byte`)
  return command
}

function parseCommand(value: unknown, where: string): WorkspaceActionCommand {
  if (typeof value === 'string') {
    const command = parseCommandString(value, where)
    // A plain string means BOTH interpreters, which is what a user who wrote one
    // command meant. Expanded here rather than at the resolver so there is one
    // shape past this point.
    return { windows: command, posix: command }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${where} must be a string or an object with "windows" and/or "posix"`)
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(COMMAND_KEYS as readonly string[]).includes(key)) fail(`${where} has unknown key "${key}"`)
  }
  const parsed: WorkspaceActionCommand = {}
  if (record.windows !== undefined) parsed.windows = parseCommandString(record.windows, `${where}.windows`)
  if (record.posix !== undefined) parsed.posix = parseCommandString(record.posix, `${where}.posix`)
  // `{}` is refused for blank's reason: it is the one value that would silently
  // define an action that can never run on any platform.
  if (parsed.windows === undefined && parsed.posix === undefined) {
    fail(`${where} must declare "windows", "posix", or both`)
  }
  return parsed
}

/**
 * The working directory, or a refusal.
 *
 * Relative and inside the project, checked on the STRING rather than after a
 * join: `..` and an absolute path are both refused by name, so the reason a
 * declaration was rejected reaches the person who wrote it.
 */
function parseCwd(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} must be a string`)
  const cwd = value as string
  if (cwd.trim().length === 0) fail(`${where} must not be blank`)
  if (cwd.includes('\u0000')) fail(`${where} must not contain a NUL byte`)
  if (cwd.startsWith('/') || cwd.startsWith('\\') || /^[A-Za-z]:/.test(cwd)) {
    fail(`${where} must be relative to the workspace root, not absolute`)
  }
  if (cwd.split(/[\\/]/).includes('..')) fail(`${where} must not contain ".."`)
  return cwd
}

/**
 * Parse the declared list, or throw naming the first thing that was wrong.
 *
 * `undefined` is "no actions" and is the default. Everything else is parsed
 * strictly, because every entry here is a shell command someone will click.
 */
export function parseWorkspaceActions(value: unknown): WorkspaceAction[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('must be an array')
  if (value.length > MAX_ACTIONS) fail(`must declare at most ${MAX_ACTIONS} actions`)

  const seen = new Set<string>()
  return value.map((entry, index) => {
    const where = `[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${where} must be an object`)
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!(ACTION_KEYS as readonly string[]).includes(key)) fail(`${where} has unknown key "${key}"`)
    }
    if (typeof record.id !== 'string' || record.id.trim().length === 0) fail(`${where}.id must be a non-empty string`)
    if (typeof record.name !== 'string' || record.name.trim().length === 0) {
      fail(`${where}.name must be a non-empty string`)
    }
    if (record.name.length > MAX_ACTION_NAME_LENGTH) {
      fail(`${where}.name must be at most ${MAX_ACTION_NAME_LENGTH} characters`)
    }
    // A duplicate id is refused rather than last-one-wins: the id is what an
    // entry point saved, so two actions sharing one is a launch that runs the
    // wrong command with no error anywhere.
    if (seen.has(record.id)) fail(`${where}.id "${record.id}" is declared twice`)
    seen.add(record.id)

    const action: WorkspaceAction = {
      id: record.id,
      name: record.name,
      command: parseCommand(record.command, `${where}.command`),
    }
    if (record.cwd !== undefined) action.cwd = parseCwd(record.cwd, `${where}.cwd`)
    return action
  })
}

/**
 * The actions runnable on THIS host, platform choice already made.
 *
 * An action declared only for the other interpreter is DROPPED rather than
 * offered and failed: a button that cannot work is worse than an absent one, and
 * this is the same answer `resolveWorktreeSettings` gives a Windows-only
 * `setupScript` on macOS.
 */
export function resolveWorkspaceActions(
  actions: readonly WorkspaceAction[],
  platform: NodeJS.Platform = process.platform,
): ResolvedWorkspaceAction[] {
  const bucket: keyof WorkspaceActionCommand = platform === 'win32' ? 'windows' : 'posix'
  const resolved: ResolvedWorkspaceAction[] = []
  for (const action of actions) {
    const command = typeof action.command === 'string' ? action.command : action.command[bucket]
    if (command === undefined) continue
    resolved.push({
      id: action.id,
      name: action.name,
      command,
      ...(action.cwd === undefined ? {} : { cwd: action.cwd }),
    })
  }
  return resolved
}

/**
 * Is launching a saved action off for this install?
 *
 * The vendor's own `disableSkillShellExecution` and NOT a key of our own, which
 * is a deliberate reading rather than a convenience. Its documented subject is
 * *"inline shell execution in skills and custom slash commands from user,
 * project, or plugin sources"* — a saved user command that the app runs on a
 * click is the same class of thing under a different button, and an operator who
 * turned that off did not mean "except from the toolbar". Adding a second key
 * would let the two answer differently, which is how a kill switch stops being
 * one.
 *
 * The residue, stated because it is a real narrowing: an operator who wants
 * actions but not `!`-syntax in skills cannot express that today. If that is
 * ever asked for it needs its own key and its own row, not a widened reading of
 * this one.
 */
export function workspaceActionsDisabled(config: unknown): boolean {
  return skillShellExecutionDisabled(config)
}

/** Named so a refusal can say WHY, since the person who meets it has no other route back. */
export const WORKSPACE_ACTIONS_DISABLED_REASON =
  `Saved actions are turned off by ${DISABLE_SKILL_SHELL_EXECUTION_SETTING_KEY}.`

/**
 * Read the declared actions out of a settings object, resolved for this host.
 *
 * Returns `[]` when the kill switch is on, so a caller that forgets to ask
 * cannot offer a disabled action — the switch is enforced at the read rather
 * than at every call site.
 */
export function getWorkspaceActions(
  config: unknown,
  platform: NodeJS.Platform = process.platform,
): ResolvedWorkspaceAction[] {
  if (workspaceActionsDisabled(config)) return []
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return []
  const declared = (config as Record<string, unknown>)[WORKSPACE_ACTIONS_SETTING_KEY]
  return resolveWorkspaceActions(parseWorkspaceActions(declared), platform)
}

/**
 * P6.720 — the action's working directory as an ABSOLUTE path, or a refusal by
 * name. `undefined` in means `undefined` out: no declaration, no change.
 *
 * ## Why the containment runs a SECOND time here
 *
 * {@link parseWorkspaceActions} already refuses an absolute path and a `..`
 * segment when the declaration is read, so on the ordinary route this function
 * can only agree with it. It exists because the two checks answer different
 * questions and are separated by a whole subsystem: the parser asks *was this
 * declaration well formed*, and this asks *does this path, joined to THIS
 * session's working directory, still land inside it*. Only the second one can
 * be asked at the moment a command is about to run, and only the second one is
 * available to a caller that did not come through the parser — the value is a
 * string by then, and a string that has crossed an RPC boundary has no memory
 * of having been validated.
 *
 * The check is on the RESOLVED path rather than on the string, which is the
 * half a per-segment test cannot do on its own.
 *
 * It does NOT follow symlinks. A `realpath` here would refuse a project whose
 * own subdirectory is a link — an ordinary layout — and the threat it would
 * address (a link planted inside the project, pointing out) is one the person
 * who can plant it can also exercise by writing the command itself. Stated
 * rather than silently assumed, because a containment check that looks stronger
 * than it is is worse than one whose limit is written down.
 *
 * THROWS rather than falling back, unlike `resolvePlansDirectory`'s posture and
 * for the opposite reason: a plans directory that quietly reverts to the default
 * still writes the file, while a command that quietly runs somewhere other than
 * where it was told to is the accepted-and-ignored shape this row removes.
 */
export function resolveWorkspaceActionCwd(
  sessionCwd: string,
  actionCwd: string | undefined,
): string | undefined {
  if (actionCwd === undefined) return undefined
  if (typeof actionCwd !== 'string' || actionCwd.trim().length === 0) {
    fail('`cwd` must be a non-empty string relative to the workspace root')
  }
  if (actionCwd.includes('\u0000')) fail('`cwd` must not contain a NUL byte')
  const root = resolve(sessionCwd)
  const candidate = resolve(root, actionCwd.trim())
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    fail(`\`cwd\` must be within the workspace root, not ${actionCwd.trim()}`)
  }
  return candidate
}
