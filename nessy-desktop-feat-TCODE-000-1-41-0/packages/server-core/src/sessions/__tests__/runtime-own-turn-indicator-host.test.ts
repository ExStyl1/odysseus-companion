/**
 * F1.524 (2) (origin WJ-am P-WJ-am-2) — the HOST half of the busy seam for a turn the claude child opened itself:
 * the real `SessionManager` wires `runtime-own-turn-indicator.ts` onto a claude agent, and a Stop pressed while that
 * turn runs — the indicator now puts a Stop on screen — reaches it.
 *
 * ## The defect
 *
 * `cancelProcessing` returned at once when no HOST turn ran (`!managed.isProcessing`), which is exactly the state
 * while the CLI answers a background task on its own. So once the renderer showed that turn (and since F1.511 it did,
 * via D1.379's raise on a between-turns `tool_start`), its Stop did nothing.
 *
 * ## What this file pins (the REAL `SessionManager`, an agent on `ClaudeAgent`'s real prototype, no subprocess)
 *
 * (a) The wire: the agent's `onRuntimeOwnTurn` is set, and its two phases reach the event sink as a `runtime_turn`
 *     status and a `complete` — through the turn-end door, so P3.21's bypass check stays quiet.
 * (b) A Stop with no host turn asks the agent to interrupt its own turn, and pauses a queue waiting behind it, as a
 *     host turn's Stop does (D1.376) — so the message does not run the moment the stopped turn ends.
 * CONTROL: a Pi agent gets no indicator (it has no such turn), and its Stop with no turn stays a no-op.
 *
 * F1.612 — a message queued behind the own turn is replayed when that turn settles, and the replay announces its
 * host turn (`user_message` 'processing') BEFORE the own turn's `complete` leaves the flush door, while
 * `managed.isProcessing` is still false (it rises inside `setImmediate`). That `complete` lowered the replayed turn's
 * spinner and Stop until its first streamed event. (c) With a replay announced, no `complete` follows it.
 * (d) F1.597's owed case — `ended` with a task still owed, so no settle and no replay — still sends its `complete`,
 * with a message waiting in the queue.
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

const WORKSPACE_ID = 'ws-f1-524-2'

interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messageQueue: Array<{ message: string }>
  queuePaused?: boolean
}

type Wired = { onRuntimeOwnTurn?: (phase: 'running' | 'ended') => void }

function rig(sessionId: string, prototype: object) {
  const sm = createTestSessionManager()
  const events: Array<{ type: string; statusType?: string; sessionId?: string }> = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as { type: string }) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-524-2-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.524' },
    { id: WORKSPACE_ID, name: 'F1.524', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  const interrupt = mock(() => true)
  const forceAbort = mock(() => undefined)
  const agent = Object.create(prototype) as Record<string, unknown>
  agent.forceAbort = forceAbort
  agent.debug = () => undefined
  if (prototype === ClaudeAgent.prototype) agent.interruptRuntimeOwnTurn = interrupt
  managed.agent = agent
  managed.isProcessing = false
  const wire = () => (sm as unknown as { wireRuntimeOwnTurnIndicator: (m: unknown) => void }).wireRuntimeOwnTurnIndicator(managed)
  return { sm, managed, agent: agent as Wired & Record<string, unknown>, events, interrupt, forceAbort, wire }
}

const macrotask = () => new Promise<void>(resolve => setImmediate(resolve))

describe('F1.524 (2) — the host shows the runtime\'s own turn, and its Stop reaches it', () => {
  it('(a) the wire: running becomes a runtime_turn status, ended a complete through the turn-end door', async () => {
    const h = rig('wired', ClaudeAgent.prototype)
    expect(typeof (h.sm as unknown as { wireRuntimeOwnTurnIndicator?: unknown }).wireRuntimeOwnTurnIndicator).toBe('function')
    h.wire()
    expect(typeof h.agent.onRuntimeOwnTurn).toBe('function')

    h.agent.onRuntimeOwnTurn!('running')
    h.agent.onRuntimeOwnTurn!('ended')
    await macrotask()
    await macrotask()
    expect(h.events.map(e => [e.type, e.statusType ?? null])).toEqual([['status', 'runtime_turn'], ['complete', null]])
  })

  it('(b) a Stop with no host turn interrupts the runtime\'s own turn and pauses the queue behind it', async () => {
    const h = rig('stopped', ClaudeAgent.prototype)
    h.managed.messageQueue.push({ message: 'what did the subagent find?' })
    await h.sm.cancelProcessing(h.managed.id, false, WORKSPACE_ID)
    expect(h.interrupt).toHaveBeenCalledTimes(1)
    // Not a host turn's Stop: nothing to abort, and no turn to mark interrupted.
    expect(h.forceAbort).not.toHaveBeenCalled()
    expect(h.managed.queuePaused).toBe(true)
  })

  it('CONTROL — a Pi agent gets no indicator, and its Stop with no turn stays a no-op', async () => {
    const h = rig('pi', PiAgent.prototype)
    h.wire()
    expect(h.agent.onRuntimeOwnTurn).toBeUndefined()
    h.managed.messageQueue.push({ message: 'queued' })
    await h.sm.cancelProcessing(h.managed.id, false, WORKSPACE_ID)
    expect(h.forceAbort).not.toHaveBeenCalled()
    expect(h.managed.queuePaused).not.toBe(true)
  })
})

describe('F1.612 — the own turn\'s complete never follows the replay it settled', () => {
  /** A claude agent whose own turn is RUNNING (F1.509's promise, started), wired, with ClaudeAgent's real settle. */
  function ownTurnRig(sessionId: string, owed: number) {
    const h = rig(sessionId, ClaudeAgent.prototype)
    const agent = h.agent as Record<string, unknown>
    agent.redirect = mock(() => true)
    agent.chat = mock(() => { throw new Error('F1.612: the queued send must not start a turn') })
    agent.runtimeOwnTurnStartBoundMs = 60_000
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    agent.runtimeOwnTurn = { settled, settle, bound: null, started: true, owed }
    h.wire()
    ;(agent.reportRuntimeOwnTurn as (phase: string) => void).call(agent, 'running')
    return { ...h, agent }
  }
  const busy = (events: Array<{ type: string; statusType?: string; status?: string }>) => events
    .filter(e => (e.type === 'status' && e.statusType === 'runtime_turn') || e.type === 'complete'
      || (e.type === 'user_message' && e.status === 'processing'))
    .map(e => e.type === 'status' ? 'status:runtime_turn' : e.type === 'user_message' ? 'user_message:processing' : e.type)
  /** Queue one send behind the own turn, then capture the replay instead of running a host turn. */
  async function queueOneSend(h: ReturnType<typeof ownTurnRig>) {
    await h.sm.sendMessage(h.managed.id, 'what did the subagent find?')
    expect(h.managed.messageQueue).toHaveLength(1)
    const replayed: unknown[] = []
    ;(h.sm as unknown as { sendMessage: (...a: unknown[]) => Promise<void> }).sendMessage = async (...a: unknown[]) => { replayed.push(a) }
    return replayed
  }

  it('(c) a settled own turn with a queued send: the replay\'s processing is the last busy signal, no complete after it', async () => {
    const h = ownTurnRig('f1-612-replay', 0)
    const replayed = await queueOneSend(h)
    ;(h.agent.settleRuntimeOwnTurn as () => void).call(h.agent)
    for (let i = 0; i < 4; i++) await macrotask()
    expect(replayed).toHaveLength(1)
    expect(busy(h.events)).toEqual(['status:runtime_turn', 'user_message:processing'])
  })

  it('(d) F1.597 owed: the own turn ends with a task still owed, nothing replays, and its complete still goes out', async () => {
    const h = ownTurnRig('f1-612-owed', 1)
    const replayed = await queueOneSend(h)
    ;(h.agent.endRuntimeOwnTurnAtResult as () => void).call(h.agent)
    for (let i = 0; i < 4; i++) await macrotask()
    const turn = h.agent.runtimeOwnTurn as { bound: ReturnType<typeof setTimeout> | null, started: boolean }
    if (turn.bound) clearTimeout(turn.bound)
    expect(turn.started).toBe(false)
    expect(replayed).toHaveLength(0)
    expect(h.managed.messageQueue).toHaveLength(1)
    expect(busy(h.events)).toEqual(['status:runtime_turn', 'complete'])
  })
})
