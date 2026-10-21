/**
 * `/btw` overlay ring semantics — R36's (interactive-mode.md:374, :383) and
 * D1.399's, where the owner's posture replaced three of them.
 *
 * The ring is RENDERER STATE ONLY (`:365` — exchanges never enter the
 * conversation history), so the behaviours are pinned here as pure state
 * transitions. What D1.399 changed, and what these arms exist to hold:
 * the panel renders EVERY exchange as a chat thread instead of one at a time
 * with a dimmed list above it (`:372`), `←`/`→` stepping is gone (`:382`), and
 * `x` clears the whole thread rather than "the earlier list" (`:385`). What it
 * did not change: `c` still copies RAW MARKDOWN (`:383`) — now the LATEST
 * answer, since there is no displayed one to mean — bare `/btw` still reopens
 * on the most recent exchange (`:374`), and `f` (`:384`) is still a recorded
 * narrowing with no action.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  EMPTY_SIDE_QUESTION_RING,
  appendExchange,
  clearThread,
  copyPayload,
  currentExchange,
  getSideQuestionRing,
  hasPendingExchange,
  resetSideQuestionRingsForTest,
  resolveExchange,
  sideQuestionOverlayKeyAction,
  sideQuestionThreadMessages,
  subscribeSideQuestionRings,
  updateSideQuestionRing,
  viewNewest,
  type SideQuestionRingState,
} from '../side-question-ring'

function ringWithThree(): SideQuestionRingState {
  let state = EMPTY_SIDE_QUESTION_RING
  state = appendExchange(state, { id: 'a', question: 'first?', timestamp: 1 })
  state = resolveExchange(state, 'a', { text: 'answer **one**' })
  state = appendExchange(state, { id: 'b', question: 'second?', timestamp: 2 })
  state = resolveExchange(state, 'b', { text: 'answer *two*' })
  state = appendExchange(state, { id: 'c', question: 'third?', timestamp: 3 })
  state = resolveExchange(state, 'c', { text: 'answer `three`' })
  return state
}

/** The i18n seam, stubbed so this module stays pure and the pins are exact. */
const LABELS = {
  failure: (error: string) => `a sentence about ${error}`,
}

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function strippedPanel(): string {
  return readFileSync(new URL('../SideQuestionOverlay.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('side-question ring', () => {
  it('appends pending exchanges and points at the newest', () => {
    let state = appendExchange(EMPTY_SIDE_QUESTION_RING, { id: 'a', question: 'q?', timestamp: 1 })
    expect(currentExchange(state)).toMatchObject({ id: 'a', pending: true })
    expect(hasPendingExchange(state)).toBe(true)
    // Nothing answered yet — `c` must be inert.
    expect(copyPayload(state)).toBeNull()

    state = resolveExchange(state, 'a', { text: 'the answer' })
    expect(currentExchange(state)).toMatchObject({ id: 'a', pending: false, answer: 'the answer' })
    expect(hasPendingExchange(state)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // D1.399 — the panel is a chat THREAD (owner, 2026-09-19, screenshot: five
  // earlier questions stacked and scrolling at the TOP of the card).
  // -------------------------------------------------------------------------

  it('renders EVERY exchange as messages, oldest first — three resolved make six', () => {
    const messages = sideQuestionThreadMessages(ringWithThree(), LABELS)

    expect(messages).toHaveLength(6)
    expect(messages.map(m => [m.role, m.content])).toEqual([
      ['user', 'first?'],
      ['assistant', 'answer **one**'],
      ['user', 'second?'],
      ['assistant', 'answer *two*'],
      ['user', 'third?'],
      ['assistant', 'answer `three`'],
    ])
    // Ids must be unique or the chat list keys collide.
    expect(new Set(messages.map(m => m.id)).size).toBe(6)
    // Ascending, so the newest lands at the BOTTOM like the main chat.
    const stamps = messages.map(m => m.timestamp)
    expect([...stamps].sort((x, y) => x - y)).toEqual(stamps)
  })

  it('a pending exchange is its question alone, with the answered ones above (F1.179)', () => {
    let state = ringWithThree()
    state = appendExchange(state, { id: 'd', question: 'fourth?', timestamp: 4 })

    // D1.392 forked an `isIntermediate` "thinking" message here. F1.179 moved the
    // in-flight state onto the session (`isProcessing`), whose `ProcessingIndicator`
    // is the one affordance — so the newest message is the pending QUESTION.
    const messages = sideQuestionThreadMessages(state, LABELS)
    expect(messages).toHaveLength(7)
    expect(messages[6]).toMatchObject({ role: 'user', content: 'fourth?' })
    expect(messages.some(message => message.isIntermediate === true)).toBe(false)
  })

  it('renders a failed exchange as its SENTENCE, never as the code (D1.398)', () => {
    let state = appendExchange(EMPTY_SIDE_QUESTION_RING, { id: 'e', question: 'why?', timestamp: 1 })
    state = resolveExchange(state, 'e', { error: 'agent-start-failed' })

    const messages = sideQuestionThreadMessages(state, LABELS)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ role: 'error', content: 'a sentence about agent-start-failed' })
    // The labels seam CAN spell the code, which is what makes this negative real.
    expect(messages[1]?.content).not.toBe('agent-start-failed')
  })

  it('renders nothing for an empty ring', () => {
    expect(sideQuestionThreadMessages(EMPTY_SIDE_QUESTION_RING, LABELS)).toEqual([])
  })

  it('c copies the LATEST ANSWER as raw Markdown, even while a newer question is in flight', () => {
    expect(copyPayload(ringWithThree())).toBe('answer `three`')

    // The newest exchange is pending: `c` walks back to the newest ANSWER.
    let state = appendExchange(ringWithThree(), { id: 'd', question: 'fourth?', timestamp: 4 })
    expect(copyPayload(state)).toBe('answer `three`')

    // ...and past a failure too.
    state = resolveExchange(state, 'd', { error: 'agent-start-failed' })
    expect(copyPayload(state)).toBe('answer `three`')

    // Nothing answered at all — inert rather than copying garbage.
    let failed = appendExchange(EMPTY_SIDE_QUESTION_RING, { id: 'e', question: 'q?', timestamp: 1 })
    failed = resolveExchange(failed, 'e', { error: 'agent-start-failed' })
    expect(copyPayload(failed)).toBeNull()
  })

  it('x clears the WHOLE thread (D1.399, re-reading :385)', () => {
    const state = clearThread(ringWithThree())
    expect(state.exchanges).toEqual([])
    expect(currentExchange(state)).toBeNull()
    expect(sideQuestionThreadMessages(state, LABELS)).toEqual([])
    // Identity-preserving on an empty ring, so no subscriber is woken for nothing.
    expect(clearThread(EMPTY_SIDE_QUESTION_RING)).toBe(EMPTY_SIDE_QUESTION_RING)
  })

  it('keeps viewIndex pinned to the newest exchange — nothing can move it (:374)', () => {
    const state = ringWithThree()
    expect(state.viewIndex).toBe(state.exchanges.length - 1)
    expect(currentExchange(state)!.id).toBe('c')
    // The bare-`/btw` reopen is therefore a no-op, and says so by identity.
    expect(viewNewest(state)).toBe(state)
    expect(viewNewest(EMPTY_SIDE_QUESTION_RING)).toBe(EMPTY_SIDE_QUESTION_RING)
  })

  it('drops the Left/Right stepping from the key table and renames x to clear-thread', () => {
    expect(sideQuestionOverlayKeyAction(' ')).toBe('dismiss')
    expect(sideQuestionOverlayKeyAction('Enter')).toBe('dismiss')
    expect(sideQuestionOverlayKeyAction('Escape')).toBe('dismiss')
    expect(sideQuestionOverlayKeyAction('ArrowUp')).toBe('scroll-up')
    expect(sideQuestionOverlayKeyAction('ArrowDown')).toBe('scroll-down')
    expect(sideQuestionOverlayKeyAction('ArrowLeft')).toBeNull()
    expect(sideQuestionOverlayKeyAction('ArrowRight')).toBeNull()
    expect(sideQuestionOverlayKeyAction('c')).toBe('copy')
    expect(sideQuestionOverlayKeyAction('x')).toBe('clear-thread')
    expect(sideQuestionOverlayKeyAction('f')).toBeNull()
    expect(sideQuestionOverlayKeyAction('q')).toBeNull()
  })

  it('the panel builds its messages from the thread, and shows no dimmed list', () => {
    const panel = strippedPanel()
    expect(panel).toContain('sideQuestionThreadMessages(')
    expect(panel).toContain('clearThread')
    // The dimmed earlier list and the stepping it existed to navigate.
    expect(panel).not.toContain('earlierExchanges')
    expect(panel).not.toContain('earlier.map(')
    expect(panel).not.toContain('stepOlder')
    expect(panel).not.toContain('stepNewer')
    expect(panel).not.toContain('clearEarlier')
    // The `← / →` hint left with the keys; its two siblings stayed.
    expect(panel).not.toContain('sideQuestion.stepHint')
    expect(panel).toContain('sideQuestion.copyHint')
    expect(panel).toContain('sideQuestion.clearHint')
  })

  /**
   * F1.94 (origin D1.407) — NO CAP, decided 2026-09-23: a cap would silently
   * discard a user's own answers, and the thread is human-paced. N = 50 is what a
   * cap would plausibly have been; the pair shows that crossing it drops nothing,
   * so a cap added later turns the N+1 arm red rather than passing unseen.
   */
  it('drops nothing at N = 50 or at N + 1 — the thread is never capped (F1.94)', () => {
    const N = 50
    const ringOf = (count: number) => {
      let state = EMPTY_SIDE_QUESTION_RING
      for (let index = 0; index < count; index += 1) {
        state = appendExchange(state, { id: `x${index}`, question: `q${index}?`, timestamp: index })
        state = resolveExchange(state, `x${index}`, { text: `answer ${index}` })
      }
      return state
    }

    const atN = ringOf(N)
    expect(atN.exchanges.map(exchange => exchange.id)).toEqual(Array.from({ length: N }, (_, index) => `x${index}`))

    const pastN = ringOf(N + 1)
    // The oldest is still there, nothing between went missing, and the newest is last.
    expect(pastN.exchanges).toHaveLength(N + 1)
    expect(pastN.exchanges[0]?.id).toBe('x0')
    expect(pastN.exchanges[N]?.id).toBe(`x${N}`)
    expect(pastN.viewIndex).toBe(N)
    // `c` still answers the latest, and the whole thread is still drawn.
    expect(copyPayload(pastN)).toBe(`answer ${N}`)
    expect(sideQuestionThreadMessages(pastN, LABELS)).toHaveLength(2 * (N + 1))
  })

  it('keeps rings per session in the renderer-only store and notifies subscribers', () => {
    resetSideQuestionRingsForTest()
    let notified = 0
    const unsubscribe = subscribeSideQuestionRings(() => { notified += 1 })

    updateSideQuestionRing('session-1', state =>
      appendExchange(state, { id: 'a', question: 'q1?', timestamp: 1 }))
    updateSideQuestionRing('session-2', state =>
      appendExchange(state, { id: 'b', question: 'q2?', timestamp: 2 }))

    expect(getSideQuestionRing('session-1').exchanges.map(x => x.id)).toEqual(['a'])
    expect(getSideQuestionRing('session-2').exchanges.map(x => x.id)).toEqual(['b'])
    expect(getSideQuestionRing('session-3')).toBe(EMPTY_SIDE_QUESTION_RING)
    expect(notified).toBe(2)

    // Identity-preserving no-ops do not notify (useSyncExternalStore contract).
    updateSideQuestionRing('session-1', state => state)
    expect(notified).toBe(2)

    unsubscribe()
    resetSideQuestionRingsForTest()
  })
})
