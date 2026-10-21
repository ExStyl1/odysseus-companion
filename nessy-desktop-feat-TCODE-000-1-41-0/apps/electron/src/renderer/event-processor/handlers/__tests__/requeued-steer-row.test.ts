/**
 * F1.333 (renderer half) — a steer the host hands back to the queue flips its
 * transcript row back to queued, and does not restart a turn in the renderer.
 *
 * Measured before this row (`work/wjqqa/probe-1333-renderer.test.ts`): a
 * transcript row's `isQueued` is written only by `handleUserMessage` (App.tsx
 * returns early on `queue_changed`, which feeds the queue list), and its
 * sequence guard drops a 'queued' for a row already marked delivered — which a
 * steered message always is (its 'accepted' set `isQueued: false`). So upstream's
 * re-announce (craft-agents-oss v0.13.4 `recoverUndeliveredSteer`, which carries
 * the same guard in its renderer) would be inert here: the bubble went on
 * rendering as delivered, and offering Rewind, while the queue list showed it
 * queued. The host now marks its re-announce `requeued: true`
 * (`SessionManager.requeueUndeliveredSteer`), and the guard lets exactly that one
 * through.
 *
 * And it must not RAISE `isProcessing`: every other `user_message` does (D1.376),
 * but a re-queue can arrive after the turn's end — codex reports a late refusal
 * after `complete` on its own sink — and a raise then would strand a stopped
 * session with a spinner and a Stop that does nothing.
 */
import { describe, expect, it } from 'bun:test'
import { handleUserMessage } from '../session'
import type { SessionState, UserMessageEvent } from '../../types'

function stateWith(isQueued: boolean | undefined, isProcessing: boolean): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [{ id: 'msg-steer', role: 'user', content: 'stop, use the other API', timestamp: 1, ...(isQueued === undefined ? {} : { isQueued }) }],
      isProcessing,
    },
    streaming: null,
  } as unknown as SessionState
}

function queued(extra: Partial<UserMessageEvent> = {}): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message: { id: 'msg-steer', role: 'user', content: 'stop, use the other API', timestamp: 1, isQueued: true } as never,
    status: 'queued',
    ...extra,
  } as UserMessageEvent
}

const rowOf = (state: SessionState) => (state.session.messages as Array<{ id: string; isQueued?: boolean }>).find(m => m.id === 'msg-steer')!

describe('F1.333 — a re-queued steer on the transcript', () => {
  it('a REQUEUED \'queued\' flips a delivered row back to queued', () => {
    const next = handleUserMessage(stateWith(false, true), queued({ requeued: true } as never))
    // THE DEFECT: the guard dropped it and the row stayed `isQueued: false`.
    expect(rowOf(next.state).isQueued).toBe(true)
  })

  it('a REQUEUED \'queued\' after the turn ended leaves the renderer idle', () => {
    const next = handleUserMessage(stateWith(false, false), queued({ requeued: true } as never))
    expect(rowOf(next.state).isQueued).toBe(true)
    expect(next.state.session.isProcessing).toBe(false)
  })

  it('CONTROL — a late, out-of-order \'queued\' (not a re-queue) is still ignored for a delivered row', () => {
    const before = stateWith(false, true)
    const next = handleUserMessage(before, queued())
    expect(rowOf(next.state).isQueued).toBe(false)
    expect(next.state).toBe(before)
  })

  it('CONTROL — an ordinary \'queued\' for a new row still raises isProcessing (D1.376)', () => {
    const next = handleUserMessage(stateWith(undefined, false), queued())
    expect(rowOf(next.state).isQueued).toBe(true)
    expect(next.state.session.isProcessing).toBe(true)
  })
})
