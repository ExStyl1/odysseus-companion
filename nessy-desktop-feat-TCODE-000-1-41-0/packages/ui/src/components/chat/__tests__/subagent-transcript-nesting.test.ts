/**
 * P6.561 · a forwarded subagent transcript nests under the Task row that
 * spawned it, and never takes the parent turn's response slot.
 *
 * With `forwardSubagentText` on, claude emits the subagent's own messages with
 * `parent_tool_use_id` set — and the LAST of them carries the subagent's own
 * `end_turn`, so it reaches the renderer with `isIntermediate: false`. Read as
 * a final response it would close the parent turn while the Task tool was
 * still running; read by its parent id it is one more row under the Task.
 */
import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@nessy-agent/core'

let seq = 0
const at = () => Date.now() + ++seq * 100

function userMessage(): Message {
  return { id: `user-${seq}`, role: 'user', content: 'go', timestamp: at() }
}

function taskTool(toolUseId: string, completed: boolean): Message {
  return {
    id: `tool-${toolUseId}`,
    role: 'tool',
    content: completed ? 'done' : '',
    timestamp: at(),
    toolName: 'Task',
    toolUseId,
    toolInput: { description: 'explore', subagent_type: 'Explore' },
    ...(completed ? { toolStatus: 'completed' as const, toolResult: 'done' } : {}),
  }
}

function assistantMessage(patch: Partial<Message>): Message {
  return {
    id: `assistant-${++seq}`,
    role: 'assistant',
    content: 'text',
    timestamp: at(),
    isStreaming: false,
    isIntermediate: false,
    ...patch,
  }
}

function lastAssistantTurn(messages: Message[]): AssistantTurn {
  const turns = groupMessagesByTurn(messages)
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.type === 'assistant') return turns[i] as AssistantTurn
  }
  throw new Error('no assistant turn')
}

describe('P6.561 · forwarded subagent text nests under its parent tool row', () => {
  it('positive — a subagent final message becomes a nested activity, not the response', () => {
    seq = 0
    const turn = lastAssistantTurn([
      userMessage(),
      taskTool('tu-task-1', false),
      // The subagent's own `end_turn`: not intermediate, but not ours either.
      assistantMessage({ content: 'subagent finished', parentToolUseId: 'tu-task-1' }),
    ])

    // It did NOT take the response slot, so the parent turn stays open.
    expect(turn.response).toBeUndefined()
    const nested = turn.activities.find(a => a.content === 'subagent finished')
    expect(nested?.parentId).toBe('tu-task-1')
    expect(nested?.depth).toBe(1)
  })

  it('negative — the parent turn\'s own final message is still the response', () => {
    seq = 0
    const turn = lastAssistantTurn([
      userMessage(),
      taskTool('tu-task-2', true),
      assistantMessage({ content: 'subagent finished', parentToolUseId: 'tu-task-2' }),
      assistantMessage({ content: 'here is what it found' }),
    ])

    expect(turn.response?.text).toBe('here is what it found')
    // and the subagent line is still nested rather than lost
    expect(turn.activities.some(a => a.content === 'subagent finished' && a.parentId === 'tu-task-2'))
      .toBe(true)
  })
})
