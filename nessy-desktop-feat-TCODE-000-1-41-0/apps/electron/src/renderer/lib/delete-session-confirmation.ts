/**
 * UA1.26 follow-up (O18) — when a session delete asks first.
 *
 * Since UA1.25 the session delete no longer revokes a shared chat's link on its own: the host-built delete
 * confirmation (`SHOW_DELETE_SESSION_CONFIRMATION`, server-core `handlers/rpc/auth.ts`) asks a SHARED chat
 * "Delete, keep the link / Delete and stop sharing" and revokes that chat's link on the second answer. So every
 * renderer delete path asks for a shared chat, including the paths that otherwise skip the question:
 * - a batch delete's 2nd..n chats (`BatchSessionMenu` confirms only the first and passes `skipConfirmation`);
 * - the `delete-session` deep link (`NavigationContext`; upstream deletes without a dialog, and still does here for an
 *   unshared chat).
 * DECIDED (simple, transparent): one question per shared chat on the existing host dialog and its boolean answer, so
 * "Delete and stop sharing" revokes exactly the chat it names; no batch-wide variant of the channel.
 */
import type { SessionMeta } from '@/atoms/sessions'

export type DeleteConfirmationMeta = Pick<SessionMeta, 'name' | 'lastFinalMessageId' | 'sharedUrl'>

/**
 * Whether deleting this session shows the host confirmation. A shared chat always does (its link outlives the
 * delete); otherwise a skipped confirmation stays skipped, and an empty session (no lastFinalMessageId — no assistant
 * response — and no name, set on the first user message) is deleted without one.
 */
export function deleteNeedsConfirmation(meta: DeleteConfirmationMeta | undefined, skipConfirmation: boolean): boolean {
  if (meta?.sharedUrl) return true
  if (skipConfirmation) return false
  return !!meta && (!!meta.lastFinalMessageId || !!meta.name)
}

/**
 * The batch delete: the first session is confirmed as before (a cancel there deletes nothing and answers `null`); the
 * rest pass `skipConfirmation`, which `deleteNeedsConfirmation` still overrides for a shared chat — a cancel on one of
 * those keeps that chat only. Answers how many sessions were deleted.
 */
export async function deleteSessionsInBatch(
  ids: readonly string[],
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>,
): Promise<number | null> {
  if (ids.length === 0) return 0
  if (!(await onDeleteSession(ids[0]!))) return null
  let deleted = 1
  for (let i = 1; i < ids.length; i++) {
    if (await onDeleteSession(ids[i]!, true)) deleted++
  }
  return deleted
}
