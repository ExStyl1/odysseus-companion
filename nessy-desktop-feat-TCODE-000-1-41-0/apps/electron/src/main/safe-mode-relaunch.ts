/**
 * P6.451 — safe mode could be entered only from a shell.
 *
 * The posture itself was complete on all three runtimes: `isSafeModeEnabled`
 * gates the whole capability input set at one funnel before any runtime is
 * chosen, both spellings are accepted, and `SafeModeBanner` already tells the
 * user which posture the window is in. What was missing was the ENTRY. A `git
 * grep` over `apps/electron` finds no setter of either variable outside the
 * preload's read, so the only way in was `NESSY_SAFE_MODE=1` on a command line —
 * and, worse, the only way BACK OUT of a shell-started safe-mode session was
 * another command line, because a relaunch inherits the environment it was
 * started with.
 *
 * ## Why the environment, and not a relaunch option
 *
 * MEASURED against the installed Electron typings rather than assumed: Electron's
 * `RelaunchOptions` declares exactly `args?: string[]` and `execPath?: string`
 * (`node_modules/electron/electron.d.ts`) — **there is no `env` field**, so
 * `app.relaunch({ env: … })` cannot express this and would silently pass an
 * ignored property.
 *
 * The environment is the right carrier anyway, and the vendor's own page says
 * why: `env-vars.md:318` on the documented twin of our variable ends with
 * *"Directly spawned child processes inherit the variable"* — which is exactly
 * the property safe mode needs, since a session's real work happens in the Pi,
 * claude and codex children. An `argv` flag would have to be re-derived and
 * re-forwarded by every spawn site; the variable is forwarded by the operating
 * system.
 *
 * So the whole mechanism is: mutate this process's own environment, then let
 * Electron relaunch, which spawns the new instance inheriting it.
 *
 * ## Leaving is not "not entering"
 *
 * `off` deletes BOTH spellings, and that is the half a naive implementation
 * misses. `isSafeModeEnabled` prefers `NESSY_SAFE_MODE` when it is defined and
 * otherwise falls back to the documented Claude alias, so a session started by a
 * wrapper that exports `CLAUDE_CODE_SAFE_MODE=1` would stay in safe mode forever
 * if only our own spelling were cleared. A user who cannot get back out has been
 * given a trap, not a diagnostic.
 *
 * `undefined` leaves the environment exactly as it is, which is what every
 * pre-existing caller of the relaunch channel means — the server-settings page
 * restarts the app to apply a server change and must not silently alter the
 * posture.
 */

import {
  SAFE_MODE_COMPAT_ENV_VAR,
  SAFE_MODE_ENV_VAR,
  type SafeModeEnvRecord,
} from '@nessy-agent/shared/config/safe-mode'

/** What a relaunch should do to the safe-mode posture. */
export type SafeModeRelaunchIntent = 'on' | 'off' | 'unchanged'

/**
 * Normalises the renderer's optional flag into an intent.
 *
 * `undefined` is `'unchanged'` rather than `'off'`: the relaunch channel predates
 * this row and its existing caller passes nothing.
 */
export function safeModeRelaunchIntent(safeMode: boolean | undefined): SafeModeRelaunchIntent {
  if (safeMode === undefined) return 'unchanged'
  return safeMode ? 'on' : 'off'
}

/**
 * Applies the intent to an environment record, in place.
 *
 * Exported and taking the record as an argument so the decision is testable
 * without an Electron process; production passes `process.env`.
 *
 * The `delete` before the assignment is the house rule from AGENTS.md §Traps
 * (assigning to a name a runtime pre-created a slot for leaves it readable by
 * property and invisible to `Object.keys`/spread, so a spawned child gets
 * nothing). Electron's main process is Node rather than Bun and is not known to
 * be affected, but every subprocess environment in this tree is built by
 * spreading, the cost is one statement, and a conditional habit is the one that
 * fails on the machine nobody tested.
 */
export function applySafeModeRelaunchEnv(
  env: SafeModeEnvRecord,
  intent: SafeModeRelaunchIntent,
): void {
  if (intent === 'unchanged') return
  delete env[SAFE_MODE_ENV_VAR]
  delete env[SAFE_MODE_COMPAT_ENV_VAR]
  if (intent === 'on') env[SAFE_MODE_ENV_VAR] = '1'
}
