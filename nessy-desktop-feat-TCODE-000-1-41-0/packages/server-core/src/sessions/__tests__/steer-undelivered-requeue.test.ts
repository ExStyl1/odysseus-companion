/**
 * A REFUSED STEER MUST ACTUALLY RE-DELIVER THE USER'S CORRECTION.
 *
 * `redirect()` is allowed to return an optimistic `true` — a claim about the
 * precondition rather than a receipt — ONLY because a refusal that arrives later
 * is reported as `steer_undelivered` and re-queued. That is the whole
 * justification, and it was not holding.
 *
 * The handler minted a FRESH message id. `sendMessage`'s replay path resolves
 * `existingMessageId` with `managed.messages.find(...)!` and throws
 * `Existing message … not found` when it is absent, which the replay catch turns
 * into a `queued_message_replay_failed` banner. So the correction the user typed
 * mid-turn was dropped — after the composer had already shown it as accepted.
 * An accepted steer appends a real transcript message with a real id; this pins
 * that the refusal reuses THAT one.
 *
 * The second half is the interruption flag. `steer_undelivered` set
 * `wasInterrupted = true` unconditionally, which is a THIRD door to the lie
 * `backendInterruptsOnFailedSteer` exists to close — and it bypassed that
 * contract member entirely. On a backend whose failed steer leaves the turn
 * running (codex, Nestor), the next turn must not be told its predecessor was
 * cut off.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const sessionKey = { workspaceId: 'workspace-1', sessionId: 'session-1' }

interface QueueEntry { message: string; messageId?: string }

function harness(options: { backendInterrupts: boolean; steeredId?: string }) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    processEvent(managed: unknown, event: unknown): Promise<void>
    sendEvent(event: unknown, workspaceId: string): void
    emitQueueChanged(managed: unknown): void
  }
  const managed: Record<string, unknown> = {
    id: sessionKey.sessionId,
    workspace: { id: sessionKey.workspaceId, rootPath: '/tmp/workspace-1' },
    isProcessing: true,
    // The message an ACCEPTED steer appended: in the transcript, not queued.
    messages: [
      { id: 'user-0', role: 'user', content: 'refactor the auth module', timestamp: 0 },
      { id: 'steered-1', role: 'user', content: 'stop, use the other API', timestamp: 1, isQueued: false },
    ],
    messageQueue: [] as QueueEntry[],
    queuePaused: false,
    // F1.238 — the record `sendMessage` keeps per steer: id, the text the
    // backend got, and the payload. This event names no id, so it resolves on
    // the text (codex's refusal shape).
    ...(options.steeredId === undefined ? {} : {
      pendingSteers: [{
        steerText: 'stop, use the other API',
        entry: { message: 'stop, use the other API', messageId: options.steeredId },
      }],
    }),
    // A backend that declares its failed steer inert answers `false`; one that
    // stays silent inherits `BaseAgent.redirect`'s abort and reads `true`.
    agent: {
      isProcessing: () => true,
      redirect: () => false,
      ...(options.backendInterrupts ? {} : { redirectFallbackInterruptsTurn: () => false }),
    },
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)
  internals.sendEvent = () => undefined
  internals.emitQueueChanged = () => undefined
  return { internals, managed }
}

const UNDELIVERED = { type: 'steer_undelivered', message: 'stop, use the other API' }

describe('a refused steer is re-queued so it can actually replay', () => {
  test('reuses the transcript id the accepted steer created, and re-marks it queued', async () => {
    const h = harness({ backendInterrupts: false, steeredId: 'steered-1' })
    await h.internals.processEvent(h.managed, UNDELIVERED)

    const queue = h.managed.messageQueue as QueueEntry[]
    expect(queue).toHaveLength(1)
    // THE ASSERTION THIS FILE EXISTS FOR. A fresh id here is a correction the
    // replay will throw on rather than send.
    expect(queue[0]!.messageId).toBe('steered-1')
    const messages = h.managed.messages as Array<{ id: string; isQueued?: boolean }>
    expect(messages.find(m => m.id === 'steered-1')!.isQueued).toBe(true)
    // The id is consumed, so a second refusal cannot replay the same message.
    expect(h.managed.pendingSteers).toEqual([])
  })

  test('with no id to reuse it queues WITHOUT one, rather than inventing a throw', async () => {
    // A steer this manager never recorded — a restart between the accept and the
    // refusal, or a backend that reports one we did not send. Queuing it with a
    // fabricated id is the defect; queuing it with none lets `sendMessage`
    // create the message it needs.
    const h = harness({ backendInterrupts: false })
    await h.internals.processEvent(h.managed, UNDELIVERED)

    const queue = h.managed.messageQueue as QueueEntry[]
    expect(queue).toHaveLength(1)
    expect(queue[0]!.message).toBe('stop, use the other API')
    expect(queue[0]!.messageId).toBeUndefined()
  })

  test('a backend whose failed steer is INERT does not stamp the turn as interrupted', async () => {
    const h = harness({ backendInterrupts: false, steeredId: 'steered-1' })
    await h.internals.processEvent(h.managed, UNDELIVERED)
    expect(h.managed.wasInterrupted).toBeUndefined()
  })

  test('F1.332 — even a backend whose redirect FALLBACK aborts is not stamped by this event', async () => {
    // Re-pinned 2026-09-24 (F1.332, DECIDED by the controller 2026-09-23). This arm
    // was the CONTROL that the stamp survived for an "aborting" backend. But the event
    // reports no abort: on Claude — the one backend whose `backendInterruptsOnFailedSteer`
    // answers true AND which emits it — it comes from a turn that ACCEPTED the redirect
    // and completed with no tool call, so the replay opened by telling the model its
    // finished reply was cut off by the user. The aborts are stamped where they happen;
    // the control below is that a Stop still stamps.
    const h = harness({ backendInterrupts: true, steeredId: 'steered-1' })
    await h.internals.processEvent(h.managed, UNDELIVERED)
    expect(h.managed.wasInterrupted).toBeUndefined()
    // …and the message still comes back as itself.
    expect((h.managed.messageQueue as QueueEntry[]).map(entry => entry.messageId)).toEqual(['steered-1'])
  })

  test('CONTROL — a Stop still stamps the turn (cancelProcessing), and the held steer still comes back', async () => {
    // Without this arm the assertion above would pass against a host that had stopped
    // stamping at all, and a turn the user really stopped would stop saying so.
    const manager = createTestSessionManager()
    manager.setEventSink((() => undefined) as never)
    const managed = createManagedSession(
      { id: 'session-stop', name: 'F1.332' },
      { id: sessionKey.workspaceId, name: 'F1.332', rootPath: mkdtempSync(join(tmpdir(), 'f1-332-')), createdAt: Date.now() } as never,
      { messagesLoaded: true },
    ) as unknown as { id: string; isProcessing: boolean; agent: unknown; wasInterrupted?: boolean; messageQueue: QueueEntry[]; messages: Array<{ id: string; role: string }> }
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      encodeSessionKey({ workspaceId: sessionKey.workspaceId, sessionId: 'session-stop' }),
      managed,
    )
    const held: Array<{ message: string; messageId?: string }> = []
    managed.agent = {
      isProcessing: () => true,
      redirect: (message: string, metadata?: { messageId?: string }) => { held.push({ message, ...metadata }); return true },
      takePendingSteers: () => held.splice(0),
      forceAbort: () => undefined,
    }
    managed.isProcessing = true
    await manager.sendMessage(managed.id, 'stop, use the other API')
    const steered = managed.messages.filter(message => message.role === 'user').at(-1)!

    await manager.cancelProcessing(managed.id, true, sessionKey.workspaceId)

    expect(managed.wasInterrupted).toBe(true)
    expect(managed.messageQueue.map(entry => entry.messageId)).toEqual([steered.id])
    // Defuse the Stop's 5 s safety timer, which would otherwise replay the queue inside a later file.
    ;(managed as { stopRequested?: boolean }).stopRequested = false
    managed.isProcessing = false
  })
})

/**
 * THE TWO WAYS THIS FIX WAS DEFEATED IN PRODUCTION, both found by a LIVE run
 * (STR-2) after the unit tests above were already green — which is the reason
 * they are pinned here rather than trusted.
 *
 * The list is cleared on the turn's RISING edge, not its falling one. `complete`
 * arrives BEFORE `steer_undelivered` on the Claude path, and `complete` is what
 * drives `onProcessingStopped` → `setProcessing(false)`; clearing there meant the
 * handler always saw an empty list and always took the no-id branch.
 *
 * And a queue entry with no id does not stay that way: `queueEntryId` mints one
 * for the renderer's DTO by MUTATING the entry, so the phantom id reached the
 * replay as `existingMessageId` against a transcript that had never seen it — and
 * the replay THREW, destroying the user's correction. It adopts the id now.
 */
