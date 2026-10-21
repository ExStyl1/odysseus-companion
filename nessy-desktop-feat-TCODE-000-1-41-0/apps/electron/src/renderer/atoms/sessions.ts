/**
 * Per-Session State Management with Jotai
 *
 * Uses atomFamily to create isolated atoms per session.
 * Updates to one session don't trigger re-renders in other sessions.
 *
 * This solves the performance issue where streaming in Session A
 * caused re-renders and focus loss in Session B.
 */

import { atom } from 'jotai'
import type { Getter, Setter } from 'jotai/vanilla'
import { atomFamily } from 'jotai-family'
import type { PermissionRequestType } from '@nessy-agent/core/types'
import type { Session, Message, ComposerCapabilities } from '../../shared/types'

/**
 * Session metadata for list display (lightweight, no messages)
 * Used by SessionList to avoid re-rendering on message changes
 */
export interface SessionMeta {
  id: string
  name?: string
  /** Preview of first user message (for title fallback) */
  preview?: string
  /**
   * P6.504 — one line of the session's own last output, precomputed server-side.
   * NOT a model-written summary: it is the session's own words, extracted, and
   * the row that renders it says so.
   */
  lastOutputSummary?: string
  workspaceId: string
  lastMessageAt?: number
  isProcessing?: boolean
  isFlagged?: boolean
  lastReadMessageId?: string
  workingDirectory?: string
  /**
   * D1.251 — where the runtime child actually runs: the project folder when the
   * session has one, and the session's own managed storage when it does not.
   *
   * It arrives with no extra work — `extractSessionMeta` spreads the whole
   * session — and is declared so a surface can READ it; see the field's own
   * docblock on the protocol `Session`.
   */
  sdkCwd?: string
  enabledSourceSlugs?: string[]
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  /**
   * F15 / P6.758 — how many permission requests the SERVER says this session is
   * waiting on a human to answer. Derived there from the live pending-request
   * map (`SessionManager.awaitingApprovalCount`) and carried on every Session
   * DTO, so it is never stored and never stale on the wire.
   *
   * It has been arriving through `extractSessionMeta`'s spread since F15 and was
   * invisible to this type, which is the whole reason the desktop never read it
   * while iOS has read it since the same row. Optional for the same reason the
   * DTO field is: an older server that omits it must read as "not waiting",
   * never fail the projection.
   */
  /**
   * UB6.15 — set when the decision model moved the session to Needs Review at
   * turn end: the visible reason. Arrives on the Session DTO through the same
   * spread; optional, so an older server reads as "not set".
   */
  statusSetByDecision?: { outcome: string; probability: number }
  awaitingApprovalCount?: number
  /**
   * P6.764 — WHAT the server's oldest pending request is waiting on, arriving
   * on the same Session DTO as the count and through the same spread.
   *
   * Read only as a PAIR and only when this window holds no live prompt of its
   * own; {@link sessionAttentionPrompt} is where that rule lives.
   */
  awaitingApprovalToolName?: string
  /** P6.764 — the kind of that same request. See {@link SessionMeta.awaitingApprovalToolName}. */
  awaitingApprovalType?: PermissionRequestType
  /** Labels for filtering (additive tags, many-per-session) */
  labels?: string[]
  /** Permission mode ('dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions') — used by view expressions */
  permissionMode?: string
  /** Session status for filtering */
  sessionStatus?: string
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  /** Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration) */
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  /** Model override for this session */
  model?: string
  /** LLM connection slug for this session */
  llmConnection?: string
  /** Server-resolved composer capabilities for this session's active integration */
  composerCapabilities?: ComposerCapabilities
  /** Token usage stats (from JSONL header, available without loading messages) */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    contextTokens: number
  }
  /** When the session was created (ms timestamp) */
  createdAt?: number
  /** Total number of messages in this session */
  messageCount?: number
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** UA2.1 (v0.13.4) — Kanban board column id ('todo' | 'in-progress' | 'done' or a project column); independent of sessionStatus */
  kanbanColumn?: string
  /** UA3.1 (v0.13.4) — workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** UA3.1 (v0.13.4) — parent session id: a subtask of the parent (undefined = top-level task); not PermissionRequest.parentSessionId */
  parentSessionId?: string
  /** UA3.1 (v0.13.4) — Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes) */
  taskSlug?: string
  /** UA3.1 (v0.13.4) — Tasks Conductor: id of the run that spawned this child session (Conductor-owned children only) */
  taskRunId?: string
  /** UA3.1 (v0.13.4) — Tasks Conductor: id of the DAG node this child session executes (Conductor-owned children only) */
  taskNodeId?: string
  /** UA3.1 (v0.13.4) — Tasks Conductor: total DAG node count (orchestrator only); a stable board progress denominator */
  taskNodeCount?: number
  /** UA3.1 (v0.13.4) — Tasks Conductor: a generate-time draft orchestrator, hidden from the board until adopted */
  taskDraft?: boolean
}

