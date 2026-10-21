/**
 * What the RUNNING app inherited from the shell that launched it — D1.27's rig
 * precondition, and a rig fact that outlived the row it was found for.
 *
 * ## The measurement this file exists for
 *
 * A sitting lane is a Claude Code agent, and that agent's own shell exports
 * names THIS PRODUCT reads. A bare `exec` of the packaged binary hands every one
 * of them to the app, and nothing anywhere says so. Measured 2026-09-17 on the
 * packaged 1.39.0: with the lane's environment inherited, a `scout` dispatch on
 * the Nessy Gateway Pi card resolved its child to **`opus`** — a model that
 * gateway does not serve and that nothing in the profile names — because the
 * lane's shell carried `CLAUDE_CODE_SUBAGENT_MODEL=opus` AND
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, and the force flag restores the
 * pre-v2.1.251 precedence in which the variable outranks the per-invocation
 * parameter, the frontmatter AND the tier map. D1.27 asks which model the
 * `small` tier resolves to; without this guard its answer would have been a
 * reading about the lane's own shell, arriving as a product finding.
 *
 * The child's own stored `model` had already been substituted back to the
 * session model by the time it ran, so the contamination is invisible in the
 * transcript and visible only in `piChildRestrictions.model`. That is what makes
 * it worth a guard rather than a sentence: it does not look like anything.
 *
 * ## The instrument, and why it is the APP and not this process
 *
 * `ps eww -p <pid>` prints a process's own environment on macOS, so the app is
 * asked about itself. The case process's environment is a PROXY at best — a case
 * can be run from a different shell than the app was, and on a sitting the two
 * are minutes apart. The app is the thing under measurement, so the app is what
 * is read.
 *
 * **The positive control is not optional.** "No contaminating name is present" is
 * equally true of a read that returned nothing at all — a wrong pid, a `ps` that
 * refused, a parse that produced an empty map. So {@link ENV_READ_CONTROL} must
 * be found in the same read, on the same pid, or the result reports
 * `controlSeen: false` and the caller must treat the verdict as unavailable
 * rather than clean.
 *
 * ## Names, never values
 *
 * Only the NAME and the value's LENGTH ever leave this module. Two of the names
 * below are credentials by construction (`CLAUDE_CODE_MESSAGING_TOKEN`), and the
 * sitting's standing rule is that no token is read, printed or committed. A
 * length is enough to tell "present and empty" from "present and set", which is
 * the only distinction a rig verdict needs.
 *
 * ## How the list was derived, so the next lane can re-derive it
 *
 * Not by guessing at prefixes: the lane's own environment was intersected with
 * what the product reads.
 *
 * ```sh
 * env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
 *   while read -r n; do
 *     c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
 *     [ "$c" -ne 0 ] && echo "$n -> $c file(s)"
 *   done
 * ```
 *
 * On 2026-09-17 that answered THIRTEEN names over a 31-name candidate set. It is
 * a reading with a date, not a closed set — a new SDK release adds variables and
 * this repo grows readers — so the list below carries the file count each name
 * scored and the rule is to re-run the command, never to trust the sentence.
 *
 * ## The filter was INERT until 2026-09-18, and it printed every candidate (D1.325)
 *
 * It read `[ "$c" != 0 ]`, a STRING comparison, and `wc -l` pads its output on
 * this shell: the value is the eight characters `"       0"`, which is not the
 * one character `0`, so the test passed for every name and the command printed
 * all thirty-one candidates with their counts. Measured here, both arms on the
 * same shell: `c=$(printf '' | wc -l)` gives `[       0]`, `[ "$c" != 0 ]`
 * PASSES, and `[ "$c" -ne 0 ]` FILTERS — with `c=$(printf 'a\nb\n' | wc -l)`
 * passing the numeric form as the positive control, so the fix is not merely
 * stricter. `-ne` is the smallest correct spelling because `test` tolerates the
 * padding in a NUMERIC comparison; `$(… | wc -l | tr -d ' ')` works too.
 *
 * It never made a reading wrong — the counts beside the names are the reading,
 * and the thirteen were read off them by eye in sittings 3, 4 and 5 — but a lane
 * that trusts the filter counts thirty-one readers where there are thirteen, and
 * a control nobody can read at a glance is a control that stops being run.
 *
 * ## The command above is BOUNDARY-AWARE since 2026-09-18, and that changed an entry
 *
 * It was `git grep -ac "$n"` — a SUBSTRING match — and a candidate name that is a
 * substring of a real reader scores that reader as its own. Two of the thirteen
 * were inflated by it: `CLAUDE_CODE_SUBAGENT_MODEL` 14 → **10** (the four extra
 * are the `_FORCE` name that contains it, which has its own entry), and
 * `MCP_CONNECTION_NONBLOCKING` 3 → **1** — whose single remaining hit is a
 * DOCBLOCK SENTENCE in `mcp-pool-connect-batch-timing.test.ts`, not a reader. The
 * product's only reader of that posture is
 * `env.NESSY_MCP_CONNECTION_NONBLOCKING` (`mcp/server-config-values.ts`
 * `mcpConnectionNonBlockingFromEnv`), a DIFFERENT name, so the bare one a lane's
 * shell exports moves nothing. `files: 0` marks that, and
 * {@link appEnvBlockReason} reports such a name without BLOCKING on it — a guard
 * that refuses a measurement over an inert name is the "cries wolf" failure this
 * repo already pays for elsewhere. The name stays in the launcher's `env -u`
 * list: deleting it costs nothing and a reader could appear.
 *
 * `-P` rather than `-E`: `git grep -E` does not honour `\b` on this rig and the
 * miss is silent (AGENTS.md §Traps).
 *
 * ## Re-run 2026-09-23 (F1.205): FOURTEEN names, and the new one is a model ALIAS
 *
 * The same command over that day's lane shell (31 candidates) answered fourteen:
 * the thirteen already listed (`ANTHROPIC_BASE_URL` at 53 files, up from 51) plus
 * **`ANTHROPIC_DEFAULT_OPUS_MODEL` -> 4 files**. The reading the row asked for
 * first — does the claude child's env builder strip an INHERITED value? — is
 * NO: `buildClaudeSubprocessEnv` (`packages/shared/src/agent/options.ts`) starts
 * from `{ ...process.env }` and deletes only `CLAUDE_SDK_STRIPPED_ENV_KEYS` and
 * `CLAUDE_LAUNCHER_ENV_KEYS` (`config/claude-provider-routing-env.ts`), neither
 * of which names an alias. The product WRITES its own value
 * (`buildClaudeRuntimeAliasModelEnv`, `agent/claude-agent.ts`) only when the
 * session model is one the connection serves, and HAIKU only from the
 * connection's mini model — so everywhere else the lane's value reaches the SDK
 * child and retargets the alias. Its three siblings are listed beside it, as the
 * row says, though the lane shell exports none of them today: the product
 * writes all four into the same child, so an inherited one of any of them moves
 * the same thing, and `harness.test.ts` holds this list to every alias name
 * `claude-agent.ts` spells, so a fifth cannot be missed.
 *
 * ## The launcher deletes a PREFIX sweep since 2026-09-28, not only this list
 *
 * The list below is what a name is BLOCKED on; what the launcher DELETES is
 * {@link launcherUnsetNames} — the list plus every `CLAUDE*`, `ANTHROPIC_*`,
 * `MCP_*` and `DISABLE_*` name the launching shell exports. A measured list is
 * always one SDK release behind: RC #1 of 1.41.0 (2026-09-25) stopped every lane
 * on `CLAUDE_CODE_TERMINAL_MCP_TOOLS`, which no census had scored, and the lanes
 * then carried a hand-kept 17-name extra list outside the repo beside it.
 * The owner's F1.825 decision (DECISIONS.md) says to do this sweep under any
 * option; SIT-w's launch-2 read-back used exactly these four prefixes.
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * A name the LANE's shell exports that the PRODUCT reads, with the file count it
 * scored on 2026-09-18 and what it would move.
 *
 * Sorted by how badly it corrupts a measurement rather than alphabetically,
 * because the first four are the ones that have to be read before a verdict.
 *
 * `files: 0` means MEASURED INERT: the launcher still deletes it, the read still
 * reports it, and {@link appEnvBlockReason} does not block on it.
 */