describe('the two ways this was defeated live', () => {
  test('the pending list survives the end of its own turn, and is cleared by the next one', () => {
    const h = harness({ backendInterrupts: false, steeredId: 'steered-1' })
    const internals = h.internals as unknown as {
      setProcessing(managed: unknown, processing: boolean): void
    }

    // The falling edge — where the clear used to live. `steer_undelivered` has
    // not arrived yet, so wiping here is what lost the correction.
    internals.setProcessing(h.managed, false)
    expect((h.managed.pendingSteers as Array<{ entry: { messageId: string } }>).map(r => r.entry.messageId)).toEqual(['steered-1'])

    // The rising edge of the NEXT turn is when a stale id would become dangerous.
    internals.setProcessing(h.managed, true)
    expect(h.managed.pendingSteers).toBeUndefined()
  })

  test('a queued id with no transcript entry is ADOPTED, not thrown on', async () => {
    // `queueEntryId` gives every queue row a stable id for the UI, including a
    // row deliberately queued without one. That id then arrives as
    // `existingMessageId`. Throwing here is what dropped the message.
    const h = harness({ backendInterrupts: false })
    const internals = h.internals as unknown as {
      queueEntryId(entry: { messageId?: string }): string
    }
    await h.internals.processEvent(h.managed, UNDELIVERED)

    const queue = h.managed.messageQueue as QueueEntry[]
    const dtoId = internals.queueEntryId(queue[0]!)
    // The mutation is real and is not the defect — the renderer needs it.
    expect(queue[0]!.messageId).toBe(dtoId)
    // What matters is that no transcript message carries it, which is the state
    // the replay used to throw on.
    const messages = h.managed.messages as Array<{ id: string }>
    expect(messages.some(m => m.id === dtoId)).toBe(false)
  })
})