/**
 * Find the last final (non-intermediate) assistant or plan message ID
 */
function findLastFinalMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Include plan messages as final responses (they're AI-generated content)
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate) {
      return msg.id
    }
  }
  return undefined
}

/**
 * Extract metadata from a full session object
 */
export function extractSessionMeta(session: Session): SessionMeta {
  const messages = session.messages || []

  // Destructure fields that don't exist on SessionMeta or need overrides
  const {
    messages: _msgs, supportsBranching: _sb,
    workspaceName: _wn, thinkingLevel: _tl, currentStatus: _cs,
    isAsyncOperationOngoing, isRegeneratingTitle,
    messageCount, lastFinalMessageId: sessionLastFinal,
    ...sessionFields
  } = session

  return {
    ...sessionFields,
    lastFinalMessageId: sessionLastFinal ?? findLastFinalMessageId(messages),
    messageCount: Math.max(messageCount ?? 0, messages.length), // F1.355 — the header count is frozen at load (upstream v0.11.0+)
    isAsyncOperationOngoing: isAsyncOperationOngoing ?? isRegeneratingTitle,
    isRegeneratingTitle,
  }
}

/**
 * P6.270 (denominator F14, F28) — which of three things a session wants from you.
 *
 * **The row's verdict was `absent` x3 and it is REFUTED at HEAD.** The list
 * already DRAWS all three: `item.isProcessing` renders a spinner, `hasUnreadMeta`
 * an accent dot, and a pending permission a `ShieldAlert`
 * (`SessionItem.tsx`) — and it already does so from host state with no
 * per-runtime branch, because the permission gate that fills `pendingPermissions`
 * is host-side for Pi, claude and codex alike. So `done_means` (a) — *"marks each
 * session running / waiting-for-you / unread across all three runtimes, from the
 * host state rather than a per-runtime branch"* — was delivered before the row
 * was written.
 *
 * What is missing is the OTHER half of the row's own title: *"nor what they are
 * waiting on"*. Not one of those three markers carries a label — no `title`, no
 * `aria-label` — so the list says a session wants something and never what, and a
 * screen reader is told nothing at all. That is what this function exists for: it
 * names the state ONCE, so the icon, its tooltip and its accessible name cannot
 * disagree, and a fourth marker added later has one place to be added.
 *
 * Precedence is deliberate and is not the order the icons are drawn in. A session
 * that is BOTH running and holding a prompt is **waiting**: the prompt is the
 * thing only the user can clear, and the run is blocked behind it. Unread is the
 * weakest — it says the session finished and nobody looked.
 *
 * Pure and runtime-agnostic by construction: it takes a meta record and a boolean
 * the caller already has, and knows about no provider. A per-runtime branch here
 * would be the divergence the row is about.
 */
export type SessionAttentionState = 'waiting' | 'running' | 'unread'

