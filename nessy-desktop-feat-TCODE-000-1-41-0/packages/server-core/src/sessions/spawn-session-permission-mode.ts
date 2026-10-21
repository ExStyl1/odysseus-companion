/**
 * F1.549 (origin WJ-ba P-WJ-ba-3, LOW, DECIDED 2026-09-24) — the permission mode a session started by
 * `spawn_session` runs in is never wider than the mode of the session that started it.
 *
 * `onSpawnSession` used to hand the model-supplied `permissionMode` straight to `createSession`, so a `default`
 * parent could start a `bypassPermissions` child: nothing bounded it, and since F1.537 the parent's `spawn_session`
 * card is the only guard on every runtime — while a `bypassPermissions` or headless parent raises no card at all.
 * Subagents were already bounded by exactly this rule (`clampPermissionModeToParent`, the one ranking over
 * `PERMISSION_MODE_ORDER`, with the `plan`/`explore` write-axis carve-out), so the decision is to reuse it rather
 * than to state the gap: a spawned session is a child the parent's mode never authorised to be wider.
 *
 * - No requested mode keeps today's behaviour: the child inherits the parent's mode verbatim.
 * - A requested mode is alias-resolved first (a model may still write `allow-all` or `safe`), then clamped. An
 *   unrecognised value never widens: it resolves to the parent's mode, as the clamp itself does.
 * - Narrowing is always allowed (a `bypassPermissions` parent may start a `default` child).
 * - A parent with no recorded mode is `default`, the same floor the subagent clamp uses.
 *
 * What was narrowed is reported back (`narrowedFrom`) so the host can say so IN THE CHILD — the owner's
 * "visible note": a user opening the spawned session sees why it is not in the mode the agent asked for.
 */
import { clampPermissionModeToParent, parsePermissionMode, type PermissionMode } from '@nessy-agent/shared/agent'

export interface SpawnedSessionPermissionMode {
  /** The mode the child is created in; `undefined` only when neither side has one (the store's default applies). */
  mode: PermissionMode | undefined
  /** The mode the agent asked for, when the clamp changed it. */
  narrowedFrom?: string
}

export function resolveSpawnedSessionPermissionMode(
  requested: string | undefined,
  parent: PermissionMode | undefined,
): SpawnedSessionPermissionMode {
  if (requested === undefined) return { mode: parent }
  const parentMode = parent ?? 'default'
  const requestedMode = parsePermissionMode(requested)
  const mode = requestedMode ? clampPermissionModeToParent(requestedMode, parentMode) : parentMode
  return mode === requestedMode ? { mode } : { mode, narrowedFrom: requested }
}

/** The child's transcript note for a narrowed mode (host text, like every other session notice). */
export function spawnedSessionModeNarrowedNote(narrowedFrom: string, mode: PermissionMode, parentName: string): string {
  return `This session was started by the agent in "${parentName}" and asked for the "${narrowedFrom}" permission mode.`
    + ` It runs in "${mode}" instead: a session the agent starts is never more permissive than the session that`
    + ' started it. Change the mode here yourself if you want more.'
}
