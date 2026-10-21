/**
 * P6.546 — an archived chat that is still waiting for an answer says so, once,
 * where the user actually is.
 *
 * ## The gap this closes, and the half that was already closed
 *
 * `SessionManager.offerWorktreeCleanupOnClose` posts the keep-or-remove card
 * INTO the session being archived and does not await it — which is right: the
 * archive is the user's instruction and must not wait on an answer to a
 * different question. `41000700a` made the card come back when the archived
 * chat is opened again. What stayed open is the user who archives from the
 * sidebar and never opens that chat again: the offer waits somewhere they are
 * not, and the worktree is kept silently. Nothing regressed — nothing asked.
 *
 * ## Why this reads the PENDING PERMISSION MAP and not a worktree field
 *
 * The renderer has no per-session "holds a worktree lease" signal — measured at
 * HEAD, `worktree` appears nowhere in `App.tsx` and the `Session` DTO carries no
 * such field. Inventing one would mean the wire type and `SessionManager`, and
 * would say less than what is already in the renderer's hands: the keep-or-remove
 * card is raised through the ordinary approval band
 * (`requestPiToolApproval` → `handleAgentPermissionRequest`), so it arrives in
 * `App.tsx`'s own `pendingPermissions` map, keyed by session, like every other
 * prompt.
 *
 * ## P6.763 — the map ALONE was the defect, and the union is the fix
 *
 * The paragraph above still holds for what the notice MEANS; what it got wrong
 * was the source. `pendingPermissions` is per WINDOW and per CONNECTION: it
 * holds what this renderer was told about while it was listening. A card raised
 * before the app started — which is precisely the archive-and-quit case this
 * notice exists for — is in no window's map, so the notice that was written for
 * the user who never reopens the chat was invisible to the user who also
 * restarted.
 *
 * The signal now exists and is not ours to invent: the server has published
 * `awaitingApprovalCount` on every Session DTO since F15, derived at read time
 * from `SessionManager`'s live pending-request map, and P6.757 taught this
 * renderer to read it. So this reads the SAME union the sidebar badge reads,
 * through the same predicate ({@link sessionAwaitsApproval}) rather than a
 * second copy of it — the two surfaces cannot disagree about whether a session
 * is waiting on a human, which is the divergence P6.757 closed one layer up.
 *
 * The local map stays in the union rather than becoming a fallback, for
 * P6.757's measured reason: nothing emits a Session DTO when a permission
 * request is raised, so a meta in hand can legitimately say 0 while this window
 * holds a live card.
 *
 * The consequence is stated rather than hidden: this notice is about an
 * unanswered QUESTION, not specifically about a worktree, because that is what
 * the map means. The copy is written to match — it explains that closing a chat
 * holding a worktree is what raises such a question, without CLAIMING that this
 * particular one is that. A notice that named the worktree unconditionally would
 * be a claim the data does not carry, and would go wrong the first time any
 * other card outlived an archive.
 *
 * ## Why the session on screen is excluded
 *
 * A user looking at the chat can see the card. Telling them about it in a toast
 * is noise, and noise is how a notice meant to be trusted stops being read. The
 * excluded session drops out of `retained` too, so navigating away without
 * answering announces it — deliberate, and the reason the caller re-runs this on
 * a selection change: leaving the chat with the card unanswered is exactly the
 * moment the offer becomes invisible again.
 */

import { sessionAwaitsApproval } from '../atoms/sessions'

/** The session fields this decision reads, and nothing else. */
export interface ArchivedAwaitingSession {
  id: string
  name?: string
  isArchived?: boolean
  /**
   * P6.763 — the server's own count, published on every Session DTO since F15.
   * Optional because a meta assembled before this field existed, or by a client
   * that never received a list refresh, legitimately carries none; absent reads
   * as zero, which leaves the decision exactly where the local map puts it.
   */
  awaitingApprovalCount?: number
}

/**
 * Which archived chats owe the user a notice, and which ids to keep remembering.
 *
 * `announce` is what to show now: qualifying and not already announced.
 * `retained` is the whole qualifying set, which becomes the next call's
 * `announced` — so a chat whose question is answered leaves the set and can be
 * announced again if a later one is raised. The bookkeeping lives here rather
 * than in the component so that all three of its rules are testable.
 */
export function reconcileArchivedAwaitingNotices(
  sessions: readonly ArchivedAwaitingSession[],
  pending: ReadonlyMap<string, readonly unknown[]>,
  announced: ReadonlySet<string>,
  options: { viewingSessionId?: string } = {},
): { announce: ArchivedAwaitingSession[]; retained: Set<string> } {
  const qualifying = sessions.filter(session =>
    session.isArchived === true
    && sessionAwaitsApproval(session, (pending.get(session.id)?.length ?? 0) > 0)
    && session.id !== options.viewingSessionId)
  return {
    announce: qualifying.filter(session => !announced.has(session.id)),
    retained: new Set(qualifying.map(session => session.id)),
  }
}
