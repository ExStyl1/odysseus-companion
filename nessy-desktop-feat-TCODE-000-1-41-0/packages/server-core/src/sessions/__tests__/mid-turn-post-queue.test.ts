/**
 * UB6.13 — MID-TURN MESSAGES, THE POST-QUEUE HALF (decision model, toggle `midTurnMessages`).
 *
 * A text message sent while the agent works is RECORDED AS QUEUED at once (send order kept, the
 * acknowledgement never waits on the model, the queue the single source of truth); in the
 * background `steerQueuedIfDecided` moves it into the running turn when the model (or, without an
 * answer, the connection's `midStreamBehavior`) says steer — only while it is still queued, the
 * same turn runs and the backend's `canSteerNow()` says a steer would land without its abort
 * fallback. Two queued messages the model calls one request are replayed together as one turn.
 *
 * Rebased from craft-agents-oss `v0.15.1:packages/server-core/src/sessions/decision-lifecycle.test.ts`
 * ("mid-turn messages", Apache-2.0) onto this tree's rig (`createTestSessionManager`, the composite
 * session key, `processNextQueuedMessage(sessionId, workspaceId)`), plus the row's own controls:
 * layer off = the connection's behaviour as before; `wasInterrupted` from the backend's answer;
 * the ack not waiting on the decision; and the per-runtime `canSteerNow` reads.
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import * as backendFactory from '../../../../shared/src/agent/backend/factory.ts'
import { ClaudeAgent } from '../../../../shared/src/agent/claude-agent.ts'
import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { PiAgent } from '../../../../shared/src/agent/pi-agent.ts'
import * as midTurnMessages from '../../decisions/mid-turn-messages.ts'
import { createManagedSession } from '../SessionManager.ts'
import { canMergeQueuedEntry, isInQueuedContinuation } from '../mid-stream-interruption.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-ub6-13'

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }

interface QueueEntry { message: string; messageId?: string; mergeWith?: object; continuationCheck?: Promise<void> }
interface Row { id: string; role: string; content: string; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  processingGeneration: number
  agent: unknown
  messages: Row[]
  messageQueue: QueueEntry[]
  wasInterrupted?: boolean
  replayMergedIds?: Map<string, string[]>
}

afterEach(() => {
  mock.restore()
})

/** The manager as the cases drive it: the public send plus the private seams they stub (upstream's `as any`). */
type Sm = {
  sendMessage: (...args: unknown[]) => Promise<void>
  [seam: string]: unknown
}