export const CONTAMINATING_ENV_NAMES: ReadonlyArray<{ name: string; files: number; moves: string }> = [
  // MEASURED to change a verdict, not inferred. See the header.
  { name: 'CLAUDE_CODE_SUBAGENT_MODEL', files: 10, moves: 'every subagent spawn\'s model, on Pi and on claude' },
  { name: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', files: 11, moves: 'the PRECEDENCE — the variable above outranks the per-call parameter, the frontmatter and the tier map' },
  { name: 'CLAUDE_EFFORT', files: 19, moves: 'reasoning-effort resolution, which is AGT-5\'s entire subject' },
  { name: 'ANTHROPIC_BASE_URL', files: 53, moves: 'the claude runtime\'s upstream' },
  // F1.205 (2026-09-23) — the claude child's model ALIASES. Read first: an
  // inherited value is NOT stripped (header, "Re-run 2026-09-23"). OPUS is in
  // the lane shell today; the three siblings are listed for the same child.
  { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', files: 4, moves: 'which model the claude child\'s `opus` alias resolves to, whenever the session model is not one the card serves' },
  { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', files: 3, moves: 'which model the claude child\'s `sonnet` alias resolves to, on the same condition' },
  { name: 'ANTHROPIC_DEFAULT_FABLE_MODEL', files: 3, moves: 'which model the claude child\'s `fable` alias resolves to, on the same condition' },
  { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', files: 7, moves: 'the claude child\'s `haiku` tier (built-in SDK tools), whenever the connection has no mini model' },
  // MEASURED INERT 2026-09-18 (WI-aa, D1.260): the product's only reader of this
  // posture is `NESSY_MCP_CONNECTION_NONBLOCKING`, a different name. The bare one
  // has ZERO readers — its single boundary-aware hit over `packages apps` is a
  // docblock sentence in `mcp-pool-connect-batch-timing.test.ts`. It was recorded
  // at 3 files by a substring census that counted the prefixed name.
  { name: 'MCP_CONNECTION_NONBLOCKING', files: 0, moves: 'NOTHING — no reader spells it; the MCP connect posture RS-06 measures is read from NESSY_MCP_CONNECTION_NONBLOCKING. Deleted by the launcher anyway, and reported rather than blocked on' },
  { name: 'CLAUDE_CODE_DISABLE_CRON', files: 12, moves: 'the automation scheduler' },
  { name: 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', files: 1, moves: 'SDK checkpointing' },
  { name: 'CLAUDE_CODE_OAUTH_SCOPES', files: 2, moves: 'what the SDK believes it is entitled to' },
  { name: 'CLAUDE_CODE_EXECPATH', files: 4, moves: 'which binary a nested invocation reaches for' },
  { name: 'CLAUDE_CODE_MESSAGING_SOCKET', files: 1, moves: 'the host messaging channel' },
  { name: 'CLAUDE_CODE_MESSAGING_TOKEN', files: 1, moves: 'the host messaging channel — a CREDENTIAL, name and length only' },
  { name: 'CLAUDECODE', files: 2, moves: 'the "am I inside Claude Code" branch' },
  { name: 'DISABLE_AUTOUPDATER', files: 5, moves: 'the updater — benign for a rig, but it is a product behaviour and must be CHOSEN rather than inherited' },
  // F1.512 (2026-09-24) — in the lane shell that day. The SDK's `query()` writes
  // its own value over it, and since F1.512 the claude drift hash ignores the
  // name (`CLAUDE_SDK_SELF_WRITTEN_ENV_NAMES`, `backend/claude/live-session.ts`),
  // so an inherited value is no longer corrected by a respawn at turn 2.
  { name: 'CLAUDE_AGENT_SDK_VERSION', files: 2, moves: 'the `agent-sdk/<version>` a turn-1 claude child reports in its user-agent (the provenance self-report) for that child\'s whole life; before F1.512, a respawn at turn 2 that ended every background task turn 1 started' },
]

/**
 * The name whose PRESENCE proves the environment read worked.
 *
 * Every sitting launches the app with its own `NESSY_CONFIG_DIR`, so a read that
 * cannot see this one saw nothing, and its silence about the names above means
 * nothing either.
 */
export const ENV_READ_CONTROL = 'NESSY_CONFIG_DIR'

export interface AppEnvReading {
  /** Every `Nessy Desktop` process the read covered. */
  readonly pids: readonly number[]
  /** Contaminating names found, as `name -> value length`. NEVER the value. */
  readonly present: Readonly<Record<string, number>>
  /** Did {@link ENV_READ_CONTROL} appear? When false, `present` proves nothing. */
  readonly controlSeen: boolean
  /** Why the read produced nothing, when it did. */
  readonly reason?: string
}

/**
 * The names and value LENGTHS in one process's environment.
 *
 * `ps eww` separates pairs with spaces and a value may contain one
 * (`CLAUDE_CODE_OAUTH_SCOPES` does), so a space split is lossy for VALUES and
 * exact for the question asked here: a token is counted only when it looks like
 * `NAME=`, and a value can only forge one by containing a literal ` NAME=`.
 * Lengths are therefore lower bounds, which is stated rather than hidden — the
 * verdict is presence, and presence is not affected.
 */
function envOfPid(pid: number): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    const text = Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
    for (const token of text.split(/\s+/)) {
      const eq = token.indexOf('=')
      if (eq <= 0) continue
      const name = token.slice(0, eq)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue
      out[name] = token.length - eq - 1
    }
  } catch { /* an unreadable process is reported by the control, not by a throw */ }
  return out
}

