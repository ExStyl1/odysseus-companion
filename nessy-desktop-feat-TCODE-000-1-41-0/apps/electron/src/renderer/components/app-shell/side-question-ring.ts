/**
 * `/btw` side-question exchange ring — RENDERER STATE ONLY.
 *
 * interactive-mode.md:365 — "The question and answer are ephemeral: they
 * appear in a dismissible overlay and never enter the conversation history."
 * So this state is never persisted, never sent as a session event, and never
 * touches the real session transcript: it lives in a module-level map keyed by
 * session id, survives composer remounts for the renderer's lifetime, and dies
 * with the window.
 *
 * D1.399 — THE PANEL IS A CHAT THREAD, AND THE THREAD IS THE HISTORY (owner,
 * 2026-09-19, screenshot: five earlier questions stacked and scrolling at the
 * TOP of the card with the current one below — *"очередь сообщений будто вверху
 * копятся и скроллятся, поведение не такое как в обычном чате"*). R36 built the
 * doc's ring literally: ONE displayed exchange, the older ones as a dimmed list
 * above it (`:372`), and `Left`/`Right` to step between them (`:382`). That is
 * a reader, not a chat, and the panel is a chat since D1.375. So every exchange
 * is now rendered as messages in order ({@link sideQuestionThreadMessages}) and
 * the three pieces that existed only to navigate a one-at-a-time view are gone:
 * `earlierExchanges`, `stepOlder`/`stepNewer`, and `clearEarlier` (replaced by
 * {@link clearThread}, since `x` now clears the whole thread — there is no
 * "earlier" left to distinguish). `:372`, `:382` and `:385` are DEVIATIONS from
 * the page, recorded here: the owner's posture outranks it for this surface,
 * exactly as it did for `:369` when D1.375 gave the panel a composer.
 *
 * What survives unchanged, and deliberately:
 * - `:383` — `c` copies "as raw Markdown … the source text", never the rendered
 *   form ({@link copyPayload} returns a stored answer verbatim).
 * - `:374` — bare `/btw` "reopens on your most recent exchange"
 *   ({@link viewNewest}). With no stepping, `viewIndex` can only ever BE the
 *   newest, so this is a no-op in practice and is kept because `FreeFormInput`
 *   calls it and the invariant should be asserted rather than assumed.
 * - The `f` fork key is OMITTED — recorded narrowing (R36 plan): there is no
 *   transcript-copying session-create substrate, and `/subtask` is not it.
 *
 * NO SIZE CAP — DECIDED, not merely unstated (F1.94, origin D1.407; controller
 * 2026-09-23: "leave it — no cap"). The thread grows for as long as the window
 * lives, is per session, holds only the strings the user asked for and the
 * answers they got, never reaches disk or the server, and `x` empties it. A cap
 * would SILENTLY discard a user's own answers, and the growth it would bound is
 * already bounded by the user: one exchange per question they typed. So
 * {@link appendExchange} drops nothing, and the ring test's N / N+1 pair
 * (N = 50, a plausible cap) pins that — adding a cap is a visible change there.
 *
 * A `/recap` result rides the same ring: a recap is just an exchange whose
 * question is the localized recap label (R36 dispatch B choice — overlay over
 * toast, for component reuse).
 */

import type { Message } from '../../../shared/types'

export interface SideQuestionExchange {
  id: string
  /** The question as typed (or the localized `/recap` label for recap exchanges). */
  question: string
  /** Raw Markdown answer — the `c` copy payload (`:383`), never the rendered form. */
  answer?: string
  /** Typed error code (`SideQuestionResult.error`) or provider message on failure. */
  error?: string
  /** True while the query is in flight — the overlay shows the streaming affordance. */
  pending: boolean
  timestamp: number
}