function rig(sessionId: string, agent: Record<string, unknown>) {
  const manager = createTestSessionManager()
  const events: Array<{ type: string; status?: string; message?: { id?: string } }> = []
  manager.setEventSink(((...args: unknown[]) => { events.push(args[2] as { type: string }) }) as never)
  const sm = manager as unknown as Sm
  const root = mkdtempSync(join(tmpdir(), 'ub6-13-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'UB6.13' },
    { id: WORKSPACE_ID, name: 'UB6.13', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm.sessions as Map<string, unknown>).set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  managed.agent = agent
  managed.isProcessing = true
  // Hermetic: the decision layer is off unless a case turns it on.
  sm.decisionFeatureActive = () => false
  return { sm, managed, events }
}

function liveAgent(opts: { canSteer: () => boolean; accepts?: boolean; interruptsOnRefusal?: boolean }) {
  const redirects: string[] = []
  const agent: Record<string, unknown> = {
    redirect: (message: string) => { redirects.push(message); return opts.accepts ?? true },
    canSteerNow: opts.canSteer,
    forceAbort: () => undefined,
  }
  if (opts.interruptsOnRefusal !== undefined) agent.redirectFallbackInterruptsTurn = () => opts.interruptsOnRefusal
  return { agent, redirects }
}

/** Turn the layer on and hand every delivery decision to the test. */
function decidedByTest(sm: Sm) {
  sm.decisionFeatureActive = (feature: string) => feature === 'midTurnMessages'
  const answers = new Map<string, (delivery: 'steer' | 'queue' | null) => void>()
  const asked: string[] = []
  sm.decideMidTurnDelivery = (_managed: unknown, message: string) => {
    asked.push(message)
    return new Promise(resolve => answers.set(message, resolve))
  }
  return { answers, asked }
}

describe('UB6.13 — record as queued, then steer what the model calls a correction', () => {
  it('records messages in send order at once, then steers only the one the model calls a correction', async () => {
    const { agent, redirects } = liveAgent({ canSteer: () => true })
    const { sm, managed, events } = rig('order', agent)
    const { answers } = decidedByTest(sm)
    sm.markQueuedContinuation = async () => {}

    await sm.sendMessage(managed.id, 'also add a changelog entry')
    await sm.sendMessage(managed.id, 'wait, use tabs not spaces')
    // Both are recorded and queued before any decision is back.
    expect(managed.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['also add a changelog entry', 'wait, use tabs not spaces'])
    expect(managed.messageQueue.map(entry => entry.message)).toEqual(['also add a changelog entry', 'wait, use tabs not spaces'])
    expect(redirects).toEqual([])

    // Answers arrive in reverse order.
    answers.get('wait, use tabs not spaces')!('steer')
    answers.get('also add a changelog entry')!('queue')
    await tick()
    expect(redirects).toEqual(['wait, use tabs not spaces'])
    expect(managed.messageQueue.map(entry => entry.message)).toEqual(['also add a changelog entry'])
    const steeredRow = managed.messages.find(m => m.content === 'wait, use tabs not spaces')!
    expect(steeredRow.isQueued).toBe(false)
    const accepted = events.filter(e => e.type === 'user_message' && e.status === 'accepted')
    expect(accepted.map(e => e.message?.id)).toEqual([steeredRow.id])
    // Recorded like a composer steer, so a refusal or a Stop re-queues it under its own id (F1.238).
    const pending = (managed as unknown as { pendingSteers?: Array<{ entry: QueueEntry }> }).pendingSteers ?? []
    expect(pending.map(record => record.entry.messageId)).toEqual([steeredRow.id])
    expect(pending[0]!.entry.continuationCheck).toBeUndefined()
  })

  it('never steers when the backend cannot take a steer right now, or the turn has ended', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'anthropic', midStreamBehavior: 'queue' } as never)
    let canSteer = false
    const { agent, redirects } = liveAgent({ canSteer: () => canSteer })
    const { sm, managed } = rig('steer-guard', agent)
    decidedByTest(sm)
    sm.markQueuedContinuation = async () => {}
    let answer!: (delivery: 'steer') => void
    sm.decideMidTurnDelivery = () => new Promise(resolve => { answer = resolve })

    await sm.sendMessage(managed.id, 'fix the typo first')
    answer('steer')
    await tick()
    expect(redirects).toEqual([])
    expect(managed.messageQueue.map(entry => entry.message)).toEqual(['fix the typo first'])

    canSteer = true
    await sm.sendMessage(managed.id, 'and rename the file')
    managed.processingGeneration++ // that turn ended and a new one began before the answer
    answer('steer')
    await tick()
    expect(redirects).toEqual([])
    expect(managed.messageQueue.map(entry => entry.message)).toEqual(['fix the typo first', 'and rename the file'])

    await sm.sendMessage(managed.id, 'use tabs')
    answer('steer')
    await tick()
    expect(redirects).toEqual(['use tabs'])
  })

  it('without an answer the connection behaviour decides: a steer default steers, a queue default stays queued', async () => {
    const { agent, redirects } = liveAgent({ canSteer: () => true })
    const { sm, managed } = rig('no-answer', agent)
    const { answers } = decidedByTest(sm)
    sm.markQueuedContinuation = async () => {}
    // No connection resolves in the isolated config: the fallback is 'steer'.
    await sm.sendMessage(managed.id, 'one more thing')
    answers.get('one more thing')!(null)
    await tick()
    expect(redirects).toEqual(['one more thing'])

    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'nestor-cloud-agent', midStreamBehavior: 'queue' } as never)
    await sm.sendMessage(managed.id, 'and another')
    answers.get('and another')!(null)
    await tick()
    expect(redirects).toEqual(['one more thing'])
    expect(managed.messageQueue.map(entry => entry.message)).toEqual(['and another'])
  })

  // Found upstream in a harness run: "call it X" was steered while "when you create the event
  // later," replayed alone, so the agent read the second half as "create the event now".
  describe('a message split over two sends', () => {
    const FIRST = 'when you create the calendar event later,'
    const SECOND = 'call it "Balaton team day" and don\'t invite anyone yet'

    async function splitSend() {
      const { agent, redirects } = liveAgent({ canSteer: () => true })
      const h = rig('split', agent)
      const { answers: deliveries } = decidedByTest(h.sm)
      const continuations: Array<(same: boolean) => void> = []
      spyOn(midTurnMessages, 'isContinuation').mockImplementation(() => new Promise(resolve => continuations.push(resolve)))
      await h.sm.sendMessage(h.managed.id, FIRST)
      await h.sm.sendMessage(h.managed.id, SECOND)
      return { ...h, redirects, deliveries, continuations }
    }

    it('waits for the continuation check before steering the second half, then replays both as one turn', async () => {
      const { sm, managed, redirects, deliveries, continuations } = await splitSend()
      deliveries.get(FIRST)!('queue')
      deliveries.get(SECOND)!('steer') // the steer answer comes back first
      await tick()
      expect(redirects).toEqual([])
      continuations[0]!(true)
      await tick()
      expect(redirects).toEqual([])
      expect(managed.messageQueue.map(entry => entry.message)).toEqual([FIRST, SECOND])
      expect(managed.messageQueue[1]!.mergeWith).toBe(managed.messageQueue[0])

      // THE ROW'S POSITIVE: the continuation is merged with the previous queued message into ONE replay.
      const [firstId, secondId] = managed.messageQueue.map(entry => entry.messageId)
      const replays: Array<{ message: string; existingMessageId?: string }> = []
      sm.sendMessage = async (...args: unknown[]) => {
        replays.push({ message: args[1] as string, existingMessageId: args[5] as string | undefined })
      }
      managed.isProcessing = false
      ;(sm.processNextQueuedMessage as (id: string, ws?: string) => void).call(sm, managed.id, WORKSPACE_ID)
      await tick()
      expect(replays).toEqual([{ message: `${FIRST}\n\n${SECOND}`, existingMessageId: firstId }])
      expect(managed.messageQueue).toEqual([])
      // Both bubbles leave the queued state, and the auth retry knows the replay stands for both.
      expect(managed.messages.filter(m => m.role === 'user').map(m => m.isQueued)).toEqual([false, false])
      expect(managed.replayMergedIds?.get(firstId!)).toEqual([firstId!, secondId!])
    })

    it('does not steer the first half once a later message is known to continue it', async () => {
      const { redirects, deliveries, continuations } = await splitSend()
      continuations[0]!(true)
      await tick()
      deliveries.get(FIRST)!('steer')
      deliveries.get(SECOND)!('steer')
      await tick()
      expect(redirects).toEqual([])
    })

    it('steers the second half on its own when it is a separate request', async () => {
      const { redirects, deliveries, continuations } = await splitSend()
      deliveries.get(FIRST)!('queue')
      continuations[0]!(false)
      deliveries.get(SECOND)!('steer')
      await tick()
      expect(redirects).toEqual([SECOND])
    })
  })

  it('recognises either half of a queued continuation (upstream case)', () => {
    const a = { message: 'A' }
    const b = { message: 'B', mergeWith: a }
    const c = { message: 'C' }
    expect(isInQueuedContinuation([a, b, c], a)).toBe(true)
    expect(isInQueuedContinuation([a, b, c], b)).toBe(true)
    expect(isInQueuedContinuation([a, b, c], c)).toBe(false)
    // The earlier half already left the queue (steered or replayed): nothing to keep together.
    expect(isInQueuedContinuation([b, c], b)).toBe(false)
  })

  it('merges only plain text: never a workflow invocation, a differing model text or attachments', () => {
    expect(canMergeQueuedEntry({ message: 'and keep the dates' })).toBe(true)
    expect(canMergeQueuedEntry({ message: 'run it', workflowInvocation: { name: 'wf' } })).toBe(false)
    expect(canMergeQueuedEntry({ message: 'shown', modelMessage: 'what the model gets' })).toBe(false)
    expect(canMergeQueuedEntry({ message: 'see file', attachments: [{}] })).toBe(false)
  })
})

