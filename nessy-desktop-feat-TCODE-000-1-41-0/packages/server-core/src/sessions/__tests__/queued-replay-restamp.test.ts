/**
 * F1.349 — a message queued while the agent streamed is RE-STAMPED when its
 * replay starts, so it sorts after the answer it waited for.
 *
 * Measured at HEAD before this row (upstream comparison, session 21138b, read
 * 2f49fafb4): `sendMessage` stamps a queued user message with `monotonic()` at
 * ENQUEUE time and the finished answer is stamped at COMPLETION, so the queued
 * question is OLDER than the answer it followed. `insertCompletedAssistantMessage`
 * (transcript-order.ts) fixes the host ARRAY order, but the renderer's
 * `groupMessagesByTurn` sorts by timestamp — live and after a reload — and so drew
 * the previous turn's answer BELOW the queued question. `processNextQueuedMessage`
 * did not re-stamp.
 *
 * The host half ported from craft-agents-oss v0.11.2 / v0.13.4
 * (`processNextQueuedMessage`: `existingMessage.timestamp = this.monotonic()`,
 * Apache-2.0); the renderer half, which applies the stamp on `'processing'`, is
 * pinned in `apps/electron/.../handlers/__tests__/queued-restamp.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-349'

interface Managed { id: string; messageQueue: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> }

function rig(sessionId: string) {
  const sm = createTestSessionManager()
  const events: Array<Record<string, unknown>> = []
  sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => { events.push(event) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-349-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.349' },
    { id: WORKSPACE_ID, name: 'F1.349', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async () => {}
  return { sm, managed, events }
}

describe('F1.349 — the replay of a queued message re-stamps it after the answer it waited for', () => {
  it('THE ROW: processNextQueuedMessage moves the queued question past answer 1, and the processing event carries the new stamp', () => {
    const h = rig('restamp')
    const QUEUED_AT = 1_000
    const ANSWER_AT = 2_000
    h.managed.messages.push(
      { id: 'u-1', role: 'user', content: 'question 1', timestamp: 500 },
      { id: 'u-2', role: 'user', content: 'question 2', timestamp: QUEUED_AT, isQueued: true },
      { id: 'a-1', role: 'assistant', content: 'answer 1', timestamp: ANSWER_AT },
    )
    h.managed.messageQueue.push({ message: 'question 2', messageId: 'u-2' })

    ;(h.sm as unknown as { processNextQueuedMessage(id: string, ws: string): void }).processNextQueuedMessage(h.managed.id, WORKSPACE_ID)

    const replayed = h.managed.messages.find(m => m.id === 'u-2')!
    expect(replayed.isQueued).toBe(false)
    // THE DEFECT: still QUEUED_AT, i.e. older than answer 1.
    expect(replayed.timestamp as number).toBeGreaterThan(ANSWER_AT)
    const processing = h.events.find(e => e.type === 'user_message' && e.status === 'processing')
    expect(processing).toBeDefined()
    expect((processing!.message as { timestamp: number }).timestamp).toBe(replayed.timestamp as number)
  })

  it('CONTROL — only the replayed row moves: the rows around it keep their stamps', () => {
    const h = rig('neighbours')
    h.managed.messages.push(
      { id: 'u-1', role: 'user', content: 'question 1', timestamp: 500 },
      { id: 'u-2', role: 'user', content: 'question 2', timestamp: 1_000, isQueued: true },
      { id: 'a-1', role: 'assistant', content: 'answer 1', timestamp: 2_000 },
      { id: 'u-3', role: 'user', content: 'question 3', timestamp: 1_500, isQueued: true },
    )
    h.managed.messageQueue.push({ message: 'question 2', messageId: 'u-2' }, { message: 'question 3', messageId: 'u-3' })

    ;(h.sm as unknown as { processNextQueuedMessage(id: string, ws: string): void }).processNextQueuedMessage(h.managed.id, WORKSPACE_ID)

    const stamp = (id: string) => h.managed.messages.find(m => m.id === id)!.timestamp
    expect([stamp('u-1'), stamp('a-1'), stamp('u-3')]).toEqual([500, 2_000, 1_500])
    // question 3 is still queued, so it is re-stamped by ITS replay, not this one.
    expect(h.managed.messages.find(m => m.id === 'u-3')!.isQueued).toBe(true)
  })
})
