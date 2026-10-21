/**
 * P3.16 · a queued delta is flushed before the turn completes.
 *
 * `queueDelta` holds up to `DELTA_BATCH_INTERVAL_MS` (50 ms) of assistant text
 * and lets a timer send it. Only `text_complete` ever awaited `flushDelta`, so
 * every OTHER renderer-facing turn-ending event could go out with text still in
 * the batcher — and the batcher's timer then delivered that text AFTER the turn
 * had ended.
 *
 * Measured through the real renderer event-processor (P3.16 pre-check, the
 * outcomes P3.14's review recorded):
 * - `complete` → late `text_delta` → late `text_complete` renders TWO bubbles
 *   with a duplicated prefix ("Hello " + "Hello world"): `handleComplete` lowers
 *   `isStreaming` on every assistant bubble (P3.14), so the late delta finds no
 *   streaming message for its turnId and appends a NEW one, which the late
 *   `text_complete` then fills with the whole message.
 * - `complete` → late `text_delta` alone leaves that new bubble
 *   `isStreaming`/`isPending` — a bubble spinning after the turn visibly ended.
 * - `interrupted` → late `text_delta` does the same: `handleInterrupted` clears
 *   the same pair, so the user-stop path has the identical split.
 * - Flushed BEFORE the terminal event, the same four events render ONE bubble
 *   with the correct text and no live flags.
 *
 * The renderer cannot repair this — it cannot know a delta is still queued — so
 * the fix is here, at the emitter: every terminal event goes out through
 * `sendTurnEndEvent`, which awaits the flush first.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { RPC_CHANNELS, type SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []
/** Wires swept by the standing invariant below; `setUp({ sweep: false })` opts out. */
const sweptWires: Array<{ label: string; sent: SessionEvent[] }> = []

/**
 * The standing invariant, asserted on EVERY row in this file for free.
 *
 * It reads the WIRE, not the source — which is the whole point. P3.16 first
 * shipped a source-text guard here (`this.sendEvent({ type: 'complete'` must not
 * appear, and `sendTurnEndEvent(` must appear exactly nine times). Review
 * measured that guard against eight ways of writing the same emit and it caught
 * ONE; it also failed on any legitimate tenth site, so it was brittle where it
 * cost and permissive where it should bite. It is gone.
 *
 * A wire property has no such evasions: a delta that arrives after its session's
 * turn ended is the defect, however the emit was spelled — object literal, key
 * order, comments, quotes, a variable, a spread, an aliased send, or a direct
 * `this.eventSink(...)` that never touches `sendEvent` at all. All eight are
 * probed against this function in the last describe block.
 *
 * It discriminates BY TURN, and it has to. "Any delta after any `complete`" is
 * not the defect — a session that finishes turn 1 and then streams turn 2 puts
 * exactly that on the wire, and the first version of this function reported it
 * as a violation. Measured, before sharpening:
 *
 *   [ text_delta(X,"Hello "), complete, text_delta(X,"world"),
 *     text_delta(Y,"second answer"), complete ]
 *
 * — where `world` IS the defect and `second answer` is an ordinary next turn.
 * No row drove two turns, so nothing was red; the cost would have landed on
 * whoever first wrote one, as a failure accusing their row of P3.16's bug, and
 * the natural repair is `sweep: false`, which disarms the instrument entirely.
 *
 * Deltas carry `turnId` on the wire (`flushDeltaOnce` sends it — verified on a
 * real capture, above); terminal events do NOT, so the ended turn is the one
 * that was streaming when the terminal event went out. A later delta is a
 * violation only if it carries THAT turnId. A different turnId opens a new turn
 * and lifts the constraint.
 *
 * TWO KNOWN GAPS, recorded rather than papered over.
 *
 * 1. Coverage, not statics: it fires only on paths a test DRIVES, and only on
 *    events that reach THIS manager's sink. A tenth terminal-event site on an
 *    undriven path — or one emitting outside `SessionManager`'s sink — is caught
 *    by nothing here. No cheap static check closes that honestly: four of the
 *    eight emit shapes are undecidable without type-flow analysis. The
 *    mitigation is coverage: every one of today's sites has a behavioural row,
 *    so a new site means a new path, and a new path means a new row.
 *
 *    There were NINE, and `preflightDpAuth` was the ninth. C3.381 (owner
 *    decision 2026-09-12, option A) stopped it ending a turn at all: it raises
 *    no card, parks nothing in `dpAuthReplay`, and returns a bare
 *    `DpAuthPreflight` the send path threads into `setSourceServers` — so it
 *    emits no terminal event and is no longer a handoff site. Its case is
 *    REMOVED rather than re-pinned (2026-09-19, WI-bs): it was red alone at HEAD
 *    and on CI job 630520568 because no `complete` is emitted any more, and a
 *    case re-aimed at a site that cannot end a turn would be a control whose two
 *    arms agree. The site count is therefore EIGHT, and this paragraph is the
 *    record of which one left and why.
 * 2. A turn that put NOTHING on the wire before its terminal event leaves the
 *    ended turnId unknown, and a later delta carrying a real turnId is then read
 *    as a new turn rather than a late one. Every row in this file streams before
 *    it ends, so the instrument is armed wherever it is used today — but a
 *    future row that ends a silent turn and then streams is unswept for that
 *    delta.
 */
