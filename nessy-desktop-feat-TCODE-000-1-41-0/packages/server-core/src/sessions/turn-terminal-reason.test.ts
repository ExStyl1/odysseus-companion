import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TERMINAL_REASON_MARKER, messageToStored, parseTerminalReasonMarker, storedToMessage, type AgentEvent, type PersistedMessage } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

// SessionManager's `case 'complete':` accumulates usage and drops everything
// else, and the `complete` the renderer actually sees is rebuilt in
// onProcessingStopped (reached from sendMessage's completion path). So without
// the wiring under test, a terminal reason produced by a backend adapter never
// leaves the main process.

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function usageFixture() {
  return { inputTokens: 12, outputTokens: 3, costUsd: 0 }
}

/**
 * P3.18 · await the REAL turn-end signal — the `complete` reaching the sink —
 * rather than assuming a fixed microtask/`setImmediate` count carries it there
 * before we read `events` and tear the manager down. The renderer-facing
 * `complete` is emitted fire-and-forget from `onProcessingStopped` (the two
 * 'complete' sites in SessionManager.ts) several awaits deep, inside
 * `sendTurnEndEvent` → `sendEvent`. Polling the actual array — yielding
 * macrotasks — means any `await` a future change inserts before that emit only
 * DELAYS the signal, never loses it here: the wait absorbs the delay. It throws
 * loudly, naming the cause, only when the `complete` is genuinely never sent,
 * which is the real regression worth catching.
 */
async function awaitComplete(events: ReadonlyArray<{ type: string }>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!events.some(event => event.type === 'complete')) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `awaitComplete: no 'complete' reached the event sink within ${timeoutMs}ms — `
        + 'an await inserted before this.sendEvent in SessionManager.sendTurnEndEvent '
        + 'likely lost the turn-end event (P3.18).',
      )
    }
    await new Promise(resolve => setTimeout(resolve))
  }
}

async function runTurnEmitting(backendEvents: AgentEvent[]): Promise<SessionEvent[]> {
  const { events } = await runTurn(backendEvents)
  return events
}

async function runTurn(
  backendEvents: AgentEvent[],
  sendOptions?: import('@nessy-agent/shared/protocol').SendMessageOptions,
): Promise<{ events: SessionEvent[]; chatCalls: Array<unknown[]>; messages: PersistedMessage[] }> {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-terminal-reason-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-terminal-reason',
    name: 'Terminal Reason Workspace',
    slug: 'terminal-reason',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'session-terminal-reason' },
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
    snapshot: { leaseId: 'terminal-reason-lease' },
    runtime: { view: { sources: [] }, materializer: {} },
  })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  const chatCalls: Array<unknown[]> = []
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
    chat: async function* (...args: unknown[]) {
      chatCalls.push(args)
      for (const event of backendEvents) yield event
    },
  }
  internals.getOrCreateAgent = async () => {
    managed.agent = agent as never
    return agent
  }

  try {
    await manager.sendMessage(
      managed.id,
      'terminal reason probe',
      undefined,
      undefined,
      sendOptions,
      undefined,
      undefined,
      undefined,
      { workspaceId: workspace.id },
    )
    // Wait for the turn-end `complete` to actually land before tearing down, so
    // the assertions read a settled event stream rather than racing the
    // fire-and-forget emit (P3.18).
    await awaitComplete(events)
  } finally {
    manager.cleanup()
  }
  return { events, chatCalls, messages: managed.messages }
}

function lastComplete(events: SessionEvent[]) {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'complete' }> => event.type === 'complete')
    .at(-1)
}