/**
 * Every packaged-app process, by the path only the artefact has — and, when a
 * config dir is given, only the ones that carry it.
 *
 * **Scoping is not tidiness on this machine.** Measured 2026-09-18 (SIT-5c):
 * three sitting lanes ran at once and `pgrep -f 'MacOS/Nessy Desktop'` answered
 * TWELVE pids while the lane that asked owned four. Unscoped, a case reads its
 * NEIGHBOURS' app environments, and {@link appEnvBlockReason} then blocks a
 * measurement over a variable in somebody else's process — the cries-wolf
 * failure this module already refuses elsewhere, arriving by a different door.
 * It can also fail the other way on a lane whose own app is gone: the control
 * appears in a sibling's process and `controlSeen` goes true for a read that
 * touched nothing of this rig.
 *
 * The filter is the CONFIG DIR inside the process's OWN environment, which is the
 * shape `cases/rs-72.ts` already uses locally and the one thing that is unique
 * per sitting by construction. `ps eww` is asked once per pid; the alternative —
 * matching the `--user-data-dir` in the command line — would miss the helper
 * processes, which do not all carry it.
 *
 * With no argument the behaviour is exactly what it was, so an existing caller is
 * unchanged. Pass {@link configDirScope}'s answer to get the scoped list.
 */
