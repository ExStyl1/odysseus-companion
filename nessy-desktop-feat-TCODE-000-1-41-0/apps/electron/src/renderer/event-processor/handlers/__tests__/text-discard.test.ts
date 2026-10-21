/**
 * F1.298 — the renderer removes a failed attempt's UNFINISHED text when the Pi
 * adapter says so (`text_discard`), and nothing else.
 *
 * Both SDK attempts stream into the same sub-turn id, so before this row the
 * retried deltas were APPENDED to the failed partial by `handleTextDelta` —
 * the bubble read "Partial ansFull answer" until `text_complete` replaced it
 * (the WJ-dd verifier's probe P4). Ported from craft-agents-oss v0.13.4's
 * `handleTextDiscard` (`renderer/event-processor/handlers/text.ts`,
 * Apache-2.0): only an assistant message of THAT turnId that is still
 * streaming or pending goes; completed history, other turns and the user's
 * own rows are untouched.
 */
import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../../event-processor/processor'
import type { AgentEvent, SessionState } from '../../types'

const SESSION = 'session-f1298'

function runningTurn(): SessionState {
  return {
    session: {
      id: SESSION,
      messages: [
        { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
        // Completed earlier text of the SAME sub-turn id: a finished message is history.
        { id: 'a0', role: 'assistant', content: 'Earlier, completed', timestamp: 2, turnId: 'pi-turn-0__m0' },
      ],
      lastMessageAt: 2,
      isProcessing: true,
    } as never,
    streaming: null,
  }
}

const apply = (state: SessionState, event: Record<string, unknown>) => processEvent(state, event as unknown as AgentEvent).state

describe('F1.298 — text_discard removes only the failed attempt\'s unfinished text', () => {
  it('the retried answer does not append to the discarded partial', () => {
    let state = apply(runningTurn(), { type: 'text_delta', sessionId: SESSION, delta: 'Partial ans', turnId: 'pi-turn-1__m0' })
    expect(state.session.messages.at(-1)?.content).toBe('Partial ans')
    state = apply(state, { type: 'text_discard', sessionId: SESSION, turnId: 'pi-turn-1__m0' })
    expect(state.session.messages.map(message => message.id)).toEqual(['u1', 'a0'])
    expect(state.streaming).toBeNull()
    state = apply(state, { type: 'text_delta', sessionId: SESSION, delta: 'Full ', turnId: 'pi-turn-1__m0' })
    state = apply(state, { type: 'text_delta', sessionId: SESSION, delta: 'answer', turnId: 'pi-turn-1__m0' })
    expect(state.session.messages.at(-1)?.content).toBe('Full answer')
    expect(state.session.messages.filter(message => message.role === 'assistant')).toHaveLength(2)
  })

  it('CONTROL — completed history and another turn\'s streaming text stay', () => {
    let state = apply(runningTurn(), { type: 'text_delta', sessionId: SESSION, delta: 'other turn', turnId: 'pi-turn-2__m0' })
    state = apply(state, { type: 'text_discard', sessionId: SESSION, turnId: 'pi-turn-0__m0' })
    expect(state.session.messages.map(message => message.content)).toEqual(['hi', 'Earlier, completed', 'other turn'])
    expect(state.streaming?.turnId).toBe('pi-turn-2__m0')
  })
})
