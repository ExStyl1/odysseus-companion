/**
 * P3.14 · a COMPLETED turn must leave no bubble marked streaming.
 *
 * `handleComplete` cleared `isProcessing` but left the per-message transient
 * flags alone, so any assistant bubble that never received its own
 * `text_complete` stayed `isStreaming: true` / `isPending: true` forever —
 * after the turn had visibly ended. Only `handleInterrupted` cleared them, so
 * the user-stop path was covered and the normal-completion path was not.
 *
 * The state is user-visible three ways, all keyed off exactly these two flags:
 * - `ChatDisplay.tsx:3088` hides the pop-out affordance while
 *   `message.isStreaming`, and `:3099` keeps rendering the bubble through
 *   `StreamingMarkdown`;
 * - `turn-utils.ts:556,565,576` routes an assistant message with `isPending`
 *   into the turn card as a **running** activity, and `:596` refuses to lower
 *   `currentTurn.isStreaming` until BOTH flags are down — which is why this fix
 *   has to clear both, exactly as `handleInterrupted` does;
 * - `annotation-host-config.ts:14` refuses to annotate a streaming message.
 *
 * The sequence below is P3.9's, verified live by its review: deltas under one
 * per-message identity and a completion under another (a codex turn whose prose
 * streams while an image completes beside it) leave the streamed bubble with no
 * completion of its own. Reaching it needs nothing codex-specific, though — any
 * turn that ends without a `text_complete` for a message it streamed lands here,
 * which is why the fix is in the backend-agnostic renderer handler.
 */
import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import { handleComplete } from '../session'
import type { AgentEvent, CompleteEvent, SessionState } from '../../types'

function emptyState(): SessionState {
  return { session: { id: 's1', messages: [], isProcessing: true } as never, streaming: null }
}

function drive(events: AgentEvent[]): SessionState {
  let state = emptyState()
  for (const event of events) state = processEvent(state, event).state
  return state
}

const COMPLETE: CompleteEvent = { type: 'complete', sessionId: 's1' }

