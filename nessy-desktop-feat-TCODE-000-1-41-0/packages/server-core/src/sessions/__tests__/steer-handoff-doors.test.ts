/**
 * F1.345 — the host doors F1.238 opened, each driven through the REAL method
 * that opens it: the two plan-submission handoffs (`projectPiPlanSubmission`
 * with and without a Pi plan projection) and `sendQueuedNow` followed by a Stop.
 *
 * F1.238 pinned the take at a Stop and at one handoff on a hand-built backend
 * double, and nothing drove either plan-submission site or the steer that
 * `sendQueuedNow` sends (which recorded nothing before F1.238). Each arm here
 * steers a message, crosses the door, and proves the message came back to the
 * queue AS ITSELF — its own transcript id, marked queued — instead of vanishing
 * with the interrupted turn.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-345'

interface Row { id: string; role: string; content: string; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Row[]
  messageQueue: Array<{ message: string; messageId?: string }>
  queuePaused: boolean
  piPlanProjectionId?: string
}

/** Holds accepted steers the way Claude's PreToolUse emulation does. */
function claudeShapedAgent() {
  const held: Array<{ message: string; messageId?: string }> = []
  const handoffs: string[] = []
  return {
    held,
    handoffs,
    agent: {
      isProcessing: () => true,
      redirect(message: string, metadata?: { messageId?: string }) {
        held.push({ message, ...(metadata?.messageId === undefined ? {} : { messageId: metadata.messageId }) })
        return true
      },
      takePendingSteers: () => held.splice(0),
      forceAbort: () => undefined,
      interruptForHandoff: (reason: string) => { handoffs.push(reason) },
    },
  }
}

/**
 * A Stop arms `cancelProcessing`'s 5 s safety timer, which calls `onProcessingStopped`
 * — and so replays the queue — only while `stopRequested && isProcessing`. Left armed,
 * it fired inside LATER files of the same bun process and slowed them past their
 * budget (measured: a neighbour's 5 000 ms timeout). Every session a test created is
 * defused after it.
 */
const created: Array<{ stopRequested?: boolean; isProcessing: boolean }> = []
afterEach(() => {
  for (const session of created.splice(0)) {
    session.stopRequested = false
    session.isProcessing = false
  }
})

function rig(sessionId: string, agent: unknown) {
  const sm = createTestSessionManager()
  sm.setEventSink((() => undefined) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-345-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.345' },
    { id: WORKSPACE_ID, name: 'F1.345', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  managed.agent = agent
  managed.isProcessing = true
  created.push(managed as unknown as { stopRequested?: boolean; isProcessing: boolean })
  const planPath = join(root, 'plan.md')
  writeFileSync(planPath, '# Plan\n\n1. do the thing\n')
  const internals = sm as unknown as { projectPiPlanSubmission(managed: unknown, planPath: string): Promise<void> }
  return { sm, managed, internals, planPath }
}

const lastUser = (managed: Managed) => managed.messages.filter(message => message.role === 'user').at(-1)!

describe('F1.345 — a steer accepted before a plan-submission handoff comes back as itself', () => {
  it('the ADJACENT handoff (no Pi plan projection) re-queues the steer under its own id', async () => {
    const backend = claudeShapedAgent()
    const h = rig('adjacent-plan-handoff', backend.agent)
    await h.sm.sendMessage(h.managed.id, 'also cover the migration')
    const steer = lastUser(h.managed)
    expect(backend.held.map(entry => entry.messageId)).toEqual([steer.id]) // control: it went out as a steer

    await h.internals.projectPiPlanSubmission(h.managed, h.planPath)

    expect(backend.handoffs).toEqual(['plan_submitted'])
    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([steer.id])
    expect(steer.isQueued).toBe(true)
    expect(h.managed.isProcessing).toBe(false)
  })

  it('the Pi-PROJECTION handoff re-queues the steer under its own id', async () => {
    const backend = claudeShapedAgent()
    const h = rig('projected-plan-handoff', backend.agent)
    h.managed.piPlanProjectionId = 'plan-projection-f1-345'
    await h.sm.sendMessage(h.managed.id, 'also cover the migration')
    const steer = lastUser(h.managed)

    await h.internals.projectPiPlanSubmission(h.managed, h.planPath)

    expect(h.managed.messages.some(message => message.id === 'plan-projection-f1-345' && message.role === 'plan')).toBe(true) // control: the projection branch ran
    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([steer.id])
    expect(steer.isQueued).toBe(true)
  })
})

describe('F1.345 — sendQueuedNow, then Stop', () => {
  it('a queued row sent now as a steer and then stopped comes back under its own id', async () => {
    const backend = claudeShapedAgent()
    const h = rig('send-now-then-stop', backend.agent)
    // Queue it first (the connection default steers, so ask for the queue for this one send).
    await h.sm.sendMessage(h.managed.id, 'send me now', undefined, undefined, { midStreamOverride: 'queue' } as never)
    const row = lastUser(h.managed)
    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([row.id])

    await h.sm.sendQueuedNow(h.managed.id, row.id, WORKSPACE_ID)
    expect(backend.held.map(entry => entry.messageId)).toEqual([row.id]) // control: sent as a steer
    expect(h.managed.messageQueue).toEqual([])

    await h.sm.cancelProcessing(h.managed.id, true, WORKSPACE_ID)

    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([row.id])
    expect(row.isQueued).toBe(true)
  })
})
