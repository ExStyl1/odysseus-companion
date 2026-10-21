/**
 * P3.16 · what a delta that lands AFTER the turn ended does to the transcript,
 * measured on the real event-processor.
 *
 * This file is the RENDERER half of P3.16, and on its own it proves only what
 * the renderer does with an event order a human typed here. It is deliberately
 * NOT the proof that the emitter produces that order — review found the two
 * halves were joined by nothing but a hand-copied list, so `sendTurnEndEvent`
 * could regress with this file still green. The join now has its own rig, which
 * feeds the wire a real `SessionManager` actually emitted into the real
 * `processEvent` below:
 * `apps/electron/src/renderer/event-processor/__tests__/delta-flush-emitter-to-renderer.test.ts`.
 *
 * The cause half — the emitter's wire ORDER — is in
 * `packages/server-core/src/sessions/__tests__/delta-flush-before-turn-end.test.ts`,
 * where `SessionManager` learned to flush its 50 ms delta batch before every
 * renderer-facing `complete`/`interrupted`.
 *
 * The seam exists because P3.14 made `handleComplete` lower `isStreaming` and
 * `isPending` on every assistant bubble (correctly — a finished turn may not
 * leave one spinning). `handleTextDelta` finds its bubble with
 * `findStreamingMessage`, which matches on `turnId` AND `isStreaming`, so once
 * the turn has completed the next delta of the SAME message matches nothing and
 * appends a second bubble. That is the trade P3.14's review recorded, and it is
 * not repairable here: the renderer cannot know a delta is still queued
 * upstream. Hence the fix at the emitter, and hence these rows — they say what
 * the wire order upstream now guarantees, and what it buys.
 */
import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

function drive(events: AgentEvent[]): SessionState {
  let state: SessionState = { session: { id: 's1', messages: [], isProcessing: true } as never, streaming: null }
  for (const event of events) state = processEvent(state, event).state
  return state
}

const contents = (state: SessionState) => state.session.messages.map(m => m.content)
const live = (state: SessionState) => state.session.messages.filter(m => m.isStreaming || m.isPending)

const delta = (text: string): AgentEvent => ({ type: 'text_delta', sessionId: 's1', delta: text, turnId: 'X' })
const COMPLETE: AgentEvent = { type: 'complete', sessionId: 's1' }
const INTERRUPTED: AgentEvent = { type: 'interrupted', sessionId: 's1' }
const COMPLETION: AgentEvent = {
  type: 'text_complete', sessionId: 's1', text: 'Hello world', turnId: 'X', timestamp: 7, messageId: 'm-x',
}

describe('P3.16 · a queued delta must reach the renderer before the turn ends', () => {
  it('flushed first, the turn renders ONE bubble carrying the whole message', () => {
    const state = drive([delta('Hello '), delta('world'), COMPLETE, COMPLETION])

    expect(contents(state)).toEqual(['Hello world'])
    expect(live(state)).toEqual([])
    expect(state.session.messages[0].id).toBe('m-x')

    // POSITIVE CONTROL — the ONLY difference is where the second delta lands.
    // Delivered after the `complete` (what the 50 ms batch timer did before
    // P3.16) it appends a second bubble, and the completion then fills THAT one
    // with the whole message: the user reads the prefix twice.
    const lateDelta = drive([delta('Hello '), COMPLETE, delta('world'), COMPLETION])
    expect(contents(lateDelta)).toEqual(['Hello ', 'Hello world'])
  })

  it('a late delta with no completion behind it leaves a bubble spinning', () => {
    // The second measured outcome: the handoff paths (auth, plan submission)
    // end the turn without a `text_complete`, so nothing arrives to retire the
    // bubble the late delta created — it claims to be live until some LATER
    // turn's `complete` heals it.
    const orphaned = drive([delta('Hello '), COMPLETE, delta('world')])
    expect(contents(orphaned)).toEqual(['Hello ', 'world'])
    expect(live(orphaned).map(m => m.content)).toEqual(['world'])

    // Flushed before the `complete`, the same three events leave one bubble and
    // nothing live.
    const flushed = drive([delta('Hello '), delta('world'), COMPLETE])
    expect(contents(flushed)).toEqual(['Hello world'])
    expect(live(flushed)).toEqual([])
  })

  it('the user-stop path has the identical split', () => {
    // `handleInterrupted` clears the same two flags, so `interrupted` opens the
    // same seam — which is why P3.16 routes it through the same flush.
    const orphaned = drive([delta('Hello '), INTERRUPTED, delta('world')])
    expect(live(orphaned).map(m => m.content)).toEqual(['world'])

    const flushed = drive([delta('Hello '), delta('world'), INTERRUPTED])
    expect(contents(flushed)).toEqual(['Hello world'])
    expect(live(flushed)).toEqual([])
  })
})
