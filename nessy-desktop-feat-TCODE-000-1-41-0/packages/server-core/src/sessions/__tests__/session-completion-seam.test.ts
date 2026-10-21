/**
 * UA1.4 — the in-process session-completion seam, ported from upstream
 * (`v0.13.4:packages/server-core/src/sessions/SessionManager.ts`, lines 1095–1106,
 * 5144–5151, 6602–6625 and 6750–6795; Apache-2.0) and narrowed by spec §11:
 *
 * - it emits ONLY in `onProcessingStopped`'s final idle arm, with nothing left to
 *   start a turn — never while a queued message remains (paused or not), never on
 *   the notification arm (that arm starts a turn, whose own stop emits);
 * - `finalText`/`finalMessageId` are TURN-SCOPED: present only when this turn
 *   produced a new final assistant message (`didReceiveNewFinalMessage` against
 *   `turnStartFinalMessageId`), so neither an `isIntermediate` row nor the previous
 *   turn's answer passes as this turn's output;
 * - it carries the turn's `terminalIsError` / `terminalReason`;
 * - a throwing browser-pane teardown (`clearVisualsForSession`) never blocks it —
 *   upstream's own hang fix.
 *
 * Every arm drives the SHIPPED `onProcessingStopped`; only the I/O beneath it
 * (persistence, the queue and notification starters, the browser pane) is stubbed.
 */
import { describe, expect, it } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, type SessionCompletionEvent } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-ua1-4'

interface Row { id: string; role: string; content: string; isIntermediate?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  messages: Row[]
  messageQueue: Array<{ message: string; messageId?: string }>
  queuePaused: boolean
  pendingTaskNotifications?: string[]
  turnStartFinalMessageId?: string
  turnTerminalReason?: string
  turnTerminalIsError?: boolean
  tokenUsage?: Record<string, number>
}

