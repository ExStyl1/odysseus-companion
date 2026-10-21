/**
 * Scenario tests for turn lifecycle transitions.
 *
 * These tests verify the turn phase transitions through realistic
 * message flow scenarios, ensuring the state machine correctly
 * handles all common use cases.
 */

import { describe, it, expect } from 'bun:test'
import { deriveTurnPhase, groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@nessy-agent/core'

// ============================================================================
// Test Helpers
// ============================================================================

let messageIdCounter = 0
let turnIdCounter = 0

function resetCounters() {
  messageIdCounter = 0
  turnIdCounter = 0
}

function createUserMessage(content = 'Hello'): Message {
  return {
    id: `user-${++messageIdCounter}`,
    role: 'user',
    content,
    timestamp: Date.now() + messageIdCounter * 100,
  }
}

function createToolMessage(
  status: 'running' | 'completed',
  name = 'Read',
  turnId?: string
): Message {
  return {
    id: `tool-${++messageIdCounter}`,
    role: 'tool',
    content: status === 'completed' ? 'Tool result' : '',
    timestamp: Date.now() + messageIdCounter * 100,
    toolName: name,
    toolUseId: `tu-${messageIdCounter}`,
    toolStatus: status === 'completed' ? 'completed' : undefined,
    toolResult: status === 'completed' ? 'Tool result' : undefined,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

function createAssistantMessage(
  isStreaming: boolean,
  isIntermediate = false,
  turnId?: string
): Message {
  return {
    id: `assistant-${++messageIdCounter}`,
    role: 'assistant',
    content: 'Response text',
    timestamp: Date.now() + messageIdCounter * 100,
    isStreaming,
    isIntermediate,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

/** Update a message in the array (simulating streaming updates) */
function updateMessage(
  messages: Message[],
  id: string,
  updates: Partial<Message>
): Message[] {
  return messages.map(m => (m.id === id ? { ...m, ...updates } : m))
}

/** Get the last assistant turn from grouped turns */
function getLastAssistantTurn(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.type === 'assistant') {
      return turns[i] as AssistantTurn
    }
  }
  return undefined
}

// ============================================================================
// Scenario Tests
// ============================================================================

describe('turn lifecycle scenarios', () => {
  describe('simple response flow', () => {
    it('pending → streaming → complete (no tools)', () => {
      resetCounters()

      // 1. User message
      let messages: Message[] = [createUserMessage()]
      let turns = groupMessagesByTurn(messages)
      // No assistant turn yet
      expect(getLastAssistantTurn(turns)).toBeUndefined()

      // 2. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 3. Response completes
      messages = updateMessage(messages, 'assistant-2', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('single tool flow', () => {
    it('pending → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. User message
      let messages: Message[] = [createUserMessage()]

      // 2. Tool starts running
      messages = [...messages, createToolMessage('running')]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 3. Tool completes - THIS IS THE GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 4. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 5. Response completes
      messages = updateMessage(messages, 'assistant-3', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('multi-tool flow', () => {
    it('tool_active → awaiting → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. First tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes - GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 3. Second tool starts
      messages = [...messages, createToolMessage('running', 'Grep')]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 4. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 5. Response starts
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 6. Response completes
      messages = updateMessage(messages, 'assistant-4', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('parallel tools flow', () => {
    it('handles multiple tools running in parallel', () => {
      resetCounters()
      turnIdCounter++

      // 1. Multiple tools start
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
        createToolMessage('running', 'Grep'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes (second still running)
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active') // Still running

      // 3. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('tool with error', () => {
    it('error transitions to awaiting (not stuck in tool_active)', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. Tool errors
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: undefined,
        isError: true,
        content: 'File not found',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('interruption', () => {
    it('user message during tool_active marks turn complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool running
      let messages: Message[] = [
        createUserMessage('First question'),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. User interrupts with new message
      messages = [...messages, createUserMessage('Cancel that')]
      turns = groupMessagesByTurn(messages)
      // First assistant turn should now be complete (interrupted)
      const firstAssistantTurn = turns.find(t => t.type === 'assistant') as AssistantTurn
      expect(firstAssistantTurn.isComplete).toBe(true)
      expect(deriveTurnPhase(firstAssistantTurn)).toBe('complete')
    })
  })

  describe('intermediate text', () => {
    it('intermediate text during tool sequence stays in awaiting', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool completes
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 2. Intermediate text arrives (thinking out loud)
      messages = [...messages, createAssistantMessage(false, true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      // Still awaiting because intermediate text is not the final response
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  // Mirrors the renderer lastAssistantText fallback (PR #779).
  // When the Pi agent emits intermediate text + a tool call and then completes
  // without a non-intermediate text_complete, the chat must not sit on "Thinking…"
  // forever. The session.isProcessing=false signal triggers the existing
  // "promote last intermediate text to response" branch in groupMessagesByTurn.
  describe('tool-terminated run — session-complete fallback', () => {
    it('intermediate text + completed tool + session done → phase complete, intermediate promoted to response', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createAssistantMessage(false, /* isIntermediate */ true), // "I'll run the requested echo hello"
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(turn)).toBe('complete')
      expect(turn.response?.text).toBe('Response text') // promoted from the intermediate
    })

    it('intermediate text + completed tool + session still processing → phase awaiting', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createAssistantMessage(false, true),
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
      const turn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })

    it('only tool + session done + no text → phase complete, no response promoted', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(turn)).toBe('complete')
      expect(turn.response).toBeUndefined()
    })

    it('omitting the option keeps current behavior (backwards compat)', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createAssistantMessage(false, true),
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages) // no second arg
      const turn = getLastAssistantTurn(turns)!
      // Without the explicit signal, the turn stays open — pre-fix behavior preserved
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })
  })
})

// P2.37 · a terminal-reason VERDICT row must not be read as an interruption.
// `groupMessagesByTurn` flushes the open turn as interrupted for any `info`
// row, and the "promote last intermediate to response" branch is guarded by
// `!interrupted`. The renderer's own handleComplete appends a
// `terminal_reason:<reason>` info row on exactly the cap turns the verdict
// describes, so before the fix the model's last words stayed an `intermediate`
// activity and the response bubble vanished — the opposite of "make the
// verdict visible". Options mirror ChatDisplay's real call
// (`isSessionProcessing: session.isProcessing`, false at turn end).
describe('terminal-reason verdict row — not an interruption (P2.37)', () => {
  function createInfoMessage(content: string): Message {
    return {
      id: `info-${++messageIdCounter}`,
      role: 'info',
      content,
      timestamp: Date.now() + messageIdCounter * 100,
    }
  }

  it('POSITIVE: a terminal_reason info row still promotes the last intermediate to a response', () => {
    resetCounters()
    turnIdCounter++

    const messages: Message[] = [
      createUserMessage('do the thing'),
      createAssistantMessage(false, /* isIntermediate */ true), // "Response text"
      createToolMessage('completed', 'Bash'),
      createInfoMessage('terminal_reason:max_agent_turns'),
    ]
    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })

    const turn = getLastAssistantTurn(turns)!
    expect(deriveTurnPhase(turn)).toBe('complete')
    expect(turn.response?.text).toBe('Response text') // promoted, not lost
    // The verdict itself is still rendered as its own system row.
    expect(turns.some(t => t.type === 'system')).toBe(true)
  })

  it('NEGATIVE: a non-terminal_reason info row still flushes the turn as interrupted', () => {
    resetCounters()
    turnIdCounter++

    const messages: Message[] = [
      createUserMessage('do the thing'),
      createAssistantMessage(false, true), // "Response text" (intermediate)
      createToolMessage('completed', 'Bash'),
      createInfoMessage('The session was interrupted for a mid-turn notice'),
    ]
    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })

    const turn = getLastAssistantTurn(turns)!
    // Interrupted → promotion suppressed: the last words stay an activity, no
    // response bubble.
    expect(turn.response).toBeUndefined()
    expect(turn.activities.some(a => a.type === 'intermediate' && a.content === 'Response text')).toBe(true)
  })
})

describe('edge cases', () => {
  it('empty activities array returns pending', () => {
    resetCounters()

    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: false,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('pending')
  })

  it('isComplete true with empty activities returns complete', () => {
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: true,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('complete')
  })

  it('response with isStreaming false but isComplete false returns awaiting', () => {
    // This is an edge case - usually when response.isStreaming is false,
    // the turn should be marked complete. But we trust isComplete as
    // the authoritative signal.
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [
        {
          id: 'act-1',
          type: 'tool',
          status: 'completed',
          timestamp: Date.now(),
        },
      ],
      response: {
        text: 'Done',
        isStreaming: false,
      },
      isStreaming: false,
      isComplete: false, // Not yet marked complete
      timestamp: Date.now(),
    }
    // Per our priority: complete > streaming > tool_active > awaiting > pending
    // response.isStreaming is false, so not streaming
    // no running tools, so not tool_active
    // has activities, so awaiting
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })
})

// UB2.14 — copied+adapted from craft-agents-oss v0.15.1
// `packages/ui/src/components/chat/__tests__/turn-lifecycle.test.ts` ("hidden messages", Apache-2.0),
// plus the source-activation retry shape, the one hidden producer in our tree.
describe('hidden messages (UB2.14)', () => {
  it('never render as a turn but the assistant reply they trigger still does', () => {
    resetCounters()

    const hiddenRetry: Message = { ...createUserMessage('list my repos\n\n[github activated]'), hidden: true }
    const reply = createAssistantMessage(false, false, 'turn-reply')

    const turns = groupMessagesByTurn([hiddenRetry, reply])

    expect(turns.some(t => t.type === 'user')).toBe(false)
    expect(turns.filter(t => t.type === 'assistant').length).toBe(1)
  })

  it('a visible user message still renders normally alongside a hidden one', () => {
    resetCounters()

    const visible = createUserMessage('real user question')
    const hidden: Message = { ...createUserMessage('real user question\n\n[github activated]'), hidden: true }

    const userTurns = groupMessagesByTurn([visible, hidden]).filter(t => t.type === 'user')

    expect(userTurns.length).toBe(1)
    expect((userTurns[0] as { message: Message }).message.content).toBe('real user question')
  })

  it('CONTROL — the activation retry without the flag draws a second user bubble', () => {
    resetCounters()

    const original = createUserMessage('list my repos')
    const retryText = 'list my repos\n\n[github activated]'
    const reply = createAssistantMessage(false, false, 'turn-reply')

    const visibleRetry = groupMessagesByTurn([original, createUserMessage(retryText), reply])
    expect(visibleRetry.filter(t => t.type === 'user').length).toBe(2)

    resetCounters()
    const hiddenRetry = groupMessagesByTurn([
      createUserMessage('list my repos'),
      { ...createUserMessage(retryText), hidden: true },
      createAssistantMessage(false, false, 'turn-reply'),
    ])
    expect(hiddenRetry.map(t => t.type)).toEqual(['user', 'assistant'])
  })
})