describe('UB6.13 — controls', () => {
  it('layer off: the connection behaviour applies exactly as before, and nothing is asked', async () => {
    const { agent, redirects } = liveAgent({ canSteer: () => true })
    const { sm, managed, events } = rig('layer-off', agent)
    const asked: string[] = []
    sm.decideMidTurnDelivery = async (_m: unknown, message: string) => { asked.push(message); return 'queue' as const }
    await sm.sendMessage(managed.id, 'use tabs')
    // The 'steer' fallback steers at once, through the composer door.
    expect(redirects).toEqual(['use tabs'])
    expect(asked).toEqual([])
    expect(managed.messageQueue).toEqual([])
    expect(events.filter(e => e.type === 'user_message').at(-1)?.status).toBe('accepted')
  })

  it('wasInterrupted still comes from the backend\'s answer, never from a decided queue', async () => {
    // Layer ON, steer default, the model says queue: redirect() is never called, so nothing was
    // interrupted — even on a backend whose refusal WOULD abort.
    const decided = liveAgent({ canSteer: () => true, interruptsOnRefusal: true })
    const on = rig('interrupt-decided', decided.agent)
    const { answers } = decidedByTest(on.sm)
    on.sm.markQueuedContinuation = async () => {}
    await on.sm.sendMessage(on.managed.id, 'later, draft the notes')
    answers.get('later, draft the notes')!('queue')
    await tick()
    expect(decided.redirects).toEqual([])
    expect(on.managed.wasInterrupted).toBeFalsy()

    // Layer OFF: a refused steer stamps the flag only when the backend says its refusal interrupted.
    const inert = liveAgent({ canSteer: () => false, accepts: false, interruptsOnRefusal: false })
    const offInert = rig('interrupt-inert', inert.agent)
    await offInert.sm.sendMessage(offInert.managed.id, 'use tabs')
    expect(offInert.managed.wasInterrupted).toBeFalsy()
    const aborting = liveAgent({ canSteer: () => false, accepts: false, interruptsOnRefusal: true })
    const offAborting = rig('interrupt-aborting', aborting.agent)
    await offAborting.sm.sendMessage(offAborting.managed.id, 'use tabs')
    expect(offAborting.managed.wasInterrupted).toBe(true)
  })

  it('the acknowledgement never waits on the decision (it bounds only the later steer)', async () => {
    const { agent, redirects } = liveAgent({ canSteer: () => true })
    const { sm, managed } = rig('ack', agent)
    decidedByTest(sm)
    sm.markQueuedContinuation = async () => {}
    sm.decideMidTurnDelivery = () => new Promise(() => {}) // never answers
    const acked: string[] = []
    await sm.sendMessage(managed.id, 'use tabs', undefined, undefined, undefined, undefined, undefined, (id: string) => acked.push(id))
    expect(acked).toHaveLength(1)
    expect(managed.messageQueue.map(entry => entry.messageId)).toEqual(acked)
    expect(redirects).toEqual([])
  })

  it('a one-message override is the user\'s choice and is never re-decided', async () => {
    const { agent, redirects } = liveAgent({ canSteer: () => true })
    const { sm, managed } = rig('override', agent)
    const { asked } = decidedByTest(sm)
    sm.markQueuedContinuation = async () => {}
    await sm.sendMessage(managed.id, 'use tabs', undefined, undefined, { midStreamOverride: 'steer' } as never)
    expect(asked).toEqual([])
    expect(redirects).toEqual(['use tabs'])
  })
})

