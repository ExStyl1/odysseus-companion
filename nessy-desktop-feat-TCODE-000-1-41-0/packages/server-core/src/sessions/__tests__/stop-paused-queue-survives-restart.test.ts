/**
 * F1.1248 (the final sitting's D-17) — a message queue paused by Stop stays paused across an app restart.
 *
 * Measured on the RC (SIT2-f, RS-81 arm A): a claude message queued behind a turn the user stopped waited, as D1.376
 * promises, for 53 minutes; at the next launch the host sent it by itself, in the restored mode, with nobody driving.
 * `queuePaused` lived only in memory, and queue recovery re-queued every orphaned `isQueued` row and drained it.
 *
 * What runs for real: `cancelProcessing` (the user's Stop and its D1.376 pause), `persistSession` and the persistence
 * queue writing the session file, then a FRESH manager (the restart) loading that file through the real session
 * store and its queue recovery — both doors: `ensureMessagesLoaded` (opening the chat) and the cold-persist hydration
 * (anything that writes the session first). Only `processNextQueuedMessage` is replaced, by a recorder: whether it is
 * called is the defect.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionFilePath } from '@nessy-agent/shared/sessions'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-1248'
const QUEUED = 'CDP RS-81 queued message — this one must survive or be cancelled.'

interface Managed {
  id: string
  isProcessing: boolean
  queuePaused: boolean
  messagesLoaded: boolean
  messageQueue: Array<{ message: string; messageId?: string }>
  messages: Array<Record<string, unknown>>
}

interface Internals {
  sessions: Map<string, unknown>
  persistSession(managed: unknown): void
  ensureMessagesLoaded(managed: unknown): Promise<void>
  processNextQueuedMessage(sessionId: string, workspaceId: string): void
}

const roots: string[] = []
const managers: Array<ReturnType<typeof createTestSessionManager>> = []
let counter = 0

function process_(sessionId: string, messagesLoaded: boolean) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const events: Array<Record<string, unknown>> = []
  manager.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => { events.push(event) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-1248-'))
  roots.push(root)
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.1248' },
    { id: WORKSPACE_ID, name: 'F1.1248', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded },
  ) as unknown as Managed
  const internals = manager as unknown as Internals
  internals.sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }), managed)
  const sent: string[] = []
  internals.processNextQueuedMessage = (id: string) => { sent.push(id) }
  return { manager, internals, managed, events, sent }
}

/** The process before the restart: a turn running, one message queued behind it, then (or not) the user's Stop. */
async function previousLaunch(stop: boolean): Promise<string> {
  counter += 1
  const sessionId = `session-f1-1248-${counter}`
  const before = process_(sessionId, true)
  before.managed.messages.push(
    { id: 'u-1', role: 'user', content: 'run the long Bash call', timestamp: 1 },
    { id: 'u-q', role: 'user', content: QUEUED, timestamp: 2, isQueued: true },
  )
  before.managed.messageQueue.push({ message: QUEUED, messageId: 'u-q' })
  before.managed.isProcessing = true
  if (stop) {
    await before.manager.cancelProcessing(sessionId, false, WORKSPACE_ID)
    expect(before.managed.queuePaused).toBe(true) // D1.376 — the live half, unchanged
  }
  before.managed.isProcessing = false
  // onProcessingStopped's "6. Always persist", then the quit's flush.
  before.internals.persistSession(before.managed)
  await before.manager.flushSession(sessionId, WORKSPACE_ID, { strict: true })
  return sessionId
}

function header(sessionId: string): Record<string, unknown> {
  const firstLine = readFileSync(getSessionFilePath(WORKSPACE_ID, sessionId), 'utf-8').split('\n')[0]!
  return JSON.parse(firstLine) as Record<string, unknown>
}

const doors: Array<[string, (after: ReturnType<typeof process_>) => Promise<void>]> = [
  ['opening the chat (ensureMessagesLoaded)', async after => { await after.internals.ensureMessagesLoaded(after.managed) }],
  ['a write before the chat is opened (the cold-persist hydration)', async after => { after.internals.persistSession(after.managed) }],
]

const settle = () => new Promise(resolve => setImmediate(resolve))

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.flushAllSessions().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('F1.1248 — a queue paused by Stop is still paused after a restart', () => {
  for (const [door, load] of doors) {
    it(`a message queued behind a stopped turn is recovered PAUSED and not sent — ${door}`, async () => {
      const sessionId = await previousLaunch(true)
      expect(header(sessionId).messageQueuePaused).toBe(true)

      const after = process_(sessionId, false)
      await load(after)
      await settle()

      expect(after.managed.messageQueue.map(entry => entry.message)).toEqual([QUEUED])
      expect(after.managed.queuePaused).toBe(true)
      // THE DEFECT: the recovery drained it — the next launch sent the user's message unattended.
      expect(after.sent).toEqual([])
      // The chat shows the same paused queue the user left (Send now / Resume), not a bare queued row.
      const changed = after.events.filter(event => event.type === 'queue_changed')
      expect(changed.at(-1)?.paused).toBe(true)
      expect(after.manager.getQueuedMessages(sessionId, WORKSPACE_ID).paused).toBe(true)
    })
  }

  it('after the restart the user\'s Resume sends it, and the stored pause is gone with the live one', async () => {
    const sessionId = await previousLaunch(true)
    const after = process_(sessionId, false)
    await after.internals.ensureMessagesLoaded(after.managed)
    await settle()
    expect(after.sent).toEqual([])

    await after.manager.resumeQueue(sessionId, WORKSPACE_ID)
    await after.manager.flushSession(sessionId, WORKSPACE_ID, { strict: true })

    expect(after.sent).toEqual([sessionId])
    expect(after.managed.queuePaused).toBe(false)
    expect('messageQueuePaused' in header(sessionId)).toBe(false) // a later restart does not pause it again
  })

  it('BOUNDARY: a queue nobody paused (a quit or a crash mid-turn) is still recovered and drained, as before', async () => {
    const sessionId = await previousLaunch(false)
    expect('messageQueuePaused' in header(sessionId)).toBe(false)

    const after = process_(sessionId, false)
    await after.internals.ensureMessagesLoaded(after.managed)
    await settle()

    expect(after.managed.messageQueue.map(entry => entry.message)).toEqual([QUEUED])
    expect(after.managed.queuePaused).toBe(false)
    expect(after.sent).toEqual([sessionId])
  })
})
