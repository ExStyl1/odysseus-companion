/**
 * D1.376 — `cancelProcessing` performs the STOP before the queue bookkeeping,
 * and an event-channel failure can no longer swallow a user's Stop.
 *
 * ## What this is NOT
 *
 * It is not the cause of RS-81. The cause is one line in the renderer —
 * `handleUserMessage`'s `isProcessing: status === 'accepted' || status === 'processing'`
 * lowered the session's processing flag on a message the host had QUEUED behind
 * a running turn, and `ChatDisplay.handleStop`'s first line
 * (`if (!session?.isProcessing) return`) then returned before the RPC, so the
 * host was never asked to stop at all. That is fixed in
 * `apps/electron/src/renderer/event-processor/handlers/__tests__/queued-message-keeps-processing.test.ts`,
 * and the reading is in this lane's report.
 *
 * ## What it IS
 *
 * The one statement in this method that is gated on the queue —
 * `if (managed.messageQueue.length > 0) { managed.queuePaused = true; this.emitQueueChanged(managed) }` —
 * used to run BEFORE `stopRequested`, `wasInterrupted`, `forceAbort` and the
 * `Response interrupted` row. `emitQueueChanged` reaches the renderer through
 * `sendEvent` → the event sink → the RPC push, and nothing on that path is
 * inside a `try`. So a single rejecting frame there returned the method at a
 * statement whose ONLY job is to keep a queued message from draining, and the
 * user's Stop was lost — silently, because both renderer call sites end in
 * `.catch(error => console.error(…))`.
 *
 * The ordering is free to fix and it removes a whole class: the Stop is now the
 * first thing that happens, and the bookkeeping that follows cannot un-happen
 * it. `queuePaused` is still set inside the same synchronous frame as
 * `forceAbort` — there is no `await` between them — so the drain in
 * `onProcessingStopped` still cannot slip past it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AbortReason } from '@nessy-agent/shared/agent'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface FixtureOptions {
  /** Messages parked behind the running turn. */
  queued: string[]
  /** Make the `queue_changed` push fail, the way a dead event sink would. */
  queueEventThrows?: boolean
}

function fixture(options: FixtureOptions) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-cancel-stop-first-'))
  roots.push(stateRoot)
  const manager = createTestSessionManager() as any

  const workspace = {
    id: 'ws-cancel',
    name: 'Cancel Workspace',
    slug: 'cancel-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-1' },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  managed.isProcessing = true
  managed.messages = [
    { id: 'msg-1', role: 'user', content: 'run three shell steps', timestamp: 1 },
  ] as typeof managed.messages
  managed.messageQueue = options.queued.map((message, index) => ({
    message,
    messageId: `queued-${index}`,
  })) as typeof managed.messageQueue

  const aborts: string[] = []
  managed.agent = {
    forceAbort: (reason: string) => { aborts.push(reason) },
  } as unknown as typeof managed.agent

  manager.sessions.set(`${workspace.id}:${managed.id}`, managed)

  const events: string[] = []
  manager.sendEvent = (event: any) => {
    events.push(event?.type)
    if (options.queueEventThrows && event?.type === 'queue_changed') {
      throw new Error('event sink is gone')
    }
  }

  return {
    manager,
    managed,
    aborts,
    events,
    interruptRows: () => managed.messages.filter(
      (message: { role: string; content: string }) =>
        message.role === 'info' && message.content === 'Response interrupted',
    ).length,
  }
}

describe('a user Stop reaches the backend before any queue bookkeeping', () => {
  it('stops the turn and pauses the queue when a message is parked behind it', async () => {
    const rig = fixture({ queued: ['a follow-up'] })

    await rig.manager.cancelProcessing('session-1', false, 'ws-cancel')

    expect(rig.aborts).toEqual([AbortReason.UserStop])
    expect(rig.managed.stopRequested).toBe(true)
    expect(rig.managed.wasInterrupted).toBe(true)
    expect(rig.managed.queuePaused).toBe(true)
    expect(rig.interruptRows()).toBe(1)
    // The parked message is NOT delivered by the Stop — it stays queued and
    // visible, which is the product posture D1.361 states.
    expect(rig.managed.messageQueue.map((entry: { message: string }) => entry.message))
      .toEqual(['a follow-up'])
  })

  it('THE ROW — a dead event sink can no longer swallow the Stop', async () => {
    // RED before this row: the throw escaped from `emitQueueChanged`, which ran
    // FIRST, so `forceAbort` never ran, no `Response interrupted` row was
    // appended, `queuePaused` stayed false and the queued message drained on the
    // turn's natural end — every effect RS-81 arm A found missing.
    const rig = fixture({ queued: ['a follow-up'], queueEventThrows: true })

    await rig.manager.cancelProcessing('session-1', false, 'ws-cancel')

    expect(rig.aborts).toEqual([AbortReason.UserStop])
    expect(rig.managed.stopRequested).toBe(true)
    expect(rig.interruptRows()).toBe(1)
    // The pause is bookkeeping the host owns; only the BROADCAST failed, so the
    // queue must still be paused or the message drains behind a stopped turn.
    expect(rig.managed.queuePaused).toBe(true)
    expect(rig.events).toContain('queue_changed')
  })

  it('THE CONTROL — the same failing sink with an EMPTY queue', async () => {
    // Green before this row and after it. `queue_changed` is only emitted when
    // the queue is non-empty, so this arm proves the arm above is about the
    // queue-gated statement rather than about a sink that throws for everything.
    const rig = fixture({ queued: [], queueEventThrows: true })

    await rig.manager.cancelProcessing('session-1', false, 'ws-cancel')

    expect(rig.aborts).toEqual([AbortReason.UserStop])
    expect(rig.interruptRows()).toBe(1)
    expect(rig.managed.queuePaused).toBe(false)
    expect(rig.events).not.toContain('queue_changed')
  })

  it('a SILENT cancel still stops and still pauses, and appends no row', async () => {
    // The redirect path. It must keep its one difference — no user-visible
    // "Response interrupted" — and nothing else.
    const rig = fixture({ queued: ['a follow-up'] })

    await rig.manager.cancelProcessing('session-1', true, 'ws-cancel')

    expect(rig.aborts).toEqual([AbortReason.UserStop])
    expect(rig.managed.queuePaused).toBe(true)
    expect(rig.interruptRows()).toBe(0)
  })

  it('a session that is not processing is still a no-op', () => {
    const rig = fixture({ queued: ['a follow-up'] })
    rig.managed.isProcessing = false

    void rig.manager.cancelProcessing('session-1', false, 'ws-cancel')

    expect(rig.aborts).toEqual([])
    expect(rig.managed.queuePaused).toBe(false)
    expect(rig.interruptRows()).toBe(0)
  })
})