export function appProcessPids(configDir?: string): number[] {
  let pids: number[]
  try {
    const text = Bun.spawnSync(['pgrep', '-f', 'MacOS/Nessy Desktop']).stdout.toString()
    pids = text.split('\n').map(line => Number(line.trim())).filter(pid => Number.isFinite(pid) && pid > 0)
  } catch {
    return []
  }
  const root = configDir?.trim()
  if (!root) return pids
  return pids.filter(pid => {
    try {
      return Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString().includes(`NESSY_CONFIG_DIR=${root}`)
    } catch {
      return false
    }
  })
}

/**
 * The config dir this PROCESS was given, or `undefined`.
 *
 * A convenience so a case can write `appProcessPids(configDirScope())` without
 * importing the config-dir helper for one string, and deliberately NOT a
 * fallback to a default path: a lane that did not export `NESSY_CONFIG_DIR` has
 * no scope to apply, and silently scoping to somebody's home directory would be
 * worse than not scoping at all.
 */
export function configDirScope(): string | undefined {
  const root = process.env.NESSY_CONFIG_DIR?.trim()
  return root && root.length > 0 ? root : undefined
}

/**
 * What the running app inherited. See the header for why this is read at all.
 *
 * Scoped to THIS rig's config dir by default since 2026-09-18 — see
 * {@link appProcessPids}. A caller that really wants every app on the machine
 * passes `appProcessPids()` explicitly.
 */
export function readAppEnvContamination(pids = appProcessPids(configDirScope())): AppEnvReading {
  if (pids.length === 0) {
    return {
      pids: [],
      present: {},
      controlSeen: false,
      reason: configDirScope()
        ? `no \`MacOS/Nessy Desktop\` process carries NESSY_CONFIG_DIR=${configDirScope()} — nothing was read. On a `
          + 'machine running more than one sitting an UNSCOPED read would have measured a neighbour\'s app, so this '
          + 'is a refusal rather than a fallback'
        : 'no `MacOS/Nessy Desktop` process — nothing was read',
    }
  }
  const present: Record<string, number> = {}
  let controlSeen = false
  for (const pid of pids) {
    const env = envOfPid(pid)
    if (ENV_READ_CONTROL in env) controlSeen = true
    for (const { name } of CONTAMINATING_ENV_NAMES) {
      const length = env[name]
      if (length !== undefined) present[name] = length
    }
  }
  return {
    pids,
    present,
    controlSeen,
    reason: controlSeen ? undefined : `no ${ENV_READ_CONTROL} in any of ${pids.length} process environment(s) — the read failed, so "clean" is unfalsifiable`,
  }
}

/**
 * The sentence a case blocks with, or `undefined` when the rig is clean.
 *
 * Deliberately one function rather than a boolean plus a message at each call
 * site: the message has to name the variable AND what it moves, or the next
 * operator removes the wrong one.
 */
