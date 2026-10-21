/**
 * Text Event Handlers
 *
 * Handles text_delta and text_complete events.
 * Pure functions that return new state - no side effects.
 */

import type { SessionState, StreamingState, TextDeltaEvent, TextCompleteEvent, TextDiscardEvent } from '../types'
import type { Message } from '../../../shared/types'
import {
  findStreamingMessage,
  findAssistantMessage,
  updateMessageAt,
  appendMessage,
  generateMessageId
} from '../helpers'

/**
 * Handle text_delta - accumulate streaming content
 *
 * Creates a new streaming message if none exists, otherwise updates existing.
 * Uses turnId for lookup, never position.
 */
export function handleTextDelta(
  state: SessionState,
  event: TextDeltaEvent
): SessionState {
  const { session, streaming } = state

  // Accumulate in streaming state
  const newStreaming: StreamingState = streaming
    ? {
        ...streaming,
        content: streaming.content + event.delta,
        turnId: event.turnId ?? streaming.turnId
      }
    : {
        content: event.delta,
        turnId: event.turnId
      }

  // Find existing streaming message by turnId
  const streamingIndex = findStreamingMessage(session.messages, event.turnId)

  if (streamingIndex !== -1) {
    // Message exists - update its content
    const currentMsg = session.messages[streamingIndex]
    const updatedSession = updateMessageAt(session, streamingIndex, {
      content: currentMsg.content + event.delta,
      // R32 · a MessageDisplay hook's replacement accumulates in its own field.
      // `content` stays the model's text — it is what the transcript, copy,
      // export and branch-from-message read (hooks.md:1273). The display field
      // only exists once an override has actually arrived; until then a reader
      // falls back to `content`, which is the documented fail-open (:740 "The
      // original text is displayed").
      ...(event.displayDelta === undefined && currentMsg.displayContent === undefined
        ? {}
        : { displayContent: (currentMsg.displayContent ?? currentMsg.content) + (event.displayDelta ?? event.delta) }),
    })
    return { session: updatedSession, streaming: newStreaming }
  }

  // No streaming message found - create new one
  // Don't update lastMessageAt for streaming messages (they're intermediate)
  const newMessage: Message = {
    id: generateMessageId(),
    role: 'assistant',
    content: event.delta,
    ...(event.displayDelta === undefined ? {} : { displayContent: event.displayDelta }),
    timestamp: Date.now(),
    isStreaming: true,
    isPending: true,
    turnId: event.turnId,
  }

  return {
    session: appendMessage(session, newMessage, false),
    streaming: newStreaming,
  }
}

/**
 * Handle text_complete - finalize the streaming message
 *
 * Sets isStreaming: false, isPending: false.
 * If message not found, CREATES it (fixes race condition bug).
 * Uses complete text from SDK (event.text), not accumulated content.
 */
export function handleTextComplete(
  state: SessionState,
  event: TextCompleteEvent
): SessionState {
  const { session, streaming } = state

  // Find message by turnId (try streaming first, then any assistant)
  let msgIndex = findStreamingMessage(session.messages, event.turnId)
  if (msgIndex === -1) {
    msgIndex = findAssistantMessage(session.messages, event.turnId)
  }

  if (msgIndex !== -1) {
    const existingMsg = session.messages[msgIndex]

    // Don't overwrite a completed intermediate message with another intermediate —
    // each thinking block (e.g. Codex reasoning between tool calls) should be distinct
    if (!existingMsg.isStreaming && existingMsg.isIntermediate && event.isIntermediate) {
      msgIndex = -1
    }
  }

  if (msgIndex !== -1) {
    // Update existing message with final content
    // Only update lastMessageAt for final (non-intermediate) messages
    const shouldUpdateTimestamp = !event.isIntermediate
    const existingMsg = session.messages[msgIndex]
    // Fallback chain: SDK event text → accumulated streaming content → existing message content.
    // Guards against SDK quirks or race conditions where event.text arrives empty.
    const resolvedContent = event.text || streaming?.content || existingMsg?.content || ''
    const updatedSession = updateMessageAt(session, msgIndex, {
      // Replace temporary renderer-generated ID with authoritative main-process ID
      // so branchFromMessageId always resolves against persisted session.jsonl.
      ...(event.messageId ? { id: event.messageId } : {}),
      content: resolvedContent,
      // R32 · `text_complete.displayText` is the whole message's display text, so
      // it REPLACES what the deltas accumulated rather than appending. Absent means
      // the message was never overridden: clear the field so the renderer falls
      // back to the original `content`.
      displayContent: event.displayText,
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      // P4.4 · written unconditionally, like `isIntermediate` above: a message
      // reused across two completions must not keep a stale reasoning flag.
      isThinking: event.isThinking,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
      // Overwrite text_delta's Date.now() with main process monotonic timestamp
      // This ensures reload order matches live order
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    }, shouldUpdateTimestamp)
    return { session: updatedSession, streaming: null }
  }

  // Message not found - CREATE IT
  // This handles the race condition where text_complete arrives
  // before text_delta's setSessions has been processed
  const newMessage: Message = {
    id: event.messageId ?? generateMessageId(),
    role: 'assistant',
    content: event.text || streaming?.content || '',
    ...(event.displayText === undefined ? {} : { displayContent: event.displayText }),
    timestamp: event.timestamp ?? Date.now(),
    isStreaming: false,
    isPending: false,
    isIntermediate: event.isIntermediate,
    isThinking: event.isThinking,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
  }

  // Only update lastMessageAt for final (non-intermediate) messages
  const shouldUpdateTimestamp = !event.isIntermediate

  return {
    session: appendMessage(session, newMessage, shouldUpdateTimestamp),
    streaming: null,
  }
}

/**
 * F1.298 — handle text_discard: drop a failed attempt's UNFINISHED text.
 *
 * Both of the Pi SDK's attempts at one call stream into the same sub-turn id, so
 * without this the retried deltas were appended to the failed partial by
 * {@link handleTextDelta} ("Partial ansFull answer") until `text_complete`
 * replaced it. Only an assistant message of THAT `turnId` that is still streaming
 * or pending goes — a completed message is history — and the streaming buffer is
 * cleared when it belongs to that turn. Ported from craft-agents-oss v0.13.4's
 * `handleTextDiscard` (`renderer/event-processor/handlers/text.ts`, Apache-2.0).
 */
export function handleTextDiscard(state: SessionState, event: TextDiscardEvent): SessionState {
  return {
    session: {
      ...state.session,
      messages: state.session.messages.filter(m => !(
        m.role === 'assistant' && m.turnId === event.turnId && (m.isStreaming || m.isPending)
      )),
    },
    streaming: state.streaming?.turnId === event.turnId ? null : state.streaming,
  }
}
