/**
 * The two subagent limits that are NOT the nesting depth: how many subagents may
 * run at once, and how much of one subagent's report reaches the parent.
 *
 * Claude env names map to ours, the way `background-task-settings.ts` records
 * its family (the Nessy name wins when both spellings are set — the
 * `subagent-spawn-depth.ts` aliased-pair discipline):
 *
 * - `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` → `NESSY_MAX_CONCURRENT_SUBAGENTS`
 * - `TASK_MAX_OUTPUT_LENGTH`               → `NESSY_TASK_MAX_OUTPUT_LENGTH`
 *
 * ## The concurrency ceiling, and why this module also owns the memory bound
 *
 * `sub-agents.md:898`: "By default, when 20 subagents are running in a session,
 * spawning another with the Agent tool fails with `Concurrent subagent limit
 * reached`, and the error tells Claude not to retry. Spawning succeeds again
 * when the running count drops below the limit. To change the limit, set
 * `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` to any positive whole number. Sessions
 * with ultracode active are exempt: the limit isn't enforced there."
 *
 * `env-vars.md:277` adds the parse contract: "Accepts a positive whole number in
 * plain digits; anything else is ignored, so the variable can adjust the cap but
 * can't disable it."
 *
 * THREE gates sit on one Agent-tool spawn, and only one of them may ever speak.
 * A Claude Code subagent is another context window inside one process; ours is a
 * whole Pi subprocess at roughly a gibibyte, so the host additionally bounds how
 * many agent runtimes may be live at once ({@link hostLiveAgentCeiling}, the
 * formula `server-core/src/sessions/live-agent-ceiling.ts` enforces). On a 16 GiB
 * laptop that bound is 8. Ship the documented 20 without reconciling the two and
 * the ninth subagent is refused by the MEMORY gate, asynchronously, with
 * `live-agent-ceiling-reached` — a differently-worded refusal at 8, which is the
 * inverse of the finding. So the reconciliation lives here, in one place both
 * sides read:
 *
 * - {@link maxConcurrentSubagents} is the documented ceiling, narrowed by the
 *   machine when it is left at its default. It is the ONLY gate that refuses an
 *   Agent-tool spawn, and it refuses with the documented message.
 * - {@link resolveLiveAgentCeilingFor} is the host's memory bound, RAISED to stay
 *   strictly above the subagent ceiling. The invariant
 *   `maxConcurrentSubagents() < resolveLiveAgentCeilingFor()` is what makes the
 *   memory gate structurally unable to speak first for a subagent child.
 * - {@link childSessionConcurrencyBackstop} is the host's durable per-parent
 *   backstop (`child-session-service.ts`'s `child-session-concurrency-limit`),
 *   sized above every legitimate scope mix so it is a runaway detector rather
 *   than a second ceiling.
 *
 * Both sides compute from the same two inputs — the environment and
 * `os.totalmem()` — and the Pi subprocess runs on the same machine as its host,
 * so the numbers agree with no manifest field, no wire change and therefore no
 * execution-manifest hash movement.
 *
 * An EXPLICIT `NESSY_MAX_CONCURRENT_SUBAGENTS` wins outright over the memory
 * narrowing, and the host's live-agent ceiling rises to follow it. That is the
 * only shape in which the documented knob is not inert: an operator who asks for
 * 40 concurrent subagents on a small machine is choosing to hold 41 runtimes,
 * and the refusal they eventually get is still the documented one.
 */

import { totalmem } from 'node:os'

export type SubagentLimitsEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the concurrent-subagent ceiling. */
export const MAX_CONCURRENT_SUBAGENTS_ENV = 'NESSY_MAX_CONCURRENT_SUBAGENTS'

/** The documented Claude spelling (`env-vars.md:277`), accepted as a compat alias. */
export const MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'

/** "(default: 20)" — `sub-agents.md:898`, `env-vars.md:277`. */
export const MAX_CONCURRENT_SUBAGENTS_DEFAULT = 20

/** The Nessy spelling of the subagent output cap. */
export const TASK_MAX_OUTPUT_LENGTH_ENV = 'NESSY_TASK_MAX_OUTPUT_LENGTH'

/** The documented Claude spelling (`env-vars.md:428`), accepted as a compat alias. */
export const TASK_MAX_OUTPUT_LENGTH_COMPAT_ENV = 'TASK_MAX_OUTPUT_LENGTH'

/** "(default: 32000, …)" — `env-vars.md:428`. CHARACTERS, not bytes. */
export const TASK_MAX_OUTPUT_CHARS_DEFAULT = 32_000

/** "…, maximum: 160000)" — `env-vars.md:428`. */
export const TASK_MAX_OUTPUT_CHARS_MAX = 160_000

/**
 * One agent runtime per 2 GiB of installed memory — the number
 * `server-core/src/sessions/live-agent-ceiling.ts` was built around, moved here
 * so the subprocess can compute the same bound without importing server-core.
 */
export const LIVE_AGENT_BYTES_PER_RUNTIME = 2 * 1024 ** 3

/**
 * The floor is not cosmetic: a session that spawns a child needs two live agents
 * at once, so a ceiling of 1 would make subagents impossible on a small host.
 */
export const LIVE_AGENT_CEILING_FLOOR = 2

/**
 * Slack the host's per-parent backstop carries above the two scoped ceilings, for
 * the children no scoped ceiling counts: the review judge and the guardian judge
 * (`limitScope: 'internal'`), which can overlap when a turn issues parallel tool
 * calls. Four is deliberately generous — the backstop exists to catch a runaway,
 * not to be a third ceiling.
 */
export const INTERNAL_CHILD_HEADROOM = 4