export function appEnvBlockReason(reading: AppEnvReading, subject: string): string | undefined {
  if (!reading.controlSeen) return reading.reason
  // A name MEASURED to have no reader (`files: 0`) is reported by
  // `readAppEnvContamination` and never blocked on: refusing a measurement over a
  // variable nothing reads is the cries-wolf failure, and the next operator would
  // learn to ignore the block rather than the variable.
  const inert = new Set(CONTAMINATING_ENV_NAMES.filter(entry => entry.files === 0).map(entry => entry.name))
  const names = Object.keys(reading.present).filter(name => !inert.has(name))
  if (names.length === 0) return undefined
  const detail = names
    .map(name => {
      const entry = CONTAMINATING_ENV_NAMES.find(candidate => candidate.name === name)
      return `${name} (${reading.present[name]} chars) — ${entry?.moves ?? 'read by the product'}`
    })
    .join('; ')
  return (
    `the app inherited ${names.length} name(s) this product reads from the shell that launched it, `
    + `and ${subject} would measure that shell instead: ${detail}. `
    + 'Relaunch the packaged app with each of them DELETED from the environment '
    + '(`env -u <NAME> … "<app>/Contents/MacOS/Nessy Desktop" …`), not overwritten — and read '
    + '`ps eww -p <pid>` afterwards, because the app is what has to be clean, not the shell you typed in.'
  )
}

// ---------------------------------------------------------------------------
// The launcher's `env -u` list — a PREFIX sweep over the launching shell
// ---------------------------------------------------------------------------

/**
 * The prefixes the launcher deletes wholesale. `CLAUDE` has no underscore on
 * purpose: `CLAUDECODE` is a marker the Claude Code binary stamps on its own
 * subprocesses, and it is one of the names the product reads. `NESSY_*` and
 * `CODEX_*` are NOT swept — the launcher sets the first itself, and a rig
 * that wants codex's own variables chooses them on the command line.
 */
export const LAUNCHER_SWEEP_PREFIX = /^(?:CLAUDE|ANTHROPIC_|MCP_|DISABLE_)/

/**
 * Every name the launcher `env -u`s: {@link CONTAMINATING_ENV_NAMES} (always,
 * present or not) plus every name in `env` that {@link LAUNCHER_SWEEP_PREFIX}
 * matches. NAMES only — the values never leave `env`, and the README's launcher
 * prints `-u <name>` pairs and nothing else. A name the operator wants the app to
 * have is written after the list (`env -u … DISABLE_AUTOUPDATER=1 …`): `env`
 * applies every `-u` before any assignment, so a deleted name can still be CHOSEN.
 */
export function launcherUnsetNames(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const names = new Set(CONTAMINATING_ENV_NAMES.map(entry => entry.name))
  for (const name of Object.keys(env)) {
    if (LAUNCHER_SWEEP_PREFIX.test(name)) names.add(name)
  }
  return [...names].sort()
}

// ---------------------------------------------------------------------------
// F1.852 — the CASE's config dir against the APP's
// ---------------------------------------------------------------------------

/**
 * The `NESSY_CONFIG_DIR` a process was LAUNCHED with, read from its `ps eww`
 * text; `undefined` when it carries none (the product then runs on
 * `~/.nessy-agent`, `config/paths.ts`) — an empty value counts as none, as it
 * does there.
 *
 * The one VALUE this module reads, and only this one: a config dir is a path the
 * operator chose, not a credential, and a refusal that cannot name the directory
 * to export is one the operator cannot act on. `ps eww` joins pairs with spaces,
 * so the value runs to the next ` NAME=` token; a path that itself contains
 * ` X=` is cut short there — stated rather than hidden.
 */
export function launchedConfigDir(psText: string): string | undefined {
  const match = /(?:^|\s)NESSY_CONFIG_DIR=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/m.exec(psText)
  const value = match?.[1]?.trim()
  return value ? value : undefined
}

/**
 * The directory `config/paths.ts` resolves for an override (or its absence),
 * then its REAL path when it exists, so `/tmp/x` and `/private/tmp/x` compare
 * equal — they are one directory, and a refusal between them would cry wolf.
 */
