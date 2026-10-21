/**
 * The `background_tasks` / `session_crons` projection for one session
 * (R27c, `hooks.md:2196`–`:2217`).
 *
 * Pure on purpose. `SessionManager` owns which session's maps go in; everything
 * about WHAT the documented entry looks like — the merge order, the dedupe, the
 * friendly type, the 1000-character cap — is decided here, where it can be
 * tested without standing up a session.
 */

import {
  capHookRegistryText,
  friendlyBackgroundTaskType,
  type BackgroundTaskEntryV1,
  type SessionCronEntryV1,
} from '@nessy-agent/shared/automations'

/** A child-session record narrowed to what a `subagent` entry needs. */
export interface ProjectableChildSession {
  readonly agentId: string
  /** Present for a backgrounded child; the SAME id the evaluator kind map uses. */
  readonly backgroundTaskId?: string
  readonly agent: string
  readonly task: string
  readonly status: string
}

export interface BackgroundTaskSources {
  /** Monitor entries, already in the documented shape. */
  readonly monitors: readonly BackgroundTaskEntryV1[]
  readonly children: readonly ProjectableChildSession[]
  /** Host-observed Pi background evaluators: task id -> raw kind discriminant. */
  readonly evaluatorKinds: Iterable<readonly [string, string]>
  /** Free-text summaries for evaluator tasks, when the host has one. */
  readonly evaluatorSummaries?: ReadonlyMap<string, { readonly summary: string }>
  /**
   * Supervised background shells this session owns: handle -> command line.
   *
   * A pair rather than a bare handle because `:2204`'s `command` is the audit
   * datum a fleet Stop hook logs or blocks on, and a handle is not one — see
   * {@link projectBackgroundTasks}.
   */
  readonly shells: Iterable<readonly [handle: string, command: string]>
}

/** Child statuses that still count as in flight. */
const IN_FLIGHT_CHILD_STATUSES: ReadonlySet<string> = new Set(['starting', 'running'])

/**
 * Merge every producer into one `background_tasks[]`.
 *
 * Four producers write into one registry, so entries are deduplicated by `id`
 * in decreasing order of how much each source knows:
 *
 * 1. monitors — the service already built the documented entry, `server`/`tool`
 *    and capped description included;
 * 2. child sessions — the only source carrying `agent_type` (`:2205`) and a real
 *    description, keyed by the same `backgroundTaskId` the evaluator map uses so
 *    a backgrounded subagent is not reported twice under two labels;
 * 3. Pi background evaluators — a raw kind and nothing else;
 * 4. background shells.
 *
 * `name` (`:2208`) is absent throughout: no host structure holds a workflow
 * name.
 *
 * `command` (`:2204`, "Shell command line, capped at 1000 characters. Present
 * only for `shell` tasks") is emitted for shell entries and NOTHING else — a
 * subagent or monitor entry that carried one would be reporting a field the
 * contract scopes to shells. It is the command VERBATIM, capped by the same
 * `capHookRegistryText` every other capped field uses, and deliberately not
 * redacted: the identical string is already persisted verbatim in the
 * transcript (`Message.toolInput.command`, which only relativises paths) and is
 * already handed to every `PreToolUse` hook as `tool_input`. A hook process that
 * sees the raw command at PreToolUse and a masked one at Stop would be two
 * answers for one string — the drift this projection exists to prevent, not a
 * safeguard. Whoever may run hooks may already read the transcript.
 */
export function projectBackgroundTasks(sources: BackgroundTaskSources): readonly BackgroundTaskEntryV1[] {
  const entries: BackgroundTaskEntryV1[] = []
  const seen = new Set<string>()
  const add = (entry: BackgroundTaskEntryV1): void => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    entries.push(Object.freeze(entry))
  }

  for (const monitor of sources.monitors) add(monitor)

  for (const child of sources.children) {
    if (!IN_FLIGHT_CHILD_STATUSES.has(child.status)) continue
    add({
      id: child.backgroundTaskId ?? child.agentId,
      type: 'subagent',
      status: 'running',
      description: capHookRegistryText(child.task),
      agent_type: child.agent,
    })
  }

  for (const [taskId, kind] of sources.evaluatorKinds) {
    add({
      id: taskId,
      // `:2201` — a raw discriminant we do not recognise survives as itself
      // rather than being dropped or forced into a documented label.
      type: friendlyBackgroundTaskType(kind),
      status: 'running',
      description: capHookRegistryText(sources.evaluatorSummaries?.get(taskId)?.summary ?? taskId),
    })
  }

  for (const [handle, command] of sources.shells) {
    // `description` stays the handle when nothing better exists: it is what
    // `process_stop` and `process_read` are keyed on, so a hook that decides to
    // act needs it in the entry it is looking at.
    add({
      id: handle,
      type: 'shell',
      status: 'running',
      description: capHookRegistryText(command || handle),
      ...(command ? { command: capHookRegistryText(command) } : {}),
    })
  }

  return Object.freeze(entries)
}

/**
 * `:2210` — the cron store already persists exactly `id`, `schedule`,
 * `recurring` and `prompt`, so this is a field selection rather than a
 * translation. Only `prompt` needs work: `:2217` caps it at 1000 characters
 * with the same `… [+N chars]` marker.
 */
export function projectSessionCrons(
  records: readonly { readonly id: string; readonly schedule: string; readonly recurring: boolean; readonly prompt: string }[],
): readonly SessionCronEntryV1[] {
  return Object.freeze(records.map(record => Object.freeze({
    id: record.id,
    schedule: record.schedule,
    recurring: record.recurring,
    prompt: capHookRegistryText(record.prompt),
  })))
}
