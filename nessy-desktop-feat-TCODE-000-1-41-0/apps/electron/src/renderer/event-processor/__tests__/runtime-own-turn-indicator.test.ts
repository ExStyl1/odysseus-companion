/**
 * F1.524 (2) — the host's busy indicator for a turn the claude child opened itself
 * (`packages/server-core/src/sessions/runtime-own-turn-indicator.ts`), driven into the REAL renderer event processor,
 * so the pin is what a window shows and not what the host meant to send (the cross-package import is
 * `handoff-turn-end-agrees-with-host.test.ts`'s).
 *
 * (a) A running own turn raises the renderer's `isProcessing` with NO transcript row (a `runtime_turn` status reads
 *     like a hook's), and its end lowers it again — also healing D1.379's raise from a between-turns `tool_start`,
 *     which before this row nothing lowered, and ending a tool row the door left `executing`.
 * (b) While a HOST turn runs the host owns the indicator: nothing is sent at the own turn's start, and — the case
 *     that matters — no `complete` at its end, which would lower a running host turn.
 * (c) An own turn this module did not raise (it started while a host turn ran) sends no `complete` at its end.
 * CONTROL: the D1.379 strand this closes, reproduced without the module — a between-turns `tool_start` raises the
 *     renderer's `isProcessing` and nothing that crosses between turns lowers it.
 */
import { describe, expect, it } from 'bun:test'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { processEvent } from '../processor'
import type { AgentEvent, SessionState } from '../types'
import { runtimeOwnTurnIndicator } from '../../../../../../packages/server-core/src/sessions/runtime-own-turn-indicator'

const SID = 'session-f1-524-2'

function idle(): SessionState {
  return {
    session: {
      id: SID,
      messages: [{ id: 'u1', role: 'user', content: 'start a background subagent', timestamp: 1 }],
      lastMessageAt: 1,
      isProcessing: false,
    } as never,
    streaming: null,
  }
}

/** A host double: records what went out, applies it to the renderer's state, and says whether a host turn runs. */
function harness(hostTurn: { running: boolean } = { running: false }) {
  let state = idle()
  const sent: SessionEvent[] = []
  const apply = (event: SessionEvent) => {
    sent.push(event)
    state = processEvent(state, event as unknown as AgentEvent).state
  }
  const onPhase = runtimeOwnTurnIndicator(SID, {
    hostTurnRunning: () => hostTurn.running,
    send: apply,
    endTurn: apply,
  })
  return { onPhase, sent, apply, get state() { return state } }
}

const betweenTurnsToolStart = {
  type: 'tool_start', sessionId: SID, toolName: 'Read', toolUseId: 'toolu_own_read', toolInput: {}, timestamp: 2,
} as unknown as SessionEvent

describe('F1.524 (2) — the renderer shows a turn the claude child opened itself, and stops showing it', () => {
  it('(a) running raises isProcessing with no transcript row; ended lowers it and ends the door\'s tool row', () => {
    const h = harness()
    h.onPhase('running')
    expect(h.sent.map(e => e.type)).toEqual(['status'])
    expect(h.state.session.isProcessing).toBe(true)
    expect(h.state.session.messages.map(m => m.role)).toEqual(['user'])

    // The own turn's tool row, as F1.511's door delivers it.
    h.apply(betweenTurnsToolStart)
    expect(h.state.session.messages.some(m => m.role === 'tool' && m.toolStatus === 'executing')).toBe(true)

    h.onPhase('ended')
    expect(h.sent.map(e => e.type)).toEqual(['status', 'tool_start', 'complete'])
    expect(h.state.session.isProcessing).toBe(false)
    expect(h.state.session.messages.some(m => m.role === 'tool' && m.toolStatus === 'executing')).toBe(false)
  })

  it('(b) a host turn running at the own turn\'s start owns the indicator: nothing is sent, start or end', () => {
    const hostTurn = { running: true }
    const h = harness(hostTurn)
    h.onPhase('running')
    h.onPhase('ended')
    expect(h.sent).toEqual([])
  })

  it('(c) an own turn this module raised, ending after a host turn started, sends no complete', () => {
    const hostTurn = { running: false }
    const h = harness(hostTurn)
    h.onPhase('running')
    hostTurn.running = true // F1.540: a host turn started and waits the own turn out
    h.onPhase('ended')
    expect(h.sent.map(e => e.type)).toEqual(['status'])
  })

  it('CONTROL — without the module, a between-turns tool_start raises isProcessing and nothing lowers it', () => {
    let state = idle()
    state = processEvent(state, betweenTurnsToolStart as unknown as AgentEvent).state
    expect(state.session.isProcessing).toBe(true)
    // The own turn's words and its tool result are all that crosses after it; neither is a terminal event.
    state = processEvent(state, { type: 'tool_result', sessionId: SID, toolUseId: 'toolu_own_read', toolName: 'Read', result: 'x' } as unknown as AgentEvent).state
    state = processEvent(state, { type: 'text_complete', sessionId: SID, text: 'the answer' } as unknown as AgentEvent).state
    expect(state.session.isProcessing).toBe(true)
  })
})
