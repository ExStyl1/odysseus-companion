import { afterEach, describe, expect, it, jest } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionFilePath } from '@nessy-agent/shared/sessions/storage'
import { readSessionJsonl } from '@nessy-agent/shared/sessions/jsonl'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { AgentEvent, AgentEventExecutionResult, SdkAutomationInput } from '@nessy-agent/shared/automations'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * R32 · f224. `MessageDisplay` "Runs while an assistant message streams to the
 * screen" and its `hookSpecificOutput.displayContent` "replaces the displayed
 * text on screen. Display-only: the transcript and what Claude sees keep the
 * original" (hooks.md:1263, :876).
 *
 * The invariants worth a test are the ones a per-layer unit test cannot see:
 * that the DISPLAY wire and the PERSISTED transcript disagree on purpose, and
 * that every way the hook can fail lands on the original text (":740
 * MessageDisplay | No | The original text is displayed").
 */

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  persistSession(managed: unknown): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
  runMessageDisplayBatch(
    managed: unknown,
    cursor: Record<string, unknown>,
    delta: string,
    final: boolean,
    turnId: string | undefined,
  ): Promise<string | undefined>
  trackAgentAutomationSystem(
    managed: unknown,
    system: unknown,
  ): { hasAgentEventMatchers?: (event: AgentEvent) => boolean } | undefined
  flushDelta(sessionId: string, workspaceId: string): Promise<void>
}

/** The one automation-system seam the emitter uses, plus a call log. */
function fakeAutomationSystem(
  handler: (input: SdkAutomationInput) => Promise<AgentEventExecutionResult>,
  options: { answers?: boolean } = {},
) {
  const inputs: SdkAutomationInput[] = []
  const system = {
    executeAgentEvent: async (event: AgentEvent, input: SdkAutomationInput) => {
      if (event !== 'MessageDisplay') return { matchedCount: 0 }
      inputs.push(input)
      return handler(input)
    },
    ...(options.answers === false ? {} : { hasAgentEventMatchers: (event: AgentEvent) => event === 'MessageDisplay' }),
  }
  return { system, inputs }
}

