/**
 * F1.732 — a message the host ACCEPTED as a steer into a running turn is marked `steered`, so the
 * Stop restore (`composerTextAfterStop`) can leave it to the host. SIT-f C4 (claude-gateway,
 * 2026-09-25): prompt, a steer, Stop — the steer sat in the paused queue (the host re-queues an
 * undelivered steer) AND was restored into the composer draft, so Enter after Resume sent it twice.
 * The composer sends a mid-stream message optimistically with `isQueued: true` (App.tsx); a steer is
 * the host's `accepted` for such a message.
 */
import { describe, expect, it } from 'bun:test'
import { handleUserMessage } from '../session'
import type { SessionState, UserMessageEvent } from '../../types'

function runningTurn(extra: Array<Record<string, unknown>> = []): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [
        { id: 'msg-1', role: 'user', content: 'write a story', timestamp: 1 },
        { id: 'msg-a', role: 'assistant', content: 'Once', timestamp: 2, isPending: true },
        ...extra,
      ],
      lastMessageAt: 2,
      isProcessing: true,
    } as never,
    streaming: null,
  }
}

function event(id: string, content: string, status: UserMessageEvent['status'], extra: Partial<UserMessageEvent> = {}): UserMessageEvent {
  return { type: 'user_message', sessionId: 'session-1', message: { id, role: 'user', content, timestamp: 3 } as never, status, ...extra }
}

describe('a steer accepted into a running turn is marked (F1.732)', () => {
  it('the optimistic mid-stream message the host accepts as a steer becomes `steered`', () => {
    const state = runningTurn([{ id: 'opt-2', role: 'user', content: 'Set it in winter.', timestamp: 3, isPending: true, isQueued: true }])
    const next = handleUserMessage(state, event('srv-2', 'Set it in winter.', 'accepted', { optimisticMessageId: 'opt-2' }))
    const steer = next.state.session.messages.find(m => m.id === 'opt-2') as { steered?: true; isQueued?: boolean }
    expect(steer.isQueued).toBe(false)
    expect(steer.steered).toBe(true)
  })

  it('CONTROL: the turn-opening prompt the host accepts is not a steer', () => {
    const state: SessionState = {
      session: {
        id: 'session-1',
        messages: [{ id: 'opt-1', role: 'user', content: 'write a story', timestamp: 1, isPending: true, isQueued: false }],
        lastMessageAt: 1,
        isProcessing: true,
      } as never,
      streaming: null,
    }
    const next = handleUserMessage(state, event('srv-1', 'write a story', 'accepted', { optimisticMessageId: 'opt-1' }))
    expect(next.state.session.messages.find(m => m.id === 'opt-1')).not.toHaveProperty('steered')
  })

  it('CONTROL: a steer the host re-queues and later replays is a turn of its own again', () => {
    const state = runningTurn([{ id: 'opt-2', role: 'user', content: 'Set it in winter.', timestamp: 3, steered: true }])
    const requeued = handleUserMessage(state, event('srv-2', 'Set it in winter.', 'queued', { optimisticMessageId: 'opt-2', requeued: true }))
    expect(requeued.state.session.messages.find(m => m.id === 'opt-2')).not.toHaveProperty('steered')
  })
})
