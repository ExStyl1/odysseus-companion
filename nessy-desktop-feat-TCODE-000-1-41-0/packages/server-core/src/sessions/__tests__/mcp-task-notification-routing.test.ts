/**
 * R10 MCP auto-background: a `task_notification` agent event (the settled
 * result of a detached MCP call) routes through the SAME R3 delivery
 * discipline as monitor events — idle starts a turn, busy queues into one
 * group, and the framing states no human input has occurred. The routing under
 * test is the production `processEvent` switch; only the turn machinery below
 * `sendMessage` is stubbed.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'
import { TASK_NOTIFICATION_NO_HUMAN_INPUT } from '../task-notification.ts'

const sessionKey = { workspaceId: 'workspace-1', sessionId: 'session-1' }

function harness(options: { isProcessing?: boolean } = {}) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    sendMessage(...args: unknown[]): Promise<void>
    processEvent(managed: unknown, event: unknown): Promise<void>
    onProcessingStopped(sessionId: string, reason: string, workspaceId?: string): Promise<void>
    sendEvent(event: unknown, workspaceId: string): void
    persistSession(managed: unknown, immediate?: boolean): void
    flushSession(sessionId: string, workspaceId?: string): Promise<void>
  }
  const sent: string[] = []
  const managed: Record<string, unknown> = {
    id: sessionKey.sessionId,
    workspace: { id: sessionKey.workspaceId, rootPath: '/tmp/workspace-1' },
    isProcessing: options.isProcessing === true,
    messages: [{ id: 'user-0', role: 'user', content: 'hello', timestamp: 0 }],
    messageQueue: [],
    queuePaused: false,
    agent: { isProcessing: () => options.isProcessing === true },
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)
  internals.sendMessage = async (...args: unknown[]) => { sent.push(String(args[1])) }
  internals.sendEvent = () => undefined
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined
  return { internals, managed, sent }
}

describe('task_notification event routing', () => {
  test('idle session: the settled MCP result starts a turn with the R3 framing', async () => {
    const h = harness({ isProcessing: false })
    await h.internals.processEvent(h.managed, {
      type: 'task_notification',
      taskId: 'task-mcp-1',
      text: 'MCP task task-mcp-1 settled: slow-result-one',
    })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('slow-result-one')
    expect(h.sent[0]).toContain(TASK_NOTIFICATION_NO_HUMAN_INPUT)
  })

  test('busy session: the notification queues and rides the next turn as a group', async () => {
    const h = harness({ isProcessing: true })
    await h.internals.processEvent(h.managed, {
      type: 'task_notification',
      taskId: 'task-mcp-1',
      text: 'first settled',
    })
    await h.internals.processEvent(h.managed, {
      type: 'task_notification',
      taskId: 'task-mcp-2',
      text: 'second settled',
    })
    expect(h.sent).toEqual([])
    h.managed.isProcessing = false
    await h.internals.onProcessingStopped(sessionKey.sessionId, 'complete', sessionKey.workspaceId)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.indexOf('first settled')).toBeLessThan(h.sent[0]!.indexOf('second settled'))
  })
})
