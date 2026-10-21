/**
 * UA4.7 — the Conductor's verdict read per runtime (plan UA4.7, spec §11 "Verdict and repair": upstream's parsing is
 * ported verbatim, `TaskRunner.ts` `parseVerdict`; only a completion whose turn began after the verify message counts).
 *
 * One fixture per runtime: the wire events of an orchestrator's verify turn — commentary before a tool call, then the
 * reply — go through that runtime's REAL event adapter (`PiEventAdapter`, `ClaudeEventAdapter`, `CodexEventAdapter`);
 * every `text_complete` becomes the transcript row `SessionManager`'s `text_complete` arm writes (role, text,
 * `isIntermediate`, `isThinking`); the turn ends through the REAL `onProcessingStopped`, whose completion seam
 * (`finalText`, turn-scoped) is what the REAL `TaskRunner` reads, and `getSessionFinalText` agrees with it. The verify
 * send into a mid-turn orchestrator goes through the REAL `sendMessage` in queue mode (`midStreamOverride: 'queue'`, as
 * `conductor-host.ts` sends it). Only the I/O under the session (persistence, the queue replay, the browser pane) and
 * the child sessions (a structural host; their completions ride the same seam) are stand-ins.
 *
 * Readings (2026-10-02, this file): Pi and Claude mark commentary before a tool call `isIntermediate`
 * (`stopReason === 'toolUse'` / `stop_reason === 'tool_use'`), so the turn's final text is the reply alone. Codex marks
 * NO `agentMessage` intermediate (`codex/event-adapter.ts`, the `isAgentMessage` arm; only reasoning and plan items
 * are), so every agent message of a codex turn is a final row and the seam's `finalText` is the LAST one. UA12.76: the
 * verdict therefore reads EVERY final row of the verify turn (`SessionCompletionEvent.turnFinalTexts`, joined in
 * order, last match wins), so a verdict written in an earlier agent message of the same turn is read instead of being
 * re-asked. Pi's adapter emits only a turn's FIRST final text (`hasEmittedFinalText`).
 *
 * Positive: `VERDICT: FAIL — nodes=build-up,review — reason` re-runs build-up, review and their dependent publish,
 * never the independent notes, on all three runtimes.
 * Negative: a hyphen inside the reason (and inside a node id) does not split it; an earlier quoted `VERDICT: PASS` and
 * the text after the verdict line are ignored because the last match wins and the reason is that line only; a verify
 * message sent while the orchestrator is mid-turn is queued, and the in-flight turn's text — which says
 * `VERDICT: PASS` — is never parsed, on all three runtimes; an orchestrator whose runtime changed between rounds still
 * verifies (round one on Claude, round two on Codex).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { ClaudeEventAdapter } from '@nessy-agent/shared/agent/backend/claude/event-adapter'
import { CodexEventAdapter } from '@nessy-agent/shared/agent/backend/codex/event-adapter'
import { PiEventAdapter } from '@nessy-agent/shared/agent/backend/pi/event-adapter'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { parseTaskSpec, readRunLog, saveTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
import { createManagedSession, type SessionCompletionEvent } from '../../sessions/SessionManager'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import { TaskRunner, type ConductorSessionHost } from '../TaskRunner'

const WS = 'ws-ua4-7'
const ORCH = 'orch-ua4-7'
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 6; i++) await tick() }

type Runtime = 'pi' | 'claude' | 'codex'
interface Row { id: string; role: 'user' | 'assistant'; content: string; isIntermediate?: boolean; isThinking?: boolean; turnId?: string }

// ---------------------------------------------------------------------------
// Runtime fixtures: one verify turn's wire events through the runtime's own adapter
// ---------------------------------------------------------------------------

const COMMENTARY = 'Let me read the node outputs before I decide.'

async function adapterEvents(runtime: Runtime, finalTexts: string[]): Promise<AgentEvent[]> {
  if (runtime === 'pi') {
    const adapter = new PiEventAdapter()
    adapter.startTurn()
    const events: AgentEvent[] = []
    const take = (event: unknown) => { for (const e of adapter.adaptEvent(event as never)) events.push(e as AgentEvent) }
    take({ type: 'turn_start' })
    take({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: COMMENTARY } })
    for (const text of finalTexts) take({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: text } })
    return events
  }
  if (runtime === 'claude') {
    const adapter = new ClaudeEventAdapter({ onDebug: undefined, mapSDKError: async () => ({ type: 'typed_error', error: {} }) } as never)
    adapter.startTurn()
    const events: AgentEvent[] = []
    const message = async (text: string, stop: 'tool_use' | 'end_turn') => {
      events.push(...await adapter.adapt({
        type: 'assistant',
        message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        parent_tool_use_id: null, session_id: 'sdk-1', isReplay: false,
      } as never))
      events.push(...await adapter.adapt({
        type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stop } }, parent_tool_use_id: null, session_id: 'sdk-1',
      } as never))
    }
    await message(COMMENTARY, 'tool_use')
    for (const text of finalTexts) await message(text, 'end_turn')
    return events
  }
  const adapter = new CodexEventAdapter()
  const events: AgentEvent[] = []
  const done = (item: Record<string, unknown>) => events.push(...adapter.adapt('item/completed', { threadId: 'th-1', turnId: 'cx-1', item }))
  done({ type: 'reasoning', id: 'rs-1', summary: ['Weighing the outputs against the criteria.'], content: [] })
  done({ type: 'agentMessage', id: 'am-1', text: COMMENTARY })
  finalTexts.forEach((text, index) => done({ type: 'agentMessage', id: `am-${index + 2}`, text }))
  return events
}

let rowSeq = 0
/** The rows `SessionManager`'s `text_complete` arm writes for these events (role, text, the two flags, turn id). */
function rowsOf(events: AgentEvent[]): Row[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'text_complete' }> => e.type === 'text_complete')
    .map(e => ({
      id: `row-${++rowSeq}`,
      role: 'assistant' as const,
      content: e.text,
      ...(e.isIntermediate ? { isIntermediate: true } : {}),
      ...(e.isThinking ? { isThinking: true } : {}),
      ...(e.turnId ? { turnId: e.turnId } : {}),
    }))
}