function findLateDeltas(
  sent: SessionEvent[],
): Array<{ sessionId: string; after: string; turnId: unknown; delta: unknown }> {
  /** Per session: the turnId currently streaming, from the last text event seen. */
  const streaming = new Map<string, unknown>()
  /** Per session: the turn a terminal event closed, and which terminal closed it. */
  const ended = new Map<string, { turnId: unknown; after: string }>()
  const late: Array<{ sessionId: string; after: string; turnId: unknown; delta: unknown }> = []
  for (const event of sent) {
    const sessionId = (event as { sessionId?: string }).sessionId
    if (!sessionId) continue
    if (event.type === 'complete' || event.type === 'interrupted') {
      ended.set(sessionId, { turnId: streaming.get(sessionId), after: event.type })
      streaming.delete(sessionId)
      continue
    }
    if (event.type !== 'text_delta' && event.type !== 'text_complete') continue
    const turnId = (event as { turnId?: unknown }).turnId
    const closed = ended.get(sessionId)
    if (event.type === 'text_delta' && closed && turnId === closed.turnId) {
      late.push({ sessionId, after: closed.after, turnId, delta: (event as { delta?: unknown }).delta })
      continue
    }
    // A different turnId is a NEW turn: the previous end no longer constrains it.
    if (closed) ended.delete(sessionId)
    streaming.set(sessionId, turnId)
  }
  return late
}

