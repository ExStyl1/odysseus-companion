/**
 * F1.349 (renderer half) — a queued bubble adopts the host's replay stamp on
 * `'processing'`, so the previous turn's answer renders ABOVE it.
 *
 * The host re-stamps a queued message when its replay starts
 * (`processNextQueuedMessage`; pinned in
 * `packages/server-core/src/sessions/__tests__/queued-replay-restamp.test.ts`).
 * The already-mounted optimistic bubble kept its QUEUE-TIME stamp, because
 * `handleUserMessage` ignored `message.timestamp`, and `groupMessagesByTurn`
 * sorts by timestamp — so live, answer 1 was drawn below question 2 until a
 * reload. Ported from craft-agents-oss v0.13.4 `handleUserMessage`
 * (`...(status === 'processing' ? { timestamp: message.timestamp } : {})`,
 * Apache-2.0).
 */
import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn } from '@nessy-agent/ui/chat/turn-utils'
import { handleUserMessage } from '../session'
import type { SessionState, UserMessageEvent } from '../../types'

const QUEUED_AT = 1_000
const ANSWER_AT = 2_000
const REPLAY_AT = 3_000

function stateWithQueuedQuestion(): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [
        { id: 'u-1', role: 'user', content: 'question 1', timestamp: 500 },
        // The optimistic bubble of the message queued mid-stream.
        { id: 'opt-2', role: 'user', content: 'question 2', timestamp: QUEUED_AT, isQueued: true },
        { id: 'a-1', role: 'assistant', content: 'answer 1', timestamp: ANSWER_AT },
      ],
      lastMessageAt: ANSWER_AT,
      isProcessing: false,
    } as never,
    streaming: null,
  }
}

function event(status: UserMessageEvent['status'], timestamp: number): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message: { id: 'u-2', role: 'user', content: 'question 2', timestamp } as never,
    status,
    optimisticMessageId: 'opt-2',
  } as UserMessageEvent
}

describe('F1.349 — a replayed queued message sorts after the answer it waited for', () => {
  it("THE ROW: on 'processing' the bubble adopts the host's replay stamp, and the turns group answer 1 before question 2", () => {
    const { state } = handleUserMessage(stateWithQueuedQuestion(), event('processing', REPLAY_AT))

    const bubble = state.session.messages.find(m => m.id === 'opt-2')!
    expect(bubble.timestamp).toBe(REPLAY_AT)
    expect(bubble.isQueued).toBe(false)

    const turns = groupMessagesByTurn(state.session.messages as never)
    const order = turns.map(turn => turn.type === 'user' ? `user:${turn.message.content}` : turn.type)
    const answerAt = order.indexOf('assistant')
    const question2At = order.indexOf('user:question 2')
    expect(answerAt).toBeGreaterThan(-1)
    expect(question2At).toBeGreaterThan(answerAt)
  })

  it("CONTROL — a 'queued' event leaves the enqueue stamp alone", () => {
    const { state } = handleUserMessage(stateWithQueuedQuestion(), event('queued', REPLAY_AT))

    expect(state.session.messages.find(m => m.id === 'opt-2')!.timestamp).toBe(QUEUED_AT)
  })

  it("CONTROL — an 'accepted' steer keeps its stamp: it joined the running turn, it did not follow it", () => {
    const { state } = handleUserMessage(stateWithQueuedQuestion(), event('accepted', REPLAY_AT))

    expect(state.session.messages.find(m => m.id === 'opt-2')!.timestamp).toBe(QUEUED_AT)
  })
})