export interface SideQuestionRingState {
  /** Oldest → newest. The thread, in the order it is rendered. Never capped (F1.94). */
  exchanges: SideQuestionExchange[]
  /**
   * Index into `exchanges` of the newest exchange.
   *
   * Kept after D1.399 removed the stepping, and it is now an INVARIANT rather
   * than a cursor: nothing can move it off the last element. It stays because
   * `viewNewest` is `FreeFormInput`'s bare-`/btw` reopen call and because a
   * state shape that changes shape is a migration for every reader of this
   * store; {@link currentExchange} reads it and the ring test asserts it.
   */
  viewIndex: number
}

/** Stable empty snapshot (identity matters for useSyncExternalStore). */
export const EMPTY_SIDE_QUESTION_RING: SideQuestionRingState = Object.freeze({
  exchanges: Object.freeze([]) as unknown as SideQuestionExchange[],
  viewIndex: 0,
})

/** Append a new pending exchange; the new exchange becomes the newest one. */
export function appendExchange(
  state: SideQuestionRingState,
  exchange: { id: string; question: string; timestamp: number },
): SideQuestionRingState {
  const exchanges = [...state.exchanges, { ...exchange, pending: true }]
  return { exchanges, viewIndex: exchanges.length - 1 }
}

/** Resolve a pending exchange with the answer (raw Markdown) or a typed error. */
export function resolveExchange(
  state: SideQuestionRingState,
  id: string,
  result: { text?: string; error?: string },
): SideQuestionRingState {
  return {
    ...state,
    exchanges: state.exchanges.map(exchange =>
      exchange.id === id
        ? { ...exchange, pending: false, answer: result.text, error: result.error }
        : exchange,
    ),
  }
}

/** Bare `/btw` reopen — "reopens on your most recent exchange" (`:374`). */
export function viewNewest(state: SideQuestionRingState): SideQuestionRingState {
  const newest = Math.max(0, state.exchanges.length - 1)
  if (state.viewIndex === newest) return state
  return { ...state, viewIndex: newest }
}

/**
 * `x` — clear the thread (D1.399, superseding `:385`'s "clear the list of
 * earlier exchanges shown above the current answer": there is no above any
 * more, so the key clears what the panel shows, which is all of it).
 */
export function clearThread(state: SideQuestionRingState): SideQuestionRingState {
  if (state.exchanges.length === 0) return state
  return EMPTY_SIDE_QUESTION_RING
}

/** The newest exchange, or null when the ring is empty. */
export function currentExchange(state: SideQuestionRingState): SideQuestionExchange | null {
  return state.exchanges[state.viewIndex] ?? null
}

/** True while ANY exchange in the thread is still waiting for its answer. */
export function hasPendingExchange(state: SideQuestionRingState): boolean {
  return state.exchanges.some(exchange => exchange.pending)
}

/**
 * `c` — the copy payload: the LATEST ANSWER as raw Markdown (`:383` — "the
 * source text", not the rendered form).
 *
 * "Latest answer" rather than "the displayed one" because D1.399 removed the
 * displayed one: the newest exchange can be in flight or failed while the
 * answer the user wants to copy sits one above it, so this walks back to the
 * newest exchange that HAS an answer. Null when there is none at all, so the
 * key stays inert rather than copying garbage.
 */
export function copyPayload(state: SideQuestionRingState): string | null {
  for (let index = state.exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = state.exchanges[index]
    if (exchange && !exchange.pending && exchange.answer !== undefined) return exchange.answer
  }
  return null
}

/**
 * The strings the thread needs from i18n, so this module stays pure.
 *
 * F1.179 removed the in-flight word that used to be the first of them: a pending
 * exchange is its question alone, and the panel's synthetic session reports
 * `isProcessing` while it is pending, so the compact chat draws its own
 * `ProcessingIndicator` there — ONE in-flight affordance, the main chat's.
 */
export interface SideQuestionThreadLabels {
  /** The localized SENTENCE for a failed exchange (D1.398) — never the code. */
  failure: (error: string) => string
}

