/**
 * F1.333 — a steer handed back to the queue tells the renderer its transcript
 * row is queued again.
 *
 * Measured before this row: `requeueUndeliveredSteer` flipped the row's
 * `isQueued` back to true on the HOST and broadcast only `queue_changed`. The
 * renderer reads a transcript row's `isQueued` from `user_message` alone —
 * `App.tsx` returns early on `queue_changed`, which feeds the queue list, not
 * the transcript — so the bubble went on rendering as delivered (and offered
 * Rewind) while the queue list showed it queued. Upstream (craft-agents-oss
 * v0.13.4 `recoverUndeliveredSteer`) emits a `user_message` 'queued' here; ours
 * emits one too, marked `requeued`, because the renderer's sequence guard in
 * `handleUserMessage` drops a 'queued' for a row already marked delivered — a
 * steer's row always is — and was measured to (`work/wjqqa/probe-1333-renderer`:
 * a delivered row stays `isQueued: false`). The guard's half is F1.333 (2/2).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-333'

interface Sent { type: string; status?: string; requeued?: boolean; message?: { id: string } }
interface Managed { id: string; isProcessing: boolean; agent: unknown; messages: Array<{ id: string; role: string }> }

function rig(sessionId: string) {
  const sm = createTestSessionManager()
  const sent: Sent[] = []
  sm.setEventSink(((...args: unknown[]) => { sent.push(args[2] as Sent) }) as never)
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.333' },
    { id: WORKSPACE_ID, name: 'F1.333', rootPath: mkdtempSync(join(tmpdir(), 'f1-333-')), createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  const held: Array<{ message: string; messageId?: string }> = []
  managed.agent = {
    isProcessing: () => true,
    redirect: (message: string, metadata?: { messageId?: string }) => { held.push({ message, ...metadata }); return true },
    takePendingSteers: () => held.splice(0),
    forceAbort: () => undefined,
  }
  managed.isProcessing = true
  const internals = sm as unknown as { processEvent(managed: unknown, event: AgentEvent): Promise<void> }
  return { sm, sent, managed, internals, held }
}

const queuedFor = (sent: Sent[], id: string) => sent.filter(event => event.type === 'user_message' && event.status === 'queued' && event.message?.id === id)

describe('F1.333 — a re-queued steer is announced to the transcript', () => {
  it('a steer handed back (steer_undelivered) emits ONE user_message \'queued\' for that id, marked requeued', async () => {
    const h = rig('requeue-event')
    await h.sm.sendMessage(h.managed.id, 'stop, use the other API')
    const id = h.managed.messages.filter(message => message.role === 'user').at(-1)!.id
    h.held.splice(0)

    await h.internals.processEvent(h.managed, { type: 'steer_undelivered', message: 'stop, use the other API', messageId: id } as AgentEvent)

    const queued = queuedFor(h.sent, id)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.requeued).toBe(true)
  })

  it('the take door (a Stop) announces it the same way', async () => {
    const h = rig('requeue-take')
    await h.sm.sendMessage(h.managed.id, 'stop, use the other API')
    const id = h.managed.messages.filter(message => message.role === 'user').at(-1)!.id

    await h.sm.cancelProcessing(h.managed.id, true, WORKSPACE_ID)

    expect(queuedFor(h.sent, id).map(event => event.requeued)).toEqual([true])
    // Defuse the Stop's 5 s safety timer, which would otherwise replay the queue inside a later file.
    ;(h.managed as { stopRequested?: boolean }).stopRequested = false
    h.managed.isProcessing = false
  })

  it('CONTROL — a DELIVERED steer emits no \'queued\' at all (only its \'accepted\')', async () => {
    const h = rig('delivered')
    await h.sm.sendMessage(h.managed.id, 'stop, use the other API')
    const id = h.managed.messages.filter(message => message.role === 'user').at(-1)!.id

    expect(h.sent.filter(event => event.type === 'user_message' && event.message?.id === id).map(event => event.status)).toEqual(['accepted'])
    expect(queuedFor(h.sent, id)).toEqual([])
  })
})
