import { describe, expect, it } from 'bun:test'
import { handleInterrupted } from '../session'
import type { SessionState, InterruptedEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

describe('handleInterrupted (#616)', () => {
  describe('user-initiated stop (event.message present)', () => {
    it('keeps queued bubbles and appends the interruption message', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-2', role: 'user', content: 'queued one', isQueued: true },
        { id: 'msg-3', role: 'user', content: 'queued two', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
        queuedMessages: ['queued one', 'queued two'],
      }

      const next = handleInterrupted(state, event)

      // queued bubbles remain visible; queue_changed drives queue controls
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).toContain('msg-2')
      expect(ids).toContain('msg-3')
      // info message appended
      expect(ids).toContain('info-1')
      // no draft-restore effect: queued rows remain server-owned
      expect(next.effects).toEqual([])
      // isProcessing cleared
      expect(next.state.session.isProcessing).toBe(false)
    })

    it('still works when no queued bubbles exist', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
      }

      const next = handleInterrupted(state, event)
      expect(next.effects).toEqual([])
      expect(next.state.session.messages.map(m => m.id)).toContain('info-1')
    })
  })

  describe('silent redirect (event.message absent)', () => {
    it('keeps queued bubbles in chat and emits no effects', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-2', role: 'user', content: 'queued during run', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        // no message field — silent redirect
        queuedMessages: ['queued during run'],
      }

      const next = handleInterrupted(state, event)

      // queued bubble must remain so the user sees it
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).toContain('msg-2')
      // no info bubble appended
      expect(ids).not.toContain('info-1')
      // queue replay is server-owned
      expect(next.effects).toEqual([])
      // isProcessing still gets cleared
      expect(next.state.session.isProcessing).toBe(false)
    })

    it('marks running tools as interrupted regardless of redirect type', () => {
      const state = makeState([
        { id: 'tool-1', role: 'tool', toolStatus: 'executing', toolResult: undefined },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
      }

      const next = handleInterrupted(state, event)
      const tool = next.state.session.messages[0] as any
      expect(tool.toolStatus).toBe('error')
      expect(tool.toolResult).toBe('Interrupted')
      expect(tool.isError).toBe(true)
    })
  })

  it('always strips transient status messages', () => {
    const state = makeState([
      { id: 'msg-1', role: 'user', content: 'hi' },
      { id: 'status-1', role: 'status', content: 'thinking…' },
    ])
    const event: InterruptedEvent = {
      type: 'interrupted',
      sessionId: 'session-1',
    }

    const next = handleInterrupted(state, event)
    const ids = next.state.session.messages.map(m => m.id)
    expect(ids).not.toContain('status-1')
    expect(ids).toContain('msg-1')
  })

  /**
   * D1.149 — the SUBAGENT rows inside an interrupted tool message, which this
   * handler used to walk past.
   *
   * C3.370's second half, measured live as RS-14: a background subagent's card
   * kept reading "Running Write…" forever after Escape. The cause is not a
   * missing event — `orchestrationProgress.agents[].status` carries an `aborted`
   * member that NOTHING produced (measured 2026-09-18 over the renderer, the
   * agents and server-core: only renderers of it, no producer, against
   * `running` and `done`, which have several in the same corpus). So the card
   * kept drawing the last `running` it was sent.
   *
   * Asserted in BOTH directions in one case: a finished agent must NOT be
   * rewritten, or a stop would relabel work that had already completed as
   * stopped — which is a worse lie than the one this fixes.
   */
  it('marks a subagent run aborted, and leaves a finished one alone', () => {
    const state = makeState([
      {
        id: 'tool-1',
        role: 'tool',
        toolName: 'Task',
        toolStatus: 'running',
        orchestrationProgress: {
          kind: 'parallel',
          runId: 'run-1',
          agents: [
            { id: 'a', label: 'writer', agentType: 'general', status: 'running' },
            { id: 'b', label: 'queued one', agentType: 'general', status: 'queued' },
            { id: 'c', label: 'finished', agentType: 'general', status: 'done' },
            { id: 'd', label: 'failed', agentType: 'general', status: 'error' },
          ],
        },
      },
    ])
    const event: InterruptedEvent = { type: 'interrupted', sessionId: 'session-1' }

    const tool = handleInterrupted(state, event).state.session.messages[0] as any
    expect(tool.toolStatus).toBe('error')
    expect(tool.orchestrationProgress.agents.map((a: any) => a.status))
      // `aborted` and not `error`: the run was stopped, it did not fail, and the
      // card draws the two differently.
      .toEqual(['aborted', 'aborted', 'done', 'error'])
    // The run's own identity is untouched — this rewrites statuses, not a run.
    expect(tool.orchestrationProgress.runId).toBe('run-1')
  })

  it('leaves a tool message with no subagent run exactly as it was', () => {
    // The control: the field is OPTIONAL, and a map that assumed it was there
    // would throw on every ordinary tool row — which is most of them.
    const state = makeState([
      { id: 'tool-1', role: 'tool', toolName: 'Bash', toolStatus: 'running' },
    ])
    const tool = handleInterrupted(state, { type: 'interrupted', sessionId: 'session-1' })
      .state.session.messages[0] as any
    expect(tool.toolStatus).toBe('error')
    expect('orchestrationProgress' in tool).toBe(false)
  })
})