/**
 * P6.757 — is this session waiting on a human? Both clients, one answer.
 *
 * The server has published `awaitingApprovalCount` on every Session DTO since
 * F15, derived at read time from `SessionManager`'s live pending-request map;
 * iOS reads it (`Session.isAwaitingApproval`) and the desktop did not, deriving
 * the same state from `App.tsx`'s per-window `pendingPermissions` map instead.
 * Two clients, two sources, one state — which is the divergence, not the map.
 *
 * **Native-first:** nothing new is built here. The server's own mechanism is
 * adopted, and with `hasPendingPrompt` false this reduces to exactly the iOS
 * predicate `(awaitingApprovalCount ?? 0) > 0`, so the two clients cannot
 * disagree about a session either of them can see.
 *
 * **Why the local map is a UNION and not merely a fallback.** The row asked for
 * the count to be the source of truth with the map used only where the count is
 * absent. Measured at HEAD, that would lose a signal: `awaitingApprovalCount` is
 * fresh only on a Session DTO, and nothing emits one when a permission request
 * is raised — the renderer learns of the prompt through the `permission_request`
 * effect, which updates `pendingPermissions` and no meta. So a meta in hand can
 * legitimately say 0 while this window is holding a live card, and treating the
 * present-but-older count as authoritative would blank the shield until the next
 * list refresh. The union keeps that liveness and still gains everything the
 * count carries and the map cannot: prompts raised before this window connected,
 * prompts against sessions this window never subscribed to, and prompts answered
 * or raised on another device.
 *
 * The residue, stated rather than hidden: a prompt answered elsewhere keeps this
 * window's local entry until it receives `permission_request_cancelled` or the
 * turn completes. That is today's behaviour on the map and is unchanged here —
 * the count cannot clear it, because a stale zero and a real zero are the same
 * value.
 */
export function sessionAwaitsApproval(
  meta: Pick<SessionMeta, 'awaitingApprovalCount'>,
  hasPendingPrompt: boolean,
): boolean {
  if (hasPendingPrompt) return true
  return (meta.awaitingApprovalCount ?? 0) > 0
}

export function sessionAttentionState(
  meta: Pick<SessionMeta, 'isProcessing' | 'hasUnread' | 'awaitingApprovalCount'>,
  hasPendingPrompt: boolean,
): SessionAttentionState | undefined {
  if (sessionAwaitsApproval(meta, hasPendingPrompt)) return 'waiting'
  if (meta.isProcessing) return 'running'
  if (meta.hasUnread === true) return 'unread'
  return undefined
}

/**
 * P6.764 — WHICH prompt the `waiting` label describes, and from WHICH source.
 *
 * `sessionAttentionState` says a session is waiting; this says what it is
 * waiting on. Two sources can answer, and the whole content of this function is
 * that they must not be MIXED:
 *
 * - this window's own `pendingPermissions` entry — a live card the user can
 *   answer here, carrying a required `toolName`;
 * - the Session DTO's `awaitingApprovalToolName` / `awaitingApprovalType`,
 *   describing the SERVER's oldest pending request, which is the only half that
 *   can see a prompt raised before this window connected, against a session it
 *   never subscribed to, or on another device.
 *
 * They describe DIFFERENT requests whenever both exist, so the choice is made
 * per SOURCE and never per field: taking `toolName` from one and `type` from
 * the other would name a prompt that does not exist — an `ask_user` question
 * labelled with some bash tool's name, say. The local entry wins because it is
 * the one the row's own answer control acts on (`SessionRowPermissionAnswer`
 * takes that same object), so label and control cannot disagree.
 *
 * `undefined` means "waiting, subject unknown", which is the subjectless label
 * the row already had — including against an older server that sends neither
 * field. That is deliberately not an error: the count can be non-zero with no
 * subject, and inventing one would be worse than saying nothing.
 */
export interface SessionAttentionPrompt {
  type?: PermissionRequestType
  toolName?: string
}

export function sessionAttentionPrompt(
  meta: Pick<SessionMeta, 'awaitingApprovalToolName' | 'awaitingApprovalType'>,
  localPrompt?: { type?: PermissionRequestType, toolName?: string } | null,
): SessionAttentionPrompt | undefined {
  if (localPrompt) {
    return {
      ...(localPrompt.type ? { type: localPrompt.type } : {}),
      ...(localPrompt.toolName ? { toolName: localPrompt.toolName } : {}),
    }
  }
  if (!meta.awaitingApprovalToolName && !meta.awaitingApprovalType) return undefined
  return {
    ...(meta.awaitingApprovalType ? { type: meta.awaitingApprovalType } : {}),
    ...(meta.awaitingApprovalToolName ? { toolName: meta.awaitingApprovalToolName } : {}),
  }
}

/**
 * Atom family for individual session state
 * Each session gets its own atom - updates are isolated
 */
