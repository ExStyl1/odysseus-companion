/**
 * UA3.8 — the mid-turn refusal of `archive_session`, adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/sessions/archive-guards.ts` (Apache-2.0).
 *
 * Only the PROCESSING arm is ported (spec §3, manifest "D(c) scoping / CA processing"). Upstream's scoping arm
 * ("not found" and "different workspace" sharing one opaque message) is dropped under reason (c): our
 * `SessionManager.archiveSessionForAgent` already resolves the target inside the caller's own workspace and answers
 * `not-found` by name, and raises a confirmation card in every mode. What ours lacked is upstream's mid-turn check:
 * an agent could archive a session — its own included — while that session was running a turn.
 */

/** The target's state the guard reads. */
export interface ArchiveTargetState {
  isProcessing: boolean
  /**
   * NESSY — the target IS the calling session. Upstream's tool cannot target its own session; ours documents it
   * ("Omit sessionId to target the current session", `tool-defs.ts` `archive_session`), and the caller is always
   * mid-turn while it calls the tool, so the processing arm would refuse every self-archive. Reason (c): the caller
   * closing itself out is the existing, card-confirmed hand-off; the arm guards OTHER sessions' running turns.
   */
  isCaller?: boolean
}

/**
 * Returns the refusal sentence when an agent may not make this change now, or `null` when it may. Archiving ANOTHER
 * session mid-turn is refused; UNarchiving is not (it only restores visibility). Upstream wording.
 */
export function archiveProcessingRefusal(
  target: ArchiveTargetState,
  sessionId: string,
  archived: boolean,
): string | null {
  if (archived && target.isProcessing && !target.isCaller) {
    return `Session ${sessionId} is currently processing a turn — try again once it is idle`
  }
  return null
}
