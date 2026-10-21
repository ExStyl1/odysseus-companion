/**
 * F1.351 (host half) — a between-turns task notification is stored MARKED, so the
 * renderer can draw it as a labelled system line instead of the user's bubble.
 *
 * `flushPendingTaskNotifications` hands `buildTaskNotificationDelivery(...)` to
 * `sendMessage` as its `message`, and `sendMessage` stored it as a plain role-user
 * transcript entry: nothing on the wire said the user had not typed it. The flush
 * now passes `taskNotification: true` on `sendMessage`'s host-internal context
 * (never on the wire `SendMessageOptions`, so a client cannot claim it), and both
 * user-entry sites in `sendMessage` stamp `Message.taskNotification` from it. The
 * model still receives the same text: only the transcript entry is marked.
 *
 * DECIDED by the controller (2026-09-23): a LABELLED SYSTEM LINE, not hidden —
 * the renderer half is `apps/electron/.../task-notification-line.test.tsx`.
 */
import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { messageToStored } from '@nessy-agent/core/types'
import { PiAgent } from '../../../../shared/src/agent/pi-agent.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-351'

interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Array<Record<string, unknown>>
  messageQueue: Array<Record<string, unknown>>
  pendingTaskNotifications?: string[]
  processingGeneration?: number
}

function rig(sessionId: string) {
  const sm = createTestSessionManager()
  const events: Array<Record<string, unknown>> = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as Record<string, unknown>) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-351-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.351' },
    { id: WORKSPACE_ID, name: 'F1.351', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  return { sm, managed, events }
}

describe('F1.351 — a between-turns task notification is a MARKED transcript entry', () => {
  it('the flush hands sendMessage the host-internal taskNotification flag, and no wire option', async () => {
    const h = rig('flush')
    const calls: unknown[][] = []
    ;(h.sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => { calls.push(args) }
    h.managed.pendingTaskNotifications = ['Background subagent task t-1 finished (completed).']

    await (h.sm as unknown as { flushPendingTaskNotifications(m: unknown): Promise<void> }).flushPendingTaskNotifications(h.managed)

    expect(calls).toHaveLength(1)
    const [, message, , , options, , , , context] = calls[0]!
    expect(String(message)).toContain('<task-notification>')
    expect(options).toBeUndefined()
    expect(context).toEqual({ workspaceId: WORKSPACE_ID, taskNotification: true })
  })

  it('THE ROW: sendMessage stamps the entry it stores, and the stamp survives persistence and the wire', async () => {
    const h = rig('entry')
    const agent = Object.create(PiAgent.prototype) as Record<string, unknown>
    agent.redirect = mock(() => true)
    agent.forceAbort = () => undefined
    agent.debug = () => undefined
    h.managed.agent = agent
    // Mid-turn, so the REAL sendMessage stores the entry and queues it without a backend turn.
    h.managed.isProcessing = true

    await (h.sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage(
      h.managed.id, '<task-notification>\nBackground subagent task t-1 finished.\n</task-notification>',
      undefined, undefined, undefined, undefined, undefined, undefined,
      { workspaceId: WORKSPACE_ID, taskNotification: true },
    )

    const entry = h.managed.messages.at(-1)!
    expect(entry.role).toBe('user')
    expect(entry.taskNotification).toBe(true)
    expect((messageToStored(entry as never) as { taskNotification?: unknown }).taskNotification).toBe(true)
    const wire = h.events.filter(e => e.type === 'user_message').at(-1)!
    expect((wire.message as { taskNotification?: unknown }).taskNotification).toBe(true)
  })

  it('CONTROL — a human send stores an entry that carries no flag at all', async () => {
    const h = rig('human')
    const agent = Object.create(PiAgent.prototype) as Record<string, unknown>
    agent.redirect = mock(() => true)
    agent.forceAbort = () => undefined
    agent.debug = () => undefined
    h.managed.agent = agent
    h.managed.isProcessing = true

    await (h.sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage(
      h.managed.id, 'a message I typed',
      undefined, undefined, undefined, undefined, undefined, undefined,
      { workspaceId: WORKSPACE_ID },
    )

    const entry = h.managed.messages.at(-1)!
    expect(entry.content).toBe('a message I typed')
    expect('taskNotification' in entry).toBe(false)
  })
})