afterEach(() => {
  const violations = sweptWires.splice(0)
    .flatMap(({ label, sent }) => findLateDeltas(sent).map(late => ({ label, ...late })))
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
  // Cleanup first, assertion second: a failure here must not leak a manager.
  expect(violations).toEqual([])
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  beginAuthRequest(managed: unknown, request: Record<string, unknown>): Promise<void> | void
  projectPiPlanSubmission(managed: unknown, planPath: string): Promise<void>
  projectAdjacentPlanSubmission(managed: unknown, planPath: string): Promise<void>
  onProcessingStopped(sessionId: string, reason: string, workspaceId?: string): Promise<void>
  flushDelta(sessionId: string, workspaceId: string): Promise<void>
  expireDurableApproval(managed: unknown, pending: Record<string, unknown>): Promise<void> | void
  settleDurableApproval(managed: unknown, requestId: string, allowed: boolean): Promise<boolean> | boolean
  reprojectPendingApproval(managed: unknown): void
}

function setUp(sessionId: string, { sweep = true }: { sweep?: boolean } = {}) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const sent: SessionEvent[] = []
  if (sweep) sweptWires.push({ label: sessionId, sent })
  manager.setEventSink((_channel, _target, event) => { sent.push(event as SessionEvent) })
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: `/tmp/nessy-${sessionId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
  return { manager, managed, sent, internals: manager as unknown as Internals }
}

/** A backend stub that records the handoff without running one. */
function stubAgent(managed: unknown): void {
  ;(managed as { isProcessing: boolean }).isProcessing = true
  ;(managed as { agent: unknown }).agent = {
    interruptForHandoff: () => undefined,
    forceAbort: () => undefined,
    getSessionId: () => undefined,
  }
}

/**
 * The whole assertion, in one place: the queued text reached the wire, and it
 * reached it BEFORE the terminal event — never after.
 */
function expectDeltaBeforeTurnEnd(sent: SessionEvent[], terminal: 'complete' | 'interrupted', text: string): void {
  const types = sent.map(event => event.type)
  const terminalIndex = types.indexOf(terminal)
  const deltaIndex = sent.findIndex(event => event.type === 'text_delta' && (event as { delta: string }).delta === text)
  // Both present, and in this order — asserted as one value so a failure prints
  // which half went wrong (a missing delta reads -1, a late one reads > the end).
  expect({ terminalIndex: terminalIndex >= 0, deltaIndex, before: deltaIndex >= 0 && deltaIndex < terminalIndex })
    .toEqual({ terminalIndex: true, deltaIndex, before: true })
  // …and nothing was left for the 50 ms timer to deliver afterwards.
  expect(types.slice(terminalIndex + 1)).not.toContain('text_delta')
}

/** Wait past `DELTA_BATCH_INTERVAL_MS` so a delta the fix failed to flush shows up. */
const pastTheBatchTimer = () => new Promise(resolve => setTimeout(resolve, 80))

describe('P3.16 · the mid-turn handoff sites flush before their complete', () => {
  it('auth handoff (beginAuthRequest)', async () => {
    const { managed, sent, internals } = setUp('p316-auth')
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await internals.beginAuthRequest(managed, {
      type: 'oauth',
      provider: 'github',
      requestId: 'req-1',
      sessionId: 'p316-auth',
      sourceSlug: 'github',
      sourceName: 'GitHub',
    })
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
    // The handoff's own event still follows the complete, as it always did.
    const types = sent.map(event => event.type)
    expect(types.indexOf('auth_request')).toBeGreaterThan(types.indexOf('complete'))
  })

  it('plan submission (projectPiPlanSubmission)', async () => {
    const { managed, sent, internals } = setUp('p316-plan')
    stubAgent(managed)
    ;(managed as unknown as { piPlanProjectionId?: string }).piPlanProjectionId = 'plan-projection-1'
    const planPath = join(mkdtempSync(join(tmpdir(), 'p316-plan-')), 'PLAN.md')
    writeFileSync(planPath, '# Plan\n')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await internals.projectPiPlanSubmission(managed, planPath)
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
  })

  it('adjacent plan submission (projectAdjacentPlanSubmission)', async () => {
    const { managed, sent, internals } = setUp('p316-plan-adjacent')
    stubAgent(managed)
    const planPath = join(mkdtempSync(join(tmpdir(), 'p316-plan-adj-')), 'PLAN.md')
    writeFileSync(planPath, '# Plan\n')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await internals.projectAdjacentPlanSubmission(managed, planPath)
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
  })
})

describe('P3.16 · the ordinary turn end and the user-stop path', () => {
  it('a turn that ends without a text_complete flushes what it streamed (onProcessingStopped)', async () => {
    // The reachable shape on the main path: a turn whose final assistant message
    // never arrives (refusal, error, a backend that drops it). `text_complete`
    // is the only place that flushed, so this turn ended with text still queued.
    const { managed, sent, internals } = setUp('p316-stopped')
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await internals.onProcessingStopped('p316-stopped', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
  })

  it('the user-stop path flushes before `interrupted` (the pre-existing split)', async () => {
    const { manager, managed, sent, internals } = setUp('p316-cancel')
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await manager.cancelProcessing('p316-cancel', false, 'ws_test')
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'interrupted', 'Hello world')
  })

  it('a silent stop (redirect) flushes too', async () => {
    const { manager, managed, sent, internals } = setUp('p316-cancel-silent')
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await manager.cancelProcessing('p316-cancel-silent', true, 'ws_test')
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'interrupted', 'Hello world')
  })
})

describe('P3.20 · a newline-less tail is not dropped at turn end', () => {
  /**
   * P3.16 flushes before every terminal event — but under a `MessageDisplay`
   * matcher the flush could still deliver NOTHING. `flushDeltaOnce` cuts the
   * batch after the last newline (hooks.md:1294 wants whole lines) and holds the
   * partial tail for the next flush; at a terminal event there IS no next flush,
   * so "hold" meant "drop". Measured on this rig before the fix, with the same
   * fixture as the rows below: a handoff after `"Hello world"` put `["complete"]`
   * on the wire — no delta, no bubble.
   *
   * P3.16's own hook row above uses `'Hello world\n'`, which steps around the
   * shape entirely; that is why nothing here saw it.
   *
   * The fix makes the turn's last flush a line boundary (`atTurnEnd`), so the
   * tail goes out through the ordinary hook call rather than being dropped, kept
   * raw, or padded with a newline the model never sent. The reasoning is at the
   * cut in `flushDeltaOnce`.
   */

  /** A matcher-registered system: `wholeLines: true`, with the hook input recorded. */
  function withMatcher(managed: unknown, transform?: (delta: string) => string) {
    const inputs: Array<{ index: unknown; final: unknown; delta: unknown }> = []
    ;(managed as { agentAutomationSystem: unknown }).agentAutomationSystem = {
      executeAgentEvent: async (event: string, input: Record<string, unknown>) => {
        if (event !== 'MessageDisplay') return { matchedCount: 0 }
        inputs.push({ index: input.index, final: input.final, delta: input.delta })
        return transform
          ? { matchedCount: 1, decision: { displayContent: transform(String(input.delta)) } }
          : { matchedCount: 1 }
      },
      hasAgentEventMatchers: (event: string) => event === 'MessageDisplay',
    }
    return inputs
  }

  it('a message that never ends on a newline still reaches the renderer', async () => {
    // The defect, at its smallest. RE-BREAK: with the `atTurnEnd` cut reverted
    // this fails at `deltaIndex: -1` — the wire is `['complete']` alone.
    const { managed, sent, internals } = setUp('p320-tail')
    withMatcher(managed)
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await internals.onProcessingStopped('p320-tail', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
    expect(sent.map(event => event.type)).toEqual(['text_delta', 'complete'])
  })

  it('the tail goes through the hook, not around it', async () => {
    // What rules out the cheap fix — emitting the held tail raw past the hook.
    // The hold exists so a redaction hook sees a partial line BEFORE the user
    // does (`message-display-hook.test.ts` · "holds a batch that has no completed
    // line until the final batch"), and `delta`/`displayDelta` must cover the
    // same span. Also pins `final: false`: hooks.md:1291 gives the message one
    // final batch and it belongs to `finishMessageDisplay`, not to this flush.
    const { managed, sent, internals } = setUp('p320-tail-hook')
    const inputs = withMatcher(managed, delta => delta.replace('sk-secret', '[redacted]'))
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'token is sk-secret', turnId: 'X' })

    await internals.onProcessingStopped('p320-tail-hook', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(inputs).toEqual([{ index: 0, final: false, delta: 'token is sk-secret' }])
    expect(sent.find(event => event.type === 'text_delta'))
      .toMatchObject({ delta: 'token is sk-secret', displayDelta: 'token is [redacted]' })
  })

  it('and the stranded tail no longer leaks into the NEXT turn', async () => {
    // The second symptom, measured on the same rig: a dropped tail is not just
    // lost. Turn start clears `messageDisplayCursor` but NOT `pendingDeltas`
    // (`SessionManager`'s `setProcessing(managed, true)` block), so turn 1's
    // buffer was still there when turn 2 streamed, and the batcher shipped
    // `"turn one tailsecond answer\n"` under turn 2's `turnId` — one turn's text
    // inside another turn's bubble. RE-BREAK: reverting the cut restores exactly
    // that string on the wire.
    const { managed, sent, internals } = setUp('p320-carry')
    withMatcher(managed)
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'turn one tail', turnId: 'X' })
    await internals.onProcessingStopped('p320-carry', 'complete', 'ws_test')
    await pastTheBatchTimer()

    // Turn 2. The cursor reset is what the real turn start does; the rest of the
    // prompt path is not what this row is about.
    ;(managed as { isProcessing: boolean }).isProcessing = true
    ;(managed as unknown as { messageDisplayCursor: unknown }).messageDisplayCursor = undefined
    await internals.processEvent(managed, { type: 'text_delta', text: 'second answer\n', turnId: 'Y' })
    await internals.onProcessingStopped('p320-carry', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(sent.filter(event => event.type === 'text_delta')
      .map(event => [(event as { delta?: unknown }).delta, (event as { turnId?: unknown }).turnId]))
      .toEqual([['turn one tail', 'X'], ['second answer\n', 'Y']])
  })

  it('CONTROL · a mid-turn partial line still buffers, exactly as before', async () => {
    // The semantics the fix must NOT touch. Only the turn's LAST flush is a line
    // boundary; a timer flush mid-message still holds the partial back, so a
    // redaction hook keeps its guarantee for every line but the last.
    const { managed, sent, internals } = setUp('p320-midturn')
    const inputs = withMatcher(managed)
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })
    await pastTheBatchTimer()

    // The timer fired and delivered nothing — the line is not finished.
    expect(sent).toEqual([])
    expect(inputs).toEqual([])

    // The rest of the line arrives; now it is a whole line and it goes.
    await internals.processEvent(managed, { type: 'text_delta', text: ' and more\n', turnId: 'X' })
    await pastTheBatchTimer()

    expect(inputs).toEqual([{ index: 0, final: false, delta: 'Hello world and more\n' }])
    expect(sent.map(event => [event.type, (event as { delta?: unknown }).delta]))
      .toEqual([['text_delta', 'Hello world and more\n']])
  })

  it('CONTROL · a newline-terminated tail is byte-identical to before', async () => {
    // The shape P3.16's hook row already drove, asserted on the whole event so a
    // stray `displayDelta`, a changed `turnId` or an extra send would show.
    const { managed, sent, internals } = setUp('p320-newline-terminated')
    withMatcher(managed)
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world\n', turnId: 'X' })

    await internals.onProcessingStopped('p320-newline-terminated', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(sent).toEqual([
      { type: 'text_delta', sessionId: 'p320-newline-terminated', delta: 'Hello world\n', turnId: 'X' },
      { type: 'complete', sessionId: 'p320-newline-terminated' },
    ] as unknown as SessionEvent[])
  })
})

describe('P3.16 · a batch already in flight is waited for, not overtaken', () => {
  it('a `MessageDisplay` hook holding a batch still delivers it before the complete', async () => {
    // The boundary the `messageDisplayCursor?.fires` clause exists for.
    // `flushDeltaOnce` consumes `pendingDeltas` BEFORE awaiting the hook, so
    // mid-hook the queue reads empty and the batch timer is already cleared —
    // "nothing queued" by every other signal, with a whole batch of text still
    // unsent. Awaiting `flushDelta` is what covers it: flushes are serialized
    // per session on `deltaFlushChain`, so the terminal event queues BEHIND the
    // batch in flight instead of overtaking it.
    const gate: Array<() => void> = []
    const system = {
      executeAgentEvent: async (event: string) => {
        if (event !== 'MessageDisplay') return { matchedCount: 0 }
        await new Promise<void>(resolve => { gate.push(resolve) })
        return { matchedCount: 1 }
      },
      hasAgentEventMatchers: (event: string) => event === 'MessageDisplay',
    }
    const { managed, sent, internals } = setUp('p316-hook-in-flight')
    ;(managed as unknown as { agentAutomationSystem: unknown }).agentAutomationSystem = system
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world\n', turnId: 'X' })

    const inFlight = internals.flushDelta('p316-hook-in-flight', 'ws_test')
    // Let the flush enter the hook: past this tick the queue is empty and the
    // timer is gone, while the batch is still parked on the gate.
    await new Promise(resolve => setTimeout(resolve, 0))
    const stopping = internals.onProcessingStopped('p316-hook-in-flight', 'complete', 'ws_test')
    await new Promise(resolve => setTimeout(resolve, 10))

    // The turn has NOT ended yet — it is waiting for the batch.
    expect(sent.map(event => event.type)).not.toContain('complete')
    gate.forEach(release => release())
    await Promise.all([inFlight, stopping])

    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world\n')
  })
})

describe('P3.16 · a normal turn is unchanged', () => {
  it('emits exactly one delta, in the same order, and no extra event', async () => {
    const { managed, sent, internals } = setUp('p316-normal')
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'X' })
    await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'X' })
    await internals.processEvent(managed, { type: 'text_complete', text: 'Hello world', turnId: 'X' })
    await internals.onProcessingStopped('p316-normal', 'complete', 'ws_test')
    await pastTheBatchTimer()

    // `text_complete` already flushed the batch, so the terminal flush finds
    // nothing and adds nothing: one delta, one completion, one complete.
    expect(sent.filter(event => event.type === 'text_delta')).toHaveLength(1)
    expect(sent.map(event => event.type).filter(type =>
      type === 'text_delta' || type === 'text_complete' || type === 'complete'))
      .toEqual(['text_delta', 'text_complete', 'complete'])
  })

  it('a turn with no assistant text at all still completes', async () => {
    const { sent, managed, internals } = setUp('p316-silent')
    stubAgent(managed)
    await internals.onProcessingStopped('p316-silent', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(sent.map(event => event.type)).toContain('complete')
    expect(sent.map(event => event.type)).not.toContain('text_delta')
  })
})

describe('P3.16 · the durable-approval sites (restart paths) flush too', () => {
  // Both are synchronous methods behind a `boolean` RPC reads, so they `void`
  // the send: the flush→complete ordering still holds, only the tick changes.
  //
  // M4 · `PiPendingApprovalV1.requestedAt` is a NUMBER, and it has to be one
  // here or these rows describe a different test than they run. The first
  // version of this fixture passed an ISO STRING, which
  // `isDurableApprovalExpired` rejects outright at `typeof requestedAt !==
  // 'number'` — so every record routed through the gate took the "age cannot be
  // established ⇒ expired" arm and the TTL comparison the rows are named for was
  // never evaluated. Both arms matter (the unusable-value arm is a deliberate
  // fail-closed guard), so both are exercised, told apart by name and by an
  // assertion that discriminates between them.
  const AN_HOUR_MS = 60 * 60 * 1000
  const pendingApproval = (requestId: string, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1 as const,
    requestId,
    toolName: 'Bash',
    description: 'run something',
    // An hour old against a 60-second lifetime: expired BY TTL, on a usable value.
    requestedAt: Date.now() - AN_HOUR_MS,
    approvalTtlSeconds: 60,
    ...overrides,
  })

  /** Expiry retires the card instead of re-presenting it; a reprojection re-presents it. */
  const wasExpiredNotRepresented = (sent: SessionEvent[]) => {
    const types = sent.map(event => event.type)
    return { expired: types.includes('complete'), represented: types.includes('permission_request') }
  }

  it('an approval that aged out of its TTL (reprojectPendingApproval → expireDurableApproval)', async () => {
    // Driven through the GATE, not by calling the expiry helper directly: the
    // row is about what happens to a session reopened after a restart with a
    // stale card on it, and `isDurableApprovalExpired` is the thing that decides.
    const { managed, sent, internals } = setUp('p316-expire-ttl')
    stubAgent(managed)
    ;(managed as unknown as { pendingApproval: unknown }).pendingApproval = pendingApproval('req-ttl')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    internals.reprojectPendingApproval(managed)
    await pastTheBatchTimer()

    expect(wasExpiredNotRepresented(sent)).toEqual({ expired: true, represented: false })
    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
  })

  it('an approval whose age cannot be established at all (the unusable-value arm)', async () => {
    // The other arm, kept because it is a real guard and not a migration shim.
    // The fixture discriminates: `requestedAt` is NOW and the lifetime is an
    // hour, so a usable value would read FRESH and this card would be
    // re-presented. It expires anyway — which is only possible via the
    // `typeof !== 'number'` arm.
    const { managed, sent, internals } = setUp('p316-expire-unusable')
    stubAgent(managed)
    ;(managed as unknown as { pendingApproval: unknown }).pendingApproval = pendingApproval('req-unusable', {
      requestedAt: new Date().toISOString(),
      approvalTtlSeconds: 3600,
    })
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    internals.reprojectPendingApproval(managed)
    await pastTheBatchTimer()

    expect(wasExpiredNotRepresented(sent)).toEqual({ expired: true, represented: false })
    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
  })

  it('a durable approval denied after a restart (settleDurableApproval)', async () => {
    // A FRESH record — an hour of lifetime, requested now — so this row exercises
    // the ordinary denial, not an expiry wearing a denial's name.
    const { managed, sent, internals } = setUp('p316-settle')
    stubAgent(managed)
    ;(managed as unknown as { pendingApproval: unknown }).pendingApproval = pendingApproval('req-denied', {
      requestedAt: Date.now(),
      approvalTtlSeconds: 3600,
    })
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    expect(internals.settleDurableApproval(managed, 'req-denied', false)).toBe(true)
    await pastTheBatchTimer()

    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
  })

  it('an ALLOW on a record that aged out is downgraded to a denial, and still flushes', async () => {
    // The second `isDurableApprovalExpired` call site, and the one the TTL arm
    // exists for: a card re-fired while fresh can sit on screen until the
    // request itself is stale, so the allow is checked again on the way in.
    const { managed, sent, internals } = setUp('p316-settle-expired-allow')
    stubAgent(managed)
    ;(managed as unknown as { pendingApproval: unknown }).pendingApproval = pendingApproval('req-late-allow')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    expect(internals.settleDurableApproval(managed, 'req-late-allow', true)).toBe(true)
    await pastTheBatchTimer()

    // It went through the EXPIRY path, not the allow path: the user is told, and
    // nothing was stored as a remembered approval.
    expect(sent.some(event => event.type === 'info'
      && /expired before it was answered/.test((event as { message?: string }).message ?? ''))).toBe(true)
    expectDeltaBeforeTurnEnd(sent, 'complete', 'Hello world')
  })
})

