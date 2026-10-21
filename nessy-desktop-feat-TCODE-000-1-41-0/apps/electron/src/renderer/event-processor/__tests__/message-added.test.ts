import { describe, expect, it } from 'bun:test'
import { processEvent } from '../processor'
import type { AgentEvent, SessionState } from '../types'

function makeState(messages: unknown[]): SessionState {
  return {
    session: {
      id: 's1',
      messages,
    } as never,
    streaming: null,
  }
}

describe('message_added', () => {
  it('appends the message to the session transcript', () => {
    const state = makeState([{ id: 'm1', role: 'user', content: 'hi', timestamp: 0 }])

    const next = processEvent(state, {
      type: 'message_added',
      sessionId: 's1',
      message: { id: 'm2', role: 'info', content: 'runtime_switched:pi:anthropic', timestamp: 1 },
    } as AgentEvent)

    expect(next.state.session.messages).toHaveLength(2)
    expect(next.state.session.messages.at(-1)?.content).toBe('runtime_switched:pi:anthropic')
  })

  it('ignores an event for a different session', () => {
    const state = makeState([])

    const next = processEvent(state, {
      type: 'message_added',
      sessionId: 's2',
      message: { id: 'm2', role: 'info', content: 'x', timestamp: 1 },
    } as AgentEvent)

    expect(next.state.session.messages).toHaveLength(0)
  })
})
