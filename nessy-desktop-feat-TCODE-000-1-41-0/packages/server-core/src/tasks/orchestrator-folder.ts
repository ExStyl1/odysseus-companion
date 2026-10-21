/**
 * UA3.8 — which task folder goes with a deleted session (OQ-13; spec §10 "Lifecycle"). NESSY: upstream v0.13.4 never
 * removes `tasks/<slug>/` (no `deleteTaskFolder`, no `tasks:delete`), so a deleted orchestrator left its spec and run
 * logs behind and a later create of the same slug met them.
 *
 * ONE predicate, read by the two places that must agree: `SessionManager.deleteSession` (the cascade) and the delete
 * confirmation dialog (`auth:showDeleteSessionConfirmation`, which names the folder). The rule:
 * - only an ORCHESTRATOR takes its folder: a session carrying `taskSlug` with no `taskNodeId` (a Conductor child node
 *   carries both, and deleting a node touches nothing);
 * - only when no OTHER non-archived session carries the slug (two sessions sharing a slug keep the folder). A live
 *   Conductor child node carries the slug too, so while one exists the folder (whose run logs it belongs to) stays —
 *   the spec's rule read literally, on the side that keeps data;
 * - archiving never removes anything (OQ-13) — this predicate is read on delete only.
 *
 * DECIDED (the controller's hand-back, "what an archived orchestrator's dangling taskSlug means"): an ARCHIVED carrier
 * does not keep the folder — the same rule `tasks:delete` already applies (`task-slug-in-use` counts live carriers
 * only) — and its `taskSlug` is left as it is: it records what that session orchestrated, and its tile reads the spec
 * as missing (`tasks:get` answers "not found" without throwing). Residue, stated: the slug is free again
 * (`takenTaskSlugs` counts live carriers only), so a later task may take it. UA12.48 + UA12.174 closed the unarchive
 * half: `SessionManager.unarchiveSession` drops an unarchived ORCHESTRATOR's slug when another live ORCHESTRATOR
 * ({@link isTaskOrchestrator}) carries it; a Conductor child node is never stripped and never counts as the competitor.
 * Residue: an orchestrator unarchived while the new task's only live carriers are child nodes keeps and shares the slug.
 */

export interface TaskCarrier {
  id: string
  taskSlug?: string
  taskNodeId?: string
  isArchived?: boolean
}

/** A task orchestrator: it carries a slug and is not a Conductor child node. */
export function isTaskOrchestrator(session: Pick<TaskCarrier, 'taskSlug' | 'taskNodeId'>): boolean {
  return typeof session.taskSlug === 'string' && session.taskSlug.length > 0 && !session.taskNodeId
}

/**
 * The slug whose `tasks/<slug>/` is removed when `sessionId` is deleted, or `null` when nothing is: the session is
 * not an orchestrator, or another non-archived session of the workspace carries the same slug.
 */
export function taskFolderDeletedWith(sessions: readonly TaskCarrier[], sessionId: string): string | null {
  const target = sessions.find(session => session.id === sessionId)
  if (!target || !isTaskOrchestrator(target)) return null
  const shared = sessions.some(session => session.id !== sessionId && !session.isArchived && session.taskSlug === target.taskSlug)
  return shared ? null : target.taskSlug!
}