describe('handleComplete clears the streaming flags a finished turn left behind', () => {
  it('leaves no bubble streaming after P3.9\'s delta-under-X / complete-under-Y sequence', () => {
    const state = drive([
      { type: 'text_delta', sessionId: 's1', delta: 'streamed under X', turnId: 'X' },
      { type: 'text_complete', sessionId: 's1', text: 'completed under Y', turnId: 'Y', timestamp: 1, messageId: 'm-y' },
      COMPLETE,
    ])

    // Both bubbles survive — this row does not touch content (that is P3.9's).
    expect(state.session.messages.map(m => m.content)).toEqual(['streamed under X', 'completed under Y'])
    // …and neither is still advertising itself as live.
    expect(state.session.messages.filter(m => m.isStreaming)).toEqual([])
    expect(state.session.messages.filter(m => m.isPending)).toEqual([])
    expect(state.session.isProcessing).toBe(false)
  })

  it('leaves no bubble streaming when the turn ends with no completion at all', () => {
    // The simplest reachable shape, and backend-agnostic: a turn that streams
    // and then ends (refusal, error, a backend that drops the final message).
    const state = drive([
      { type: 'text_delta', sessionId: 's1', delta: 'half a th', turnId: 'X' },
      { type: 'text_delta', sessionId: 's1', delta: 'ought', turnId: 'X' },
      COMPLETE,
    ])

    expect(state.session.messages).toHaveLength(1)
    expect(state.session.messages[0].content).toBe('half a thought')
    expect(state.session.messages[0].isStreaming).toBe(false)
    expect(state.session.messages[0].isPending).toBe(false)
  })

  it('leaves a normal single-message turn exactly as text_complete left it', () => {
    const streamed = drive([
      { type: 'text_delta', sessionId: 's1', delta: 'Hello ', turnId: 'X' },
      { type: 'text_delta', sessionId: 's1', delta: 'world', turnId: 'X' },
      { type: 'text_complete', sessionId: 's1', text: 'Hello world', turnId: 'X', timestamp: 7, messageId: 'm-x' },
    ])
    const before = streamed.session.messages
    const after = handleComplete(streamed, COMPLETE).state.session.messages

    // Not merely equal in the flags — the identical objects, i.e. the pass is a
    // no-op on a turn that completed properly.
    expect(after).toEqual(before)
    expect(after[0]).toBe(before[0])
    expect(after[0].id).toBe('m-x')
    expect(after[0].content).toBe('Hello world')
    expect(after[0].isStreaming).toBe(false)
  })

  it('touches only assistant bubbles, and only their two transient flags', () => {
    const state = handleComplete(
      {
        session: {
          id: 's1',
          isProcessing: true,
          messages: [
            // A user bubble mid-flight: `isPending` there is the optimistic-send
            // marker (`App.tsx:1366`), confirmed by `user_message`, not by us.
            { id: 'u1', role: 'user', content: 'do it', timestamp: 1, isPending: true },
            {
              id: 'a1', role: 'assistant', content: 'orphan', timestamp: 2,
              isStreaming: true, isPending: true, isIntermediate: true, turnId: 'X',
              displayContent: 'orphan (display)',
            },
          ],
        } as never,
        streaming: { content: 'orphan', turnId: 'X' },
      },
      COMPLETE,
    ).state.session

    const [user, assistant] = state.messages
    expect(user.isPending).toBe(true)
    expect(assistant.isStreaming).toBe(false)
    expect(assistant.isPending).toBe(false)
    // Everything else on the bubble is carried through untouched.
    expect(assistant.content).toBe('orphan')
    expect(assistant.displayContent).toBe('orphan (display)')
    expect(assistant.isIntermediate).toBe(true)
    expect(assistant.turnId).toBe('X')
    expect(assistant.id).toBe('a1')
  })

  it('still runs its own two passes: running tools finish and queued bubbles unqueue', () => {
    const state = handleComplete(
      {
        session: {
          id: 's1',
          isProcessing: true,
          messages: [
            { id: 't1', role: 'tool', content: '', timestamp: 1, toolStatus: 'executing' },
            { id: 'u1', role: 'user', content: 'later', timestamp: 2, isQueued: true },
            { id: 'a1', role: 'assistant', content: 'orphan', timestamp: 3, isStreaming: true, isPending: true },
          ],
        } as never,
        streaming: null,
      },
      COMPLETE,
    ).state

    const [tool, user, assistant] = state.session.messages
    expect(tool.toolStatus).toBe('completed')
    expect(user.isQueued).toBe(false)
    expect(assistant.isStreaming).toBe(false)
    expect(state.streaming).toBeNull()
  })

  it('keeps the interrupt path behaving exactly as before', () => {
    // `handleInterrupted` owns the user-stop shape (status rows dropped, tools
    // marked interrupted, an optional notice appended). P3.14 must not move any
    // of that into `handleComplete`, nor change it.
    const state = drive([
      { type: 'text_delta', sessionId: 's1', delta: 'partial', turnId: 'X' },
      { type: 'status', sessionId: 's1', message: 'thinking…' },
      {
        type: 'interrupted',
        sessionId: 's1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 9 } as never,
      },
    ])

    const ids = state.session.messages.map(m => m.id)
    expect(ids).toContain('info-1')
    expect(ids.some(id => id.startsWith('status'))).toBe(false)
    expect(state.session.messages.filter(m => m.role === 'status')).toEqual([])
    const assistant = state.session.messages.find(m => m.role === 'assistant')
    expect(assistant?.content).toBe('partial')
    expect(assistant?.isStreaming).toBe(false)
    expect(assistant?.isPending).toBe(false)
    expect(state.session.isProcessing).toBe(false)
  })
})