/**
 * The whole thread as chat messages, oldest first — question, then its answer
 * or its failure sentence. A pending exchange is its question alone (F1.179):
 * the in-flight state belongs to the session, not to a message.
 *
 * This is D1.399: the compact `ChatDisplay` the panel mounts renders these the
 * way the main chat renders a conversation, newest at the bottom, with its own
 * sticky-bottom auto-scroll. Nothing here reaches a server or a transcript —
 * the ids are derived from the ring's own exchange ids and the session they are
 * put on is the synthetic one.
 */
export function sideQuestionThreadMessages(
  state: SideQuestionRingState,
  labels: SideQuestionThreadLabels,
): Message[] {
  const messages: Message[] = []
  for (const exchange of state.exchanges) {
    messages.push({
      id: `${exchange.id}-q`,
      role: 'user',
      content: exchange.question,
      timestamp: exchange.timestamp,
    })
    if (exchange.answer !== undefined) {
      messages.push({
        id: `${exchange.id}-a`,
        role: 'assistant',
        content: exchange.answer,
        timestamp: exchange.timestamp + 1,
      })
    } else if (exchange.error !== undefined) {
      messages.push({
        id: `${exchange.id}-e`,
        role: 'error',
        content: labels.failure(exchange.error),
        timestamp: exchange.timestamp + 1,
      })
    }
    // F1.179 — nothing for a pending exchange. D1.392 forked a synthetic
    // `isIntermediate` "thinking" message here because the synthetic session
    // could not report `isProcessing`; it now does, and the `ProcessingIndicator`
    // that draws would have stood beside this word — two affordances for one
    // wait. `SideQuestionOverlay` owns the flag; this module owns the thread.
  }
  return messages
}

// ---------------------------------------------------------------------------
// Key table (`:378-385`, minus `f` — recorded narrowing, minus the stepping —
// D1.399: the thread IS the history, so there is nothing to step between)
// ---------------------------------------------------------------------------

export type SideQuestionOverlayAction =
  | 'dismiss'
  | 'scroll-up'
  | 'scroll-down'
  | 'copy'
  | 'clear-thread'

/**
 * Map a KeyboardEvent.key to the overlay action per the doc's key table:
 * Space/Enter/Escape dismiss (`:380`), Up/Down scroll the thread (`:381`),
 * `c` copies raw Markdown (`:383`), `x` clears the thread (`:385`, as D1.399
 * re-reads it). `f` (`:384`) is deliberately absent, and Left/Right (`:382`)
 * left with the one-at-a-time view they navigated.
 */
export function sideQuestionOverlayKeyAction(key: string): SideQuestionOverlayAction | null {
  switch (key) {
    case ' ':
    case 'Enter':
    case 'Escape':
      return 'dismiss'
    case 'ArrowUp':
      return 'scroll-up'
    case 'ArrowDown':
      return 'scroll-down'
    case 'c':
    case 'C':
      return 'copy'
    case 'x':
    case 'X':
      return 'clear-thread'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Per-session store (renderer lifetime, never persisted)
// ---------------------------------------------------------------------------

const rings = new Map<string, SideQuestionRingState>()
const listeners = new Set<() => void>()

export function getSideQuestionRing(sessionId: string): SideQuestionRingState {
  return rings.get(sessionId) ?? EMPTY_SIDE_QUESTION_RING
}

export function updateSideQuestionRing(
  sessionId: string,
  updater: (state: SideQuestionRingState) => SideQuestionRingState,
): void {
  const previous = getSideQuestionRing(sessionId)
  const next = updater(previous)
  if (next === previous) return
  rings.set(sessionId, next)
  for (const listener of listeners) listener()
}

/** Subscribe to any ring change (useSyncExternalStore-shaped). */
export function subscribeSideQuestionRings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test/diagnostic escape hatch — drops every ring. */
export function resetSideQuestionRingsForTest(): void {
  rings.clear()
}
