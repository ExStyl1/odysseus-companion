/**
 * UB12.7 — a turn that ENDS retires a `compacting` status row its compaction never converted.
 *
 * F1.729 (`6f34139be`) has Pi's manual /compact yield "Compacting context..." BEFORE `requestCompact`, so the wait
 * has a label and a Stop. The host stamps it `statusType: 'compacting'` and the renderer appends it as a status row.
 * Only two things retired that row: `handleInfo`'s `compaction_complete` (which converts EVERY compacting row) and
 * `handleInterrupted`'s status filter. On F1.856's nothing-to-compact refusal (a plain info) and on a failure (an
 * error) neither arrives, so the row outlived its turn: a finished-looking "Compacting context..." beside "Nothing to
 * compact", a spinner after the error, and the next successful compaction turned the leftover row into a second
 * "Conversation Compacted" divider (F1.931 draws every converted row). Status rows are never persisted, so after a
 * reload the row was already gone; the turn end now makes the live view agree, as F1.356 does for retry rows.
 *
 * Driven through the real `processEvent` and the real `groupMessagesByTurn`, with the events in the order the host
 * forwards them.
 */
import { describe, expect, it } from 'bun:test'
import type { Message } from '@nessy-agent/core'
import { groupMessagesByTurn, type AssistantTurn } from '@nessy-agent/ui/chat/turn-utils'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

const SID = 's1'
const COMPACTING = { type: 'status', sessionId: SID, message: 'Compacting context...', statusType: 'compacting' }
const REFUSAL = { type: 'info', sessionId: SID, message: 'Nothing to compact (session too small)' }
const COMPACTED = { type: 'info', sessionId: SID, message: 'Compacted context to fit within limits (from ~91,641 tokens)', statusType: 'compaction_complete' }
const COMPLETE = { type: 'complete', sessionId: SID }

let clock = 1
function start(): SessionState {
  clock = 1
  return { session: { id: SID, messages: [], lastMessageAt: 1, isProcessing: false }, streaming: null } as unknown as SessionState
}
function userTurn(state: SessionState, content: string): SessionState {
  const message = { id: `u${++clock}`, role: 'user', content, timestamp: ++clock }
  return { ...state, session: { ...state.session, isProcessing: true, messages: [...state.session.messages, message] } } as unknown as SessionState
}
function run(state: SessionState, events: unknown[]): SessionState {
  return events.reduce<SessionState>((s, event) => processEvent(s, { timestamp: ++clock, ...(event as object) } as unknown as AgentEvent).state, state)
}
const rows = (state: SessionState) => state.session.messages as unknown as Array<{ id: string; role: string; statusType?: string; content: string }>
const statusRows = (state: SessionState) => rows(state).filter(m => m.role === 'status')
const dividers = (state: SessionState) => rows(state).filter(m => m.role === 'info' && m.statusType === 'compaction_complete')
const statusActivities = (state: SessionState) =>
  groupMessagesByTurn(state.session.messages as unknown as Message[])
    .filter((turn): turn is AssistantTurn => turn.type === 'assistant')
    .flatMap(turn => turn.activities)
    .filter(activity => activity.type === 'status')

describe('UB12.7 — the turn end retires an unconverted compacting row', () => {
  it('refused /compact (F1.856 after F1.729): no "Compacting context..." row or activity is left beside "Nothing to compact"', () => {
    const state = run(userTurn(start(), '/compact'), [COMPACTING, REFUSAL, COMPLETE])
    expect(statusRows(state)).toEqual([])
    expect(statusActivities(state)).toEqual([])
    expect(rows(state).filter(m => m.role === 'info').map(m => m.content)).toEqual([REFUSAL.message])
  })

  it('failed compaction: the error ends the turn and no spinner survives it (error and typed_error)', () => {
    const errored = run(userTurn(start(), '/compact'), [COMPACTING, { type: 'error', sessionId: SID, error: 'Compaction failed: summary request returned 500' }])
    expect(statusRows(errored)).toEqual([])
    expect(statusActivities(errored)).toEqual([])
    const typed = run(userTurn(start(), '/compact'), [
      COMPACTING,
      { type: 'typed_error', sessionId: SID, error: { code: 'unknown_error', title: 'Compaction failed', message: 'summary request returned 500', canRetry: false, actions: [] } },
    ])
    expect(statusRows(typed)).toEqual([])
  })

  it('the next successful /compact after a refusal draws exactly ONE "Conversation Compacted" divider', () => {
    let state = run(userTurn(start(), '/compact'), [COMPACTING, REFUSAL, COMPLETE])
    state = run(userTurn(state, '/compact'), [COMPACTING, COMPACTED, COMPLETE])
    expect(dividers(state).map(m => m.content)).toEqual([COMPACTED.message])
    // The refusal's turn keeps its own answer and nothing claims it compacted.
    const order = rows(state).map(m => [m.role, m.statusType ?? '', m.content])
    expect(order.findIndex(([, , content]) => content === REFUSAL.message))
      .toBeLessThan(order.findIndex(([, statusType]) => statusType === 'compaction_complete'))
  })

  it('CONTROL — a compaction that completes converts its own row in place (same id); the turn end has nothing to retire', () => {
    const before = run(userTurn(start(), '/compact'), [COMPACTING])
    const rowId = statusRows(before)[0]?.id
    expect(rowId).toBeDefined()
    const state = run(before, [COMPACTED, COMPLETE])
    expect(dividers(state).map(m => m.id)).toEqual([rowId!])
    expect(statusRows(state)).toEqual([])
  })

  it('BOUNDARY — before the turn ends a compacting row is still RUNNING, and a plain status row survives the turn end', () => {
    const midTurn = run(userTurn(start(), '/compact'), [COMPACTING])
    expect(statusActivities(midTurn).map(activity => activity.status)).toEqual(['running'])
    const plain = run(userTurn(start(), 'go'), [
      { type: 'status', sessionId: SID, message: 'Auto-review approved this action' },
      COMPLETE,
    ])
    expect(statusRows(plain).map(m => m.content)).toEqual(['Auto-review approved this action'])
  })
})
