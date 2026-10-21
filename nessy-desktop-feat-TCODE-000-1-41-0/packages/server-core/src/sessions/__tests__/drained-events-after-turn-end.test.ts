/**
 * F1.165 (origin WJ-a P-WJ-a-2, host half WJ-t P-WJ-t-2) — once the HOST has
 * ended a turn, the chat loop no longer forwards the stream events the aborted
 * agent keeps draining.
 *
 * The host ends a turn in three ways before the chat generator itself finishes:
 * a handoff (plan submission / auth request lowers `managed.isProcessing` and
 * sends its own `complete`), a user Stop (`cancelProcessing` sends
 * `interrupted` and sets `stopRequested`), and the 5 s stop safety timeout
 * (`onProcessingStopped(…, 'timeout')` sends `complete`). In every one the
 * generator is left to drain, and the loop in `sendMessage` handed each drained
 * event to `processEvent`, which forwards it to the renderer unconditionally. A
 * drained `text_delta` / `tool_start` / non-hook `status` then met F1.78's
 * mid-turn raise (`processor.ts`, `impliesTurnInFlight`) — a spinner and a Stop
 * on a session the host holds idle, with no terminal event left to lower them
 * on the timeout path (measured by WJ-t's probe: `complete host=false
 * renderer=false`, then `text_delta host=false renderer=true`).
 *
 * DECIDED (controller 2026-09-23, balance rule): the host is the seam, one fix
 * for all three runtimes. What the host already persisted before its end marker
 * stays; the dropped count goes to the session's debug log. F1.164's renderer
 * rule stays as the second line of defence.
 *
 * Every arm drives the REAL `sendMessage` chat loop over a stub agent whose
 * `chat` generator yields one live event, parks until the test has ended the
 * turn through the REAL host path, then drains. The wire is read from the event
 * sink — the only thing the renderer ever sees.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The stop-timeout arm waits out the host's real 5 s safety timer.
setDefaultTimeout(30_000)

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The three event kinds F1.78's renderer rule raises `isProcessing` on. */
const STREAM_KINDS = new Set(['text_delta', 'tool_start', 'status'])

/** Past `DELTA_BATCH_INTERVAL_MS` (50 ms): a queued delta has had its chance to leave. */
const pastTheBatchTimer = () => new Promise(resolve => setTimeout(resolve, 120))

/** What the aborted agent yields after the host ended the turn. */
const DRAINED: AgentEvent[] = [
  { type: 'text_delta', text: 'and then I will ', turnId: 'T' } as AgentEvent,
  { type: 'tool_start', toolUseId: 'drained-1', toolName: 'Bash', input: { command: 'ls' } } as AgentEvent,
  { type: 'status', message: 'Thinking' } as AgentEvent,
]

type Rig = Awaited<ReturnType<typeof rig>>

