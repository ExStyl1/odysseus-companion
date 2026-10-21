/**
 * F1.395 (origin WJ-ff P-WJ-ff-1) — an abort or error that the OLD turn's chat
 * generator throws late ends only that old turn, never the one running now.
 *
 * ## What was read, and what this file measures first
 *
 * `sendMessage`'s chat loop ends its turn from three places. Its two `finally`
 * blocks call `onProcessingStopped` only when `processingGeneration` is still the
 * loop's own (`myGeneration`); its `catch` — the AbortError arm and the error
 * arm — called it unconditionally. After a Stop whose generator hangs, the 5 s
 * safety timer ends the turn (`onProcessingStopped(…, 'timeout')`) and the NEXT
 * turn can start; when the old generator then throws, the old loop's `catch`
 * lowered the new turn's flag, sent its turn end, and — since F1.263 — declined
 * the new turn's host cards. The row was READ, not measured; the DEFECT arms
 * below are the measurement, taken on the real `sendMessage` loop over a stub
 * agent whose first generator parks until the test lets it throw.
 *
 * ## CONTROL
 *
 * An abort that arrives INSIDE the 5 s (the ordinary Stop) still ends its own
 * turn, exactly once.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { AbortReason } from '@nessy-agent/shared/agent'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The DEFECT arms wait out the host's real 5 s stop safety timer.
setDefaultTimeout(30_000)

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/** A late throw of the kind the old generator produces: an abort carrying the Stop's reason, or a plain error. */
function lateThrow(kind: 'abort' | 'error'): Error {
  if (kind === 'error') return new Error('upstream connection reset')
  const error = new Error('Request was aborted.')
  error.name = 'AbortError'
  ;(error as Error & { cause?: unknown }).cause = AbortReason.UserStop
  return error
}

async function rig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1395-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1395', name: 'F1.395', slug: 'f1395', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1395-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  /** One gate per generator: the test decides when each parks, throws or completes. */
  const generators: Array<{ parked: Promise<void>; release: (outcome: 'complete' | Error) => void }> = []
  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    // A generator that does not stop when asked: the case the safety timer exists for.
    forceAbort: () => {},
    interruptForHandoff: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      let reach!: () => void
      const parked = new Promise<void>(resolve => { reach = resolve })
      let release!: (outcome: 'complete' | Error) => void
      const outcome = new Promise<'complete' | Error>(resolve => { release = resolve })
      generators.push({ parked, release })
      yield { type: 'text_delta', text: 'working ', turnId: `T${generators.length}` } as AgentEvent
      reach()
      const settled = await outcome
      if (settled instanceof Error) throw settled
      yield { type: 'complete' } as AgentEvent
    },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }

  /** `sendMessage` reaches `agent.chat()` several awaits after it is called: wait for the i-th generator to exist. */
  const generator = async (i: number) => {
    for (let n = 0; n < 500 && !generators[i]; n++) await tick(10)
    if (!generators[i]) throw new Error(`generator ${i} never started`)
    return generators[i]!
  }
  const send = (text: string) => manager.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id })
  return { manager, managed: managed as unknown as { isProcessing: boolean; processingGeneration: number; stopRequested?: boolean; id: string }, workspace, sent, generators, generator, send, cleanup: () => manager.cleanup() }
}

/** The renderer-facing turn ends the host sent after the given index. */
const turnEndsAfter = (sent: SessionEvent[], index: number) =>
  sent.slice(index).map(event => event.type).filter(type => type === 'complete' || type === 'interrupted' || type === 'error')

describe('F1.395 — a late throw from the OLD generator does not end the NEW turn', () => {
  for (const kind of ['abort', 'error'] as const) {
    it(`THE DEFECT — Stop, the 5 s timer ends the turn, the next turn starts, then the old generator throws (${kind})`, async () => {
      const r = await rig(`f1395-late-${kind}`)
      try {
        const first = r.send('first')
        await (await r.generator(0)).parked
        await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
        // The first generator is stuck: the host's safety timer ends its turn.
        await tick(5_300)
        expect(r.managed.isProcessing).toBe(false)

        // The next turn starts and is running (parked mid-stream).
        const second = r.send('second')
        await (await r.generator(1)).parked
        expect(r.managed.isProcessing).toBe(true)
        const generationOfSecond = r.managed.processingGeneration
        const index = r.sent.length

        // Only now does the OLD generator throw.
        r.generators[0]!.release(lateThrow(kind))
        await first
        await tick(120)

        expect({
          processing: r.managed.isProcessing,
          generation: r.managed.processingGeneration,
          turnEndsSent: turnEndsAfter(r.sent, index),
        }).toEqual({ processing: true, generation: generationOfSecond, turnEndsSent: [] })

        // The second turn still ends by itself, once.
        r.generators[1]!.release('complete')
        await second
        await tick(120)
        expect(r.managed.isProcessing).toBe(false)
        expect(turnEndsAfter(r.sent, index).filter(type => type === 'complete')).toEqual(['complete'])
      } finally {
        r.generators.forEach(generator => generator.release('complete'))
        r.cleanup()
      }
    })
  }
})

describe('F1.395 — CONTROL: an abort inside the 5 s still ends its own turn exactly once', () => {
  it('Stop, then the generator throws its AbortError at once → the turn ends, one `complete`, the flag is down', async () => {
    const r = await rig('f1395-prompt-abort')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      const index = r.sent.length
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      r.generators[0]!.release(lateThrow('abort'))
      await first
      await tick(120)
      expect(r.managed.isProcessing).toBe(false)
      expect(turnEndsAfter(r.sent, index)).toEqual(['interrupted', 'complete'])
      // Past the safety timer: nothing ends the turn a second time.
      await tick(5_300)
      expect(turnEndsAfter(r.sent, index)).toEqual(['interrupted', 'complete'])
    } finally {
      r.cleanup()
    }
  })
})