/** `/^\d+$/` after trim: the documented "positive whole number in plain digits". */
function parsePlainPositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * How many agent runtimes this machine may hold at once, from installed memory.
 * The formula `defaultLiveAgentCeiling` has always used; this is now its one
 * definition, so the subprocess and the host cannot drift.
 */
export function hostLiveAgentCeiling(totalMemoryBytes: number = totalmem()): number {
  return Math.max(LIVE_AGENT_CEILING_FLOOR, Math.floor(totalMemoryBytes / LIVE_AGENT_BYTES_PER_RUNTIME))
}

/**
 * The operator's explicit ceiling, or `undefined` when none was set. Malformed
 * values are ignored ("anything else is ignored") and `0` is not a disable value
 * ("can adjust the cap but can't disable it"), so both fall back to `undefined`
 * and therefore to the narrowed default.
 */
export function declaredMaxConcurrentSubagents(
  env: SubagentLimitsEnvRecord = process.env,
): number | undefined {
  const raw = env[MAX_CONCURRENT_SUBAGENTS_ENV] !== undefined
    ? env[MAX_CONCURRENT_SUBAGENTS_ENV]
    : env[MAX_CONCURRENT_SUBAGENTS_COMPAT_ENV]
  return parsePlainPositiveInteger(raw)
}

/**
 * The effective concurrent-subagent ceiling — the number the documented refusal
 * names, and the ONLY number that refuses an Agent-tool spawn.
 *
 * Unset: the documented 20, narrowed to `hostLiveAgentCeiling - 1` so the
 * parent's own runtime still fits under the memory bound and the memory gate
 * cannot speak first. 20 is therefore what a user observes from ~42 GiB of RAM
 * upward, 7 on a 16 GiB laptop, 3 on an 8 GiB one — always with the documented
 * message and always naming the number actually in force.
 *
 * Set: the operator's number verbatim, memory narrowing skipped — see the module
 * note. {@link resolveLiveAgentCeilingFor} follows it up so the invariant holds.
 */
export function maxConcurrentSubagents(
  env: SubagentLimitsEnvRecord = process.env,
  totalMemoryBytes: number = totalmem(),
): number {
  const declared = declaredMaxConcurrentSubagents(env)
  if (declared !== undefined) return declared
  return Math.max(1, Math.min(MAX_CONCURRENT_SUBAGENTS_DEFAULT, hostLiveAgentCeiling(totalMemoryBytes) - 1))
}

/**
 * The host's live-agent ceiling: the memory bound, or one more than the subagent
 * ceiling when an operator raised that above it. INVARIANT, and the whole point
 * of this function:
 * `maxConcurrentSubagents(env, mem) < resolveLiveAgentCeilingFor(env, mem)`.
 */
export function resolveLiveAgentCeilingFor(
  env: SubagentLimitsEnvRecord = process.env,
  totalMemoryBytes: number = totalmem(),
): number {
  return Math.max(hostLiveAgentCeiling(totalMemoryBytes), maxConcurrentSubagents(env, totalMemoryBytes) + 1)
}

/**
 * The host's per-parent child backstop (`PiChildStartInput.budgets.concurrency`).
 *
 * `child-session-service.ts` counts EVERY starting/running child of one parent
 * against this single number, whatever scope spawned it — so it cannot be either
 * scoped ceiling without refusing the other scope's spawns. Sized as the sum of
 * both ceilings plus {@link INTERNAL_CHILD_HEADROOM}, which is what keeps it a
 * backstop: it is strictly above every legitimate mix, so it never speaks before
 * the scoped gate that owns the decision, and `sub-agents.md:902`'s "[a fork] is
 * never blocked by the limit" holds through it as well as through the spawner.
 */
export function childSessionConcurrencyBackstop(input: {
  subagentCeiling: number
  workflowCeiling: number
}): number {
  return Math.max(1, input.subagentCeiling) + Math.max(1, input.workflowCeiling) + INTERNAL_CHILD_HEADROOM
}

/**
 * The documented refusal. `sub-agents.md:898` fixes the leading sentence
 * (`Concurrent subagent limit reached`) and requires that "the error tells Claude
 * not to retry"; the rest is ours.
 */
export function concurrentSubagentLimitMessage(limit: number): string {
  return `Concurrent subagent limit reached: ${limit} subagents are already running in this session. `
    + 'Do not retry — wait for a running subagent to finish, or do the work directly.'
}

/**
 * The per-subagent output cap, in CHARACTERS.
 *
 * `env-vars.md:428`: "Maximum number of characters in subagent output before
 * truncation (default: 32000, maximum: 160000). When truncated, the full output
 * is saved to disk and the path is included in the truncated response."
 *
 * Characters, not UTF-8 bytes: a byte cap cuts Cyrillic — this fork's primary
 * locale — at roughly half the documented budget, and CJK worse. A value above
 * the documented maximum is CLAMPED rather than ignored, because the maximum is
 * part of the same sentence as the default; a malformed or non-positive value
 * falls back to the default.
 */
export function resolveTaskMaxOutputChars(
  env: SubagentLimitsEnvRecord = process.env,
): number {
  const raw = env[TASK_MAX_OUTPUT_LENGTH_ENV] !== undefined
    ? env[TASK_MAX_OUTPUT_LENGTH_ENV]
    : env[TASK_MAX_OUTPUT_LENGTH_COMPAT_ENV]
  const value = parsePlainPositiveInteger(raw)
  if (value === undefined) return TASK_MAX_OUTPUT_CHARS_DEFAULT
  return Math.min(value, TASK_MAX_OUTPUT_CHARS_MAX)
}
