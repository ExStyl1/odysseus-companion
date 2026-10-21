/**
 * F1.509 (origin WJ-af P-WJ-af-1) — a message sent while the RUNTIME runs a turn it opened itself is queued like a
 * message sent during any running turn, and replays as its own turn once that turn settles.
 *
 * ## The defect (measured on the vendored claude 2.1.251 through `ClaudeAgent`, WJ-af's rig)
 *
 * The claude CLI opens a turn of its own between host turns to hand the model `<task-notification>`. The host
 * could not see it — `managed.isProcessing` and the agent's `isProcessing()` both say idle — so a send took the
 * idle path: a new slot opened and the message was written into the live input mid-turn. The slot then received
 * the CLI turn's reply and closed on ITS `result`, the message was answered in a turn nobody watched, and the NEXT
 * message was shown that answer while its own was dropped: every boundary after it slipped by one.
 *
 * ## What the host does now (`SessionManager.sendMessage`)
 *
 * It asks the agent (`AgentBackend.runtimeOwnTurnSettled`, `ClaudeAgent`'s answer is pinned in `shared`'s
 * `claude-runtime-own-turn.test.ts`). While such a turn runs, the send takes the mid-stream branch as `'queue'` —
 * never `'steer'`: `ClaudeAgent.redirect` with no slot open is a session KILL (`forceAbort(Redirect)`), which would
 * take the runtime's turn and every background task down with it. When the turn settles, the queue replays through
 * `processNextQueuedMessage`, the same door `onProcessingStopped` uses.
 *
 * The rig is `mid-stream-attachments-queue.test.ts`'s: the REAL `sendMessage`, an agent built on `ClaudeAgent`'s
 * real prototype with no subprocess, its `redirect` a spy that WOULD accept.
 */
import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { ClaudeAgent } from '../../../../shared/src/agent/claude-agent.ts'
import { PiAgent } from '../../../../shared/src/agent/pi-agent.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-509'

interface QueueEntry { message: string; messageId?: string }
interface TranscriptRow { id: string; role: string; content: string; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: TranscriptRow[]
  messageQueue: QueueEntry[]
  wasInterrupted?: boolean
}

function ownTurn(): { settled: Promise<void>; settle(): void } {
  let settle!: () => void
  const settled = new Promise<void>(resolve => { settle = resolve })
  return { settled, settle }
}

function rig(sessionId: string, runtimeTurn: Promise<void> | null, prototype: object = ClaudeAgent.prototype) {
  const sm = createTestSessionManager()
  const events: Array<{ type: string; status?: string; message?: { id?: string } }> = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as { type: string; status?: string }) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-509-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.509' },
    { id: WORKSPACE_ID, name: 'F1.509', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  const redirect = mock((_message: string, _metadata?: unknown) => true)
  // The idle path's door into the model. It must not be reached while the runtime's own turn runs; if it is, it
  // throws, so the send fails loudly instead of wandering into agent construction.
  const chat = mock(() => { throw new Error('F1.509 rig: the idle path reached agent.chat') })
  const agent = Object.create(prototype) as Record<string, unknown>
  agent.redirect = redirect
  agent.chat = chat
  agent.forceAbort = () => undefined
  agent.debug = () => undefined
  // The seam under test, answered the way `ClaudeAgent` answers it.
  agent.runtimeOwnTurnSettled = () => runtimeTurn
  managed.agent = agent
  managed.isProcessing = false
  return { sm, managed, events, redirect, chat }
}

function lastUserMessageStatus(events: Array<{ type: string; status?: string }>): string | undefined {
  return events.filter(event => event.type === 'user_message').at(-1)?.status
}

