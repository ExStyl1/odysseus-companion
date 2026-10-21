/**
 * F1.480 — "Send now" on a queued row of an IDLE session (the queue paused after
 * a Stop) takes the row out of the queued state, as the automatic replay does.
 *
 * Measured by WJ-qq-b's probe (`work/wjqqb/probe/send-now-idle-isqueued.probe.test.ts`,
 * 2026-09-24): `sendQueuedNow`'s idle path spliced the entry and called
 * `sendMessage` with its id, and neither wrote the transcript row — `isQueued`
 * stayed true and the only event was `queue_changed`. So the renderer kept the
 * queued chip on a message that was running, F1.349's re-stamp was skipped (the
 * answer it waited for could sort below it), and — from reading the two
 * recovery sites, which re-queue every `isQueued` row — a restart would replay
 * an already-answered message as a duplicate turn.
 *
 * `processNextQueuedMessage` has always done the three steps: clear `isQueued`,
 * re-stamp, emit 'processing'. The idle send-now now does the same.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-480'

interface Row { id: string; role: string; content: string; timestamp: number; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Row[]
  messageQueue: Array<{ message: string; messageId?: string }>
  queuePaused: boolean
}
interface Sent { type: string; status?: string; message?: { id: string } }

function rig(sessionId: string, options: { processing: boolean; redirect?: boolean }) {
  const sm = createTestSessionManager()
  const sent: Sent[] = []
  sm.setEventSink(((...args: unknown[]) => { sent.push(args[2] as Sent) }) as never)
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.480' },
    { id: WORKSPACE_ID, name: 'F1.480', rootPath: mkdtempSync(join(tmpdir(), 'f1-480-')), createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  const redirected: string[] = []
  managed.agent = {
    isProcessing: () => options.processing,
    redirect: (message: string) => { redirected.push(message); return options.redirect ?? false },
    forceAbort: () => undefined,
  }
  managed.isProcessing = options.processing
  managed.queuePaused = true
  managed.messages.push({ id: 'm-1', role: 'user', content: 'queued before the Stop', timestamp: 1, isQueued: true })
  managed.messageQueue.push({ message: 'queued before the Stop', messageId: 'm-1' })
  // The turn itself is not this row's subject: record the hand-off to `sendMessage`.
  const handedOff: unknown[][] = []
  ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => { handedOff.push(args) }
  return { sm, managed, sent, handedOff, redirected }
}

const row = (managed: Managed) => managed.messages.find(message => message.id === 'm-1')!
const statusesFor = (sent: Sent[]) => sent.filter(event => event.type === 'user_message' && event.message?.id === 'm-1').map(event => event.status)

describe('F1.480 — an idle "Send now" is a replay, and says so', () => {
  it('clears isQueued, re-stamps the row and emits \'processing\' before handing the turn to sendMessage', async () => {
    const h = rig('idle-send-now', { processing: false })

    await h.sm.sendQueuedNow(h.managed.id, 'm-1', WORKSPACE_ID)

    expect(h.handedOff).toHaveLength(1) // control: the turn really was started, with the row's own id
    expect(h.handedOff[0]![5]).toBe('m-1')
    // THE DEFECT: still true, and the only event was queue_changed.
    expect(row(h.managed).isQueued).toBe(false)
    expect(row(h.managed).timestamp).toBeGreaterThan(1)
    expect(statusesFor(h.sent)).toEqual(['processing'])
  })

  it('CONTROL — a BUSY send-now that steers is still \'accepted\', never \'processing\'', async () => {
    const h = rig('busy-steered', { processing: true, redirect: true })

    await h.sm.sendQueuedNow(h.managed.id, 'm-1', WORKSPACE_ID)

    expect(h.redirected).toEqual(['queued before the Stop'])
    expect(row(h.managed).isQueued).toBe(false)
    expect(statusesFor(h.sent)).toEqual(['accepted'])
  })

  it('CONTROL — a BUSY send-now whose steer is refused goes to sendMessage to be re-queued, and says nothing here', async () => {
    const h = rig('busy-refused', { processing: true, redirect: false })

    await h.sm.sendQueuedNow(h.managed.id, 'm-1', WORKSPACE_ID)

    expect(h.handedOff).toHaveLength(1)
    expect(row(h.managed).isQueued).toBe(true)
    expect(statusesFor(h.sent)).toEqual([])
  })
})