// ---------------------------------------------------------------------------
// The rig: a real SessionManager holding the orchestrator, a real TaskRunner
// ---------------------------------------------------------------------------

interface Managed {
  id: string
  isProcessing: boolean
  messages: Row[]
  messageQueue: Array<{ message: string; messageId?: string }>
  queuePaused: boolean
  turnStartFinalMessageId?: string
  turnTerminalReason?: string
  turnTerminalIsError?: boolean
}

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw)
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues))
  return r.data
}

function rig(slug: string) {
  const root = mkdtempSync(join(tmpdir(), `ua4-7-${slug}-`))
  const sm = createTestSessionManager()
  sm.setEventSink((() => undefined) as never)
  const managed = createManagedSession(
    { id: ORCH, name: 'orchestrator' },
    { id: WS, name: WS, rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId: WS, sessionId: ORCH }), managed)
  const replayed: string[] = []
  const internals = sm as unknown as Record<string, unknown> & {
    onProcessingStopped(sessionId: string, reason: 'complete', workspaceId?: string): Promise<void>
    emitSessionComplete(evt: SessionCompletionEvent): void
  }
  Object.assign(internals, {
    processNextQueuedMessage: (id: string) => { replayed.push(id) }, // the queue's replay is played by the test
    flushPendingTaskNotifications: async () => undefined,
    persistSession: () => undefined,
    flushSession: async () => undefined,
    writeSessionMetadata: async () => undefined,
    getBrowserPaneManagerForSession: () => null,
  })
  const completions: SessionCompletionEvent[] = []
  sm.onSessionComplete(evt => { if (evt.sessionId === ORCH) completions.push(evt) })

  const beginTurn = () => {
    managed.turnStartFinalMessageId = [...managed.messages].reverse().find(m => m.role === 'assistant' && !m.isIntermediate)?.id
    managed.turnTerminalReason = undefined
    managed.turnTerminalIsError = undefined
    managed.isProcessing = true
  }
  const endTurn = async (rows: Row[]) => {
    managed.messages.push(...rows)
    await internals.onProcessingStopped(ORCH, 'complete', WS)
    await settle()
  }

  let n = 0
  const children: { id: string; nodeId: string }[] = []
  const verifySends: string[] = []
  const host: ConductorSessionHost = {
    async createSession(_ws: string, options: CreateSessionOptions) {
      const id = `child-${options.taskNodeId}-${++n}`
      children.push({ id, nodeId: options.taskNodeId! })
      return { id }
    },
    async sendMessage(sessionId: string, message: string) {
      if (sessionId !== ORCH) return
      verifySends.push(message)
      if (managed.isProcessing) {
        // Mid-turn: the REAL queue-mode send (conductor-host.ts's), delivered at the ack.
        await new Promise<void>((resolve, reject) => {
          sm.sendMessage(ORCH, message, undefined, undefined, { midStreamOverride: 'queue' }, undefined, undefined, () => resolve(), { workspaceId: WS })
            .catch(reject)
        })
        return
      }
      // Idle: the send starts the verify turn (its user row); the test plays that turn's events.
      managed.messages.push({ id: `row-${++rowSeq}`, role: 'user', content: message })
      beginTurn()
    },
    async setSessionStatus() {},
    async setKanbanColumn() {},
    async setTaskNodeCount() {},
    async cancelProcessing() {},
    onSessionComplete: listener => sm.onSessionComplete(listener),
    async getSessionProjectHandleId() { return undefined },
    getSessionProjectId: () => undefined,
    getSessionPermissionMode: () => undefined,
  }

  saveTaskSpec(root, specOf({
    id: slug,
    title: slug,
    goal: 'ship the build',
    max_iterations: 3,
    nodes: [
      { id: 'build-up', prompt: 'build it' },
      { id: 'review', depends_on: ['build-up'], prompt: 'review ${nodes.build-up.output}' },
      { id: 'publish', depends_on: ['review'], prompt: 'publish ${nodes.review.output}' },
      { id: 'notes', prompt: 'write notes' },
    ],
  }))
  const runner = new TaskRunner({ host, workspaceId: WS, workspaceRoot: root, now: () => '2026-10-02T00:00:00.000Z' })

  /** Run the DAG to its first verify message: every node completes through the session seam. */
  const runToVerify = async () => {
    await runner.run(slug, { runId: 'r1', orchestratorSessionId: ORCH })
    for (let round = 0; round < 6; round++) {
      await settle()
      const open = children.filter(c => runner.getRunState(slug, 'r1')!.nodes.find(x => x.id === c.nodeId)?.sessionId === c.id
        && runner.getRunState(slug, 'r1')!.nodes.find(x => x.id === c.nodeId)?.state === 'running')
      for (const c of open) internals.emitSessionComplete({ sessionId: c.id, workspaceId: WS, reason: 'complete', finalText: `${c.nodeId} done` })
    }
    await settle()
  }
  const verdicts = () => readRunLog(root, slug, 'r1').filter(e => e.kind === 'verdict')
  const retried = () => readRunLog(root, slug, 'r1').flatMap(e => e.kind === 'node-retry' ? [e.nodeId] : [])
  const status = () => runner.getRunState(slug, 'r1')!.status
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { sm, managed, runner, completions, replayed, verifySends, beginTurn, endTurn, runToVerify, verdicts, retried, status, cleanup, children }
}

