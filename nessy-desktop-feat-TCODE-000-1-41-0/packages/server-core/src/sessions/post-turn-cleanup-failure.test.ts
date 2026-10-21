/**
 * P3.19 · why the RPC post-persist arm is ROUTED and not exempted.
 *
 * `handlers/rpc/sessions.ts` pushes a renderer-facing `complete` from
 * `sendMessage`'s `.catch`, outside `SessionManager.sendTurnEndEvent`. The
 * argument for leaving it alone was that nothing can be streaming when that
 * `.catch` fires: the chat loop has its own `catch`, it does not rethrow, and it
 * routes every mid-turn failure into `onProcessingStopped` — so the only
 * rejections escaping `sendMessage` are the turnless and model-only-window
 * classes its outer catch named at the time ("NEVER REACHED THE MODEL — two
 * classes reach this catch"), which stream nothing. That docblock has since been
 * corrected to the measured THREE (P2.132) on the strength of what this file
 * measures, so the quotation above is history rather than current code.
 *
 * It is a third class short. `sendMessage`'s post-turn CLEANUP block —
 * `agent.setAutomationSystem(undefined)`, `disarmPluginPeripherals`,
 * `drainAgentAutomationEvents` — sits in the `finally` OUTSIDE the chat loop's
 * catch, and the outer catch rethrows. Those run strictly AFTER the model
 * streamed, and none of the three is internally guarded.
 *
 * Measured here on the real `sendMessage`: each of the three rejects it after
 * `onAck` has already fired — i.e. into the post-persist arm — with the turn's
 * text streamed and no terminal event on the wire yet. That is P3.16's defect
 * shape, one file over, so the site takes the door's flush half
 * (`flushBeforeTurnEndEvent`).
 *
 * If a future change moves that cleanup inside the chat loop's catch, or guards
 * each member, these rows go red — and the reader should conclude the exemption
 * has become available again, not that the rows are stale.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Which member of the post-turn cleanup block blows up; `none` is the control. */
type CleanupFailure = 'none' | 'setAutomationSystem' | 'disarmPluginPeripherals' | 'drainAutomationEvents'

/** One assistant token, then an ordinary backend completion. */
const STREAMING_TURN: AgentEvent[] = [
  { type: 'text_delta', text: 'Hello world', turnId: 'X' } as AgentEvent,
  { type: 'complete', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } } as AgentEvent,
]

async function runTurn(failure: CleanupFailure) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-post-turn-cleanup-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-cleanup',
    name: 'Post-turn cleanup',
    slug: 'cleanup',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'session-cleanup' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions
    .set(`${workspace.id}:${managed.id}`, managed)

  const events: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => {
    events.push(event)
  }) as Parameters<SessionManager['setEventSink']>[0])

  const internals = manager as unknown as Record<string, unknown> & {
    pendingDeltas: Map<string, { delta: string }>
  }
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => {
    // The REAL `createCapabilityTurn` stamps this. WITHOUT IT the cleanup block's
    // `managed.capabilityLeaseId === leaseId` guard is false and the whole block
    // is skipped — the first version of this rig omitted it and measured "no
    // rejection reaches the RPC catch", which is the answer the argument wanted
    // and was purely an artefact of the fixture.
    managed.capabilityLeaseId = 'cleanup-lease'
    return {
      snapshot: { leaseId: 'cleanup-lease' },
      runtime: { view: { sources: [] }, materializer: {} },
    }
  }
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    // Cleanup passes `undefined`; the arming call earlier in the turn passes a
    // real system. Failing only on the former keeps the turn itself intact.
    setAutomationSystem: (system: unknown) => {
      if (failure === 'setAutomationSystem' && system === undefined) {
        throw new Error('cleanup: setAutomationSystem threw')
      }
    },
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {
      if (failure === 'drainAutomationEvents') throw new Error('cleanup: drainAutomationEvents rejected')
    },
    generateTitle: async () => 'cleanup probe',
    forceAbort: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () { for (const event of STREAMING_TURN) yield event },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  if (failure === 'disarmPluginPeripherals') {
    // `disarmPluginPeripherals` disposes these; a monitor that throws on dispose
    // is the third member, reached without stubbing the method itself.
    ;(managed as unknown as { pluginMonitorServices: unknown }).pluginMonitorServices = [
      { dispose: () => { throw new Error('cleanup: plugin monitor dispose threw') } },
    ]
  }

  const acked: string[] = []
  let rejection: Error | undefined
  /** Read at the instant of rejection — this is what the RPC `.catch` inherits. */
  let atRejection: { queuedText: string[]; terminalOnWire: boolean } | undefined
  try {
    await manager.sendMessage(
      managed.id, 'post-turn cleanup probe',
      undefined, undefined, undefined, undefined, undefined,
      (messageId: string) => { acked.push(messageId) },
      { workspaceId: workspace.id },
    )
  } catch (error) {
    rejection = error as Error
    atRejection = {
      queuedText: [...internals.pendingDeltas.values()].map(pending => pending.delta),
      terminalOnWire: events.some(event => event.type === 'complete' || event.type === 'interrupted'),
    }
  }
  await new Promise(resolve => setTimeout(resolve, 120))
  const wire = events.map(event => [event.type, (event as { delta?: unknown }).delta])
  manager.cleanup()
  return { acked, rejection, atRejection, wire }
}

describe('P3.19 · a post-turn cleanup failure reaches the RPC post-persist arm', () => {
  it('CONTROL · a clean turn resolves, so nothing reaches that arm', async () => {
    // The control an absence claim needs: without it, "the probes rejected"
    // could just as well mean the rig rejects everything.
    const clean = await runTurn('none')

    expect(clean.rejection).toBeUndefined()
    expect(clean.acked).toHaveLength(1)
    expect(clean.wire.map(([type]) => type)).toContain('complete')
  })

  it.each([
    ['setAutomationSystem', 'cleanup: setAutomationSystem threw'],
    ['disarmPluginPeripherals', 'cleanup: plugin monitor dispose threw'],
    ['drainAutomationEvents', 'cleanup: drainAutomationEvents rejected'],
  ] as const)('%s rejects the send AFTER the turn streamed', async (failure, message) => {
    const run = await runTurn(failure)

    // It rejects, so the RPC `.catch` runs…
    expect(run.rejection?.message).toBe(message)
    // …and `onAck` already fired, so it takes the POST-persist arm — the one
    // that pushes `error` + `complete` through `pushTyped`.
    expect(run.acked).toHaveLength(1)
    // The model streamed on this turn — the fact the exemption argument denied.
    expect(run.wire).toContainEqual(['text_delta', 'Hello world'])
    // And at the instant of rejection no terminal event had reached the wire, so
    // the arm's `complete` is the FIRST one out. Anything the batcher still holds
    // is delivered by its own timer afterwards: P3.16's late delta exactly.
    expect(run.atRejection?.terminalOnWire).toBe(false)
  })

  it('the two synchronous members reject with the text still in the batcher', async () => {
    // Sharper than the row above, and it is what makes the flush at the RPC site
    // load-bearing rather than defensive: `onProcessingStopped` is fire-and-forget
    // (P3.18), so its flush is still several awaits deep when a synchronous throw
    // in the cleanup block unwinds past it.
    for (const failure of ['setAutomationSystem', 'disarmPluginPeripherals'] as const) {
      const run = await runTurn(failure)
      expect({ failure, queued: run.atRejection?.queuedText })
        .toEqual({ failure, queued: ['Hello world'] })
    }
  })
})
