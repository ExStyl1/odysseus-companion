/**
 * The per-session WebSearch budget (doc-sweep § R48, finding f236).
 *
 * Claude env name maps to ours, the way `background-task-settings.ts` records
 * its family:
 *
 * - `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` → `NESSY_MAX_WEB_SEARCHES_PER_SESSION`
 *   (the Claude spelling is accepted as a compat alias; the Nessy name wins
 *   when both are set — the `subagent-spawn-depth.ts` aliased-pair discipline)
 *
 * `env-vars.md:284`, the `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` row: "Cap
 * on the total number of WebSearch calls one session can make (default: 200).
 * When Claude reaches the cap, further WebSearch calls return a notice telling
 * it to continue with the information it already gathered. Accepts a positive
 * whole number with no upper bound. Anything else is ignored and the default
 * applies, so the cap can be raised but not turned off."
 *
 * `tools-reference.md:449-451` § Session search limit: the cap is "counted
 * across the main conversation and every subagent it spawns"; an over-cap call
 * "return[s] a notice telling Claude to continue with the information it
 * already gathered, rather than an error that would invite a retry"; and
 * "Running `/clear` resets the count".
 *
 * ## The parse — and why it is NOT `resolveMaxSubagentSpawnDepth`'s any more
 *
 * These two knobs were kept in lockstep because one `whats-new/2026-w29.md:63`
 * sentence announces both. That was wrong, and `env-vars.md#variables` says so
 * in the paragraph that opens the Variables list: "Numeric variables such as
 * timeouts, token budgets, and retry counts accept scientific notation and
 * digit-separator spellings in addition to plain digits, **except where a
 * variable's row notes it takes plain digits only**. For example, Claude Code
 * reads `2e3` as 2000 and `64_000` as 64000."
 *
 * The spawn-depth row DOES note it ("Accepts a positive whole number in plain
 * digits"). THIS row does not — "Accepts a positive whole number with no upper
 * bound. Anything else is ignored and the default applies" — so the general
 * rule governs here and the strict one governs there. Two documented
 * behaviours, not one; `parseNumericSetting` carries both.
 *
 * "Raised but not turned off" means there is no disable value: `0` is not a
 * legal cap and never means "unlimited", so the reader requires `>= 1`. Unlike
 * `structured-output/retry.ts` there is no ceiling clamp — "no upper bound" is
 * part of the contract. A refused value is now SAID rather than silently
 * swallowed.
 *
 * ## Where the pieces live
 *
 * The counter itself (`createWebSearchBudget`) is consumed by the Pi subprocess
 * (`packages/pi-agent-server/src/index.ts`), ONE instance per process at module
 * scope. The tree-wide half — seeding a child subagent with the parent's used
 * count and folding the child's consumption back — rides the `InitMessage`
 * `webSearchesUsed` seed and the `PiChildStartInput`/`PiChildResult` mirror
 * fields (`agent/pi-harness/child-session-port.ts`).
 */

import { resolveNumericSetting } from './numeric-setting'

export type WebSearchBudgetEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the per-session WebSearch cap. */
export const MAX_WEB_SEARCHES_PER_SESSION_ENV = 'NESSY_MAX_WEB_SEARCHES_PER_SESSION'

/** The documented Claude spelling (`env-vars.md:284`), accepted as a compat alias. */
export const MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV = 'CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION'

/** "(default: 200)" — `env-vars.md:284`, `whats-new/2026-w29.md:63`. */
export const DEFAULT_MAX_WEB_SEARCHES_PER_SESSION = 200

/**
 * The effective per-session WebSearch cap. A malformed value falls back to the
 * documented default ("anything else is ignored") and `0` falls back rather
 * than meaning unlimited ("the cap can be raised but not turned off"). The
 * Nessy name wins when both spellings are set.
 */
export function resolveMaxWebSearchesPerSession(
  env: WebSearchBudgetEnvRecord = process.env,
  write?: (message: string) => void,
): number {
  // Presence decides which name is read, and the SAME choice names the value in
  // the rejection sentence — a report naming the wrong spelling is worse than
  // no report.
  const name = env[MAX_WEB_SEARCHES_PER_SESSION_ENV] !== undefined
    ? MAX_WEB_SEARCHES_PER_SESSION_ENV
    : MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV
  return resolveNumericSetting(name, env[name], DEFAULT_MAX_WEB_SEARCHES_PER_SESSION, { min: 1 }, write)
}

/**
 * The session's WebSearch counter. `used()` is the count charged against
 * `limit` — the process's own consumed calls plus whatever base `seed()` set
 * (the parent tree's count for a subagent, folded child consumption for a
 * parent). `tryConsume()` charges one call and is the ONLY gate: it consumes
 * before the provider is called, so a failed search still spends its call
 * (the doc counts "WebSearch calls", not successes).
 */
export interface WebSearchBudget {
  readonly limit: number
  /** Charge one call. `false` means the cap is reached and nothing was charged. */
  tryConsume(): boolean
  used(): number
  remaining(): number
  /** `tools-reference.md:451` — "/clear resets the count". */
  reset(): void
  /** Set the absolute used count (init seed, or folding a child's consumption). */
  seed(used: number): void
}

export function createWebSearchBudget(limit: number): WebSearchBudget {
  let count = 0
  return {
    limit,
    tryConsume() {
      if (count >= limit) return false
      count += 1
      return true
    },
    used() {
      return count
    },
    remaining() {
      return Math.max(0, limit - count)
    },
    reset() {
      count = 0
    },
    seed(used: number) {
      count = Number.isFinite(used) ? Math.max(0, Math.floor(used)) : 0
    },
  }
}