export const sessionAtomFamily = atomFamily(
  (_sessionId: string) => atom<Session | null>(null),
  (a, b) => a === b
)

/**
 * Atom for session metadata map (for list display)
 * Only contains lightweight data needed for SessionList
 */
export const sessionMetaMapAtom = atom<Map<string, SessionMeta>>(new Map())

/**
 * Derived atom: ordered list of session IDs (for list ordering)
 */
export const sessionIdsAtom = atom<string[]>([])

/**
 * Track which sessions have had their messages loaded (for lazy loading)
 * Sessions are loaded with empty messages initially, messages are fetched on-demand
 */
export const loadedSessionsAtom = atom<Set<string>>(new Set<string>())

/**
 * Promise cache for deduplicating concurrent session load requests.
 * Prevents race condition where multiple calls (e.g., from React re-renders)
 * start loading before the first completes and marks the session as loaded.
 * Module-level map since it tracks in-flight promises, not React state.
 */
const sessionLoadingPromises = new Map<string, Promise<Session | null>>()

/**
 * Currently active session ID - the session displayed in the main content area
 * This replaces the tab-based session selection
 */
export const activeSessionIdAtom = atom<string | null>(null)

// NOTE: sessionsAtom REMOVED to fix memory leak
// The sessions array with messages was being retained by Jotai's internal state.
// Instead, we now use:
// - sessionMetaMapAtom for listing (lightweight metadata, no messages)
// - sessionAtomFamily(id) for individual session data
// - initializeSessionsAtom for bulk initialization
// - addSessionAtom, removeSessionAtom for individual operations

/**
 * Action atom: update a single session
 * Only triggers re-render in components subscribed to this specific session
 */
export const updateSessionAtom = atom(
  null,
  (get, set, sessionId: string, updater: (prev: Session | null) => Session | null) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const currentSession = get(sessionAtom)
    const newSession = updater(currentSession)
    set(sessionAtom, newSession)

    // Also update metadata if session exists
    if (newSession) {
      const metaMap = get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(newSession))
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom: update only session metadata (for list display updates)
 * Doesn't affect the full session atom
 */
export const updateSessionMetaAtom = atom(
  null,
  (get, set, sessionId: string, updates: Partial<SessionMeta>) => {
    const metaMap = get(sessionMetaMapAtom)
    const existing = metaMap.get(sessionId)
    if (existing) {
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, { ...existing, ...updates })
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom: replace a session with an authoritative full session payload.
 *
 * Use this for data returned by getSessionMessages() or createSession(), where
 * the `messages` array is known to represent the loaded transcript. Keeping the
 * full session atom and loadedSessionsAtom in one write prevents the chat panel
 * from hiding real messages behind a stale lazy-loading spinner.
 */
export const replaceLoadedSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    set(sessionAtomFamily(session.id), session)

    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    const loadedSessions = get(loadedSessionsAtom)
    if (!loadedSessions.has(session.id)) {
      const newLoadedSessions = new Set(loadedSessions)
      newLoadedSessions.add(session.id)
      set(loadedSessionsAtom, newLoadedSessions)
    }
  }
)

/**
 * Action atom: append message to session (for streaming)
 * Optimized to only update the specific session
 * Note: Does NOT update lastMessageAt - caller must handle timestamp updates
 * to avoid session list jumping on intermediate/tool messages
 */
export const appendMessageAtom = atom(
  null,
  (get, set, sessionId: string, message: Message) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (session) {
      set(sessionAtom, {
        ...session,
        messages: [...session.messages, message],
        // Don't update lastMessageAt here - only user messages and final responses should update it
      })
    }
  }
)

/**
 * Action atom: update streaming content for a session
 * For text_delta events - appends to the last streaming message
 */
export const updateStreamingContentAtom = atom(
  null,
  (get, set, sessionId: string, content: string, turnId?: string) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (!session) return

    const messages = [...session.messages]
    const lastMsg = messages[messages.length - 1]

    // Append to existing streaming message
    if (lastMsg?.role === 'assistant' && lastMsg.isStreaming &&
        (!turnId || lastMsg.turnId === turnId)) {
      messages[messages.length - 1] = {
        ...lastMsg,
        content: lastMsg.content + content,
      }
      set(sessionAtom, { ...session, messages })
    }
  }
)

