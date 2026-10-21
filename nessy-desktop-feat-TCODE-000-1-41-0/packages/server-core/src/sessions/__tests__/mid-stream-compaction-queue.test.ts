/**
 * UB2.3 (COR-3; craft-agents-oss #1058) — a message sent while a manual /compact
 * owns the turn is QUEUED for replay, never offered to `redirect()`.
 *
 * The host is the seam all three runtimes share, so the arms drive the REAL
 * `SessionManager.sendMessage` (the `mid-stream-attachments-queue.test.ts` rig):
 * the agent sits on its real prototype with `isCompactionInFlight` answered by
 * the test, and its `redirect` is a spy — a steer that is never OFFERED is the
 * property under test.
 */
import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { PiAgent } from '../../../../shared/src/agent/pi-agent.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-ub2-3'

interface QueueEntry {
  message: string
  messageId?: string
}
interface TranscriptRow { id: string; role: string; content: string; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: TranscriptRow[]
  messageQueue: QueueEntry[]
  wasInterrupted?: boolean
}

function rig(sessionId: string, compactionInFlight: boolean) {
  const sm = createTestSessionManager()
  const events: Array<{ type: string; status?: string }> = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as { type: string; status?: string }) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'ub2-3-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'UB2.3' },
    { id: WORKSPACE_ID, name: 'UB2.3', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  const redirect = mock((_message: string, _metadata?: unknown) => true)
  const agent = Object.create(PiAgent.prototype) as Record<string, unknown>
  agent.redirect = redirect
  agent.forceAbort = () => undefined
  agent.debug = () => undefined
  agent.isCompactionInFlight = () => compactionInFlight
  managed.agent = agent
  managed.isProcessing = true
  return { sm, managed, events, redirect }
}

function lastUserMessageStatus(events: Array<{ type: string; status?: string }>): string | undefined {
  return events.filter(event => event.type === 'user_message').at(-1)?.status
}

describe('UB2.3 — a mid-turn message during a manual /compact is queued, not steered', () => {
  it('with the compaction in flight the text door is never tried and the message queues', async () => {
    const h = rig('compact-busy', true)
    await h.sm.sendMessage(h.managed.id, 'the question I asked during /compact')

    expect(h.redirect).not.toHaveBeenCalled()
    expect(h.managed.messageQueue).toHaveLength(1)
    expect(h.managed.messageQueue[0]!.message).toBe('the question I asked during /compact')
    const row = h.managed.messages.find(m => m.id === h.managed.messageQueue[0]!.messageId)!
    expect(row.isQueued).toBe(true)
    expect(lastUserMessageStatus(h.events)).toBe('queued')
    // The compaction was not disturbed: no failed-steer interruption stamp.
    expect(h.managed.wasInterrupted).not.toBe(true)
  })

  it('CONTROL — with no compaction in flight a text message still steers exactly as before', async () => {
    const h = rig('compact-free', false)
    await h.sm.sendMessage(h.managed.id, 'use the other endpoint')

    expect(h.redirect).toHaveBeenCalledTimes(1)
    expect(h.redirect.mock.calls[0]![0]).toBe('use the other endpoint')
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(lastUserMessageStatus(h.events)).toBe('accepted')
  })
})