const FAIL_REPLY = [
  'The required form is VERDICT: PASS when everything holds, so first the checks.',
  'The build-up output is half-done - the review missed it.',
  'VERDICT: FAIL — nodes=build-up,review — the build-up step is half-done - redo it',
  'Happy to expand on any of this.',
].join('\n')

describe.each(['pi', 'claude', 'codex'] as const)('UA4.7 — the verdict through the %s transcript', (runtime) => {
  it('POSITIVE: nodes=build-up,review re-runs them and their dependent publish, never notes; NEGATIVE: the hyphens and the trailing text', async () => {
    const h = rig(`fail-${runtime}`)
    try {
      await h.runToVerify()
      expect(h.status()).toBe('verifying')
      expect(h.verifySends).toHaveLength(1)
      await h.endTurn(rowsOf(await adapterEvents(runtime, [FAIL_REPLY])))

      // The seam's turn-scoped text IS the reply (no commentary, no reasoning), and getSessionFinalText agrees.
      expect(h.completions.at(-1)?.finalText).toBe(FAIL_REPLY)
      expect(h.sm.getSessionFinalText(ORCH, WS)).toBe(FAIL_REPLY)
      // The last match wins; the reason is that line only (hyphens kept, the trailing sentence and the quoted PASS out).
      expect(h.verdicts()).toEqual([{
        t: '2026-10-02T00:00:00.000Z',
        kind: 'verdict',
        result: 'fail',
        reason: 'the build-up step is half-done - redo it',
        nodes: ['build-up', 'review'],
      }])
      expect(h.retried().sort()).toEqual(['build-up', 'publish', 'review'])
      expect(h.status()).toBe('running')
    } finally {
      h.cleanup()
    }
  })

  it('NEGATIVE: a verify message sent mid-turn is queued, and the in-flight turn\'s text is never parsed', async () => {
    const h = rig(`midturn-${runtime}`)
    try {
      // The user is talking to the orchestrator when the run reaches verification.
      h.managed.messages.push({ id: `row-${++rowSeq}`, role: 'user', content: 'What does VERDICT: PASS mean?' })
      h.beginTurn()
      await h.runToVerify()
      expect(h.status()).toBe('verifying')
      expect(h.managed.messageQueue.map(q => q.message)).toEqual([h.verifySends[0]!]) // queued, not steered

      // The in-flight turn ends saying "VERDICT: PASS": the queue hands over, the seam stays silent, nothing is parsed.
      await h.endTurn(rowsOf(await adapterEvents(runtime, ['It means the run passed: VERDICT: PASS'])))
      expect(h.replayed).toEqual([ORCH])
      expect(h.completions).toEqual([])
      expect(h.verdicts()).toEqual([])
      expect(h.status()).toBe('verifying')

      // The queued verify turn runs next; ITS reply is the verdict.
      h.managed.messageQueue.shift()
      h.beginTurn()
      await h.endTurn(rowsOf(await adapterEvents(runtime, [FAIL_REPLY])))
      expect(h.verdicts().map(v => (v as { result: string }).result)).toEqual(['fail'])
    } finally {
      h.cleanup()
    }
  })
})

