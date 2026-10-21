/**
 * F1.583 (origin WJ-be proposed row 6, 2026-09-24, LOW) — a turn a capability revoke stopped shows ONE explanation,
 * not the explanation followed by the raw `capability-snapshot-revoked` the next materializer call throws.
 *
 * F1.493 (1) writes a warning note into the stopped session ("This turn was stopped because a capability it was
 * using was withdrawn: <reason>. …") and force-aborts it. The turn's next `assertActive` still throws
 * `CapabilityMaterializationError('revoked')` — message `capability-snapshot-revoked` — and that reached the user as
 * a raw error row after the note, through either of the two doors a turn's error takes: the chat loop's `catch` in
 * `sendMessage` (which sends an `error` event the renderer draws; F1.260's measured path, `chat.error`) and
 * `processEvent`'s `case 'error'` (an agent that reports the error as an event: a persisted `error` row plus the
 * event).
 *
 * The rule: when the note was written for THIS turn, that error is logged and not drawn. The turn still ends.
 * CONTROL — the same error in a turn no revoke note was written for keeps its row, and a different error in a noted
 * turn keeps its row.
 *
 * The chat-loop rig is F1.395's (`late-abort-ends-only-its-turn.test.ts`): the real `sendMessage` over a stub agent
 * whose generator parks until the test lets it throw; the revoke is the real `subscribeInvalidation` listener, as in
 * `capability-revoke-turn-note.test.ts`.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

setDefaultTimeout(30_000)

const REVOKED = 'capability-snapshot-revoked'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

type Listener = (event: { scope: { kind: string }; effect: string; revokedLeaseIds: string[]; reason?: string }) => void

/** `events[i]` — what generator `i` yields (after its first delta) before it parks: F1.633's tool rows. */
async function rig(sessionId: string, events: AgentEvent[][] = []) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1583-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1583', name: 'F1.583', slug: 'f1583', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  let listener: Listener | undefined
  const manager = createTestSessionManager({
    subscribeInvalidation: (next: Listener) => { listener = next; return () => { listener = undefined } },
  } as never)
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1583-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  const generators: Array<{ parked: Promise<void>; release: (outcome: Error) => void }> = []
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
    interruptForHandoff: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      let reach!: () => void
      const parked = new Promise<void>(resolve => { reach = resolve })
      let release!: (outcome: Error) => void
      const outcome = new Promise<Error>(resolve => { release = resolve })
      generators.push({ parked, release })
      yield { type: 'text_delta', text: 'working ', turnId: `T${generators.length}` } as AgentEvent
      for (const event of events[generators.length - 1] ?? []) yield event
      reach()
      throw await outcome
    },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }

  const generator = async (i: number) => {
    for (let n = 0; n < 500 && !generators[i]; n++) await tick(10)
    if (!generators[i]) throw new Error(`generator ${i} never started`)
    await generators[i]!.parked
    return generators[i]!
  }
  const turnEnded = async (from: number) => {
    for (let n = 0; n < 500; n++) {
      if (sent.slice(from).some(event => event.type === 'complete' || event.type === 'interrupted')) return
      await tick(10)
    }
    throw new Error('the turn never ended')
  }
  const send = (text: string) => manager.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id })
  /** The lease the stubbed `createCapabilityTurn` names; the real one is set inside it, which the rig replaces. */
  const holdLease = () => { (managed as unknown as { capabilityLeaseId?: string }).capabilityLeaseId = 'f1583-lease' }
  const revoke = () => listener!({ scope: { kind: 'global' }, effect: 'revoke-active-snapshot', revokedLeaseIds: ['f1583-lease'], reason: 'plugin uninstall (local.toolkit)' })
  const rawErrors = (from = 0) => sent.slice(from).filter(event => event.type === 'error' && JSON.stringify(event).includes(REVOKED))
  const notes = () => (managed.messages as Array<{ role: string; content: string }>).filter(message => message.role === 'info')
  const errorRows = () => (managed.messages as Array<{ role: string; content: string }>).filter(message => message.role === 'error')
  const toolRow = (toolUseId: string) => {
    const row = (managed.messages as Array<{ toolUseId?: string; toolStatus?: string; toolResult?: string; isError?: boolean }>).find(message => message.toolUseId === toolUseId)
    return row && { toolStatus: row.toolStatus, toolResult: row.toolResult, isError: row.isError }
  }
  const toolResults = (from = 0) => sent.slice(from).flatMap(event => event.type === 'tool_result'
    ? [{ toolUseId: (event as { toolUseId: string }).toolUseId, result: (event as { result: string }).result, isError: (event as { isError?: boolean }).isError }]
    : [])
  return {
    manager, managed: managed as unknown as { id: string; isProcessing: boolean; processingGeneration: number; agent: unknown },
    sent, generator, turnEnded, send, holdLease, revoke, rawErrors, notes, errorRows, toolRow, toolResults,
    // A turn still parked at teardown makes `cleanup()`'s strict drain throw, and a throw from `finally` would hide
    // the assertion that failed: every generator is released and the turn allowed to end first.
    cleanup: async () => {
      for (const g of generators) g.release(new Error('rig teardown'))
      for (let n = 0; n < 200 && (managed as unknown as { isProcessing: boolean }).isProcessing; n++) await tick(10)
      managed.agent = null as never
      await manager.cleanup()
    },
  }
}

