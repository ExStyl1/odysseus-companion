/**
 * F1.248 (a) — one retry run is ONE transcript row, not one spinning row per
 * attempt.
 *
 * `retryStatusEvent` (core/types) mints one status per attempt plus a
 * `Retry succeeded` line, and `SessionManager` stamps each `statusType:
 * 'retrying'`. `handleStatus` appended every one through `appendMessage`, which
 * de-duplicates by id only, and `turn-utils` turns each status message into a
 * `running` activity, so TurnCard drew a spinner per attempt that no later
 * attempt or completion replaced — they went away only on an interrupt
 * (`handleInterrupted` filters status rows) or a reload (the host does not
 * persist status rows). A retry run now keeps only its LATEST line: a
 * `retrying` status replaces a `retrying` row that is the transcript's last
 * message. Anything else — a compacting row, an assistant message between two
 * runs — breaks the run and stays.
 */

import { describe, expect, it } from 'bun:test'
import { retryStatusEvent } from '@nessy-agent/core/types'
import type { AgentRetryFacts } from '@nessy-agent/core/types'
import { handleComplete, handleError, handleStatus, handleTypedError } from '../session'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState, StatusEvent } from '../../types'
import { groupMessagesByTurn, type AssistantTurn } from '@nessy-agent/ui/chat/turn-utils'
import type { Message } from '@nessy-agent/core'

function stateWith(messages: unknown[] = []): SessionState {
  return { session: { id: 's1', messages }, streaming: null } as unknown as SessionState
}

/** The wire shape the host sends for a retry: the core event plus the stamped type. */
function retrying(facts: AgentRetryFacts): StatusEvent {
  const event = retryStatusEvent(facts)
  return { type: 'status', sessionId: 's1', message: event.message, retry: event.retry, statusType: 'retrying' }
}

const statusRows = (state: SessionState) =>
  (state.session.messages as Array<{ role: string; content: string; statusType?: string }>)
    .filter(message => message.role === 'status')

describe('handleStatus — F1.248 a retry run collapses into its latest line', () => {
  it('two retries plus a success leave ONE row, and it is the success', () => {
    let state = stateWith()
    state = handleStatus(state, retrying({ kind: 'rate_limit', attempt: 1, maxAttempts: 5, delaySeconds: 15 })).state
    state = handleStatus(state, retrying({ kind: 'rate_limit', attempt: 2, maxAttempts: 5, delaySeconds: 30 })).state
    const success = retrying({ kind: 'succeeded' })
    state = handleStatus(state, success).state

    const rows = statusRows(state)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe(success.message)
    // The chip still follows the latest status, as before.
    expect(state.session.currentStatus?.message).toBe(success.message)
  })

  it('a compacting row stays, and a retry after it is appended beside it', () => {
    let state = stateWith()
    state = handleStatus(state, {
      type: 'status', sessionId: 's1', message: 'Compacting conversation', statusType: 'compacting',
    }).state
    state = handleStatus(state, retrying({ kind: 'provider_error', attempt: 1, maxAttempts: 5 })).state
    state = handleStatus(state, retrying({ kind: 'provider_error', attempt: 2, maxAttempts: 5 })).state

    const rows = statusRows(state)
    expect(rows.map(row => row.statusType)).toEqual(['compacting', 'retrying'])
    expect(rows[1]?.content).toContain('retry 2/5')
  })

  // F1.438 — narrowed: two ATTEMPT rows with no `succeeded` between them. A success retires the whole run
  // of the turn (F1.437), so this arm stays a live control only while no success is in it.
  it('two attempt rows with a message between them and NO success keep both (only a CONSECUTIVE attempt is replaced)', () => {
    let state = stateWith()
    state = handleStatus(state, retrying({ kind: 'rate_limit', attempt: 1, maxAttempts: 5 })).state
    state = {
      ...state,
      session: {
        ...state.session,
        messages: [...state.session.messages, { id: 'a1', role: 'assistant', content: 'partial', timestamp: 1 }],
      },
    } as SessionState
    state = handleStatus(state, retrying({ kind: 'rate_limit', attempt: 1, maxAttempts: 5 })).state

    expect(statusRows(state)).toHaveLength(2)
  })
})