describe('UA4.7 — runtime switches and the codex residue', () => {
  it('NEGATIVE: an orchestrator switched between rounds still verifies (round one on Claude, round two on Codex)', async () => {
    const h = rig('switched')
    try {
      await h.runToVerify()
      await h.endTurn(rowsOf(await adapterEvents('claude', ['Notes are thin.\nVERDICT: FAIL — nodes=notes — expand the notes'])))
      expect(h.retried()).toEqual(['notes'])
      // The repair re-runs notes; the next round's verify turn is answered on the codex runtime's transcript shape.
      const repaired = h.children.filter(c => c.nodeId === 'notes').at(-1)!
      ;(h.sm as unknown as { emitSessionComplete(e: SessionCompletionEvent): void })
        .emitSessionComplete({ sessionId: repaired.id, workspaceId: WS, reason: 'complete', finalText: 'longer notes' })
      await settle()
      expect(h.status()).toBe('verifying')
      expect(h.verifySends).toHaveLength(2)
      await h.endTurn(rowsOf(await adapterEvents('codex', ['All good now.\nVERDICT: PASS'])))
      expect(h.verdicts().map(v => (v as { result: string }).result)).toEqual(['fail', 'pass'])
      expect(h.status()).toBe('completed')
    } finally {
      h.cleanup()
    }
  })

  it('UA12.76: a verdict in an earlier agent message of the codex verify turn is read (pass), and Pi keeps its first final text (pass)', async () => {
    for (const runtime of ['codex', 'pi'] as const) {
      const h = rig(`split-${runtime}`)
      try {
        await h.runToVerify()
        await h.endTurn(rowsOf(await adapterEvents(runtime, ['VERDICT: PASS', 'Let me know if you need more.'])))
        // Codex: both agent messages are final rows and the seam's finalText is the second (no verdict line);
        // the verdict reads every final row of the turn, so the first one's PASS stands. Pi (the control on the
        // same instrument): its adapter emits only the FIRST final text, which is the verdict.
        expect(h.completions.at(-1)?.finalText).toBe(runtime === 'codex' ? 'Let me know if you need more.' : 'VERDICT: PASS')
        expect(h.verdicts().map(v => (v as { result: string }).result)).toEqual(['pass'])
        expect(h.verifySends).toHaveLength(1) // no re-ask
        expect(h.status()).toBe('completed')
      } finally {
        h.cleanup()
      }
    }
  })

  it('UA12.76 NEGATIVE: across a codex turn\'s agent messages the LAST verdict line wins, and a turn with none is still re-asked', async () => {
    const h = rig('split-last-wins')
    try {
      await h.runToVerify()
      await h.endTurn(rowsOf(await adapterEvents('codex', ['VERDICT: PASS', 'On a second look: VERDICT: FAIL — nodes=notes — the notes are thin', 'Done.'])))
      expect(h.verdicts()).toEqual([{ t: '2026-10-02T00:00:00.000Z', kind: 'verdict', result: 'fail', reason: 'the notes are thin', nodes: ['notes'] }])
      expect(h.retried()).toEqual(['notes'])
    } finally {
      h.cleanup()
    }
    const none = rig('split-none')
    try {
      await none.runToVerify()
      await none.endTurn(rowsOf(await adapterEvents('codex', ['The outputs look fine.', 'Let me know if you need more.'])))
      expect(none.verdicts().map(v => (v as { result: string }).result)).toEqual(['unparsed'])
      expect(none.verifySends.at(-1)).toContain('did not include a parseable verdict')
    } finally {
      none.cleanup()
    }
  })
})
