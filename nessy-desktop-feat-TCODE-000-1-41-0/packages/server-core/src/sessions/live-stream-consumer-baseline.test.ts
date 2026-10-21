/**
 * L1 BASELINE — what today's stream consumer does, pinned so L2's rewrite has
 * something that goes red when it changes.
 *
 * `SessionManager.sendMessage` iterates the backend generator and, on the first
 * `complete` event, calls `onProcessingStopped` and RETURNS. The `return` sits
 * INSIDE the `try` whose `finally` is `await chatIterator.return?.(undefined)`
 * (SessionManager.ts:18014 and :18023-18025 — the "skip finally block" comment
 * on the return line refers to the OUTER cleanup finally, not this one). So the
 * consumer hangs up on the backend generator at the first completion.
 *
 * WHAT L2 ACTUALLY DID, recorded here because these tests were written expecting
 * the opposite and they STAYED GREEN.
 *
 * L1 wrote them as characterization tests, assuming L2 would have to change this
 * consumer. It did not. The design L1 settled puts the whole lifetime change on
 * the BACKEND side of the frozen `AgentInstance.chat()` contract: `ClaudeAgent`
 * owns one long-lived reader over one `query()`, and `chatImpl` returns a
 * per-turn QUEUE the reader feeds. `SessionManager` still returns at the first
 * `complete` and still calls `chatIterator.return?.()` — and that stops mattering,
 * because `.return()` now abandons a queue rather than unwinding the SDK stream.
 * The reader, the query and the child process are untouched.
 *
 * So every assertion below still holds ON PURPOSE, and each "AFTER L2" note has
 * been rewritten to say what was decided instead. Keeping them green is what
 * proves Pi, Codex and Nestor were not touched: this file drives a MOCK backend
 * through the real `SessionManager`, and a change to the consumer would show up
 * here first.
 *
 * An absence is not evidence until the same rig produces a presence: every
 * "the post-complete event did not arrive" assertion below is paired, in the
 * SAME test on the SAME rig, with an identically-shaped event before the
 * `complete` that DOES arrive.
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

function usageFixture() {
  return { inputTokens: 12, outputTokens: 3, costUsd: 0 }
}

interface Rig {
  manager: SessionManager
  events: SessionEvent[]
  /** How many times the backend's `chat()` was entered. */
  chatCallCount(): number
  /** Backend events actually pulled out of the generator by the consumer. */
  yielded(): string[]
  /** True once the backend generator's own `finally` ran (i.e. it was unwound). */
  unwound(): boolean
  send(message: string): Promise<void>
}

/**
 * Build a SessionManager wired to a scripted backend generator.
 *
 * `script` is produced fresh per `chat()` call, so a rig can serve several
 * turns. The generator records every event it actually yields and whether its
 * `finally` ran — the two observations that distinguish "the consumer read the
 * whole stream" from "the consumer hung up".
 */
function createRig(script: (turn: number) => AgentEvent[]): Rig {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-live-stream-baseline-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-live-stream',
    name: 'Live Stream Workspace',
    slug: 'live-stream',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'session-live-stream' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )

  const events: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => {
    events.push(event)
  }) as Parameters<SessionManager['setEventSink']>[0])

  const internals = manager as unknown as {
    persistSession(managed: unknown): void
    acquireCapabilityTurn(managed: unknown): Promise<() => void>
    createCapabilityTurn(managed: unknown): Promise<unknown>
    createRetainedCapabilityLease(leaseId: string): unknown
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
  }
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({
    snapshot: { leaseId: 'live-stream-lease' },
    runtime: { view: { sources: [] }, materializer: {} },
  })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  let chatCallCount = 0
  const yielded: string[] = []
  let unwound = false

  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    forceAbort: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      const turn = ++chatCallCount
      try {
        for (const event of script(turn)) {
          yielded.push(labelOf(event))
          yield event
        }
      } finally {
        // Runs when the consumer calls `.return()` on us — i.e. hangs up —
        // as well as on natural exhaustion.
        unwound = true
      }
    },
  }
  internals.getOrCreateAgent = async () => {
    managed.agent = agent as never
    return agent
  }

  return {
    manager,
    events,
    chatCallCount: () => chatCallCount,
    yielded: () => yielded,
    unwound: () => unwound,
    send: async (message: string) => {
      await manager.sendMessage(
        managed.id,
        message,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { workspaceId: workspace.id },
      )
      // `sendMessage` fires `onProcessingStopped` without awaiting it, so let
      // its own async tail land before a caller reads `events`.
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

function labelOf(event: AgentEvent): string {
  return event.type === 'status' || event.type === 'info'
    ? `${event.type}:${(event as { message: string }).message}`
    : event.type
}

function statusMessages(events: SessionEvent[]): string[] {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'status' }> => event.type === 'status')
    .map(event => event.message)
}