/**
 * F1.356 — the one surviving retry row kept its TurnCard spinner after the turn
 * ended: `handleComplete`, `handleError` and `handleTypedError` cleared only
 * `currentStatus`, `turn-utils` draws every status message as a `running`
 * activity, and status rows are not persisted, so the spinner lived until an
 * interrupt or a reload. Upstream craft-agents-oss v0.13.4's
 * `clearRetryStatus` (`event-processor/helpers.ts`, Apache-2.0) removes every
 * `retrying` row at the start of those three handlers; ported.
 *
 * UB12.7 — the same three handlers now also retire an UNCONVERTED `compacting`
 * row (its own arms: `compaction-status-turn-end.test.ts`), so the row these
 * arms keep as "history the retry clear must not touch" is a plain status row
 * (codex's auto-review approval line), which neither pass removes.
 */
describe('F1.356 — a turn that ends retires its retry rows', () => {
  const PLAIN = { type: 'status', sessionId: 's1', message: 'Auto-review approved this action' } as const
  function afterRetryRun(): SessionState {
    let state = stateWith([{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }])
    state = handleStatus(state, PLAIN).state
    state = handleStatus(state, { type: 'status', sessionId: 's1', message: 'Compacting conversation', statusType: 'compacting' }).state
    state = handleStatus(state, retrying({ kind: 'rate_limit', attempt: 1, maxAttempts: 5, delaySeconds: 15 })).state
    state = handleStatus(state, retrying({ kind: 'rate_limit', attempt: 2, maxAttempts: 5, delaySeconds: 30 })).state
    state = handleStatus(state, retrying({ kind: 'succeeded' })).state
    // Fixture positive control: the run's surviving row is really there before the turn ends.
    expect(statusRows(state).map(row => row.statusType)).toEqual([undefined, 'compacting', 'retrying'])
    return state
  }

  it('complete after two retries and a success leaves no retrying row; the plain status row survives (UB12.7: the unconverted compacting row goes too)', () => {
    const state = handleComplete(afterRetryRun(), { type: 'complete', sessionId: 's1' }).state
    expect(statusRows(state).map(row => row.content)).toEqual([PLAIN.message])
    expect(state.session.currentStatus).toBeUndefined()
  })

  it('error and typed_error retire them too', () => {
    const errored = handleError(afterRetryRun(), { type: 'error', sessionId: 's1', error: 'boom' }).state
    expect(statusRows(errored).map(row => row.content)).toEqual([PLAIN.message])
    const typed = handleTypedError(afterRetryRun(), {
      type: 'typed_error', sessionId: 's1', error: { code: 'rate_limited', title: 'Rate limited', message: 'slow down', canRetry: true } as never,
    }).state
    expect(statusRows(typed).map(row => row.content)).toEqual([PLAIN.message])
  })

  it('negative — a turn that ends with no retry run keeps every row it had', () => {
    let state = stateWith([{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }])
    state = handleStatus(state, PLAIN).state
    const before = state.session.messages
    state = handleComplete(state, { type: 'complete', sessionId: 's1' }).state
    expect(state.session.messages.filter(m => m.role !== 'info')).toEqual(before)
  })
})

/**
 * F1.437 / F1.438 — the success line retires the whole retry run of the turn,
 * in every runtime's ORDER, not only claude's.
 *
 * F1.248's collapse replaced only a TRAILING retry row. That is claude's order
 * (`succeeded` is published before the first delta). Pi (pi-coding-agent 0.84.4
 * emits `auto_retry_end{success}` after `message_end`) and codex with reasoning
 * (the reasoning `text_complete` lands before the delta that triggers the
 * success) append the retried answer FIRST, so two spinning attempt rows used to
 * survive, the last announcing a countdown that no longer applied. Driven
 * through the real `processEvent`, with each runtime's event order.
 */
