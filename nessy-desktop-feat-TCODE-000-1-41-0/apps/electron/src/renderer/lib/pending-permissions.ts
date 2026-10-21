import type { PermissionRequest } from '../../shared/types'

/**
 * Where a pending permission prompt is FILED in the renderer, and how it is
 * taken back out.
 *
 * `sub-agents.md:1043`/`:770` — a subagent's prompt has to reach the human
 * watching the main session. A child session is hidden and cannot be opened, so
 * filing its prompt under its own session id put it where nothing renders it
 * and the child stalled until its deadline. The server names the visible
 * ancestor on the request; the prompt is filed there, while `request.sessionId`
 * stays the child's because that is what the answer is validated against.
 *
 * Removal is therefore by REQUEST ID rather than by position under a session
 * key: the surface key and the answer key differ for exactly these prompts, and
 * a positional removal would leave an answered prompt on screen.
 */
export type PendingPermissionMap = ReadonlyMap<string, PermissionRequest[]>

export function permissionSurfaceSessionId(request: PermissionRequest, eventSessionId: string): string {
  return request.parentSessionId ?? eventSessionId
}

export function addPendingPermission(
  current: PendingPermissionMap,
  request: PermissionRequest,
  eventSessionId: string,
): Map<string, PermissionRequest[]> {
  const surfaceSessionId = permissionSurfaceSessionId(request, eventSessionId)
  const next = new Map(current)
  next.set(surfaceSessionId, [...(next.get(surfaceSessionId) ?? []), request])
  return next
}

export function removePendingPermission(
  current: PendingPermissionMap,
  requestId: string,
): PendingPermissionMap {
  let changed = false
  const next = new Map(current)
  for (const [sessionId, queue] of current) {
    if (!queue.some(request => request.requestId === requestId)) continue
    changed = true
    const remaining = queue.filter(request => request.requestId !== requestId)
    if (remaining.length === 0) next.delete(sessionId)
    else next.set(sessionId, remaining)
  }
  return changed ? next : current
}

/**
 * F1.900 — what a TURN'S END does to the cards filed under `sessionId`: a turn
 * that COMPLETES takes none of them; a card leaves when it is answered
 * ({@link removePendingPermission}, from `handleRespondToPermission`) or when
 * the host withdraws it (`permission_request_cancelled`: F1.527's 540 s expiry,
 * F1.524/F1.541's Stop Task, F1.186's host-card release, a runtime teardown).
 * Until F1.900 every `complete` also dropped the session's whole queue, and
 * that erased cards the host was still waiting on — measured on the packaged RC
 * (SIT-ad FAILS 2, SIT-ac FAILS 1): a claude background subagent's card left
 * the DOM when the parent turn ended, and again when a later turn ended, while
 * the host kept the record (`awaitingApprovalCount` 1, `pendingApproval`
 * persisted) and never re-fires a record it holds live
 * (`reprojectPendingApproval` is a restart path). A card that outlives its turn
 * is a design, not a leak: a background subagent outlives parent turns
 * (P6.793), the host keeps a between-turn card through every later turn's end
 * (F1.401), and the archive and reopen cards are raised with no turn at all.
 *
 * F1.911 — what a STOP (`interrupted`) takes, now that the host names what it
 * keeps. The Stop's clear used to drop the session's whole queue, which hid
 * cards the host still held and counted: a between-turn host card (the archive
 * worktree card, the cross-session dialog, the composer `!` card), a card a
 * person raised (the preview Publish, the Share — UA12.53), a host consent on
 * the Pi seam (worktree setup / cleanup, reopen compact), a Pi tool card raised
 * while no turn ran, and a hidden Pi child's card filed here. The `interrupted`
 * event now carries `retainedPermissionRequestIds` — the ids the host still
 * holds that surface on the session, collected after the turn's own cards were
 * withdrawn — and this rule keeps exactly those, dropping the rest. The cards
 * the turn itself raised are absent from that list because the host withdrew
 * them before it was computed (`releaseTurnBoundHostCards`,
 * `withdrawStoppedTurnPiToolCards`), so a stopped turn still clears its own.
 * The ids are optional: a host that names nothing (an older host, or nothing
 * held) clears the queue, which is the pre-F1.911 shape and still right when
 * the list is honest about being empty. An `error` completion clears nothing;
 * a card whose resolver died with such a turn stays until clicked, and the
 * click removes it (the answer path drops it by id whether or not the host
 * accepted it).
 */
export function pendingPermissionsAtTurnEnd(
  current: PendingPermissionMap,
  sessionId: string,
  ending: 'complete' | 'interrupted',
  retainedIds?: readonly string[],
): PendingPermissionMap {
  if (ending !== 'interrupted' || !current.has(sessionId)) return current
  const retained = retainedIds === undefined ? undefined : new Set(retainedIds)
  const queue = current.get(sessionId)!
  const kept = retained === undefined ? [] : queue.filter(request => retained.has(request.requestId))
  if (kept.length === queue.length) return current
  const next = new Map(current)
  if (kept.length === 0) next.delete(sessionId)
  else next.set(sessionId, kept)
  return next
}

/**
 * UA12.25 — a window that LOADS after a host card was raised (a reload, a second window) never saw
 * the original `permission_request` event, and until now nothing re-filed it: the card was gone
 * although the server still held the request. The session list now carries the still-pending host
 * cards (`Session.pendingHostCardRequests`, filled from the live pending-request map); this files
 * them exactly where the live event would, skipping every requestId the map already holds — the
 * list is also fetched on refreshes, and a card the user is answering must not stack a second
 * copy. Returns `current` unchanged when there is nothing to file.
 */
export function rehydratePendingHostCards(
  current: PendingPermissionMap,
  sessions: ReadonlyArray<{ id: string; pendingHostCardRequests?: ReadonlyArray<PermissionRequest> }>,
): PendingPermissionMap {
  const seen = new Set<string>()
  for (const queue of current.values()) {
    for (const request of queue) seen.add(request.requestId)
  }
  let next: Map<string, PermissionRequest[]> | null = null
  for (const session of sessions) {
    for (const request of session.pendingHostCardRequests ?? []) {
      if (seen.has(request.requestId)) continue
      if (!next) next = new Map(current)
      const surfaceSessionId = permissionSurfaceSessionId(request, session.id)
      next.set(surfaceSessionId, [...(next.get(surfaceSessionId) ?? []), request])
      seen.add(request.requestId)
    }
  }
  return next ?? current
}