export function effectiveConfigDir(override: string | undefined, home: string = homedir()): string {
  const resolved = resolve(override?.trim() || join(home, '.nessy-agent'))
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** The app a run will attach to, and the config dir each of its processes was launched with. */
export interface AppConfigDirReading {
  readonly port: string
  /** Every pid LISTENING on the CDP port whose environment `ps eww` could read. */
  readonly processes: ReadonlyArray<{ readonly pid: number; readonly override: string | undefined }>
  /** Listening pids whose environment could NOT be read — never guessed to be the default. */
  readonly unreadable: readonly number[]
}

/**
 * Read the app on the CDP port — the LISTENER, not every command line that
 * spells `--remote-debugging-port=<port>`. A sitting lane launches the app from
 * a `zsh -c '… env … NESSY_CONFIG_DIR=… "<app>" --remote-debugging-port=<port>'`
 * wrapper that stays alive beside it, and that wrapper's own environment has no
 * `NESSY_CONFIG_DIR` (`env` sets it for the CHILD), so a command-line match
 * would read a relocated rig as the default profile and refuse a correct run.
 * The listener is the process a case's `attach` actually reaches.
 *
 * A pid counts as readable when its `ps eww` line carries `HOME=` (every launch
 * shape here keeps it); otherwise "no NESSY_CONFIG_DIR" would be equally true of
 * a read that saw nothing.
 */
export function readAppConfigDirs(port: string): AppConfigDirReading {
  let pids: number[] = []
  try {
    const text = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).stdout.toString()
    pids = [...new Set(text.split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 0))]
  } catch { /* no listener read: reported as "not compared" */ }
  const processes: Array<{ pid: number; override: string | undefined }> = []
  const unreadable: number[] = []
  for (const pid of pids) {
    let text = ''
    try {
      text = Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
    } catch { /* unreadable below */ }
    if (/(?:^|\s)HOME=/.test(text)) processes.push({ pid, override: launchedConfigDir(text) })
    else unreadable.push(pid)
  }
  return { port, processes, unreadable }
}

export interface ConfigDirVerdict {
  readonly verdict: 'match' | 'mismatch' | 'not-compared'
  /** One line for the operator, on every verdict — what was compared, or why nothing was. */
  readonly line: string
}

/**
 * F1.852 — may a run start? A case is a SECOND process: it reads the config dir
 * from its own `NESSY_CONFIG_DIR` (`runtime-session-log.ts` `configDir`), never
 * from the app's, so a run started without the variable on a relocated rig
 * reads the owner's real `~/.nessy-agent` from disk while the app under test
 * writes somewhere else (SIT-w, RS-105, 2026-09-25: read-only that time, and
 * caught only because the lane read the `[cdp] config dir:` line). The two
 * directories are compared as {@link effectiveConfigDir} resolves them, and
 * the run is refused on any difference in EITHER direction.
 *
 * `not-compared` — no listener, or none readable — lets the run start: the case
 * then blocks on its own `attach`, or needs no app at all (RS-47 reads the
 * artefact from disk), and refusing it here would name the wrong cause.
 */
export function configDirVerdict(
  caseOverride: string | undefined,
  app: AppConfigDirReading,
  home: string = homedir(),
): ConfigDirVerdict {
  const tag = `[cdp] config dir check (F1.852), CDP port ${app.port}`
  if (app.processes.length === 0) {
    const why = app.unreadable.length > 0
      ? `the environment of listening pid(s) ${app.unreadable.join(', ')} could not be read`
      : 'no process is listening on it'
    return { verdict: 'not-compared', line: `${tag}: not compared — ${why}; the cases attach, or block, on their own` }
  }
  const mine = effectiveConfigDir(caseOverride, home)
  const theirs = [...new Set(app.processes.map(entry => effectiveConfigDir(entry.override, home)))]
  const pids = app.processes.map(entry => entry.pid).join(', ')
  if (theirs.length === 1 && theirs[0] === mine) {
    return { verdict: 'match', line: `${tag}: the app (pid ${pids}) and this run both use ${mine}` }
  }
  const own = caseOverride?.trim()
    ? `this run's NESSY_CONFIG_DIR resolves to ${mine}`
    : `NESSY_CONFIG_DIR is UNSET for this run, so every case would read the DEFAULT profile ${mine} — the owner's`
  return {
    verdict: 'mismatch',
    line: `${tag}: REFUSED — the app (pid ${pids}) runs on ${theirs.join(' and ')}, but ${own}. A case is a second `
      + 'process and reads the config dir from its OWN environment, so it would measure a directory the app does '
      + `not write. Export NESSY_CONFIG_DIR=${theirs.length === 1 ? theirs[0] : '<the app\'s dir>'} (the value the `
      + 'app was launched with) and run again.',
  }
}