/**
 * Action atom: initialize sessions from loaded data
 */
export const initializeSessionsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    // Clean up stale atom family entries from previous workspace.
    // Without this, switching workspaces leaves orphaned atoms in memory
    // and components subscribed to old session IDs see stale/empty data.
    const oldIds = get(sessionIdsAtom)
    const newIdSet = new Set(sessions.map(s => s.id))
    for (const oldId of oldIds) {
      if (!newIdSet.has(oldId)) {
        sessionAtomFamily.remove(oldId)
        backgroundTasksAtomFamily.remove(oldId)
        scheduledWorkNudgeAtomFamily.remove(oldId)
      }
    }
    // Reset loaded sessions tracking — new workspace needs fresh lazy loading
    set(loadedSessionsAtom, new Set<string>())

    // Set individual session atoms
    for (const session of sessions) {
      set(sessionAtomFamily(session.id), session)
    }

    // Build metadata map
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      metaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, metaMap)

    // Set ordered IDs (sorted by lastMessageAt desc)
    const ids = sessions
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, ids)

    // NOTE: Do NOT mark sessions as loaded here
    // Sessions from getSessions() have empty messages: [] to save memory
    // Messages are lazy-loaded via ensureSessionMessagesLoadedAtom when session is opened
    // This reduces initial memory usage from ~500MB to ~50MB for 300+ sessions
  }
)

/**
 * Action atom: refresh session metadata after a stale reconnect.
 *
 * Unlike initializeSessionsAtom (which resets everything for workspace switches),
 * this preserves messages for already-loaded sessions and only marks overwritten
 * metadata-only sessions as unloaded for lazy re-fetching.
 *
 * All cross-atom mutations happen inside a single write transaction so that
 * React subscribers see one consistent update instead of intermediate states.
 *
 * ## D1.380 · this is the ONE path that reconciles `isProcessing`, and it takes
 * the host's answer whole — in both directions, on purpose
 *
 * `nextSession` below is the HOST's own session object with only `messages`
 * preserved, so `isProcessing` is adopted wholesale: a host that says the turn
 * is running over a renderer that says idle, AND a host that says idle over a
 * renderer that says running. Both directions are pinned in
 * `__tests__/sessions.test.ts`, and the second one is the backstop that keeps
 * D1.379's mid-turn raise (`event-processor/processor.ts`) from ever becoming
 * permanent: a stale reconnect re-reads the host's own truth.
 *
 * D1.376 is why this note exists. That defect was one wrong VALUE of this same
 * flag in the renderer, and it was release-blocking because every Stop
 * affordance is gated on it — so a sync path that DECLINED to overwrite the
 * renderer's copy while that copy was wrong would have made the defect
 * permanent rather than one turn long. A guard keyed on the flag it is meant to
 * protect cannot tell a live streaming session from a mistaken one.
 *
 * Such a guard used to exist a few hundred lines below, in
 * `syncSessionsToAtomsAtom` (`if (atomSession?.isProcessing) continue`, plus a
 * separate `meta.isProcessing = true` force), which is what D1.380 was written
 * about. It is deleted rather than annotated, because measurement showed it had
 * **zero readers**: one definition and no call site anywhere in the tree, with
 * `sessionAtomFamily` (47) and this atom (11, including a live `App.tsx` caller)
 * as the positive controls on the same instrument. It was the last remnant of
 * the removed `sessionsAtom` / "React state is the source of truth" model — see
 * the note at `sessionsAtom REMOVED to fix memory leak` above — so its guard
 * never ran, and if it had ever been re-wired it would have BLOCKED the healing
 * D1.379 depends on. Do not reintroduce a flag-keyed skip here.
 */
