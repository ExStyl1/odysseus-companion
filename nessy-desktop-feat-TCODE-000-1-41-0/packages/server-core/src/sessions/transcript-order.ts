/**
 * Where a finished assistant message belongs when the user has already queued
 * the next one.
 *
 * The transcript is built from two writes with very different timing. A queued
 * user message is appended the moment it arrives, so the person sees it sitting
 * in the queue; the assistant's message for the turn ALREADY IN FLIGHT is only
 * appended when that turn's `text_complete` fires. Append both and the reply to
 * the earlier question lands underneath the later question:
 *
 *     user: "what does X do?"
 *     user: "and Y?"            ← queued while the answer was still streaming
 *     assistant: "X does …"     ← the answer to the FIRST one, now last
 *
 * Upstream v0.11.2 fixed the same shape ("queuing a message while the agent is
 * still replying no longer pushes the in-progress response below your new
 * message"). Placing the assistant message above the trailing queued run
 * restores reading order without delaying the queued message's appearance.
 */

/** Only the two fields the ordering decision reads. */
export interface OrderableMessage {
  readonly role: string
  readonly isQueued?: boolean
}

/**
 * The index a completed assistant message should be inserted at.
 *
 * Scans back over the TRAILING run of queued user messages only. A queued
 * message further up the transcript belongs to an earlier exchange and must not
 * move anything; that is why this stops at the first entry that is not a queued
 * user message rather than filtering the whole list.
 */
export function assistantInsertIndex(messages: readonly OrderableMessage[]): number {
  let index = messages.length
  while (index > 0) {
    const candidate = messages[index - 1]
    if (!candidate || candidate.role !== 'user' || candidate.isQueued !== true) break
    index -= 1
  }
  return index
}

/**
 * Insert in place, above any trailing queued user messages.
 *
 * Mutates because the caller owns a live session's message array and other
 * state (`lastFinalMessageId`, persistence) is keyed off that same array.
 */
export function insertCompletedAssistantMessage<T extends OrderableMessage>(
  messages: T[],
  assistantMessage: T,
): void {
  messages.splice(assistantInsertIndex(messages), 0, assistantMessage)
}
