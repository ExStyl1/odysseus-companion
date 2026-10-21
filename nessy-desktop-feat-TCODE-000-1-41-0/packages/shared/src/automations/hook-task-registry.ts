/**
 * The `background_tasks` and `session_crons` arrays `Stop` and `SubagentStop`
 * carry (R27c).
 *
 * Contract source, `hooks.md` fetched raw (3169 lines on 2026-07-29):
 * - `:2190` — "Stop hooks receive `stop_hook_active`, `last_assistant_message`,
 *   `background_tasks`, and `session_crons`."
 * - `:2194` — the arrays "let hooks distinguish 'session is done' from 'session
 *   is paused waiting for background work to wake it back up'. Both arrays are
 *   present when the task registry is reachable and are empty when nothing is in
 *   flight or scheduled." Present-and-EMPTY, never absent: a hook that has to
 *   tell "done" from "waiting" reads a missing key as neither.
 * - `:2196`–`:2208` — a `background_tasks` entry: `id`, `type`, `status`,
 *   `description`, plus `command` (shell), `agent_type` (subagent), `server` and
 *   `tool` (monitor and MCP task), `name` (workflow).
 * - `:2201` — `type` is a FRIENDLY label, not an internal discriminant, and
 *   "Falls back to the raw discriminant for unrecognized types".
 * - `:2203` / `:2217` — `description` and `prompt` are "capped at 1000
 *   characters with an in-string `… [+N chars]` marker when clipped". The marker
 *   text is part of the contract; a plain truncation is a different string.
 * - `:2210`–`:2217` — a `session_crons` entry: `id`, `schedule`, `recurring`,
 *   `prompt`.
 * - `:2046` — `SubagentStop` carries both arrays too, "scoped to the parent
 *   session, not the subagent".
 *
 * These live here, next to `SdkAutomationInput`, because they are hook WIRE
 * shape rather than anything a producer owns: the host registry, the cron store
 * and both emitting backends all have to agree on one definition.
 */

/** `:2201` — the documented friendly task-type vocabulary. */
export type BackgroundTaskType =
  | 'shell' | 'subagent' | 'monitor' | 'workflow' | 'teammate' | 'cloud session' | 'MCP task'

/**
 * A friendly label, or the raw discriminant when we do not recognise it
 * (`:2201`). The `& {}` keeps the documented members in autocomplete while
 * still admitting the fallback string.
 */
export type BackgroundTaskTypeLabel = BackgroundTaskType | (string & {})

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** One `background_tasks[]` entry, `:2196`–`:2208`. */
export interface BackgroundTaskEntryV1 {
  readonly id: string
  readonly type: BackgroundTaskTypeLabel
  readonly status: BackgroundTaskStatus
  /** Already capped — see {@link capHookRegistryText}. */
  readonly description: string
  /** Shell entries only (`:2204`). */
  readonly command?: string
  /** Subagent entries only (`:2205`). */
  readonly agent_type?: string
  /** Monitor and MCP-task entries only (`:2206`). */
  readonly server?: string
  /** Monitor and MCP-task entries only (`:2207`). */
  readonly tool?: string
  /** Workflow entries only (`:2208`). */
  readonly name?: string
}

/** One `session_crons[]` entry, `:2210`–`:2217`. */
export interface SessionCronEntryV1 {
  readonly id: string
  readonly schedule: string
  /** `:2216` — `false` for a one-shot, `true` for a task that re-fires. */
  readonly recurring: boolean
  /** Already capped — see {@link capHookRegistryText}. */
  readonly prompt: string
}

/** `:2203`, `:2204`, `:2217` — one cap, shared by `description`, `command` and `prompt`. */
export const HOOK_REGISTRY_TEXT_CAP = 1000

/**
 * Cap a payload string at 1000 characters with the documented in-string
 * `… [+N chars]` marker, where N counts the characters the cap dropped.
 *
 * The marker's length depends on N and N depends on the marker's length, so this
 * settles the pair by fixed point rather than guessing a width. Idempotent: a
 * string already at the cap comes back unchanged.
 */
