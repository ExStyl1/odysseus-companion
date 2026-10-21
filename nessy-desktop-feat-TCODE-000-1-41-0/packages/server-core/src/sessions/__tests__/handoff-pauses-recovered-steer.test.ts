/**
 * F1.346 — a steer recovered at a plan or auth HANDOFF pauses the queue, so the
 * correction the user typed while the model planned does not replay after the
 * plan has run.
 *
 * Measured by reading, then pinned here (WJ-gg verifier on F1.238): the three
 * handoff sites (two plan submissions, the auth request) take the accepted
 * steers back into the queue and then lower `isProcessing` THEMSELVES
 * (`setProcessing(false)`), never through `onProcessingStopped` — so nothing
 * drains the queue at that boundary. The recovered steer sat in an unpaused
 * queue; the user accepted the plan (an idle send that starts the execution
 * turn), and the steer replayed at the END of that turn, after the plan it was
 * meant to change had run.
 *
 * The posture (the row offers two; the smaller and more transparent one):
 * the queue is PAUSED when a handoff hands a steer back — the state a Stop
 * leaves — so the correction waits in the queue with Send now / Resume. A
 * message the user QUEUED on purpose does not pause anything.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-346'

interface Row { id: string; role: string; content: string; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Row[]
  messageQueue: Array<{ message: string; messageId?: string }>
  queuePaused: boolean
}

function agentShape(holdsSteers: boolean) {
  const held: Array<{ message: string; messageId?: string }> = []
  const agent: Record<string, unknown> = {
    isProcessing: () => true,
    redirect(message: string, metadata?: { messageId?: string }) {
      if (holdsSteers) held.push({ message, ...(metadata?.messageId === undefined ? {} : { messageId: metadata.messageId }) })
      return true
    },
    forceAbort: () => undefined,
    interruptForHandoff: () => undefined,
  }
  if (holdsSteers) agent.takePendingSteers = () => held.splice(0)
  return { agent, held }
}

function rig(sessionId: string, agent: unknown) {
  const sm = createTestSessionManager()
  sm.setEventSink((() => undefined) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-346-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.346' },
    { id: WORKSPACE_ID, name: 'F1.346', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  managed.agent = agent
  managed.isProcessing = true
  const planPath = join(root, 'plan.md')
  writeFileSync(planPath, '# Plan\n\n1. migrate the table\n')
  const internals = sm as unknown as {
    projectPiPlanSubmission(managed: unknown, planPath: string): Promise<void>
    onProcessingStopped(sessionId: string, reason: 'complete', workspaceId?: string): Promise<void>
    processNextQueuedMessage(sessionId: string, workspaceId?: string): void
  }
  return { sm, managed, internals, planPath }
}

const lastUser = (managed: Managed) => managed.messages.filter(message => message.role === 'user').at(-1)!

describe('F1.346 — a steer recovered at a plan handoff waits, paused', () => {
  it('the handoff that hands a steer back PAUSES the queue, and the end of the next (execution) turn does not replay it', async () => {
    const backend = agentShape(true)
    const h = rig('plan-handoff-steer', backend.agent)
    await h.sm.sendMessage(h.managed.id, 'also keep the old column for a release')
    const steer = lastUser(h.managed)

    await h.internals.projectPiPlanSubmission(h.managed, h.planPath)

    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([steer.id]) // recovered (F1.238)
    // THE DEFECT: unpaused, so the end of the execution turn replayed it.
    expect(h.managed.queuePaused).toBe(true)

    // The user accepts the plan; the execution turn runs and ends.
    const replayed: string[] = []
    h.internals.processNextQueuedMessage = (sessionId: string) => { replayed.push(sessionId) }
    h.managed.isProcessing = true
    await h.internals.onProcessingStopped(h.managed.id, 'complete', WORKSPACE_ID)

    expect(replayed).toEqual([])
    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([steer.id])
  })

  it('CONTROL — a message QUEUED on purpose before the handoff does not pause the queue', async () => {
    const backend = agentShape(true)
    const h = rig('plan-handoff-queued', backend.agent)
    await h.sm.sendMessage(h.managed.id, 'then also run the tests', undefined, undefined, { midStreamOverride: 'queue' } as never)
    expect(backend.held).toEqual([]) // control: it never went out as a steer

    await h.internals.projectPiPlanSubmission(h.managed, h.planPath)

    expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['then also run the tests'])
    expect(h.managed.queuePaused).toBe(false)
  })

  it('CONTROL — a backend that holds no steers (Pi, codex) leaves the queue as it was', async () => {
    const backend = agentShape(false)
    const h = rig('plan-handoff-no-take', backend.agent)
    await h.sm.sendMessage(h.managed.id, 'a native steer')

    await h.internals.projectPiPlanSubmission(h.managed, h.planPath)

    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.queuePaused).toBe(false)
  })
})