describe('turn terminal reason', () => {
  it('forwards the backend terminal reason on the complete it sends to the renderer', async () => {
    const events = await runTurnEmitting([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    expect(lastComplete(events)?.terminalReason).toBe('max_budget_usd')
  })

  it('sends no reason for an ordinary completion', async () => {
    const events = await runTurnEmitting([{ type: 'complete', usage: usageFixture() }])
    const complete = lastComplete(events)
    expect(complete).toBeDefined()
    expect(complete?.terminalReason).toBeUndefined()
    expect('terminalReason' in complete!).toBe(false)
  })

  it('does not leak a reason from a previous turn into the next one', async () => {
    // The field lives on the managed session, so it must be cleared per turn.
    const events = await runTurnEmitting([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    expect(lastComplete(events)?.terminalReason).toBe('max_budget_usd')
    const clean = await runTurnEmitting([{ type: 'complete', usage: usageFixture() }])
    // The next turn has to HAVE a completion for "no reason leaked into it" to
    // be a statement about anything — `lastComplete` returning undefined
    // satisfies the absence below without the second turn ever completing.
    const cleanComplete = lastComplete(clean)
    expect(cleanComplete).toBeDefined()
    expect(cleanComplete?.terminalReason).toBeUndefined()
  })

  /**
   * P2.98 — the verdict SURVIVES a reload.
   *
   * P2.37 put the verdict on screen but composed it in the renderer's
   * `handleComplete`, so it lived only in that client's memory: a reload showed
   * a turn that simply stopped, and "why did it end" — the one thing a user
   * most wants after it ends — was gone. MEASURED before this row, on this rig:
   * a `max_budget_usd` turn left `managed.messages` with NO `terminal_reason:`
   * row at all, so nothing durable carried the verdict.
   */
  it('persists the verdict row in the transcript a reload reads', async () => {
    const { events, messages } = await runTurn([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    const verdicts = messages.filter(message => message.content.startsWith(TERMINAL_REASON_MARKER))
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.content).toBe('terminal_reason:max_budget_usd')
    expect(verdicts[0]!.role).toBe('info')
    // A cap is a warning; `terminalIsError` is the only thing that picks tone.
    expect(verdicts[0]!.infoLevel).toBe('warning')
    // The live row is still the renderer's, composed from the `complete` event
    // — so this write is SILENT. A `message_added` here would put two identical
    // verdict rows on screen for one ending.
    expect(events.some(event => event.type === 'message_added')).toBe(false)
    expect(lastComplete(events)?.terminalReason).toBe('max_budget_usd')
  })

  /**
   * The reload half, measured rather than assumed: the row the turn appended
   * has to survive the store's own round-trip, because that trip is what a
   * reload actually performs. `messageToStored` drops `isStreaming`/`isPending`
   * by name and spreads the rest, so both fields the row carries — the marker
   * CONTENT the renderer parses and the `infoLevel` that picks its tone — come
   * back; a mapper that started listing fields explicitly would silently drop
   * one and the transcript would render the verdict in the wrong tone, or not
   * at all.
   */
  it('round-trips the persisted verdict through the store shape a reload reads', async () => {
    const { messages } = await runTurn([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    const verdict = messages.find(message => message.content.startsWith(TERMINAL_REASON_MARKER))!
    expect(verdict).toBeDefined()

    const reloaded = storedToMessage(messageToStored(verdict))
    expect(reloaded.content).toBe('terminal_reason:max_budget_usd')
    expect(reloaded.role).toBe('info')
    expect(reloaded.infoLevel).toBe('warning')
    // And the renderer's own mapping still reads it out of that shape.
    expect(parseTerminalReasonMarker(reloaded.content)).toBe('max_budget_usd')
  })

  it('takes the persisted row’s tone from terminalIsError', async () => {
    const { messages } = await runTurn([
      { type: 'complete', usage: usageFixture(), terminalReason: 'provider_error', terminalIsError: true },
    ])
    const verdicts = messages.filter(message => message.content.startsWith(TERMINAL_REASON_MARKER))
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.content).toBe('terminal_reason:provider_error')
    expect(verdicts[0]!.infoLevel).toBe('error')
  })

  /**
   * The boundary, and it is the one that would have hurt: a server that
   * persisted EVERY terminal reason would write an invisible row on every
   * `user_stop` — i.e. every interrupt — and `groupMessagesByTurn` reads a
   * `terminal_reason:` row as NOT an interruption, so those turns would stop
   * grouping as interrupted. Membership is `hasTerminalReasonNotice`, shared
   * with the renderer's copy map.
   */
  it('writes no row for an ending that already owns a louder surface', async () => {
    const stopped = await runTurn([
      { type: 'complete', usage: usageFixture(), terminalReason: 'user_stop' },
    ])
    expect(stopped.messages.some(message => message.content.startsWith(TERMINAL_REASON_MARKER))).toBe(false)
    expect(lastComplete(stopped.events)?.terminalReason).toBe('user_stop')

    const ordinary = await runTurn([{ type: 'complete', usage: usageFixture() }])
    expect(ordinary.messages.some(message => message.content.startsWith(TERMINAL_REASON_MARKER))).toBe(false)
  })

  it('threads options.outputSchema from sendMessage onto the backend chat options (R18)', async () => {
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    const withSchema = await runTurn(
      [{ type: 'complete', usage: usageFixture() }],
      { outputSchema: schema },
    )
    expect(withSchema.chatCalls).toHaveLength(1)
    expect((withSchema.chatCalls[0]?.[2] as { outputSchema?: unknown } | undefined)?.outputSchema).toEqual(schema)

    // Absent schema: chat options stay exactly as today (undefined third arg).
    const without = await runTurn([{ type: 'complete', usage: usageFixture() }])
    expect(without.chatCalls).toHaveLength(1)
    expect(without.chatCalls[0]?.[2]).toBeUndefined()
  })

  it('forwards structured-output result fields on the renderer complete and never leaks them (R18)', async () => {
    const succeeded = await runTurnEmitting([
      {
        type: 'complete',
        usage: usageFixture(),
        structuredOutput: { ok: true },
        structuredOutputSubtype: 'success',
      } as never,
    ])
    const success = lastComplete(succeeded) as Record<string, unknown> | undefined
    expect(success?.structuredOutput).toEqual({ ok: true })
    expect(success?.structuredOutputSubtype).toBe('success')

    const exhaustedEvents = await runTurnEmitting([
      {
        type: 'complete',
        usage: usageFixture(),
        terminalReason: 'structured_output_retry_exhausted',
        structuredOutputSubtype: 'error_max_structured_output_retries',
        structuredOutputErrors: ['$ must have required property \'ok\''],
      } as never,
    ])
    const exhausted = lastComplete(exhaustedEvents) as Record<string, unknown> | undefined
    expect(exhausted?.terminalReason).toBe('structured_output_retry_exhausted')
    expect(exhausted?.structuredOutputSubtype).toBe('error_max_structured_output_retries')
    expect(exhausted?.structuredOutputErrors).toEqual(['$ must have required property \'ok\''])

    // An ordinary turn stays byte-identical and nothing leaks from prior turns.
    const clean = await runTurnEmitting([{ type: 'complete', usage: usageFixture() }])
    const cleanComplete = lastComplete(clean) as Record<string, unknown> | undefined
    expect(cleanComplete).toBeDefined()
    expect('structuredOutput' in cleanComplete!).toBe(false)
    expect('structuredOutputSubtype' in cleanComplete!).toBe(false)
    expect('structuredOutputErrors' in cleanComplete!).toBe(false)
  })

  it('forwards the deferred_tool_use payload and error flag on tool_deferred terminations (R7 Task 5)', async () => {
    const events = await runTurnEmitting([
      {
        type: 'complete',
        usage: usageFixture(),
        terminalReason: 'tool_deferred',
        deferredToolUse: { id: 'call-1', name: 'Bash', input: { command: 'echo hi' } },
      } as never,
    ])
    const complete = lastComplete(events) as Record<string, unknown> | undefined
    expect(complete?.terminalReason).toBe('tool_deferred')
    expect(complete?.deferredToolUse).toEqual({ id: 'call-1', name: 'Bash', input: { command: 'echo hi' } })

    const unavailable = await runTurnEmitting([
      {
        type: 'complete',
        usage: usageFixture(),
        terminalReason: 'tool_deferred_unavailable',
        terminalIsError: true,
        deferredToolUse: { id: 'call-1', name: 'Gone', input: {} },
      } as never,
    ])
    const unavailableComplete = lastComplete(unavailable) as Record<string, unknown> | undefined
    expect(unavailableComplete?.terminalReason).toBe('tool_deferred_unavailable')
    expect(unavailableComplete?.terminalIsError).toBe(true)

    // Neither leaks into a following ordinary turn.
    const clean = await runTurnEmitting([{ type: 'complete', usage: usageFixture() }])
    const cleanComplete = lastComplete(clean) as Record<string, unknown> | undefined
    expect(cleanComplete).toBeDefined()
    expect(cleanComplete?.deferredToolUse).toBeUndefined()
    expect(cleanComplete?.terminalIsError).toBeUndefined()
  })
})