/** Replace `sendMessage` AFTER the real call under test, so the replay it triggers is recorded, not run. */
function recordReplays(sm: unknown): unknown[][] {
  const replayed: unknown[][] = []
  ;(sm as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => {
    replayed.push(args)
  }
  return replayed
}

const macrotask = () => new Promise<void>(resolve => setImmediate(resolve))

describe('F1.509 — a send during the runtime\'s own turn is queued, never written into that turn', () => {
  it('the message is queued (not steered, not started) and the transcript row says so', async () => {
    const turn = ownTurn()
    const h = rig('queued', turn.settled)
    await Promise.race([
      h.sm.sendMessage(h.managed.id, 'what did the subagent find?').catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ])

    expect(h.chat).not.toHaveBeenCalled()
    // A steer here would be `ClaudeAgent.redirect` with no slot open: a session kill.
    expect(h.redirect).not.toHaveBeenCalled()
    expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['what did the subagent find?'])
    const row = h.managed.messages.find(m => m.id === h.managed.messageQueue[0]!.messageId)!
    expect(row.isQueued).toBe(true)
    expect(lastUserMessageStatus(h.events)).toBe('queued')
    // Queued, not a failed steer: nothing was interrupted, so the next turn must not be told it was.
    expect(h.managed.wasInterrupted).not.toBe(true)
  })

  it('when that turn settles, the queue replays the message as its OWN turn, once', async () => {
    const turn = ownTurn()
    const h = rig('replay', turn.settled)
    await h.sm.sendMessage(h.managed.id, 'first')
    await h.sm.sendMessage(h.managed.id, 'second')
    const firstId = h.managed.messageQueue[0]!.messageId
    const replayed = recordReplays(h.sm)

    await macrotask()
    expect(replayed).toHaveLength(0)

    turn.settle()
    await macrotask()
    await macrotask()

    // ONE replay per settled turn — the second message waits for the first one's turn to end, as any queue does.
    expect(replayed).toHaveLength(1)
    expect(replayed[0]![1]).toBe('first')
    expect(replayed[0]![5]).toBe(firstId)
    expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['second'])
    // The renderer is told the queued row is now processing (and re-stamped after the runtime turn's reply).
    const processing = h.events.filter(event => event.type === 'user_message' && event.status === 'processing')
    expect(processing.map(event => event.message?.id)).toEqual([firstId])
  })

  it('a turn that settles while the HOST is already processing replays nothing — the host turn\'s end will', async () => {
    const turn = ownTurn()
    const h = rig('host-busy', turn.settled)
    await h.sm.sendMessage(h.managed.id, 'queued behind the runtime turn')
    const replayed = recordReplays(h.sm)
    h.managed.isProcessing = true

    turn.settle()
    await macrotask()
    await macrotask()

    expect(replayed).toHaveLength(0)
    expect(h.managed.messageQueue).toHaveLength(1)
  })
})

describe('F1.509 — CONTROL: nothing changes when the runtime is not running a turn of its own', () => {
  it('a host turn in flight still steers exactly as before, own turn or not', async () => {
    const h = rig('host-turn', ownTurn().settled)
    h.managed.isProcessing = true
    await h.sm.sendMessage(h.managed.id, 'use the other API instead')

    expect(h.redirect).toHaveBeenCalledTimes(1)
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(lastUserMessageStatus(h.events)).toBe('accepted')
  })

  it('an idle agent whose runtime is NOT running its own turn takes the idle path, unqueued', async () => {
    const h = rig('idle', null)
    await Promise.race([
      h.sm.sendMessage(h.managed.id, 'hello').catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ])

    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.redirect).not.toHaveBeenCalled()
    expect(h.managed.messages.find(m => m.content === 'hello')?.isQueued).not.toBe(true)
  })

  it('a runtime without the seam (Pi) is read as "no own turn"', async () => {
    const h = rig('pi', null, PiAgent.prototype)
    delete (h.managed.agent as Record<string, unknown>).runtimeOwnTurnSettled
    await Promise.race([
      h.sm.sendMessage(h.managed.id, 'hello pi').catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ])

    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.redirect).not.toHaveBeenCalled()
  })
})
