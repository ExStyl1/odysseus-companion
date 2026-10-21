/**
 * The subagent nesting-depth ceiling.
 *
 * `env-vars.md:281`, the `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` row: "Number of
 * subagent layers allowed below the main conversation (default: 3). At the
 * default, subagents can spawn their own subagents, and a subagent at the third
 * layer can't spawn further; set `1` to turn nesting off. … Accepts a positive
 * whole number in plain digits; anything else is ignored, so the limit can be
 * adjusted but not removed."
 *
 * ## The parse is deliberately stricter, and the page is why
 *
 * `env-vars.md#variables` opens the Variables list by granting scientific
 * notation and digit separators to numeric variables generally — "For example,
 * Claude Code reads `2e3` as 2000 and `64_000` as 64000" — and then carves out
 * "except where a variable's row notes it takes plain digits only". THIS row
 * notes it: "Accepts a positive whole number in plain digits; anything else is
 * ignored, so the limit can be adjusted but not removed."
 *
 * So `1e3`, `0x3`, `2.5`, `3_000` and `+3` are ignored here BY CONTRACT, while
 * `resolveMaxWebSearchesPerSession`, whose row carries no such note, reads
 * `2e3` as 2000. The strictness is expressed as `plainDigitsOnly` at the call
 * below so the reading is visible rather than implied by a regex.
 *
 * And because "the limit can be adjusted but not removed", there is no disable
 * value — `0` is not a legal depth and must never be read as "unlimited", so
 * the reader also requires `>= 1`. `1` is the documented "nesting off" value
 * and is a legal setting.
 *
 * ## Where the value is read
 *
 * HOST-side only, at execution-manifest seed time (`SessionManager`'s
 * `createPiExecutionManifestSeed`). The `orchestrator` config travels on the
 * signed execution manifest and both sides assert they agree on it, so a
 * subprocess that re-read the variable itself could disagree with the host
 * whenever the two environments differ. `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH` is
 * the static fallback the frozen manifest defaults and the subprocess spawner
 * share.
 */

import { resolveNumericSetting } from './numeric-setting'

export type SubagentSpawnDepthEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the depth ceiling. */
export const MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR = 'NESSY_MAX_SUBAGENT_SPAWN_DEPTH'

/** The documented Claude spelling, accepted as a compat alias. */
export const MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR = 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'

/**
 * "(default: 3)" — three subagent layers below the main conversation
 * (`sub-agents.md:867`). v2.1.219 raised Claude's default from 1 to 3; our
 * previous 1 was parity with v2.1.217–218, not a different choice.
 */
export const DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 3

/**
 * The effective depth ceiling. A malformed value falls back to the documented
 * default ("anything else is ignored") and `0` falls back rather than meaning
 * unlimited ("the limit can be adjusted but not removed"). Follows the
 * `resolvePrintBackgroundWaitCeilingMs` precedent for an aliased pair — the
 * Nessy name wins when both are set.
 */
export function resolveMaxSubagentSpawnDepth(
  env: SubagentSpawnDepthEnvRecord = process.env,
  write?: (message: string) => void,
): number {
  // Presence decides which name is read, and the SAME choice names the value in
  // the rejection sentence.
  const name = env[MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR] !== undefined
    ? MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR
    : MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR
  return resolveNumericSetting(
    name,
    env[name],
    DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH,
    // The exception clause, not an oversight: this key's own row says "in
    // plain digits", so `2e3` must keep falling back here while it resolves to
    // 2000 for a key whose row is silent.
    { plainDigitsOnly: true, min: 1 },
    write,
  )
}