async function rig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1165-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-f1165',
    name: 'F1.165 Workspace',
    slug: 'f1165',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  /** Every wire event, and the host's own flag at the instant it left. */
  const sent: { event: SessionEvent; host: boolean }[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => {
    sent.push({ event, host: (managed as { isProcessing: boolean }).isProcessing })
  }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as {
    persistSession(managed: unknown, force?: boolean): void
    acquireCapabilityTurn(managed: unknown): Promise<() => void>
    createCapabilityTurn(managed: unknown): Promise<unknown>
    createRetainedCapabilityLease(leaseId: string): unknown
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    projectPiPlanSubmission(managed: unknown, planPath: string): Promise<void>
    beginAuthRequest(managed: unknown, request: Record<string, unknown>): Promise<void> | void
  }
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({
    snapshot: { leaseId: 'f1165-lease' },
    runtime: { view: { sources: [] }, materializer: {} },
  })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  let reachGate!: () => void
  const parked = new Promise<void>(resolve => { reachGate = resolve })
  let openGate!: () => void
  const gate = new Promise<void>(resolve => { openGate = resolve })

  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    // The aborted agent does not stop on its own: it drains when the test says so.
    forceAbort: () => {},
    interruptForHandoff: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      // LIVE — the turn is running; these must reach the renderer.
      yield { type: 'text_delta', text: 'working on it ', turnId: 'T' } as AgentEvent
      yield { type: 'tool_start', toolUseId: 'live-1', toolName: 'Read', input: { file_path: 'a.txt' } } as AgentEvent
      yield { type: 'status', message: 'Reading' } as AgentEvent
      reachGate()
      await gate
      // DRAINED — whatever the host did in between decides their fate.
      for (const event of DRAINED) yield event
      yield { type: 'tool_result', toolUseId: 'live-1', toolName: 'Read', result: 'contents', isError: false } as AgentEvent
      yield { type: 'text_complete', text: 'working on it and then I will ', turnId: 'T' } as AgentEvent
      yield { type: 'complete' } as AgentEvent
    },
  }
  internals.getOrCreateAgent = async () => {
    managed.agent = agent as never
    return agent
  }

  const sending = manager.sendMessage(
    managed.id,
    'do the thing',
    undefined, undefined, undefined, undefined, undefined, undefined,
    { workspaceId: workspace.id },
  )
  await parked
  // The live events have been handed to `processEvent`; let their batch leave.
  await pastTheBatchTimer()

  /** Let the generator drain, wait for the loop to finish, read the wire. */
  async function drainAndSettle() {
    const endIndex = sent.length
    openGate()
    await sending
    await pastTheBatchTimer()
    return { afterEnd: sent.slice(endIndex), all: sent }
  }

  return { manager, managed, workspace, sent, internals, drainAndSettle, cleanup: () => manager.cleanup() }
}

function writePlan(): string {
  const dir = mkdtempSync(join(tmpdir(), 'f1165-plan-'))
  roots.push(dir)
  const planPath = join(dir, 'plan.md')
  writeFileSync(planPath, '# Plan\n\n1. do the thing\n')
  return planPath
}

/** The stream kinds that left the host after the given index. */
const streamKindsAfter = (events: { event: SessionEvent }[]) =>
  events.map(entry => entry.event.type).filter(type => STREAM_KINDS.has(type))