function rig(sessionId: string, options: { browserPane?: { clearVisualsForSession(): Promise<void>; unbindAllForSession(): void } } = {}) {
  const sm = createTestSessionManager()
  sm.setEventSink((() => undefined) as never)
  const managed = createManagedSession(
    { id: sessionId, name: 'UA1.4' },
    { id: WORKSPACE_ID, name: 'UA1.4', rootPath: '/tmp/ua1-4', createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  const replayed: string[] = []
  const flushed: string[][] = []
  const internals = sm as unknown as {
    onProcessingStopped(sessionId: string, reason: 'complete' | 'interrupted' | 'error' | 'timeout', workspaceId?: string): Promise<void>
    processNextQueuedMessage(sessionId: string, workspaceId?: string): void
    flushPendingTaskNotifications(managed: unknown): Promise<void>
    persistSession(managed: unknown): void
    writeSessionMetadata(managed: unknown, updates: unknown): Promise<void>
    getBrowserPaneManagerForSession(sessionId: string, workspaceId?: string): unknown
  }
  internals.processNextQueuedMessage = (id: string) => { replayed.push(id) }
  internals.flushPendingTaskNotifications = async (m: unknown) => {
    const target = m as Managed
    flushed.push(target.pendingTaskNotifications ?? [])
    target.pendingTaskNotifications = undefined
  }
  internals.persistSession = () => undefined
  internals.writeSessionMetadata = async () => undefined
  internals.getBrowserPaneManagerForSession = () => options.browserPane ?? null
  const events: SessionCompletionEvent[] = []
  const off = sm.onSessionComplete(evt => { events.push(evt) })

  /** One turn: what it appended, then the stop. */
  const turn = async (appended: Row[], reason: 'complete' | 'interrupted' | 'error' | 'timeout' = 'complete') => {
    managed.turnStartFinalMessageId = [...managed.messages].reverse().find(m => m.role === 'assistant' && !m.isIntermediate)?.id
    managed.turnTerminalReason = undefined
    managed.turnTerminalIsError = undefined
    managed.isProcessing = true
    managed.messages.push(...appended)
    await internals.onProcessingStopped(sessionId, reason, WORKSPACE_ID)
  }
  return { sm, managed, internals, events, off, turn, replayed, flushed }
}

const user = (id: string, content = 'go'): Row => ({ id, role: 'user', content })
const answer = (id: string, content: string): Row => ({ id, role: 'assistant', content })
const thinking = (id: string, content: string): Row => ({ id, role: 'assistant', content, isIntermediate: true })

describe('UA1.4 — onSessionComplete fires once per settled turn (idle arm only)', () => {
  it('POSITIVE — a settled turn emits once, with its own final text, the reason, the workspace and the usage', async () => {
    const h = rig('seam-positive')
    h.managed.tokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, contextTokens: 10, costUsd: 0 }
    await h.turn([user('u1'), thinking('t1', 'let me look'), answer('a1', 'the answer')])

    expect(h.events).toHaveLength(1)
    const evt = h.events[0]!
    expect(evt.sessionId).toBe('seam-positive')
    expect(evt.workspaceId).toBe(WORKSPACE_ID)
    expect(evt.reason).toBe('complete')
    expect(evt.finalMessageId).toBe('a1')
    expect(evt.finalText).toBe('the answer')
    expect(evt.tokenUsage?.totalTokens).toBe(15)
    expect(evt.terminalIsError).toBeUndefined()

    // A second settled turn emits exactly one more, carrying ITS text.
    await h.turn([user('u2'), answer('a2', 'the second answer')])
    expect(h.events.map(e => e.finalText)).toEqual(['the answer', 'the second answer'])
  })

  it('POSITIVE — the turn verdict rides the event: terminalIsError and terminalReason', async () => {
    const h = rig('seam-terminal')
    h.managed.isProcessing = true
    h.managed.messages.push(user('u1'), answer('a1', 'partial'))
    h.managed.turnTerminalReason = 'max_agent_turns'
    h.managed.turnTerminalIsError = true
    await h.internals.onProcessingStopped('seam-terminal', 'complete', WORKSPACE_ID)

    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.terminalIsError).toBe(true)
    expect(h.events[0]!.terminalReason).toBe('max_agent_turns')
  })

  it('NEGATIVE — no emit while a queued message remains (the queue hands off to the next turn)', async () => {
    const h = rig('seam-queued')
    h.managed.messageQueue.push({ message: 'then this', messageId: 'q1' })
    await h.turn([user('u1'), answer('a1', 'first')])

    expect(h.replayed).toEqual(['seam-queued'])
    expect(h.events).toEqual([])
  })

  it('NEGATIVE — a PAUSED queue with queued messages emits nothing (the user is intervening)', async () => {
    const h = rig('seam-paused')
    h.managed.messageQueue.push({ message: 'held', messageId: 'q1' })
    h.managed.queuePaused = true
    await h.turn([user('u1'), answer('a1', 'stopped here')], 'interrupted')

    expect(h.replayed).toEqual([]) // control: the paused queue was not replayed either
    expect(h.events).toEqual([])
  })

  it('NEGATIVE — with pendingTaskNotifications nothing fires until the follow-up turn settles', async () => {
    const h = rig('seam-notifications')
    h.managed.pendingTaskNotifications = ['<task-notification>child done</task-notification>']
    await h.turn([user('u1'), answer('a1', 'started a child')])

    expect(h.flushed).toHaveLength(1) // the notification arm started the follow-up
    expect(h.events).toEqual([])

    await h.turn([answer('a2', 'the child reported back')])
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.finalText).toBe('the child reported back')
  })

  it('NEGATIVE — an isIntermediate-only turn reports undefined finalText', async () => {
    const h = rig('seam-intermediate')
    await h.turn([user('u1'), thinking('t1', 'thinking out loud')])

    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.finalText).toBeUndefined()
    expect(h.events[0]!.finalMessageId).toBeUndefined()
  })

  it('NEGATIVE — the previous turn\'s text is never returned as this turn\'s output', async () => {
    const h = rig('seam-previous')
    await h.turn([user('u1'), answer('a1', 'old answer')])
    await h.turn([user('u2'), thinking('t2', 'only commentary this time')], 'error')

    expect(h.events).toHaveLength(2)
    expect(h.events[1]!.reason).toBe('error')
    expect(h.events[1]!.finalText).toBeUndefined()
    expect(h.events[1]!.finalMessageId).toBeUndefined()
  })

  it('NEGATIVE — a throwing clearVisualsForSession still emits once (upstream hang fix)', async () => {
    let unbound = 0
    const h = rig('seam-bpm-throws', {
      browserPane: {
        clearVisualsForSession: async () => { throw new Error('BROWSER_NO_CAPABLE_CLIENT') },
        unbindAllForSession: () => { unbound += 1 },
      },
    })
    await h.turn([user('u1'), answer('a1', 'done anyway')])

    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.finalText).toBe('done anyway')
    expect(unbound).toBe(0) // the throw skipped the unbind, as upstream's guard does
  })

  it('NEGATIVE — an unsubscribed listener is not called; a throwing listener does not stop the next one', async () => {
    const h = rig('seam-unsubscribe')
    const late: SessionCompletionEvent[] = []
    h.sm.onSessionComplete(() => { throw new Error('listener bug') })
    const offLate = h.sm.onSessionComplete(evt => { late.push(evt) })
    h.off()
    await h.turn([user('u1'), answer('a1', 'one')])

    expect(h.events).toEqual([])
    expect(late).toHaveLength(1)

    offLate()
    await h.turn([user('u2'), answer('a2', 'two')])
    expect(late).toHaveLength(1)
  })

  it('UA12.37 — a listener that unsubscribes and re-subscribes inside its own call is invoked exactly once per emit', async () => {
    // v0.14.0 parity: emitSessionComplete iterates a snapshot of the listener
    // Set. A live-Set loop also visits the entry the listener ADDS mid-loop, so
    // the re-subscribed closure was re-entered by the same emit — upstream's
    // symptom was the Conductor re-asking an unparsed verdict
    // MAX_UNPARSED_REASKS+1 times and failing runs before the orchestrator
    // could answer. (Our TaskRunner arms its re-ask listener on delivery, so
    // the symptom does not fire here today; this pins the hardening.)
    // The re-arm is ONE-SHOT, the Conductor's own shape. Measured 2026-10-04: a
    // first draft of this arm re-subscribed UNCONDITIONALLY, and under the
    // live-Set bug every visit moved its entry to the end of the Set, so the
    // emit never terminated — 697 s and a 9.17 GB peak later the Bun 1.3.14
    // runner segfaulted. One-shot re-arm terminates under both arms and still
    // discriminates: live-Set re-enters the re-armed listener in THIS emit.
    const h = rig('seam-resubscribe')
    let selfCalls = 0
    let offSelf: () => void = () => undefined
    offSelf = h.sm.onSessionComplete(() => {
      selfCalls += 1
      if (selfCalls === 1) {
        offSelf()
        offSelf = h.sm.onSessionComplete(() => { selfCalls += 1 })
      }
    })
    try {
      await h.turn([user('u1'), answer('a1', 'first')])
      // Exactly once for THIS emit, and the rig's own listener was not
      // disturbed by the mid-emit mutation either.
      expect(selfCalls).toBe(1)
      expect(h.events).toHaveLength(1)
      // The re-attached closure sees the NEXT completion exactly once.
      await h.turn([user('u2'), answer('a2', 'second')])
      expect(selfCalls).toBe(2)
      expect(h.events).toHaveLength(2)
    } finally {
      offSelf()
    }
  })

  it('getSessionFinalText reads the last final assistant text (upstream reader; NOT turn-scoped)', async () => {
    const h = rig('seam-reader')
    await h.turn([user('u1'), answer('a1', 'kept'), thinking('t1', 'aside')])

    expect(h.sm.getSessionFinalText('seam-reader', WORKSPACE_ID)).toBe('kept')
    expect(h.sm.getSessionFinalText('no-such-session', WORKSPACE_ID)).toBeUndefined()
  })
})
