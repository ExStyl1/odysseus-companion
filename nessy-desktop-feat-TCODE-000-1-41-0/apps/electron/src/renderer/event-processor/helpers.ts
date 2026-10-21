/**
 * Message Operation Helpers
 *
 * Pure utility functions for finding and updating messages.
 * All lookups are by ID (turnId, toolUseId) - NEVER by position.
 */

import type { Message, Session } from '../../shared/types'

let messageIdCounter = 0

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`
}

/**
 * Find message index by turnId
 * Returns -1 if not found
 */
export function findMessageByTurnId(
  messages: Message[],
  turnId: string | undefined,
  role?: 'assistant' | 'tool'
): number {
  if (!turnId) return -1
  return messages.findIndex(m =>
    m.turnId === turnId && (!role || m.role === role)
  )
}

/**
 * Last streaming assistant message, by position.
 *
 * The ONE positional lookup in this file, and it exists for exactly one case:
 * an event that carries no id at all, which cannot be resolved any other way.
 */
function findLastStreamingAssistant(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].isStreaming) {
      return i
    }
  }
  return -1
}

/**
 * Find streaming assistant message by turnId.
 * With no turnId, falls back to the last streaming assistant.
 *
 * P3.9 · an id that is PRESENT and unmatched means a DIFFERENT message, so it
 * returns -1 instead of falling through to the positional fallback. Both
 * lookups used to fall back on an unmatched id too, which is how a message that
 * never streamed could take over the bubble another message was streaming:
 * measured live on the codex runtime, an image completion landing mid-answer
 * replaced the streamed text, and lost it for good when the turn ended before
 * the answer's own completion arrived. Caller-side that reads as "not found",
 * and both text handlers already create the message they cannot find — the
 * documented race where `text_complete` overtakes `text_delta` resolves through
 * that same path, unchanged.
 */
export function findStreamingMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    return messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId && m.isStreaming
    )
  }
  return findLastStreamingAssistant(messages)
}

/**
 * Find assistant message by turnId (streaming or not).
 * With no turnId, falls back to the last streaming assistant.
 *
 * P3.9 · same rule as {@link findStreamingMessage}: a supplied id is the whole
 * answer, never a hint refined by position.
 */
export function findAssistantMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    return messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId
    )
  }
  return findLastStreamingAssistant(messages)
}

/**
 * Find tool message by toolUseId
 */
export function findToolMessage(
  messages: Message[],
  toolUseId: string
): number {
  return messages.findIndex(m => m.toolUseId === toolUseId)
}

/**
 * Update message at index, returning new session
 * Always creates new references (immutable update)
 * @param updateTimestamp - If true, also update lastMessageAt
 */
export function updateMessageAt(
  session: Session,
  index: number,
  updates: Partial<Message>,
  updateTimestamp = false
): Session {
  if (index < 0 || index >= session.messages.length) {
    return session
  }
  const messages = [...session.messages]
  messages[index] = { ...messages[index], ...updates }
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * Append message to session, returning new session
 * @param updateTimestamp - If false, don't update lastMessageAt (for intermediate/tool messages)
 */
export function appendMessage(
  session: Session,
  message: Message,
  updateTimestamp = false
): Session {
  // Guard: skip if message with same ID already exists (prevents duplicate events on Windows)
  if (message.id && session.messages.some(m => m.id === message.id)) {
    return session
  }

  // Determine if this message role should update lastMessageRole (for badge display)
  const badgeRoles = ['user', 'assistant', 'plan', 'tool', 'error'] as const
  const roleForBadge = badgeRoles.includes(message.role as typeof badgeRoles[number])
    ? message.role as Session['lastMessageRole']
    : undefined

  return {
    ...session,
    messages: [...session.messages, message],
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
    ...(roleForBadge ? { lastMessageRole: roleForBadge } : {}),
  }
}

/**
 * Insert message at index, returning new session
 * @param updateTimestamp - If false, don't update lastMessageAt (for intermediate/tool messages)
 */
export function insertMessageAt(
  session: Session,
  index: number,
  message: Message,
  updateTimestamp = false
): Session {
  const messages = [...session.messages]
  messages.splice(index, 0, message)
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * Create an empty session for a given ID
 *
 * F1.855 — its one caller is `useEventProcessor`'s fallback for an event whose
 * session this window has no atom for: a session the renderer was never told
 * about, which is what every host-created child is (a guardian judge, a
 * subagent — `createSession` sends no `session_created`). It is therefore
 * HIDDEN until the host says what it is: every list, the turn-completion
 * notification and `ReplyAnnouncer` skip `hidden`, and `App.tsx`'s session-event
 * handler asks the host on that same first event (`refreshSessionFromServer`),
 * whose answer replaces these provisional fields. Minted visible, it listed as
 * an unnamed 'New chat' row until the next full reload — one per judged action.
 */
export function createEmptySession(sessionId: string, workspaceId: string, workspaceName: string = ''): Session {
  return {
    id: sessionId,
    workspaceId,
    workspaceName,
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: false, // F1.807 — idle until a turn event raises it (processor.ts, D1.379); a mode or usage event drew a ghost spinner
    hidden: true,
  }
}