export function capHookRegistryText(value: string): string {
  if (value.length <= HOOK_REGISTRY_TEXT_CAP) return value
  let dropped = value.length - HOOK_REGISTRY_TEXT_CAP
  for (let pass = 0; pass < 8; pass += 1) {
    const marker = `… [+${dropped} chars]`
    const keep = HOOK_REGISTRY_TEXT_CAP - marker.length
    const nextDropped = value.length - keep
    if (nextDropped === dropped) return `${value.slice(0, keep)}${marker}`
    dropped = nextDropped
  }
  const marker = `… [+${dropped} chars]`
  return `${value.slice(0, HOOK_REGISTRY_TEXT_CAP - marker.length)}${marker}`
}

/**
 * Our internal discriminants, mapped onto `:2201`'s friendly vocabulary. Keys
 * are every raw value a Nessy producer can hand us: the supervisor's
 * `semanticId`s, the Pi background-evaluator kinds, and the friendly labels
 * themselves (so a caller that already speaks the vocabulary is a no-op).
 */
const FRIENDLY_BACKGROUND_TASK_TYPES: Readonly<Record<string, BackgroundTaskType>> = Object.freeze({
  bash_background: 'shell',
  shell: 'shell',
  bash: 'shell',
  monitor: 'monitor',
  subagent: 'subagent',
  child_session: 'subagent',
  workflow: 'workflow',
  teammate: 'teammate',
  cloud_session: 'cloud session',
  'cloud session': 'cloud session',
  mcp: 'MCP task',
  mcp_task: 'MCP task',
  'MCP task': 'MCP task',
})

/**
 * `:2201` — the friendly label for a raw discriminant, "falls back to the raw
 * discriminant for unrecognized types". Falling back is deliberate: dropping the
 * entry would under-report what the session is waiting on, and forcing it into a
 * documented label would mislabel it.
 */
export function friendlyBackgroundTaskType(raw: string): BackgroundTaskTypeLabel {
  return FRIENDLY_BACKGROUND_TASK_TYPES[raw] ?? raw
}

/**
 * The host's synchronous reader for both arrays.
 *
 * Synchronous on purpose. `Stop` is emitted from a `finally` that also orders
 * `SessionEnd` behind it, and `emitAutomationEvent` orders by CALL, not by
 * completion — an `await` between the two would let `SessionEnd` overtake
 * `Stop`. Every underlying source (the monitor registry, the session map, the
 * cron store's file read) is already synchronous, so nothing is lost.
 *
 * Presence of the port IS `:2194`'s "the task registry is reachable": when it is
 * wired the arrays are always emitted, empty when nothing is in flight.
 */
export interface HookTaskRegistryPort {
  backgroundTasks(): readonly BackgroundTaskEntryV1[]
  sessionCrons(): readonly SessionCronEntryV1[]
}

/** The two array keys, as they appear on a `Stop` / `SubagentStop` payload. */
export interface HookTaskRegistryInput {
  background_tasks?: readonly BackgroundTaskEntryV1[]
  session_crons?: readonly SessionCronEntryV1[]
}

/**
 * Build both array keys for a `Stop` or `SubagentStop` payload.
 *
 * The parameter is named `parent` because that is the whole contract on
 * `SubagentStop`: `:2046` — "Both arrays are scoped to the parent session, not
 * the subagent." Handing this a child's registry would report the child's empty
 * maps as the session's state, telling a hook "nothing is in flight" at the
 * exact moment the parent may still be waiting on siblings — worse than
 * omitting the field, because it is confidently wrong. Naming it here makes the
 * scoping a testable contract rather than an argument choice at each call site.
 *
 * An absent port is `:2194`'s "the task registry is [not] reachable" — the only
 * case where the keys are missing rather than present and empty.
 */
export function hookTaskRegistryInput(parent: HookTaskRegistryPort | undefined): HookTaskRegistryInput {
  if (!parent) return {}
  return { background_tasks: parent.backgroundTasks(), session_crons: parent.sessionCrons() }
}