describe('UB6.13 — canSteerNow per runtime (the read steerQueuedIfDecided makes)', () => {
  it('claude: an open, unsettled slot with an unpaused steer FIFO, and nothing else', () => {
    const claude = Object.create(ClaudeAgent.prototype) as Record<string, unknown> & { canSteerNow(): boolean }
    claude.openSlot = { settled: false }
    claude.steerFifoPaused = false
    expect(claude.canSteerNow()).toBe(true)
    claude.steerFifoPaused = true // F1.335: a Stop, a handoff or the turn's own take paused it
    expect(claude.canSteerNow()).toBe(false)
    claude.steerFifoPaused = false
    claude.openSlot = { settled: true }
    expect(claude.canSteerNow()).toBe(false)
    claude.openSlot = null // a turn still preparing, or none
    expect(claude.canSteerNow()).toBe(false)
  })

  it('pi: a processing subprocess with no manual compaction in flight', () => {
    const pi = Object.create(PiAgent.prototype) as Record<string, unknown> & { canSteerNow(): boolean }
    pi._isProcessing = true
    pi.subprocess = {}
    expect(pi.canSteerNow()).toBe(true)
    pi.pendingCompactions = new Map([['c1', {}]])
    expect(pi.canSteerNow()).toBe(false)
    pi.pendingCompactions = new Map()
    pi._isProcessing = false
    expect(pi.canSteerNow()).toBe(false)
  })

  it('codex: an active turn this client is draining (codex then accepts or refuses natively)', () => {
    const codex = Object.create(CodexAgent.prototype) as Record<string, unknown> & { canSteerNow(): boolean }
    codex.client = {}
    codex.threadId = 'thread-1'
    codex.activeTurnId = 'turn-1'
    codex.turnSink = {}
    expect(codex.canSteerNow()).toBe(true)
    codex.turnSink = null // a turn this client is not draining (a server-side compaction turn)
    expect(codex.canSteerNow()).toBe(false)
  })
})