function setUp(sessionId: string, system?: unknown) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const sent: SessionEvent[] = []
  manager.setEventSink((_channel, _target, event) => { sent.push(event as SessionEvent) })
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: `/tmp/nessy-${sessionId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  if (system) (managed as unknown as { agentAutomationSystem: unknown }).agentAutomationSystem = system
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
  return { manager, managed, sent, internals: manager as unknown as Internals }
}

const textEvents = (sent: SessionEvent[]) =>
  sent.filter((event): event is Extract<SessionEvent, { type: 'text_delta' | 'text_complete' }> =>
    event.type === 'text_delta' || event.type === 'text_complete')

describe('R32 MessageDisplay emission', () => {
  it('keeps the wire in arrival order when a slow hook overlaps a fast one', async () => {
    // A flush clears its own timer entry BEFORE awaiting the hook, so a delta
    // arriving mid-await schedules a fresh timer and a second flush enters
    // concurrently. Neither can re-send the same span, but two hooks in flight
    // resolve in either order — so without `deltaFlushChain` the fast second
    // batch reaches the wire ahead of the slow first one and the user reads the
    // message out of order. Positive control: drop the chaining in `flushDelta`
    // and this test fails with ['second', 'first'].
    const gate: Array<() => void> = []
    const { system } = fakeAutomationSystem(async input => {
      const delta = String(input.delta)
      // Only the FIRST batch waits, and it waits for this test to release it.
      if (delta.startsWith('first')) {
        await new Promise<void>(resolve => { gate.push(resolve) })
      }
      return { matchedCount: 1, decision: { displayContent: delta.trim() } }
    })
    const { managed, sent, internals } = setUp('message-display-order', system)

    await internals.processEvent(managed, { type: 'text_delta', text: 'first\n', turnId: 't1' })
    const slow = internals.flushDelta('message-display-order', 'ws_test')
    // Let flush #1 actually enter and park on the gate. Without this tick the
    // chain's own microtask defers it and the second delta simply joins the same
    // batch — correct behaviour, but not the overlap this test is about.
    await new Promise(resolve => setTimeout(resolve, 0))
    // The slow hook is now parked inside flush #1. Queue and flush a second batch.
    await internals.processEvent(managed, { type: 'text_delta', text: 'second\n', turnId: 't1' })
    const fast = internals.flushDelta('message-display-order', 'ws_test')
    // Release the first hook only after the second flush has been kicked off.
    await new Promise(resolve => setTimeout(resolve, 10))
    gate.forEach(release => release())
    await Promise.all([slow, fast])

    expect(textEvents(sent).map(event => (event as { displayDelta?: string }).displayDelta))
      .toEqual(['first', 'second'])
  })

  it('renders the replacement while the transcript, the reload and the model keep the original', async () => {
    // The documented redaction use case (":1267 redact API keys or internal
    // hostnames from Claude's responses").
    const { system, inputs } = fakeAutomationSystem(async input => ({
      matchedCount: 1,
      decision: { displayContent: String(input.delta).replace('sk-secret', '[redacted]') },
    }))
    const { managed, sent, internals } = setUp('message-display-override', system)

    await internals.processEvent(managed, { type: 'text_delta', text: 'token is sk-secret\n', turnId: 't1' })
    await internals.processEvent(managed, { type: 'text_delta', text: 'and done', turnId: 't1' })
    await internals.processEvent(managed, {
      type: 'text_complete',
      text: 'token is sk-secret\nand done',
      turnId: 't1',
    })

    // Two batches: the completed line, then the final one with the held-back tail.
    expect(inputs.map(input => [input.index, input.final, input.delta])).toEqual([
      [0, false, 'token is sk-secret\n'],
      [1, true, 'and done'],
    ])
    // `message_id` is stable across batches (":1287") and is not the transcript id
    // (":1287 This is not the API `msg_…` id, so it can't be correlated with
    // transcript message ids").
    expect(new Set(inputs.map(input => input.message_id)).size).toBe(1)
    expect(inputs[0]!.message_id).not.toBe(managed.messages[0]!.id)
    expect(inputs.every(input => input.turn_id === 't1')).toBe(true)

    // The WIRE: display fields carry the replacement, the originals are untouched.
    // One `text_delta` and not two — the two agent deltas coalesced into one 50 ms
    // batch, and its trailing partial line was held back for the final batch.
    const events = textEvents(sent)
    expect(events.map(event => event.type)).toEqual(['text_delta', 'text_complete'])
    expect(events[0]).toMatchObject({ delta: 'token is sk-secret\n', displayDelta: 'token is [redacted]\n' })
    expect(events[1]).toMatchObject({
      text: 'token is sk-secret\nand done',
      displayText: 'token is [redacted]\nand done',
    })

    // The TRANSCRIPT: the in-memory message and the model's view keep the original.
    expect(managed.messages).toHaveLength(1)
    expect(managed.messages[0]!.content).toBe('token is sk-secret\nand done')
    expect((managed.messages[0] as unknown as { displayContent?: string }).displayContent).toBeUndefined()

    // And the RELOAD — the assertion a per-layer unit test cannot make: a session
    // whose messages were written with an override in flight reloads original.
    internals.persistSession(managed)
    await internals.flushSession('message-display-override', 'ws_test')
    const sessionFile = getSessionFilePath('ws_test', 'message-display-override')
    expect(readFileSync(sessionFile, 'utf-8')).not.toContain('[redacted]')
    const reloaded = readSessionJsonl(sessionFile)
    expect(reloaded?.messages?.map(message => message.content)).toEqual(['token is sk-secret\nand done'])
  })

  it.each([
    ['no displayContent in the output', async (): Promise<AgentEventExecutionResult> => ({ matchedCount: 1 })],
    ['a non-string displayContent', async (): Promise<AgentEventExecutionResult> => ({ matchedCount: 1, decision: { displayContent: 42 as unknown as string } })],
    ['a hook that throws', async (): Promise<AgentEventExecutionResult> => { throw new Error('hook blew up') }],
    ['a hook trying to block the message', async (): Promise<AgentEventExecutionResult> => ({ matchedCount: 1, decision: { decision: 'block', reason: 'no' } })],
  ])('displays the original text on %s', async (_label, handler) => {
    // hooks.md:740 — "`MessageDisplay` | No | The original text is displayed" —
    // and ":1311 Omit it to display the original". ":1313 They can't block the
    // message", which is why the blocking row belongs in this table and not in a
    // branch of its own.
    const { system } = fakeAutomationSystem(handler)
    const { managed, sent, internals } = setUp('message-display-failopen', system)

    await internals.processEvent(managed, { type: 'text_delta', text: 'plain line\n', turnId: 't1' })
    await internals.processEvent(managed, { type: 'text_complete', text: 'plain line\n', turnId: 't1' })

    for (const event of textEvents(sent)) {
      expect(event).not.toHaveProperty('displayDelta')
      expect(event).not.toHaveProperty('displayText')
    }
    expect(managed.messages[0]!.content).toBe('plain line\n')
  })

  it('displays the original text when the hook exceeds the 10-second budget', async () => {
    // ":1271 Claude Code holds each batch until your hook returns […] If the hook
    // fails or times out, Claude Code displays the original text. The default
    // timeout for this event is 10 seconds."
    let entered!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const { system } = fakeAutomationSystem(() => {
      entered()
      return new Promise<AgentEventExecutionResult>(() => {})
    })
    const { managed, internals } = setUp('message-display-timeout', system)
    const cursor = { messageId: 'm1', index: 0, fires: true, wholeLines: true, displayed: '', overridden: false }

    jest.useFakeTimers()
    try {
      const running = internals.runMessageDisplayBatch(managed, cursor, 'held line\n', false, 't1')
      await reached
      jest.advanceTimersByTime(10_000)
      expect(await running).toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
    expect(cursor.overridden).toBe(false)
  })

  it('leaves a session with no MessageDisplay hook on its original streaming path', async () => {
    // The cost control: `hasAgentEventMatchers` answers no, so nothing fires and
    // the 50 ms time-based batch is emitted whole — a partial line is NOT held.
    const { system, inputs } = fakeAutomationSystem(async () => ({ matchedCount: 0 }))
    const noMatchers = {
      ...system,
      hasAgentEventMatchers: () => false,
    }
    const { managed, sent, internals } = setUp('message-display-inactive', noMatchers)

    await internals.processEvent(managed, { type: 'text_delta', text: 'no newline here', turnId: 't1' })
    await internals.processEvent(managed, { type: 'text_complete', text: 'no newline here', turnId: 't1' })

    expect(inputs).toEqual([])
    const events = textEvents(sent)
    expect(events[0]).toMatchObject({ type: 'text_delta', delta: 'no newline here' })
    expect(events[0]).not.toHaveProperty('displayDelta')
    expect(managed.messages[0]!.content).toBe('no newline here')
  })

  it('fires once with the whole message when nothing streamed', async () => {
    // ":1277 In non-interactive runs […] MessageDisplay runs once per assistant
    // message instead of once per batch of lines. The single call arrives after
    // the message completes and carries the full message text: `index` is `0`,
    // `final` is `true`, and `delta` holds the entire message."
    const { system, inputs } = fakeAutomationSystem(async input => ({
      matchedCount: 1,
      decision: { displayContent: `[${String(input.delta)}]` },
    }))
    const { managed, sent, internals } = setUp('message-display-oneshot', system)

    await internals.processEvent(managed, { type: 'text_complete', text: 'whole message', turnId: 't1' })

    expect(inputs.map(input => [input.index, input.final, input.delta])).toEqual([[0, true, 'whole message']])
    expect(textEvents(sent)[0]).toMatchObject({ type: 'text_complete', text: 'whole message', displayText: '[whole message]' })
    expect(managed.messages[0]!.content).toBe('whole message')
  })

  it('holds a batch that has no completed line until the final batch', async () => {
    // ":1294 Always whole lines, except the final batch which may end mid-line."
    // A one-line message therefore produces exactly one call — the final one —
    // and the partial text is never shown unreplaced first, which is what a
    // redaction hook depends on.
    const { system, inputs } = fakeAutomationSystem(async input => ({
      matchedCount: 1,
      decision: { displayContent: String(input.delta).replace('sk-secret', '[redacted]') },
    }))
    const { managed, sent, internals } = setUp('message-display-oneline', system)

    await internals.processEvent(managed, { type: 'text_delta', text: 'token is ', turnId: 't1' })
    await internals.processEvent(managed, { type: 'text_delta', text: 'sk-secret', turnId: 't1' })
    await internals.processEvent(managed, { type: 'text_complete', text: 'token is sk-secret', turnId: 't1' })

    expect(inputs.map(input => [input.index, input.final, input.delta])).toEqual([
      [0, true, 'token is sk-secret'],
    ])
    const events = textEvents(sent)
    expect(events.map(event => event.type)).toEqual(['text_complete'])
    expect(events[0]).toMatchObject({ text: 'token is sk-secret', displayText: 'token is [redacted]' })
    expect(managed.messages[0]!.content).toBe('token is sk-secret')
  })

  it('forwards the matcher question through the tracking wrapper', async () => {
    // The wrapper is what `managed.agentAutomationSystem` actually holds, so a
    // missing forward would silently read as "unknown" and put an awaited round
    // trip on every session's 50 ms delta batch — the exact cost the question
    // exists to avoid. Tested here rather than inferred from the emitter, because
    // the emitter's own tests inject the inner system directly.
    const { system } = fakeAutomationSystem(async () => ({ matchedCount: 0 }))
    const { managed, internals } = setUp('message-display-wrapper')

    const tracked = internals.trackAgentAutomationSystem(managed, system)
    expect(tracked?.hasAgentEventMatchers?.('MessageDisplay')).toBe(true)
    expect(tracked?.hasAgentEventMatchers?.('Stop')).toBe(false)

    // A host without the optional method must not gain one — the emitter reads
    // its absence as "unknown", which is a different decision from "no".
    const { system: silent } = fakeAutomationSystem(async () => ({ matchedCount: 0 }), { answers: false })
    // The host must be TRACKED and lack the method. A `trackAgentAutomationSystem`
    // that returned nothing at all would satisfy the absence while failing to do
    // the one thing this line is about.
    const silentTracked = internals.trackAgentAutomationSystem(managed, silent)
    expect(silentTracked).toBeDefined()
    expect(silentTracked?.hasAgentEventMatchers).toBeUndefined()
  })

  it('fires nothing for a message with no text', async () => {
    // ":1275 messages with no text, such as tool-call-only responses, don't
    // trigger it."
    const { system, inputs } = fakeAutomationSystem(async () => ({ matchedCount: 1, decision: { displayContent: 'x' } }))
    const { managed, internals } = setUp('message-display-empty', system)

    await internals.processEvent(managed, { type: 'text_complete', text: '', turnId: 't1' })

    expect(inputs).toEqual([])
    expect(managed.messages[0]!.content).toBe('')
  })
})
