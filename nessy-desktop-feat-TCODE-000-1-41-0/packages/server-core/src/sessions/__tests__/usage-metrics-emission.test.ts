import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { FleetCounterEvent, UsageMetrics, UsageMetricsTurn } from '@nessy-agent/shared/telemetry/usage-metrics'
import type { HostTracer } from '@nessy-agent/shared/telemetry/host-tracer'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * B2 task 3, "declared ≠ enforced": a counter that exists and is never emitted is
 * this row's own failure mode. This pins the emission SITE — the `complete` arm of
 * `SessionManager.processEvent` — and that it is not provider-gated, unlike
 * `emitPiTelemetry`, which returns early for anything but Pi.
 */

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

interface RecordedSpan {
  op: 'begin' | 'end'
  key: string
  name?: string
  attributes?: Record<string, unknown>
}

function harness(id: string, provider: string, options: { tracing?: boolean } = {}) {
  const recorded: UsageMetricsTurn[] = []
  // P6.732 — the host turn span's two edges, collected at the SITE.
  const spans: RecordedSpan[] = []
  // P6.461 — the adoption counters ride the same sink; collected so this
  // harness cannot go quietly blind to them.
  const counted: FleetCounterEvent[] = []
  let shutdowns = 0
  const usageMetrics: UsageMetrics = {
    record: turn => { recorded.push(turn) },
    count: event => { counted.push(event) },
    flush: async () => undefined,
    shutdown: async () => { shutdowns += 1 },
  }
  const hostTracer: HostTracer = {
    startSpan: async (_options, callback) => callback({
      startSpan: async (_o, c) => c({} as never),
      addEvent: () => {}, setAttributes: () => {}, setStatus: () => {},
    }),
    currentTraceparent: () => undefined,
    beginTurnSpan: (key, spanOptions) => {
      spans.push({
        op: 'begin',
        key,
        name: spanOptions.name,
        ...(spanOptions.attributes ? { attributes: { ...spanOptions.attributes } } : {}),
      })
    },
    endTurnSpan: key => { spans.push({ op: 'end', key }) },
    // P6.882 — the re-arm path's bulk close. Recorded as an `end` with no key,
    // so a case that made this fire silently would be visible here.
    closeOpenTurnSpans: () => { spans.push({ op: 'end', key: '<all>' }) },
    flush: async () => undefined,
    shutdown: async () => undefined,
  }
  const manager = createTestSessionManager({
    usageMetrics,
    ...(options.tracing === false ? {} : { hostTracer }),
  })
  managers.push(manager)
  const managed = createManagedSession({ id, model: 'tgpt/qwen35-397b-a17b-fp8' }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/nessy-usage-metrics',
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const internals = manager as unknown as {
    processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
    resolveManagedProvider(managed: unknown): string
    sessions: Map<string, unknown>
    // P6.461 — the two adoption-counter producers.
    countSessionStart(managed: unknown): void
    setProcessing(managed: unknown, processing: boolean): void
    freshlyCreatedSessions: Set<string>
    // P6.461's third producer, and the pending record its discriminant is read
    // from.
    respondToPermission(
      sessionId: string,
      requestId: string,
      allowed: boolean,
      alwaysAllow: boolean,
      options?: unknown,
      workspaceId?: string,
    ): boolean
    pendingPermissionRequests: Map<string, Record<string, unknown>>
  }
  internals.sessions.set(`ws_test:${id}`, managed)
  internals.resolveManagedProvider = () => provider
  return { manager, managed, internals, recorded, counted, spans, shutdowns: () => shutdowns }
}

describe('usage metric emission', () => {
  it('emits on Pi, the shipped default, with the backend and model as attributes', async () => {
    const { managed, internals, recorded } = harness('usage-pi', 'pi')

    await internals.processEvent(managed, {
      type: 'complete',
      usage: {
        inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 300,
        cacheCreationTokens: 100, costUsd: 0.25, costReporting: 'reported',
      },
    })

    expect(recorded).toEqual([{
      backend: 'pi',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 100,
      costUsd: 0.25,
      costReporting: 'reported',
    }])
  })

  it('emits for a non-Pi backend too, marked cost-unsupported', async () => {
    const { managed, internals, recorded } = harness('usage-codex', 'codex')

    await internals.processEvent(managed, {
      type: 'complete',
      usage: { inputTokens: 900, outputTokens: 40, costReporting: 'unsupported' },
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.backend).toBe('codex')
    expect(recorded[0]?.costReporting).toBe('unsupported')
    expect(recorded[0]?.costUsd).toBeUndefined()
  })

  it('carries the per-model map through when the backend reported one', async () => {
    const { managed, internals, recorded } = harness('usage-claude', 'anthropic')

    await internals.processEvent(managed, {
      type: 'complete',
      usage: {
        inputTokens: 5_000, outputTokens: 300, costUsd: 0.42, costReporting: 'reported',
        modelUsage: {
          'claude-sonnet-4-6': {
            inputTokens: 4_000, outputTokens: 250, cacheReadTokens: 100,
            cacheCreationTokens: 20, webSearchRequests: 1, costUsd: 0.4,
            costReporting: 'reported',
          },
        },
      },
    })

    expect(Object.keys(recorded[0]?.modelUsage ?? {})).toEqual(['claude-sonnet-4-6'])
  })

  /**
   * P6.461 — the two adoption counters, at their producers.
   *
   * The fleet saw cost and tokens and none of the six documented adoption
   * metrics. These pin the two SITES, which is where the row's failure mode
   * lives: `getOrCreateAgentUnchecked` also runs after an idle-agent eviction
   * and after a runtime switch, and `setProcessing` runs on every turn.
   */
  it('counts a session start ONCE per session, and says how it started', () => {
    const { managed, internals, counted } = harness('usage-session-count', 'pi')

    internals.countSessionStart(managed)
    // The second call is the one that matters: an agent restarted by the
    // live-agent ceiling, or a runtime switch, must not read as a second
    // session in an adoption dashboard.
    internals.countSessionStart(managed)

    expect(counted).toEqual([{ metric: 'session.count', startType: 'resume' }])
  })

  it('says `fresh` for a session createSession made in this process', () => {
    const { managed, internals, counted } = harness('usage-session-fresh', 'pi')
    internals.freshlyCreatedSessions.add('ws_test:usage-session-fresh')

    internals.countSessionStart(managed)

    expect(counted).toEqual([{ metric: 'session.count', startType: 'fresh' }])
  })

  it('counts cli active time across the processing interval, and only a closed one', () => {
    const { managed, internals, counted } = harness('usage-active-time', 'pi')

    internals.setProcessing(managed, true)
    internals.setProcessing(managed, false)
    expect(counted).toHaveLength(1)
    const event = counted[0]!
    expect(event.metric).toBe('active_time.total')
    expect(event.metric === 'active_time.total' && event.type).toBe('cli')
    expect(event.metric === 'active_time.total' && event.seconds).toBeGreaterThanOrEqual(0)

    // NEGATIVE: a falling edge with no rising edge adds nothing. Without the
    // stamp being CONSUMED this would report the time since the process
    // started, on every stop of a session whose processing was reconstructed.
    internals.setProcessing(managed, false)
    expect(counted).toHaveLength(1)
  })

  /**
   * P6.732 — the HOST turn span, at the one boundary every runtime passes
   * through.
   *
   * Pinned at the SITE rather than in the tracer's own suite, because the row's
   * failure mode is a span source with no producer: `host-tracer.test.ts` proves
   * a span reaches the wire, and this proves `setProcessing` opens and closes
   * one. The negative is the control the row names by name — tracing off means
   * no span AND no minted `traceparent`.
   */
  it('opens a turn span on the rising edge and closes it on the falling one', () => {
    const { managed, internals, spans } = harness('trace-turn', 'codex-runtime')

    internals.setProcessing(managed, true)
    expect(spans.map(entry => entry.op)).toEqual(['begin'])
    const opened = spans[0]!
    expect(opened.key).toBe('ws_test:trace-turn')
    expect(opened.name).toBe('nessy.session.turn')
    // The runtime, and nothing that identifies the session or its content.
    expect(opened.attributes).toEqual({ 'nessy.runtime': 'codex-runtime' })

    internals.setProcessing(managed, false)
    expect(spans.map(entry => entry.op)).toEqual(['begin', 'end'])
    expect(spans[1]!.key).toBe('ws_test:trace-turn')
  })

  it('opens no span when tracing is off', () => {
    // NEGATIVE. A session manager built with no tracer must mint nothing — the
    // row's own control, and the reason `hostTracer` is optional rather than a
    // no-op object: an object would be a producer nobody can see is inert.
    const { managed, internals, spans } = harness('trace-off', 'pi', { tracing: false })

    internals.setProcessing(managed, true)
    internals.setProcessing(managed, false)

    expect(spans).toEqual([])
  })

  /**
   * P6.461's THIRD metric, at the site P6.880 forced it to: the moment a person
   * answers a permission card, not `runPreToolUseChecks` — which the row's own
   * native clause named and which has zero call sites in `codex-agent.ts`.
   *
   * Driven through the real `respondToPermission`, because the whole value of
   * moving the site is that all three runtimes reach THIS one.
   */
  function answerCard(
    id: string,
    request: Record<string, unknown>,
    answer: { allowed: boolean; alwaysAllow: boolean },
  ) {
    const { managed, internals, counted } = harness(id, 'codex-runtime')
    // A stub agent: `respondToPermission` requires one and hands it the answer
    // after every host-side record is written, which is all this drives.
    ;(managed as unknown as { agent: unknown }).agent = { respondToPermission: () => {} }
    internals.pendingPermissionRequests.set('req-1', {
      workspaceId: 'ws_test', sessionId: id, ...request,
    })
    expect(internals.respondToPermission(id, 'req-1', answer.allowed, answer.alwaysAllow, undefined, 'ws_test'))
      .toBe(true)
    return counted
  }

  it('counts a code-edit approval with the tool, the decision, the source and the language', () => {
    const counted = answerCard(
      'usage-edit-accept',
      { type: 'file_write', toolName: 'Edit', command: '/repo/src/index.ts' },
      { allowed: true, alwaysAllow: false },
    )
    expect(counted).toEqual([{
      metric: 'code_edit_tool.decision',
      toolName: 'Edit',
      decision: 'accept',
      // "the user chose 'Yes' … for a one-time approval" — the page's own words
      // for an approval that saves no rule.
      source: 'user_temporary',
      language: 'TypeScript',
    }])
  })

  it("reads Yes-and-don't-ask-again as the page's user_permanent, and No as user_reject", () => {
    expect(answerCard(
      'usage-edit-always',
      { type: 'file_write', toolName: 'Write', command: '/repo/notes.md' },
      { allowed: true, alwaysAllow: true },
    )).toEqual([{
      metric: 'code_edit_tool.decision',
      toolName: 'Write', decision: 'accept', source: 'user_permanent', language: 'Markdown',
    }])

    expect(answerCard(
      'usage-edit-reject',
      { type: 'file_write', toolName: 'Edit', command: '/repo/main.py' },
      { allowed: false, alwaysAllow: false },
    )).toEqual([{
      metric: 'code_edit_tool.decision',
      toolName: 'Edit', decision: 'reject', source: 'user_reject', language: 'Python',
    }])
  })

  it('counts nothing for a card that is not a code edit', () => {
    // THE NEGATIVE, and it is the one the page's sentence demands: the counter
    // is "Edit, Write, or NotebookEdit tool usage", so a Bash approval — the
    // most common card in this product — must not inflate it. Keyed on the
    // request TYPE rather than on a list of tool names, because the name varies
    // per runtime and the type does not.
    expect(answerCard(
      'usage-edit-bash',
      { type: 'bash', toolName: 'Bash', command: 'ls -la' },
      { allowed: true, alwaysAllow: false },
    )).toEqual([])
  })

  it('drains the exporter during cleanup', async () => {
    const { manager, shutdowns } = harness('usage-drain', 'pi')

    await manager.cleanup()

    expect(shutdowns()).toBe(1)
    managers.splice(managers.indexOf(manager), 1)
  })
})