export const refreshSessionsMetadataAtom = atom(
  null,
  (
    get,
    set,
    payload: { sessions: Session[]; loadedSessionIds: Set<string>; removeMissing?: boolean }
  ): Map<string, SessionMeta> => {
    const { sessions, loadedSessionIds, removeMissing = true } = payload

    // Remove stale sessions only for authoritative refreshes. Stale reconnect
    // recovery can receive a transient partial list immediately after sleep/wake;
    // treating that as authoritative is what makes the sidebar collapse to the
    // single active session. In non-destructive mode we upsert returned sessions
    // and preserve missing metadata until a confirmed delete/workspace reload.
    const currentIds = get(sessionIdsAtom)
    const latestIds = new Set(sessions.map(s => s.id))
    if (removeMissing) {
      for (const staleId of currentIds) {
        if (!latestIds.has(staleId)) {
          set(removeSessionAtom, staleId)
        }
      }
    }

    // Update each session atom, preserving messages for loaded sessions
    const unloadedIds: string[] = []
    for (const session of sessions) {
      const currentSession = get(sessionAtomFamily(session.id))
      const shouldPreserveMessages = !!currentSession && loadedSessionIds.has(session.id)
      const nextSession = shouldPreserveMessages && currentSession
        ? { ...session, messages: currentSession.messages }
        : session

      set(sessionAtomFamily(session.id), nextSession)

      // Track sessions that lost their messages so lazy-loading re-fetches them
      if (!shouldPreserveMessages && loadedSessionIds.has(session.id)) {
        unloadedIds.push(session.id)
      }
    }

    // Remove overwritten sessions from loadedSessionsAtom
    if (unloadedIds.length > 0) {
      const nextLoaded = new Set(get(loadedSessionsAtom))
      for (const id of unloadedIds) nextLoaded.delete(id)
      set(loadedSessionsAtom, nextLoaded)
    }

    // Build and set metadata map. Non-destructive refresh starts from the
    // existing map so sessions omitted by a transient partial response remain
    // visible. Returned sessions are still authoritative for their own fields.
    const nextMetaMap = removeMissing
      ? new Map<string, SessionMeta>()
      : new Map(get(sessionMetaMapAtom))
    for (const session of sessions) {
      nextMetaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, nextMetaMap)

    // Set ordered IDs from the metadata map we actually exposed to the UI.
    const nextIds = Array.from(nextMetaMap.values())
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, nextIds)

    return nextMetaMap
  }
)

/**
 * Action atom: add a new session
 */
export const addSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    // Set session atom
    set(sessionAtomFamily(session.id), session)

    // Add to metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    // Add to beginning of IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, [session.id, ...ids])

    // Mark as loaded (new sessions are complete - no lazy loading needed)
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.add(session.id)
    set(loadedSessionsAtom, newLoadedSessions)
  }
)

/**
 * Action atom: remove a session
 */
export const removeSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    // Clear session atom value first
    set(sessionAtomFamily(sessionId), null)
    // Remove atom from family cache to allow GC of the atom and its stored value
    sessionAtomFamily.remove(sessionId)

    // Remove from metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.delete(sessionId)
    set(sessionMetaMapAtom, newMetaMap)

    // Remove from IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, ids.filter(id => id !== sessionId))

    // Remove from loaded sessions tracking
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, newLoadedSessions)

    // Clean up additional atom families to prevent memory leaks
    // These store per-session UI state that should be garbage collected
    backgroundTasksAtomFamily.remove(sessionId)
    scheduledWorkNudgeAtomFamily.remove(sessionId)
  }
)

/**
 * Action atom: Load session messages if not already loaded
 * Returns the loaded session or current session if already loaded.
 * Uses promise deduplication to prevent redundant IPC calls from concurrent requests.
 *
 * IMPORTANT: This only merges messages into the existing session atom.
 * UI state fields (hasUnread, isFlagged, sessionStatus, etc.) are preserved from
 * the in-memory atom, NOT overwritten with potentially stale disk data.
 * This prevents a race condition where optimistic updates (e.g., clearing the
 * NEW badge on session view) get clobbered by async message loading that reads
 * older state from disk.
 */