describe('F1.165 · once the host has ended the turn, the drained stream stays in the host', () => {
  it('THE DEFECT — the 5 s stop-timeout ended the turn; a late drained delta/tool_start/status must not reach the renderer', async () => {
    const r: Rig = await rig('f1165-timeout')
    try {
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      // The generator is stuck: the host's own safety timer ends the turn.
      await new Promise(resolve => setTimeout(resolve, 5_300))
      const hostComplete = r.sent.findIndex(entry => entry.event.type === 'complete')
      expect(hostComplete).toBeGreaterThan(-1)
      expect((r.managed as { isProcessing: boolean }).isProcessing).toBe(false)

      const { afterEnd } = await r.drainAndSettle()
      expect(streamKindsAfter(afterEnd)).toEqual([])
    } finally {
      r.cleanup()
    }
  })

  it('THE DEFECT — a plan handoff ended the turn; the drained stream must not reach the renderer', async () => {
    const r: Rig = await rig('f1165-plan')
    try {
      await r.internals.projectPiPlanSubmission(r.managed, writePlan())
      expect(r.sent.some(entry => entry.event.type === 'plan_submitted')).toBe(true)
      expect((r.managed as { isProcessing: boolean }).isProcessing).toBe(false)

      const { afterEnd } = await r.drainAndSettle()
      expect(streamKindsAfter(afterEnd)).toEqual([])
    } finally {
      r.cleanup()
    }
  })

  it('THE DEFECT — an auth handoff ended the turn; the drained stream must not reach the renderer', async () => {
    const r: Rig = await rig('f1165-auth')
    try {
      await r.internals.beginAuthRequest(r.managed, {
        type: 'oauth',
        provider: 'github',
        requestId: 'req-f1165',
        sessionId: 'f1165-auth',
        sourceSlug: 'github',
        sourceName: 'GitHub',
      })
      expect(r.sent.some(entry => entry.event.type === 'auth_request')).toBe(true)

      const { afterEnd } = await r.drainAndSettle()
      expect(streamKindsAfter(afterEnd)).toEqual([])
    } finally {
      r.cleanup()
    }
  })

  it('THE DEFECT — a user Stop sent `interrupted`; the drained stream must not reach the renderer, and the turn still ends', async () => {
    const r: Rig = await rig('f1165-stop')
    try {
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      expect(r.sent.some(entry => entry.event.type === 'interrupted')).toBe(true)

      const { afterEnd } = await r.drainAndSettle()
      expect(streamKindsAfter(afterEnd)).toEqual([])
      // The generator's own `complete` still ends the turn on the host.
      expect(afterEnd.map(entry => entry.event.type)).toContain('complete')
      expect((r.managed as { isProcessing: boolean }).isProcessing).toBe(false)
      // A tool the aborted agent started only after the Stop is not a row left `executing`.
      const messages = (r.managed as { messages: Array<{ toolUseId?: string }> }).messages
      expect(messages.some(message => message.toolUseId === 'drained-1')).toBe(false)
    } finally {
      r.cleanup()
    }
  })

  it('THE DEFECT — the NEXT turn has already begun on the host; the old generator\'s drain is not that turn\'s activity', async () => {
    const r: Rig = await rig('f1165-next-turn')
    try {
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      await new Promise(resolve => setTimeout(resolve, 5_300))
      expect((r.managed as { isProcessing: boolean }).isProcessing).toBe(false)
      // What `sendMessage` does at the head of the next turn, while the old
      // generator is still parked: the flag goes back up under a new generation.
      const m = r.managed as { isProcessing: boolean; processingGeneration: number }
      m.isProcessing = true
      m.processingGeneration++

      const { afterEnd } = await r.drainAndSettle()
      expect(streamKindsAfter(afterEnd)).toEqual([])
    } finally {
      ;(r.managed as { isProcessing: boolean }).isProcessing = false
      r.cleanup()
    }
  })
})

describe('F1.165 · controls — a live turn is untouched, and what settles the turn still lands', () => {
  it('CONTROL — no end: the same events flow while the host holds the turn', async () => {
    const r: Rig = await rig('f1165-live')
    try {
      const liveKinds = streamKindsAfter(r.sent)
      expect(liveKinds).toEqual(expect.arrayContaining(['text_delta', 'tool_start', 'status']))
      expect(r.sent.filter(entry => STREAM_KINDS.has(entry.event.type)).every(entry => entry.host)).toBe(true)

      const { afterEnd } = await r.drainAndSettle()
      // Nothing ended the turn, so the "drained" events are live ones too. (Sorted:
      // a `text_delta` leaves on the batch timer, after the events queued behind it.)
      expect(streamKindsAfter(afterEnd).sort()).toEqual(['status', 'text_delta', 'tool_start'])
      expect(afterEnd.map(entry => entry.event.type)).toContain('complete')
    } finally {
      r.cleanup()
    }
  })

  it('CONTROL — after a Stop, the events that SETTLE the turn still land: the running tool gets its result, the answer is persisted', async () => {
    const r: Rig = await rig('f1165-settle')
    try {
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      const { afterEnd } = await r.drainAndSettle()
      const types = afterEnd.map(entry => entry.event.type)
      expect(types).toContain('tool_result')
      expect(types).toContain('text_complete')
      const messages = (r.managed as { messages: Array<{ role: string; toolUseId?: string; toolStatus?: string; content: string }> }).messages
      // The tool that started while the turn was live is settled, not left executing.
      expect(messages.find(message => message.toolUseId === 'live-1')?.toolStatus).toBe('completed')
      expect(messages.some(message => message.role === 'assistant' && message.content.startsWith('working on it'))).toBe(true)
    } finally {
      r.cleanup()
    }
  })
})