describe('F1.583 — a revoked turn shows the note, not the raw capability-snapshot-revoked after it', () => {
  it('THE DEFECT (chat loop) — the revoked turn\'s thrown capability-snapshot-revoked sends no raw error row; the turn still ends', async () => {
    const r = await rig('f1583-chat')
    try {
      void r.send('use the plugin')
      const g = await r.generator(0)
      r.holdLease()
      r.revoke()
      expect(r.notes()).toHaveLength(1)
      const from = r.sent.length
      g.release(new Error(REVOKED))
      await r.turnEnded(from)
      expect(r.rawErrors(from)).toEqual([])
      expect(r.managed.isProcessing).toBe(false)
    } finally {
      await r.cleanup()
    }
  })

  it('CONTROL (chat loop) — the same error in a turn no revoke note was written for keeps its raw error row', async () => {
    const r = await rig('f1583-chat-control')
    try {
      void r.send('use the plugin')
      const g = await r.generator(0)
      const from = r.sent.length
      g.release(new Error(REVOKED))
      await r.turnEnded(from)
      expect(r.rawErrors(from)).toHaveLength(1)
    } finally {
      await r.cleanup()
    }
  })

  it('THE DEFECT (agent error event) — an error EVENT carrying it in the noted turn writes no error row and sends no event', async () => {
    const r = await rig('f1583-event')
    try {
      void r.send('use the plugin')
      await r.generator(0)
      r.holdLease()
      r.revoke()
      const from = r.sent.length
      await (r.manager as unknown as { processEvent(m: unknown, e: AgentEvent): Promise<void> }).processEvent(r.managed, { type: 'error', message: REVOKED } as AgentEvent)
      expect(r.errorRows()).toEqual([])
      expect(r.rawErrors(from)).toEqual([])
      // CONTROL — a DIFFERENT error in the same noted turn is still drawn.
      await (r.manager as unknown as { processEvent(m: unknown, e: AgentEvent): Promise<void> }).processEvent(r.managed, { type: 'error', message: 'upstream connection reset' } as AgentEvent)
      expect(r.errorRows().map(row => row.content)).toEqual(['upstream connection reset'])
    } finally {
      await r.cleanup()
    }
  })
})

/**
 * F1.633 (F1.583's residue, origin WJ-bp proposed row 4, 2026-09-24, LOW) — a tool row still running when a revoke
 * stops the turn closes as FAILED, with a result that says why. Before F1.583 the raw error's renderer handler marked
 * it failed ('Error occurred'), on the live view only; with that error no longer drawn, the turn end's fail-safe marked
 * it finished with no result, and the host's own row stayed `executing`.
 */
const STOPPED = 'Stopped because a capability this turn was using was withdrawn.'
const toolStart = (toolUseId: string, toolName = 'Bash') => ({ type: 'tool_start', toolName, toolUseId, input: { command: `echo ${toolUseId}` }, turnId: 'T1' }) as AgentEvent
const toolResult = (toolUseId: string, result: string) => ({ type: 'tool_result', toolUseId, toolName: 'Bash', result, isError: false, turnId: 'T1' }) as AgentEvent

