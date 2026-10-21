/**
 * F1.235 (origin upstream-refresh D04, 2026-09-23) — a Pi turn stays open
 * across the SDK's own auto-retry, so the retried answer reaches the turn.
 *
 * ## The defect, read from the vendored SDK and measured on the host
 *
 * `@earendil-works/pi-coding-agent` 0.84.4 (`dist/core/agent-session.js`)
 * stamps `willRetry` on `agent_end` (`_willRetryAfterAgentEnd`) while the
 * failed attempt is still inside `agent.prompt()`; only afterwards does
 * `_handlePostAgentRun` → `_prepareRetry` emit `auto_retry_start`, sleep the
 * backoff (the gateway ladder, `GATEWAY_RETRY_SETTINGS` 15 s × 2^n, five
 * attempts) and call `agent.continue()`, whose run is a fresh
 * `agent_start … agent_end`. So the wire order on a retried 429 is
 * `message_end(error)` → `agent_end{willRetry:true}` → `auto_retry_start` →
 * `agent_start` → … → `message_end(ok)` → `auto_retry_end{success:true}` →
 * `agent_end{willRetry:false}`.
 *
 * At the parent commit `PiEventAdapter`'s `agent_end` arm never read `willRetry`,
 * `shouldCompleteQueue` answered true on the FIRST `agent_end`, and
 * `PiAgent.handleSubprocessEvent` latched `rawEventAttemptTerminal` — so the
 * retried answer, the retry status line and its resolution were all dropped at
 * the latch (the answer survived only in the Pi JSONL), and the first attempt's
 * retryable provider error had already been shown as a turn error from the
 * `message_end` arm.
 *
 * ## What these arms drive
 *
 * The REAL host path: JSONL lines in the exact `{type:'event', event}` envelope
 * `pi-agent-server`'s `handleSessionEvent` writes (it forwards `agent_end`,
 * `auto_retry_*` and `willRetry` unchanged), into `PiAgent.handleLine` →
 * `handleSubprocessEvent` → `PiEventAdapter` → the turn's event queue, whose
 * `enqueue`/`complete` calls are recorded. Nothing below the queue is stubbed.
 *
 * ## How the two retries compose (pinned below)
 *
 * The SDK ladder retries the SAME model inside the subprocess. The host has one
 * retry of its own: `PiAgent.chatImpl` walks the fallback-model chain when a
 * `typed_error` with a `FALLBACK_MODEL_RETRY_ERROR_CODES` code reaches it
 * (`service_error`, `service_unavailable`, `provider_error`, …). Before the fix
 * a retryable 5xx reached the host as a `typed_error` on the FIRST failed
 * attempt, so the host could start a fallback-model turn while the SDK was
 * still backing off to retry the old one. Now the error is PARKED while the SDK
 * will retry and released only when it will not — the SDK ladder runs first,
 * and the host's fallback chain starts only after it is exhausted.
 */
import { describe, expect, it, jest } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1235',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-f1235',
      workspaceRootPath: '/tmp/nessy-f1235',
      sessionRootPath: '/tmp/nessy-f1235-sessions/ws-f1235',
    } as any,
    session: {
      id: 'session-f1235',
      workspaceRootPath: '/tmp/nessy-f1235',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

type Recorded = { kind: 'event'; event: any } | { kind: 'complete' }

/** A PiAgent whose turn queue records what it is handed, fed through `handleLine`. */
function rig() {
  const agent = new PiAgent(createConfig())
  const runtime = agent as any
  const log: Recorded[] = []
  runtime.eventQueue.enqueue = (event: any) => { log.push({ kind: 'event', event }) }
  runtime.eventQueue.complete = () => { log.push({ kind: 'complete' }) }
  runtime.adapter.startTurn()
  runtime.rawEventAttemptTerminal = false
  const feed = (...events: Array<Record<string, unknown>>) => {
    for (const event of events) runtime.handleLine(JSON.stringify({ type: 'event', event }))
  }
  const events = () => log.flatMap(entry => (entry.kind === 'event' ? [entry.event] : []))
  const completions = () => log.filter(entry => entry.kind === 'complete').length
  return { agent, runtime, log, feed, events, completions }
}

const RATE_LIMIT = '429 Too Many Requests: rate limit exceeded for tgpt/deepseek'
const SERVICE_DOWN = '503 Service Unavailable'
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } }

const delta = (text: string) => ({
  type: 'message_update',
  message: { role: 'assistant' },
  assistantMessageEvent: { type: 'text_delta', delta: text },
})
const failed = (errorMessage: string, id: string) => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason: 'error', errorMessage, content: [], id },
})
const answered = (text: string, id: string) => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: USAGE, id },
})
const agentEnd = (willRetry: boolean) => ({ type: 'agent_end', messages: [], willRetry })
/** One SDK turn inside a run — `turn_start … turn_end` wraps every attempt, as the agent loop emits it. */
const turn = (...inner: Array<Record<string, unknown>>) => [{ type: 'turn_start' }, ...inner, { type: 'turn_end' }]