describe('live-stream consumer baseline (L1 — replaced by L2)', () => {
  it('stops at the first complete: a later backend event is never pulled and never reaches the renderer', async () => {
    const rig = createRig(() => [
      { type: 'status', message: 'before-complete' },
      { type: 'complete', usage: usageFixture() },
      // In a live session this is an ordinary between-turns event. Today it is
      // unreachable, because the consumer has already hung up.
      { type: 'status', message: 'after-complete' },
    ])

    await rig.send('probe')

    // PRESENCE on this rig: the identically-shaped event BEFORE `complete`
    // does arrive, so the absence below is a property of the position, not of
    // the harness.
    expect(statusMessages(rig.events)).toContain('before-complete')

    // ABSENCE: the post-complete event was never even pulled out of the
    // generator, let alone forwarded.
    expect(rig.yielded()).toEqual(['status:before-complete', 'complete'])
    expect(statusMessages(rig.events)).not.toContain('after-complete')

    // SETTLED BY L2: this stays true, and it is no longer a defect. A live
    // session keeps reading past a turn boundary INSIDE THE BACKEND — the
    // agent's reader is what sees the post-complete traffic — while the chat
    // loop remains a per-turn view. An event that belongs to no open turn is a
    // between-turns event and needs the whitelisted sink, not this generator.
  })

  it('unwinds the backend generator at complete (chatIterator.return runs)', async () => {
    // This is the mechanism behind the test above, asserted directly: the
    // consumer does not merely ignore later events, it terminates the producer.
    // For the Claude backend that `.return()` lands inside `chatImpl`'s
    // `finally` (claude-agent.ts:3826), which nulls `currentQuery`.
    const rig = createRig(() => [
      { type: 'complete', usage: usageFixture() },
      { type: 'status', message: 'never-reached' },
    ])

    await rig.send('probe')

    expect(rig.unwound()).toBe(true)
    expect(rig.yielded()).toEqual(['complete'])

    // SETTLED BY L2: `unwound` stays TRUE, and the generator that is unwound is
    // the per-turn queue, not the SDK stream. The unwind used to tear down the
    // child process with it; that entanglement is what L2 removed.
  })

  it('starts a fresh backend generator for every turn — one chat() per message', async () => {
    // Today the stream's lifetime IS the turn's lifetime. Two sends produce two
    // generators, and turn 2 cannot see anything turn 1's generator held.
    const rig = createRig(turn => [
      { type: 'status', message: `turn-${turn}` },
      { type: 'complete', usage: usageFixture() },
    ])

    await rig.send('first')
    await rig.send('second')

    expect(rig.chatCallCount()).toBe(2)
    expect(rig.yielded()).toEqual([
      'status:turn-1', 'complete',
      'status:turn-2', 'complete',
    ])
    expect(statusMessages(rig.events)).toEqual(['turn-1', 'turn-2'])

    // SETTLED BY L2: `chatCallCount` is still one per message — `chatImpl` is
    // still entered per turn; what it no longer does is spawn a process. The
    // per-turn EVENT partition asserted on the last line is the contract L2 owed
    // the renderer, and it survives unchanged.
  })
})