describe('F1.633 — a tool still running when a capability revoke stops the turn is closed as failed, with the reason', () => {
  it('THE DEFECT — the running tool is failed with the reason, persisted and sent; CONTROL — a tool that finished before the revoke keeps its result', async () => {
    const r = await rig('f1633-running', [[toolStart('tu-done'), toolResult('tu-done', 'done output'), toolStart('tu-running')]])
    try {
      void r.send('use the plugin')
      const g = await r.generator(0)
      expect(r.toolRow('tu-running')).toEqual({ toolStatus: 'executing', toolResult: undefined, isError: undefined })
      r.holdLease()
      const from = r.sent.length
      r.revoke()
      expect(r.toolRow('tu-running')).toEqual({ toolStatus: 'error', toolResult: STOPPED, isError: true })
      expect(r.toolResults(from)).toEqual([{ toolUseId: 'tu-running', result: STOPPED, isError: true }])
      expect(r.toolRow('tu-done')).toEqual({ toolStatus: 'completed', toolResult: 'done output', isError: false })
      const ended = r.sent.length
      g.release(new Error(REVOKED))
      await r.turnEnded(ended)
      expect(r.toolRow('tu-running')).toEqual({ toolStatus: 'error', toolResult: STOPPED, isError: true })
    } finally {
      await r.cleanup()
    }
  })

  it('CONTROL — a row an EARLIER turn left running is not this turn\'s: the revoke of the next turn leaves it as it was', async () => {
    const r = await rig('f1633-earlier', [[toolStart('tu-earlier')], []])
    try {
      void r.send('first turn')
      const first = await r.generator(0)
      const from = r.sent.length
      first.release(new Error('upstream connection reset'))
      await r.turnEnded(from)
      expect(r.toolRow('tu-earlier')).toEqual({ toolStatus: 'executing', toolResult: undefined, isError: undefined })
      void r.send('second turn')
      await r.generator(1)
      r.holdLease()
      const revokedFrom = r.sent.length
      r.revoke()
      expect(r.notes()).toHaveLength(1)
      expect(r.toolRow('tu-earlier')).toEqual({ toolStatus: 'executing', toolResult: undefined, isError: undefined })
      expect(r.toolResults(revokedFrom)).toEqual([])
    } finally {
      await r.cleanup()
    }
  })
})

/**
 * F1.1264 (origin: the final CDP sitting's triage D-20, F1.633's residue; also closes F1.747's and F1.897's stale rows) —
 * a user Stop closes the tool rows THIS turn started that are still running as `Interrupted`, the text the renderer's
 * `handleInterrupted` already draws live, so the stored transcript says the same after a reload instead of keeping
 * `toolStatus: executing` forever (SIT-h: claude's Monitor rows, SIT-ab: codex's Bash row). Same scope as F1.633:
 * only this generation's rows, a finished row keeps its result, a background row is `task_completed`'s.
 */
describe('F1.1264 — a Stop closes the stopped turn\'s running tool rows as interrupted', () => {
  it('THE DEFECT — the running tool is closed as Interrupted, persisted on the host; CONTROL — a finished tool keeps its result', async () => {
    const r = await rig('f1264-stop', [[toolStart('tu-done'), toolResult('tu-done', 'done output'), toolStart('tu-running')]])
    try {
      void r.send('run two commands')
      const g = await r.generator(0)
      expect(r.toolRow('tu-running')).toEqual({ toolStatus: 'executing', toolResult: undefined, isError: undefined })
      await r.manager.cancelProcessing(r.managed.id)
      expect(r.toolRow('tu-running')).toEqual({ toolStatus: 'error', toolResult: 'Interrupted', isError: true })
      expect(r.toolRow('tu-done')).toEqual({ toolStatus: 'completed', toolResult: 'done output', isError: false })
      const ended = r.sent.length
      g.release(new Error('aborted'))
      await r.turnEnded(ended).catch(() => {})
      expect(r.toolRow('tu-running')).toEqual({ toolStatus: 'error', toolResult: 'Interrupted', isError: true })
    } finally {
      await r.cleanup()
    }
  })

  it('CONTROL — a row an EARLIER turn left running is not the stopped turn\'s: the Stop leaves it as it was', async () => {
    const r = await rig('f1264-earlier', [[toolStart('tu-earlier')], []])
    try {
      void r.send('first turn')
      const first = await r.generator(0)
      const from = r.sent.length
      first.release(new Error('upstream connection reset'))
      await r.turnEnded(from)
      void r.send('second turn')
      await r.generator(1)
      await r.manager.cancelProcessing(r.managed.id)
      expect(r.toolRow('tu-earlier')).toEqual({ toolStatus: 'executing', toolResult: undefined, isError: undefined })
    } finally {
      await r.cleanup()
    }
  })
})
