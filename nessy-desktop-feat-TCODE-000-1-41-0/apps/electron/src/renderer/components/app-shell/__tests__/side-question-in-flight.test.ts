/**
 * F1.179 (origin WJ-g, P-WJ-g-1) — the `/btw` panel reports a REAL in-flight
 * state, and the two things that blocked it are closed first.
 *
 * ## What changed
 *
 * The panel mounts a compact `ChatDisplay` over a synthetic session
 * (`side-question:<real id>`). Until this row that session was NEVER
 * `isProcessing`, and the panel said "thinking" as a forked `isIntermediate`
 * assistant message in its thread (D1.392). D1.397 designed the honest shape —
 * the panel reports `isProcessing` while its answer is in flight, so the chat
 * draws the SAME `ProcessingIndicator` (spinner, cycling word, elapsed time) the
 * main chat and `EditPopover`'s inline chat draw — and WJ-g measured two
 * blockers before flipping it (F1.92's report, recorded in
 * `input/submit-control.ts`'s header):
 *
 *  1. `ChatDisplay`'s `chat.backgroundInFlightTask` chord was gated on
 *     `session?.isProcessing === true` ALONE, and its handler sends
 *     `sessionCommand(session.id, …)`. The action registry runs the FIRST
 *     ENABLED handler (`actions/registry.tsx`, `execute` and the key path both
 *     `break` on it), so with the panel open and in flight while the main
 *     session is idle, the panel's registration becomes the live one and the
 *     chord round-trips an id no server knows — the class D1.383 closed.
 *  2. The forked `thinking` message would have stood beside the
 *     `ProcessingIndicator` — TWO in-flight affordances in one message list.
 *
 * So: the chord asks {@link isHostTurnInFlight} (a turn in flight on a session
 * the HOST minted), the thread stops forking the word, and the synthetic session
 * reports `isProcessing: pending`.
 *
 * ## What the composer does about it (already pinned, not re-pinned)
 *
 * `resolveSubmitControl` answers `loading` — never `stop` — for a minted id that
 * reports a turn in flight (`submit-control.test.ts`, "THE ROW'S CONTROL"), so
 * flipping the flag cannot arm a Stop no server would answer. The composer's own
 * control is the composer's affordance, exactly as a real session's Stop is;
 * "exactly one" in this row is about the MESSAGE LIST, where there used to be
 * room for two.
 *
 * ## The instrument
 *
 * The chord's gate and the thread are DRIVEN (pure functions). The two wirings
 * that cannot be driven without mounting `ChatDisplay` — whose module graph costs
 * ~136 s under bun (AGENTS.md §Traps, the `pdfjs`/`DOMMatrix` bullet) — are
 * pinned on comment-stripped source, each region bounded by an END ANCHOR read
 * out of the file (never a character count) and each carrying a control that
 * fails if the region runs past the thing it is about.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as stubSession from '../input/stub-session'
import { sideQuestionSessionId } from '../side-question-composer'
import {
  EMPTY_SIDE_QUESTION_RING,
  appendExchange,
  hasPendingExchange,
  resolveExchange,
  sideQuestionThreadMessages,
} from '../side-question-ring'

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const LABELS = { failure: (error: string) => `a sentence about ${error}` }

describe('F1.179 — the chord that round-trips `sessionCommand` fires only for a HOST session', () => {
  it('THE DEFECT — the panel in flight must not enable the chord (its id is renderer-minted)', () => {
    const panel = { id: sideQuestionSessionId('session-a'), isProcessing: true }
    expect(stubSession.isHostTurnInFlight(panel)).toBe(false)
    // `EditPopover`'s pre-session stub is the other id the renderer mints, and
    // the same rule covers it rather than a second spelling of it.
    expect(stubSession.isHostTurnInFlight({ id: stubSession.EDIT_POPOVER_STUB_SESSION_ID, isProcessing: true }))
      .toBe(false)
  })

  it('NEGATIVE — the same chord on a REAL session stays live', () => {
    // The positive control that the rule is keyed on the ID: the identical call
    // shape over a host-minted id answers true.
    expect(stubSession.isHostTurnInFlight({ id: 'session-a', isProcessing: true })).toBe(true)
  })

  it('BOUNDARY — nothing in flight, or no session at all, is never live', () => {
    expect(stubSession.isHostTurnInFlight({ id: 'session-a', isProcessing: false })).toBe(false)
    expect(stubSession.isHostTurnInFlight({ id: 'session-a' })).toBe(false)
    expect(stubSession.isHostTurnInFlight(undefined)).toBe(false)
    expect(stubSession.isHostTurnInFlight(null)).toBe(false)
  })

  it('WIRING — ChatDisplay registers the chord behind that gate, and nothing else', () => {
    const src = stripped('../ChatDisplay.tsx')
    const at = src.indexOf("useAction('chat.backgroundInFlightTask'")
    // END ANCHOR: the hook call that follows the chord in the component body.
    const end = src.indexOf('useTurnCardExpansion(', at)
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    const region = src.slice(at, end)
    // CONTROL: the region is ONE registration — it did not run into a neighbour.
    expect(region.match(/useAction\(/g)).toHaveLength(1)
    // …and it is the round trip this row is about.
    expect(region).toContain("sessionCommand(sessionId, { type: 'backgroundInFlightTasks' })")
    // THE CLAIM.
    expect(region).toContain('{ enabled: () => isHostTurnInFlight(session) }')
    expect(region).not.toContain('enabled: () => session?.isProcessing === true })')
    // The gate is the ONE spelling, imported rather than re-derived here.
    // (F1.167 extended that import line in place; the claim is the source module.)
    expect(src).toMatch(/^import \{[^}\n]*\bisHostTurnInFlight\b[^}\n]*\} from "\.\/input\/stub-session"$/m)
  })
})

describe('F1.179 — the panel reports its in-flight state, and the thread stops forking it', () => {
  it('THE DEFECT — a pending exchange renders its QUESTION and nothing else', () => {
    const ring = appendExchange(EMPTY_SIDE_QUESTION_RING, { id: 'd', question: 'fourth?', timestamp: 4 })
    expect(hasPendingExchange(ring)).toBe(true)
    // No in-flight word forked into the list: the `ProcessingIndicator` the
    // processing session draws is the ONE affordance there.
    expect(sideQuestionThreadMessages(ring, LABELS)).toEqual([
      { id: 'd-q', role: 'user', content: 'fourth?', timestamp: 4 },
    ])
  })

  it('CONTROL — the answer still lands under its question once it arrives', () => {
    const ring = resolveExchange(
      appendExchange(EMPTY_SIDE_QUESTION_RING, { id: 'd', question: 'fourth?', timestamp: 4 }),
      'd',
      { text: 'the answer' },
    )
    expect(hasPendingExchange(ring)).toBe(false)
    expect(sideQuestionThreadMessages(ring, LABELS).map(m => [m.role, m.content])).toEqual([
      ['user', 'fourth?'],
      ['assistant', 'the answer'],
    ])
  })

  it('WIRING — the synthetic session is processing exactly while an answer is pending', () => {
    const overlay = stripped('../SideQuestionOverlay.tsx')
    const at = overlay.indexOf('const overlaySession = React.useMemo(')
    // END ANCHOR: the next hook in the component, below the session's builder.
    const end = overlay.indexOf('React.useEffect(', at)
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    const region = overlay.slice(at, end)
    // CONTROL: one builder, not the builder plus the focus effect below it.
    expect(region).not.toContain('SIDE_QUESTION_COMPOSER_SELECTOR')
    // THE CLAIM, and the forked word's label is gone with the word.
    expect(region).toContain('isProcessing: pending,')
    expect(region).not.toContain('isProcessing: false')
    expect(region).not.toContain('thinking:')
    // `pending` is a dependency of the memo, or the flag would go stale.
    expect(region).toMatch(/\}\), \[[^\]]*\bpending\b[^\]]*\]\)/)
  })

  it('CONSEQUENCE — the compact composer collapses while processing, so focus is handed back on settle', () => {
    // `InputContainer` collapses a compact composer while `isProcessing` (the
    // `EditPopover` shape), which unmounts the editable element. The panel gives
    // focus back when the answer lands — only from the dropped (body) state.
    const container = stripped('../input/InputContainer.tsx')
    expect(container).toContain('const isCollapsedInCompact = compactMode && isProcessing && !expandedDuringProcessing')
    const overlay = stripped('../SideQuestionOverlay.tsx')
    const at = overlay.indexOf('const wasPending = React.useRef(pending)')
    // END ANCHOR: the key handler declared after the effect.
    const end = overlay.indexOf('const scrollAnswer = React.useCallback(', at)
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    const region = overlay.slice(at, end)
    // CONTROL: the region is this one effect, not the key handler below it.
    expect(region).not.toContain('sideQuestionOverlayKeyAction(')
    expect(region).toContain('const settled = wasPending.current && !pending')
    expect(region).toContain('document.activeElement !== document.body) return')
    expect(region).toContain('querySelector<HTMLElement>(SIDE_QUESTION_COMPOSER_SELECTOR)?.focus()')
  })

  it('WIRING — ChatDisplay draws ONE ProcessingIndicator, keyed on `isProcessing` alone', () => {
    const src = stripped('../ChatDisplay.tsx')
    // One drawing site, so "the indicator" is a single thing to reason about.
    expect(src.match(/<ProcessingIndicator\b/g)).toHaveLength(1)
    const draw = src.indexOf('<ProcessingIndicator')
    // END ANCHOR read backwards: the render guard is the nearest `&& (() => {`.
    const guard = src.lastIndexOf('&& (() => {', draw)
    expect(guard).toBeGreaterThan(-1)
    const opener = src.lastIndexOf('{', guard)
    const condition = src.slice(opener, guard)
    // The compact embedding (the panel) is NOT excluded — that is what makes the
    // panel's flip draw the indicator at all.
    expect(condition.trim()).toBe('{session.isProcessing')
    expect(condition).not.toContain('compactMode')
  })
})