async function loadSessionMessages(
  get: Getter,
  set: Setter,
  sessionId: string,
  options?: { force?: boolean },
): Promise<Session | null> {
  const force = options?.force ?? false

  if (force) {
    const nextLoadedSessions = new Set(get(loadedSessionsAtom))
    nextLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, nextLoadedSessions)

    // Clear any stale in-flight request so the caller gets a fresh fetch.
    sessionLoadingPromises.delete(sessionId)
  } else {
    const loadedSessions = get(loadedSessionsAtom)

    // Already loaded, return current session
    if (loadedSessions.has(sessionId)) {
      return get(sessionAtomFamily(sessionId))
    }
  }

  // Check if already loading - return existing promise to deduplicate concurrent calls
  const existingPromise = sessionLoadingPromises.get(sessionId)
  if (existingPromise) {
    return existingPromise
  }

  // Create the loading promise with all the fetch and update logic
  const loadPromise = (async (): Promise<Session | null> => {
    // Fetch messages from main process
    const loadedSession = await window.electronAPI.getSessionMessages(sessionId)
    if (!loadedSession) {
      return get(sessionAtomFamily(sessionId))
    }

    // Merge messages and disk-only fields into existing session, preserving in-memory UI state.
    // The renderer's atom is authoritative for UI fields (hasUnread, isFlagged, etc.)
    // because optimistic updates may have changed them since the disk write.
    // tokenUsage is only returned by getSession() (not getSessions()), so it
    // must be explicitly merged here to be available after app restart.
    const existingSession = get(sessionAtomFamily(sessionId))
    const preservedStaleMessages = !!existingSession
      && existingSession.messages.length > 0
      && (!loadedSession.messages || loadedSession.messages.length === 0)

    const mergedSession = existingSession
      ? {
          ...existingSession,
          // CRITICAL: Don't clobber messages if session is actively streaming
          // AND already has messages in the atom. Streaming events update the atom
          // directly and may contain messages the IPC response doesn't know about
          // (race window between IPC request and response).
          // The `messages.length > 0` guard ensures Cmd+R reload works: after reload,
          // the atom starts with messages=[] from getSessions(), so IPC response
          // (which has full history from main process memory) must be used.
          // Also guard against sleep/wake edge case: the server may return
          // empty messages if the session subprocess hasn't finished lazy-loading.
          messages: preservedStaleMessages
            ? existingSession.messages
            : existingSession.isProcessing && existingSession.messages.length > 0
              ? existingSession.messages
              : loadedSession.messages,
          tokenUsage: loadedSession.tokenUsage ?? existingSession.tokenUsage,
        }
      : loadedSession
    set(sessionAtomFamily(sessionId), mergedSession)

    // Update only lastFinalMessageId in metadata (now computable from loaded messages).
    // Don't replace the full meta entry — other fields are maintained through
    // optimistic updates and IPC events, and may be ahead of disk state.
    const lastFinalMessageId = findLastFinalMessageId(loadedSession.messages)
    if (lastFinalMessageId) {
      const metaMap = get(sessionMetaMapAtom)
      const existingMeta = metaMap.get(sessionId)
      if (existingMeta && existingMeta.lastFinalMessageId !== lastFinalMessageId) {
        const newMetaMap = new Map(metaMap)
        newMetaMap.set(sessionId, { ...existingMeta, lastFinalMessageId })
        set(sessionMetaMapAtom, newMetaMap)
      }
    }

    // Mark as loaded only when we received a fresh payload.
    // If we had to preserve stale in-memory messages because the backend returned
    // an empty array during lazy-load recovery, keep the session reloadable.
    if (!preservedStaleMessages) {
      const newLoadedSessions = new Set(get(loadedSessionsAtom))
      newLoadedSessions.add(sessionId)
      set(loadedSessionsAtom, newLoadedSessions)
    }

    return mergedSession
  })()

  // Cache the promise before awaiting
  sessionLoadingPromises.set(sessionId, loadPromise)

  try {
    return await loadPromise
  } finally {
    // Always clean up the cache, whether success or failure
    sessionLoadingPromises.delete(sessionId)
  }
}

export const ensureSessionMessagesLoadedAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId)
  }
)

/**
 * Force-refresh session messages even if the session is currently marked as loaded.
 * Used by reconnect recovery when a session atom is stuck in an empty-but-loaded state.
 */
export const forceSessionMessagesReloadAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId, { force: true })
  }
)

/**
 * Background task for ActiveTasksBar display
 */
/**
 * UA12.18 — a chip's lifecycle (v0.13.4 `atoms/sessions.ts`, Apache-2.0; `orphaned` dropped, see
 * `background-task-chip-state.ts`). `stale` = no signal for 20 min, still live as far as anyone knows.
 */