describe('P3.16 · the standing invariant, attacked', () => {
  /**
   * `findLateDeltas` is asserted on every row above, so it had better be worth
   * something. This block attacks it with the eight ways of writing a terminal
   * emit that review measured the deleted source-text guard against — that guard
   * caught ONE of the eight (re-measured here before deleting it: only an object
   * literal whose FIRST key is a single-quoted `type: 'complete'`, optionally
   * behind `//` comments).
   *
   * Six of the eight are the same runtime call — an object is an object, and
   * key order, comments and quote style leave no trace in it — and the last two
   * are the ones that mattered: an aliased/bound `sendEvent`, and a direct
   * `this.eventSink(...)` that never reaches `sendEvent` at all (a shape that
   * already exists in this class, at nine other call sites). Every one of them
   * still has to put its event on the wire, which is where this invariant reads.
   *
   * Each case builds a real terminal emit that SKIPS `sendTurnEndEvent` — i.e.
   * a future tenth site, written that way, that forgot the flush — with a delta
   * still in the batcher. All eight must be flagged.
   */
  const terminal = (sessionId: string) => ({ type: 'complete' as const, sessionId })

  type Emitters = {
    sendEvent(event: SessionEvent, workspaceId?: string): void
    eventSink(channel: string, target: unknown, event: SessionEvent): void
  }

  const shapes: Array<[name: string, emit: (m: Emitters, sessionId: string) => void]> = [
    // 1-4, 6: `sendEvent` with an object literal. The written differences —
    // key order, a block comment, double quotes, a spread — are erased by the
    // parser, which is exactly why a source-text guard was the wrong instrument.
    ['object literal, `type` first', (m, s) => m.sendEvent({ ...terminal(s) }, 'ws_test')],
    ['object literal, `sessionId` first', (m, s) => m.sendEvent({ sessionId: s, type: 'complete' }, 'ws_test')],
    ['block comment above `type`', (m, s) => m.sendEvent({ /* the turn is over */ type: 'complete', sessionId: s }, 'ws_test')],
    ['double-quoted "complete"', (m, s) => m.sendEvent({ type: 'complete', sessionId: s }, 'ws_test')],
    ['spread payload', (m, s) => {
      const base = { sessionId: s }
      m.sendEvent({ ...base, type: 'complete' }, 'ws_test')
    }],
    // 5: built into a variable first — no object literal at the call site at all.
    ['event built into a variable', (m, s) => {
      const done: SessionEvent = terminal(s)
      m.sendEvent(done, 'ws_test')
    }],
    // 7: the send itself is aliased, so the receiver name is gone too.
    ['aliased / bound send', (m, s) => {
      const send = m.sendEvent.bind(m)
      send(terminal(s), 'ws_test')
    }],
    // 8: straight to the sink — `sendEvent` is not involved in any form.
    ['direct this.eventSink(...)', (m, s) => {
      m.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: 'ws_test' }, terminal(s))
    }],
  ]

  for (const [name, emit] of shapes) {
    it(`flags a tenth site written as: ${name}`, async () => {
      const sessionId = `p316-shape-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      // Opted out of the standing sweep: this row's whole job is to PRODUCE the
      // violation the sweep exists to catch.
      const { manager, managed, sent, internals } = setUp(sessionId, { sweep: false })
      stubAgent(managed)
      // One delta delivered by its own timer, a SECOND still batched when the
      // turn ends — the real bug's shape, and the shape that arms the sweep:
      // the ended turn has to have put something on the wire for its turnId to
      // be known (gap 2 in the docblock).
      await internals.processEvent(managed, { type: 'text_delta', text: 'Hello ', turnId: 'X' })
      await pastTheBatchTimer()
      await internals.processEvent(managed, { type: 'text_delta', text: 'world', turnId: 'X' })

      emit(manager as unknown as Emitters, sessionId)
      await pastTheBatchTimer()

      // The batcher's own timer delivered the rest after the turn ended…
      expect(sent.map(event => event.type)).toEqual(['text_delta', 'complete', 'text_delta'])
      // …and the invariant sees it, however the emit was spelled.
      expect(findLateDeltas(sent))
        .toEqual([{ sessionId, after: 'complete', turnId: 'X', delta: 'world' }])
    })
  }

  it('and stays quiet on a correctly flushed turn (no false positive)', async () => {
    // The other half of the control: an instrument that flags everything is as
    // useless as one that flags nothing. Same session, same delta, same terminal
    // event — routed through the real `sendTurnEndEvent` this time.
    const { managed, sent, internals } = setUp('p316-shape-clean')
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'Hello world', turnId: 'X' })

    await internals.onProcessingStopped('p316-shape-clean', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(sent.map(event => event.type)).toEqual(['text_delta', 'complete'])
    expect(findLateDeltas(sent)).toEqual([])
  })

  it('and stays quiet across TWO turns — the false positive the turn check exists for', async () => {
    // A session that answers, completes, and then answers again is ordinary, and
    // the turn-blind version of this sweep called it a violation. This row pins
    // the discrimination so the sharpening cannot be lost again.
    const { managed, sent, internals } = setUp('p316-two-turns')
    stubAgent(managed)
    await internals.processEvent(managed, { type: 'text_delta', text: 'first answer', turnId: 'X' })
    await internals.onProcessingStopped('p316-two-turns', 'complete', 'ws_test')
    await pastTheBatchTimer()

    // Turn 2, on the same session, with its own turnId.
    ;(managed as { isProcessing: boolean }).isProcessing = true
    await internals.processEvent(managed, { type: 'text_delta', text: 'second answer', turnId: 'Y' })
    await internals.onProcessingStopped('p316-two-turns', 'complete', 'ws_test')
    await pastTheBatchTimer()

    expect(sent.map(event => event.type))
      .toEqual(['text_delta', 'complete', 'text_delta', 'complete'])
    expect(findLateDeltas(sent)).toEqual([])

    // NOT VACUOUS: the turn-blind rule this replaced — "any delta after any
    // terminal event" — flags turn 2's delta on this very wire. If that stops
    // being true, this row has stopped testing the thing it is named for.
    const turnBlind = (wire: SessionEvent[]) => {
      const endedSessions = new Set<string>()
      return wire.filter(event => {
        const sessionId = (event as { sessionId?: string }).sessionId
        if (!sessionId) return false
        if (event.type === 'complete' || event.type === 'interrupted') {
          endedSessions.add(sessionId)
          return false
        }
        return event.type === 'text_delta' && endedSessions.has(sessionId)
      })
    }
    expect(turnBlind(sent).map(event => (event as { delta?: unknown }).delta))
      .toEqual(['second answer'])
  })
})