describe('F1.437 — a success retires every attempt row of the turn, in each runtime\'s order', () => {
  const SID = 's1'
  const start = (): SessionState =>
    ({ session: { id: SID, messages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }], isProcessing: true }, streaming: null }) as unknown as SessionState
  const run = (events: unknown[]) => events.reduce<SessionState>((state, event) => processEvent(state, event as AgentEvent).state, start())
  const r1 = retrying({ kind: 'rate_limit', attempt: 1, maxAttempts: 5, delaySeconds: 15 })
  const r2 = retrying({ kind: 'rate_limit', attempt: 2, maxAttempts: 5, delaySeconds: 30 })
  const ok = retrying({ kind: 'succeeded' })

  it('Pi order (F1.438\'s arm): the retried answer lands between the last attempt and the success — ONE row, the success', () => {
    const state = run([
      r1, r2,
      { type: 'text_delta', sessionId: SID, delta: 'hel', turnId: 'm1' },
      { type: 'text_delta', sessionId: SID, delta: 'lo', turnId: 'm1' },
      { type: 'text_complete', sessionId: SID, text: 'hello', turnId: 'm1' },
      { type: 'usage_update', sessionId: SID, tokenUsage: { inputTokens: 10, contextWindow: 200_000 } },
      ok,
    ])
    const rows = statusRows(state)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe(ok.message)
  })

  it('codex order with reasoning: the reasoning completes before the success — ONE row', () => {
    const state = run([
      r1, r2,
      { type: 'text_complete', sessionId: SID, text: 'weighing', turnId: 'reasoning-1', isIntermediate: true, isThinking: true },
      ok,
      { type: 'text_delta', sessionId: SID, delta: 'answer', turnId: 'msg-1' },
    ])
    expect(statusRows(state)).toHaveLength(1)
  })

  it('control — claude order (success before the first delta) stays at ONE row', () => {
    const state = run([r1, r2, ok, { type: 'text_delta', sessionId: SID, delta: 'hi', turnId: 't1' }])
    expect(statusRows(state)).toHaveLength(1)
  })

  it('negative — a compacting row and two failed runs with no success keep their rows', () => {
    const state = run([
      { type: 'status', sessionId: SID, message: 'Compacting conversation', statusType: 'compacting' },
      r1,
      { type: 'text_complete', sessionId: SID, text: 'partial', turnId: 'm0' },
      r1,
    ])
    expect(statusRows(state).map(row => row.statusType)).toEqual(['compacting', 'retrying', 'retrying'])
  })

  it('a previous turn\'s rows are not this success\'s to retire', () => {
    let state = run([r1])
    state = { ...state, session: { ...state.session, messages: [...state.session.messages, { id: 'u2', role: 'user', content: 'again', timestamp: 3 }] } } as SessionState
    state = [r1, ok].reduce<SessionState>((s, event) => processEvent(s, event as unknown as AgentEvent).state, state)
    // The earlier turn's attempt row (before u2) survives; this turn's attempt is replaced by the success.
    expect(statusRows(state).map(row => row.content)).toEqual([r1.message, ok.message])
  })
})

/**
 * F1.477 (P5) — the ONE row a finished retry run leaves (F1.437) still drew a
 * spinner until the turn ended: `turn-utils` makes every status message a
 * `running` activity, and the success line is a status message like the
 * attempts. The run is over when its success line lands, so that row is drawn
 * as a completed activity; an attempt row is still waiting and keeps spinning.
 * Driven through the real `processEvent` and the real `groupMessagesByTurn`.
 */
describe('F1.477 (P5) — the retry run\'s success row is not a spinner', () => {
  const SID = 's1'
  const start = (): SessionState =>
    ({ session: { id: SID, messages: [{ id: 'u1', role: 'user', content: 'go', timestamp: 1 }], isProcessing: true }, streaming: null }) as unknown as SessionState
  const run = (events: unknown[]) => events.reduce<SessionState>((state, event) => processEvent(state, event as AgentEvent).state, start())
  const statusActivities = (state: SessionState) =>
    groupMessagesByTurn(state.session.messages as unknown as Message[])
      .filter((turn): turn is AssistantTurn => turn.type === 'assistant')
      .flatMap(turn => turn.activities)
      .filter(activity => activity.type === 'status')
  const r1 = retrying({ kind: 'rate_limit', attempt: 1, maxAttempts: 5, delaySeconds: 15 })
  const ok = retrying({ kind: 'succeeded' })

  it('Pi order: the surviving success row is a COMPLETED activity while the turn is still running', () => {
    const state = run([
      r1,
      { type: 'text_delta', sessionId: SID, delta: 'hello', turnId: 'm1' },
      { type: 'text_complete', sessionId: SID, text: 'hello', turnId: 'm1' },
      ok,
    ])
    expect(state.session.isProcessing).toBe(true)
    const rows = statusActivities(state)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe(ok.message)
    expect(rows[0]?.status).toBe('completed')
  })

  it('negative — an attempt row with no success yet is still running', () => {
    const rows = statusActivities(run([r1]))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('running')
  })

  it('negative — a compacting row is untouched (its own completion is the compaction_complete info row)', () => {
    const rows = statusActivities(run([{ type: 'status', sessionId: SID, message: 'Compacting conversation', statusType: 'compacting' }]))
    expect(rows.map(row => row.status)).toEqual(['running'])
  })
})