export type BackgroundTaskStatus = 'running' | 'stale' | 'completed' | 'failed' | 'stopped'

export interface BackgroundTask {
  /** Task or shell ID */
  id: string
  /** Task type. 'workflow' = a fan-out Workflow run (Pi's `kind: 'workflow'`, Claude's `local_workflow`). */
  type: 'agent' | 'shell' | 'workflow'
  /** Tool use ID for correlation with messages */
  toolUseId: string
  /** When the task started */
  startTime: number
  /** Elapsed seconds (from progress events; the chip also derives it from startTime) */
  elapsedSeconds: number
  /** Last renderer-observed lifecycle/progress signal; falls back to startTime. */
  lastSignalAt?: number
  /** Task intent/description */
  intent?: string
  /** Lifecycle status; 'running' when added */
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal status */
  completedAt?: number
  /**
   * UA12.18 follow-up — ms timestamp when the runtime's live set (Claude's REPLACE feed) stopped naming this LIVE row
   * before its end was reported. The row is held, with no Stop, for that report (`UNREPORTED_END_GRACE_MS`).
   */
  unlistedAt?: number
  /**
   * UA12.18 follow-up 2 — set on a row built from the runtime's live set (Claude's REPLACE feed). While that set names
   * the row (no `unlistedAt`), the set and the `task_completed` after it end the row, never its launch call's
   * `tool_result`: sdk.d.ts calls a backgrounded task's tool_result "the placeholder text". Receipt-built rows (Pi)
   * never carry it.
   */
  listed?: true
  /**
   * UA12.186 — ms timestamp of the user's Dismiss. The row stays in the atom (the live set would otherwise rebuild it)
   * but is not drawn; its task's end prunes it. See `dismissBackgroundTask`.
   */
  dismissedAt?: number
  /**
   * UA12.210 — set when this row's latest `task_completed` carried an output file or a summary: the two fields the
   * host's completed-task read (`SessionManager.getTaskOutput`) answers from. Absent, an ENDED row has nothing to read
   * (codex's background-terminal end carries neither), so the chip does not offer View Output. See `canViewTaskOutput`.
   */
  endOutput?: true
  /** UB14.7 (v0.15.1, Apache-2.0) — short summary, set when task_completed arrives; the card's text when there is no output */
  summary?: string
  /** UB14.7 (v0.15.1) — what a running task is doing (task_activity): the agent's one-line summary, its last tool, its step count */
  activity?: { summary?: string; lastToolName?: string; toolUses?: number }
  /** UB14.7 (v0.15.1) — a stop was requested; the stopped status arrives as task_completed / shell_killed */
  stopping?: boolean
}

/**
 * Atom family for tracking active background tasks per session
 * Updated on task_backgrounded, shell_backgrounded, task_progress events
 * Cleared when tasks complete or are killed
 */
export const backgroundTasksAtomFamily = atomFamily(
  (_sessionId: string) => atom<BackgroundTask[]>([]),
  (a, b) => a === b
)

/**
 * D1.269 — how many times the host has said THIS session's scheduled work moved.
 *
 * A counter and not the work itself: the list is a read
 * (`sessions:listScheduledWork`) and the nudge carries no payload, so what the
 * renderer needs from it is only "read again". Written by the
 * `scheduled_work_changed` branch in `App.tsx`, consumed through
 * `scheduledWorkRefresh`'s composite revision, and removed beside
 * `backgroundTasksAtomFamily` at both of its cleanup sites — a per-session atom
 * nobody removes is the leak the comment there names.
 */
export const scheduledWorkNudgeAtomFamily = atomFamily(
  (_sessionId: string) => atom<number>(0),
  (a, b) => a === b
)

/**
 * Window's current workspace ID — shared between Root (ThemeProvider) and App.
 * Written by App on workspace switch, read by Root to keep the theme in sync.
 */
export const windowWorkspaceIdAtom = atom<string | null>(null)

/**
 * State for "Send to Workspace" dialog.
 * Set session IDs to open; clear to close.
 */
export const sendToWorkspaceAtom = atom<string[]>([])
