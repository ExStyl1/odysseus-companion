/**
 * The consecutive-block cap for `Stop` and `SubagentStop` hooks.
 *
 * `env-vars.md`, the `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` row, quoted whole:
 *
 * > Maximum number of consecutive times a [Stop](/docs/en/hooks#stop) or
 * > [SubagentStop](/docs/en/hooks#subagentstop) hook may block the turn from
 * > ending before Claude Code overrides it and ends the turn anyway (default:
 * > 8). Set to `0` to disable the cap. Raise this if your hook legitimately
 * > needs more iterations to resolve
 *
 * ## What the cap does in this fork
 *
 * We cannot re-run a turn that has already ended, so our equivalent of
 * "overrides it and ends the turn anyway" is to stop re-delivering the blocking
 * hook's `reason` on the next turn's user-message tail — see
 * `BaseAgent.recordHookBlockFeedback`. The trigger point and the number are the
 * documented ones; only the override's shape differs.
 *
 * The comparison there is `streak > cap`, which honours exactly `cap`
 * consecutive blocks and suppresses the next one — "maximum number of
 * consecutive times a … hook **may** block … **before** Claude Code overrides
 * it".
 *
 * ## Scope
 *
 * The sentence names `Stop` and `SubagentStop` and nothing else, so the knob is
 * read for exactly those two events. The `ConfigChange` block shares the same
 * streak counter and deliberately keeps the fixed
 * {@link DEFAULT_STOP_HOOK_BLOCK_CAP}: the env-var page grants an override for
 * those two events only.
 *
 * P6.289 · this paragraph used to call `ConfigChange` "our own undocumented"
 * event. That has not been true since the contract was read: the event is
 * documented, and so is its block.
 * `hooks.md#configchange-decision-control` — *"ConfigChange hooks can block
 * configuration changes from taking effect. Use exit code 2 or a JSON
 * `decision` to prevent the change. When blocked, the new settings are not
 * applied to the running session."* — with `policy_settings` exempt
 * (*"`policy_settings` changes can't be blocked"*) and the block deliberately
 * silent (*"A blocked change surfaces no message to you or to Claude … Claude
 * Code only writes a line to the debug log."*).
 *
 * What IS still true is that OUR block is advisory: the setting is applied
 * anyway. That is an open gap against a contract, not a documented posture, and
 * closing it is P6.289's own work in the config watcher — which is why this
 * paragraph now names the divergence instead of asserting no contract exists.
 *
 * ## Which of the page's two numeric contracts this key sits under
 *
 * `env-vars.md#variables`, the paragraph opening the Variables list, verbatim:
 *
 * > Numeric variables such as timeouts, token budgets, and retry counts accept
 * > scientific notation and digit-separator spellings in addition to plain
 * > digits, except where a variable's row notes it takes plain digits only. For
 * > example, Claude Code reads `2e3` as 2000 and `64_000` as 64000. Before
 * > v2.1.211, these spellings could silently set a much smaller value, such as
 * > `1e6` setting a timeout to 1.
 *
 * This key's own row — quoted whole at the top of this file — notes **no** such
 * restriction, so the clause after "except" does not apply to it and it takes
 * the GENERAL rule: `1e3` is 1000 and `1_000` is 1000. That is
 * {@link resolveNumericSetting} with no `plainDigitsOnly`, and this docblock
 * used to claim the opposite ("the parse is deliberately stricter than
 * `Number()`") as a shared fork convention the page does not support.
 *
 * `0x8`, `1.5`, `-1`, `+8` and `8,0` stay refused in both modes. A malformed
 * value falls back to 8 rather than to `0` — a typo must never silently buy an
 * uncapped loop — and the rejection is now SAID rather than swallowed. `0` is
 * the one documented way to disable the cap, so no `min` is passed: it is a
 * legal setting here, not an out-of-range one.
 */

import { resolveNumericSetting } from './numeric-setting'

export type StopHookBlockCapEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the cap. */
export const STOP_HOOK_BLOCK_CAP_ENV_VAR = 'NESSY_STOP_HOOK_BLOCK_CAP'

/** The documented Claude spelling, accepted as a compat alias. */
export const STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR = 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP'

/** "(default: 8)". */
export const DEFAULT_STOP_HOOK_BLOCK_CAP = 8

/** "Set to `0` to disable the cap" — spelled out so readers see the sentinel. */
export const STOP_HOOK_BLOCK_CAP_DISABLED = 0

/**
 * The effective cap. `0` means no cap, per the doc.
 *
 * A malformed value falls back to the documented default rather than to `0`: a
 * typo must not silently buy an uncapped hook loop. Follows the
 * `resolvePrintBackgroundWaitCeilingMs` precedent for an aliased pair — the
 * Nessy name wins when both are set.
 */
export function resolveStopHookBlockCap(
  env: StopHookBlockCapEnvRecord = process.env,
  write?: (message: string) => void,
): number {
  // Presence decides which name is read, and the SAME choice names the value in
  // the rejection sentence — a report naming the wrong spelling is worse than
  // no report. Same shape as `resolveMaxWebSearchesPerSession`.
  const name = env[STOP_HOOK_BLOCK_CAP_ENV_VAR] !== undefined
    ? STOP_HOOK_BLOCK_CAP_ENV_VAR
    : STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR
  return resolveNumericSetting(name, env[name], DEFAULT_STOP_HOOK_BLOCK_CAP, {}, write)
}