describe('F1.235 · a Pi turn survives the SDK auto-retry', () => {
  it('agent_end{willRetry:true} → auto_retry_start → retried answer ends in ONE completion carrying the answer', () => {
    const { agent, log, feed, events, completions } = rig()
    feed(
      { type: 'agent_start' },
      ...turn(delta('Partial ans'), failed(RATE_LIMIT, 'sdk-m1')),
      agentEnd(true),
    )
    // Nothing is terminal yet: no completion, and the retryable error is not a turn error.
    expect(completions()).toBe(0)
    expect(events().filter(event => event.type === 'typed_error' || event.type === 'error')).toEqual([])

    feed(
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 15_000, errorMessage: RATE_LIMIT },
      { type: 'agent_start' },
      // `_handleAgentEvent` emits `auto_retry_end{success}` right after the first
      // successful assistant `message_end`, inside the retried turn.
      ...turn(delta('Full answer'), answered('Full answer', 'sdk-m2'), { type: 'auto_retry_end', success: true, attempt: 1 }),
      agentEnd(false),
    )

    expect(completions()).toBe(1)
    expect(log.at(-1)).toEqual({ kind: 'complete' })
    const texts = events().filter(event => event.type === 'text_complete')
    expect(texts.map(event => event.text)).toEqual(['Full answer'])
    // The retry is visible: the scheduled line, then its resolution.
    const retries = events().filter(event => event.type === 'status' && event.retry).map(event => event.retry.kind)
    expect(retries).toEqual(['rate_limit', 'succeeded'])
    // Still no turn error anywhere.
    expect(events().filter(event => event.type === 'typed_error' || event.type === 'error')).toEqual([])
    // The retried answer lands on the SAME message the failed partial streamed
    // into, so `text_complete` (which REPLACES a message's content in the
    // renderer and is what the host persists) supersedes the partial.
    const partialTurnId = events().find(event => event.type === 'text_delta' && event.text === 'Partial ans')?.turnId
    expect(partialTurnId).toBeDefined()
    expect(texts[0].turnId).toBe(partialTurnId)
    agent.destroy()
  })

  it('CONTROL: a non-retry agent_end still completes at once, after the error it carries', () => {
    const { agent, log, feed, events, completions } = rig()
    feed({ type: 'agent_start' }, ...turn(failed('401 Unauthorized: invalid api key', 'sdk-m1')), agentEnd(false))
    expect(completions()).toBe(1)
    expect(log.at(-1)).toEqual({ kind: 'complete' })
    const errors = events().filter(event => event.type === 'typed_error' || event.type === 'error')
    expect(errors).toHaveLength(1)
    agent.destroy()
  })

  it('CONTROL: a clean turn with no error completes on its agent_end exactly as before', () => {
    const { agent, log, feed, events, completions } = rig()
    feed({ type: 'agent_start' }, ...turn(delta('Hi'), answered('Hi', 'sdk-m1')), agentEnd(false))
    expect(completions()).toBe(1)
    expect(log.at(-1)).toEqual({ kind: 'complete' })
    expect(events().filter(event => event.type === 'text_complete').map(event => event.text)).toEqual(['Hi'])
    agent.destroy()
  })

  it('a retryable error the SDK will NOT retry (disabled or exhausted) is released once, at agent_end, then the turn completes', () => {
    const { agent, log, feed, events, completions } = rig()
    feed(
      { type: 'agent_start' },
      ...turn(failed(RATE_LIMIT, 'sdk-m1')),
      agentEnd(false),
      // The SDK's trailing account of the same failure lands past the latch.
      { type: 'auto_retry_end', success: false, attempt: 5, finalError: RATE_LIMIT },
    )
    expect(completions()).toBe(1)
    const errors = events().filter(event => event.type === 'typed_error' || event.type === 'error')
    expect(errors).toHaveLength(1)
    const order = log.map(entry => (entry.kind === 'complete' ? 'complete' : entry.event.type))
    expect(order.indexOf('complete')).toBeGreaterThan(order.findIndex(type => type === 'typed_error' || type === 'error'))
    agent.destroy()
  })

  it('a retry cancelled during the backoff releases the parked error and completes the turn', () => {
    const { agent, feed, events, completions } = rig()
    feed(
      { type: 'agent_start' },
      ...turn(failed(RATE_LIMIT, 'sdk-m1')),
      agentEnd(true),
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 15_000, errorMessage: RATE_LIMIT },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Retry cancelled' },
    )
    expect(completions()).toBe(1)
    expect(events().filter(event => event.type === 'typed_error' || event.type === 'error')).toHaveLength(1)
    agent.destroy()
  })

  it('COMPOSITION: a retryable 5xx reaches the host fallback chain only after the SDK ladder gives up', () => {
    const { agent, feed, events, completions } = rig()
    // Attempt 1 fails and the SDK will retry: the host sees no typed error, so
    // `chatImpl` cannot start a fallback-model turn beside the SDK's retry.
    feed({ type: 'agent_start' }, ...turn(failed(SERVICE_DOWN, 'sdk-m1')), agentEnd(true))
    expect(events().filter(event => event.type === 'typed_error')).toEqual([])
    // The last attempt fails and the SDK will not retry: ONE typed error, with
    // the code the fallback chain keys on, then the completion.
    feed(
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 15_000, errorMessage: SERVICE_DOWN },
      { type: 'agent_start' },
      ...turn(failed(SERVICE_DOWN, 'sdk-m2')),
      agentEnd(false),
    )
    const typed = events().filter(event => event.type === 'typed_error')
    expect(typed).toHaveLength(1)
    expect(['service_error', 'service_unavailable', 'provider_error']).toContain(typed[0].error.code)
    expect(completions()).toBe(1)
    agent.destroy()
  })

  it('FALLBACK: agent_end{willRetry:true} with no auto_retry_start releases the parked error after 5 s, through the host wiring', () => {
    jest.useFakeTimers()
    try {
      const { agent, feed, events, completions } = rig()
      feed({ type: 'agent_start' }, ...turn(failed(RATE_LIMIT, 'sdk-m1')), agentEnd(true))
      expect(completions()).toBe(0)
      // The adapter's timer fires outside `adaptEvent`, into the handlers
      // `PiAgent` wires to its own queue (`setOverflowFallbackHandlers`).
      jest.advanceTimersByTime(5_000)
      expect(completions()).toBe(1)
      expect(events().filter(event => event.type === 'typed_error' || event.type === 'error')).toHaveLength(1)
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('a turn started after an abort while awaiting the retry is not held by the old retry, and gets no stale error', () => {
    jest.useFakeTimers()
    try {
      const { agent, runtime, feed, events, completions } = rig()
      feed({ type: 'agent_start' }, ...turn(failed(RATE_LIMIT, 'sdk-m1')), agentEnd(true))
      // The user stops here (the host latches the old turn), then sends again:
      // `chatImpl` re-opens the latch and starts a turn on the same adapter.
      runtime.rawEventAttemptTerminal = false
      runtime.adapter.startTurn()
      feed({ type: 'agent_start' }, ...turn(delta('Hi'), answered('Hi', 'sdk-m2')), agentEnd(false))
      expect(completions()).toBe(1)
      jest.advanceTimersByTime(60_000)
      expect(completions()).toBe(1)
      expect(events().filter(event => event.type === 'typed_error' || event.type === 'error')).toEqual([])
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })
})

/**
 * F1.235 residue (found by WJ-pp while gating F1.297, 2026-09-23) — the overflow
 * machine owns an `agent_end` while it is holding the turn.
 *
 * `pi-auto-compaction-thrashing.test.ts` "resets after one immediate refill
 * followed by a settled retry" went red at d7bb7b586 (queueCompletions 0): its
 * scripted overflow `agent_end` carries `willRetry: true`, F1.235 ran its retry
 * step BEFORE the overflow block, parked the turn in `awaitingRetry` for an
 * `auto_retry_start` that never came, and the final `agent_end` was then held
 * as "unexpected" forever. pi-coding-agent itself never retries an overflow
 * (`_isRetryableError` excludes `isContextOverflow`), and craft-agents-oss
 * v0.13.4 runs the overflow machine FIRST in the same arm (Apache-2.0) — so the
 * flag is not the SDK's to spend there.
 */
describe('F1.235 residue · overflow recovery outranks a willRetry on the overflowed agent_end', () => {
  const overflow = (id: string) => ({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'context_length_exceeded', content: [], id },
  })
  const compacted = [
    { type: 'compaction_start', reason: 'overflow' },
    {
      type: 'compaction_end',
      reason: 'overflow',
      result: { summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 1_000, estimatedTokensAfter: 100 },
      aborted: false,
      willRetry: true,
    },
  ]

  for (const willRetry of [true, false]) {
    it(`overflow → compaction → recovered answer completes ONCE (overflowed agent_end willRetry:${willRetry})`, () => {
      const { agent, runtime, feed, events, completions } = rig()
      runtime.adapter.setContextWindow(1_000)
      feed({ type: 'agent_start' }, ...turn(overflow('sdk-m1')), agentEnd(willRetry))
      expect(completions()).toBe(0)
      feed(...compacted, { type: 'agent_start' }, ...turn(answered('settled', 'sdk-m2')), agentEnd(false))
      expect(completions()).toBe(1)
      expect(events().filter(event => event.type === 'text_complete').map(event => event.text)).toEqual(['settled'])
      expect(events().filter(event => event.type === 'typed_error' || event.type === 'error')).toEqual([])
      agent.destroy()
    })
  }
})
