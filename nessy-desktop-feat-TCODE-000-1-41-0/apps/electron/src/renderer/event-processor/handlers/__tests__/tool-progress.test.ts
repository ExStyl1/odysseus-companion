import { describe, expect, it } from 'bun:test'
import type { OrchestrationProgress } from '@nessy-agent/core'
import type { Message } from '../../../../shared/types'
import type { SessionState, TaskProgressEvent } from '../../types'
import { handleTaskProgress } from '../tool'

function createState(messages: Message[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
    } as SessionState['session'],
    streaming: null,
  }
}

function createToolMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'tool',
    content: '',
    timestamp: 1700000000000,
    toolUseId: 'call_1',
    toolName: 'subagent',
    toolStatus: 'executing',
    ...overrides,
  }
}

describe('handleTaskProgress', () => {
  it('stores orchestration progress on the matching tool message', () => {
    const progress: OrchestrationProgress = {
      kind: 'subagent',
      runId: 'subagent-run-1',
      agents: [{
        id: 'subagent-run-1-1',
        label: 'Scout',
        agentType: 'scout',
        status: 'running',
        tokensIn: 10,
        tokensOut: 2,
      }],
    }
    const state = createState([createToolMessage({ elapsedSeconds: 7 })])
    const event: TaskProgressEvent = {
      type: 'task_progress',
      sessionId: 'session-1',
      toolUseId: 'call_1',
      orchestrationProgress: progress,
    }

    const next = handleTaskProgress(state, event)

    expect(next.session.messages[0].orchestrationProgress).toEqual(progress)
    expect(next.session.messages[0].elapsedSeconds).toBe(7)
  })

  it('keeps elapsed progress updates working', () => {
    const state = createState([createToolMessage()])
    const event: TaskProgressEvent = {
      type: 'task_progress',
      sessionId: 'session-1',
      toolUseId: 'call_1',
      elapsedSeconds: 42,
    }

    const next = handleTaskProgress(state, event)

    expect(next.session.messages[0].elapsedSeconds).toBe(42)
  })
})
