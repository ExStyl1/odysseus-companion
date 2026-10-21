/**
 * F1.298 / F1.299 / F1.300 — the rest of F1.235's retry machine, driven through
 * the REAL host path (JSONL → `PiAgent.handleLine` → `PiEventAdapter` → the
 * turn's queue), in the SDK's own wire order (vendored pi-coding-agent 0.84.4,
 * `dist/core/agent-session.js`).
 *
 * - F1.298 — a failed attempt's streamed PARTIAL is discarded before the retry.
 *   Both attempts mint the same sub-turn id (`turn_end` resets the counter), so
 *   without a discard the renderer's `handleTextDelta` APPENDED the retried
 *   answer to the partial ("Partial ansFull answer") until `text_complete`
 *   replaced it. Ported from craft-agents-oss v0.13.4 (`text_discard`: core
 *   event, SessionManager batch cancel, renderer removal; Apache-2.0), with its
 *   rule that EVERY failed partial goes — a failure that ends the turn too: the
 *   host keeps assistant text only on `text_complete`, so the transcript never
 *   held that partial and a reload already showed it gone. (The first draft of
 *   this file kept a terminal failure's partial; that was narrower than the port
 *   and left the last attempt of an exhausted ladder half-discarded.)
 * - F1.299 — after an exhausted ladder the SDK's post-run
 *   `auto_retry_end{success:false}` arrives AFTER the `agent_end{willRetry:false}`
 *   that already released the error and ended the turn; if the host has re-opened
 *   a turn by then (the fallback-model hop), it showed "Retry failed: <old
 *   error>" there. Upstream stays quiet on that trailer; so do we.
 * - F1.300 (DECIDED by the controller) — the retried run's replacement
 *   `turn_start` does not count toward `maxAgentTurns`: the cap bounds the
 *   agent's work, not the provider's failures. A genuine second model call in
 *   the retried run still counts.
 */
import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1298',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-f1298',
      workspaceRootPath: '/tmp/nessy-f1298',
      sessionRootPath: '/tmp/nessy-f1298-sessions/ws-f1298',
    } as any,
    session: {
      id: 'session-f1298',
      workspaceRootPath: '/tmp/nessy-f1298',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

type Recorded = { kind: 'event'; event: any } | { kind: 'complete' }

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

const RATE_LIMIT = '429 Too Many Requests'
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } }
const delta = (text: string) => ({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: text } })
const failed = (errorMessage: string, id: string) => ({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage, content: [], id } })
const answered = (text: string, id: string) => ({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: USAGE, id } })
const turn = (...inner: Array<Record<string, unknown>>) => [{ type: 'turn_start' }, ...inner, { type: 'turn_end' }]
const retryStart = { type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 10, errorMessage: RATE_LIMIT }

describe('F1.298 — a failed attempt\'s partial is discarded before the re-run', () => {
  it('retried: text_discard names the partial\'s own turnId, BEFORE the retry status, and the retried answer streams afresh', () => {
    const { agent, feed, events } = rig()
    feed({ type: 'agent_start' }, ...turn(delta('Partial ans'), failed(RATE_LIMIT, 'm1')), { type: 'agent_end', messages: [], willRetry: true })
    const partialTurnId = events().find(event => event.type === 'text_delta')?.turnId
    expect(partialTurnId).toBeDefined()
    feed(retryStart, { type: 'agent_start' }, ...turn(delta('Full '), delta('answer'), answered('Full answer', 'm2')), { type: 'agent_end', messages: [], willRetry: false })
    const order = events().map(event => event.type === 'status' && event.retry ? `retry:${event.retry.kind}` : event.type)
    const discardAt = order.indexOf('text_discard')
    expect(discardAt).toBeGreaterThan(-1)
    expect(events()[discardAt]).toEqual({ type: 'text_discard', turnId: partialTurnId })
    expect(discardAt).toBeLessThan(order.indexOf('retry:rate_limit'))
    expect(events().filter(event => event.type === 'text_discard')).toHaveLength(1)
    expect(events().filter(event => event.type === 'text_complete').map(event => event.text)).toEqual(['Full answer'])
    agent.destroy()
  })

  it('overflow recovery discards the partial too — the recovered run also streams into the same sub-turn id', () => {
    const { agent, runtime, feed, events } = rig()
    runtime.adapter.setContextWindow(1_000)
    const overflow = { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'context_length_exceeded', content: [], id: 'm1' } }
    feed({ type: 'agent_start' }, ...turn(delta('Half'), overflow))
    expect(events().filter(event => event.type === 'text_discard')).toHaveLength(1)
    agent.destroy()
  })

  it('CONTROL — a failed attempt that streamed nothing emits no discard', () => {
    const { agent, feed, events } = rig()
    feed({ type: 'agent_start' }, ...turn(failed(RATE_LIMIT, 'm1')), { type: 'agent_end', messages: [], willRetry: true })
    expect(events().filter(event => event.type === 'text_discard')).toEqual([])
    agent.destroy()
  })

  it('a failure that ENDS the turn (not retryable) drops its partial too — one discard, then one error', () => {
    const { agent, feed, events, completions } = rig()
    feed({ type: 'agent_start' }, ...turn(delta('Partial'), failed('the model produced something odd', 'm1')), { type: 'agent_end', messages: [], willRetry: false })
    const order = events().map(event => event.type)
    expect(order.filter(type => type === 'text_discard')).toHaveLength(1)
    expect(order.indexOf('text_discard')).toBeLessThan(order.indexOf('error'))
    expect(events().filter(event => event.type === 'error' || event.type === 'typed_error')).toHaveLength(1)
    expect(completions()).toBe(1)
    agent.destroy()
  })

  it('an UNFINISHED reasoning partial is dropped too; a completed one is history and stays', () => {
    const thinkingDelta = (text: string) => ({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_delta', delta: text } })
    const { agent, feed, events } = rig()
    feed({ type: 'agent_start' }, ...turn(thinkingDelta('Let me th'), failed(RATE_LIMIT, 'm1')), { type: 'agent_end', messages: [], willRetry: true })
    const thinkingTurnId = events().find(event => event.type === 'text_delta')?.turnId
    expect(events().filter(event => event.type === 'text_discard')).toEqual([{ type: 'text_discard', turnId: thinkingTurnId }])
    agent.destroy()

    const finished = rig()
    finished.feed(
      { type: 'agent_start' },
      ...turn(
        thinkingDelta('Reasoned.'),
        { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_end', content: 'Reasoned.' } },
        failed(RATE_LIMIT, 'm1'),
      ),
      { type: 'agent_end', messages: [], willRetry: true },
    )
    expect(finished.events().filter(event => event.type === 'text_complete' && event.isThinking).map(event => event.text)).toEqual(['Reasoned.'])
    expect(finished.events().filter(event => event.type === 'text_discard')).toEqual([])
    finished.agent.destroy()
  })
})

describe('F1.299 — the exhausted ladder\'s trailing auto_retry_end is not re-reported', () => {
  it('a turn the host re-opened after the ladder gave up does not receive "Retry failed: <old error>"', () => {
    const { agent, runtime, feed, events, completions } = rig()
    const SERVICE_DOWN = '503 Service Unavailable'
    feed({ type: 'agent_start' }, ...turn(failed(SERVICE_DOWN, 'm1')), { type: 'agent_end', messages: [], willRetry: false })
    expect(completions()).toBe(1)
    const firstTurnErrors = events().filter(event => event.type === 'error' || event.type === 'typed_error').length
    expect(firstTurnErrors).toBe(1)
    // The fallback-model hop re-opens a turn on the same agent BEFORE the SDK's post-run trailer lands.
    runtime.rawEventAttemptTerminal = false
    runtime.adapter.startTurn()
    feed({ type: 'auto_retry_end', success: false, attempt: 1, finalError: SERVICE_DOWN })
    expect(events().filter(event => event.type === 'error' || event.type === 'typed_error')).toHaveLength(firstTurnErrors)
    agent.destroy()
  })
})

describe('F1.300 — SDK retries do not count toward maxAgentTurns', () => {
  it('cap = 1: a one-call answer with one SDK retry arrives, and is not stopped as max_agent_turns', () => {
    const { agent, runtime, feed, events, completions } = rig()
    runtime.maxPiModelTurnsThisChat = 1
    runtime.piModelTurnsThisChat = 0
    feed(
      { type: 'agent_start' },
      ...turn(failed(RATE_LIMIT, 'm1')),
      { type: 'agent_end', messages: [], willRetry: true },
      retryStart,
      { type: 'agent_start' },
      ...turn(delta('Answer'), answered('Answer', 'm2'), { type: 'auto_retry_end', success: true, attempt: 1 }),
      { type: 'agent_end', messages: [], willRetry: false },
    )
    expect(events().filter(event => event.type === 'text_complete').map(event => event.text)).toEqual(['Answer'])
    expect(events().filter(event => event.type === 'complete').map(event => event.terminalReason)).not.toContain('max_agent_turns')
    expect(completions()).toBe(1)
    expect(runtime.piModelTurnsThisChat).toBe(1)
    agent.destroy()
  })

  it('CONTROL — a genuine second model call in the retried run still counts', () => {
    const { agent, runtime, feed, events } = rig()
    runtime.maxPiModelTurnsThisChat = 1
    runtime.piModelTurnsThisChat = 0
    const toolTurn = { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [], usage: USAGE, id: 'm2' } }
    feed(
      { type: 'agent_start' },
      ...turn(failed(RATE_LIMIT, 'm1')),
      { type: 'agent_end', messages: [], willRetry: true },
      retryStart,
      { type: 'agent_start' },
      ...turn(toolTurn),
      { type: 'turn_start' },
    )
    expect(events().filter(event => event.type === 'complete').map(event => event.terminalReason)).toContain('max_agent_turns')
    agent.destroy()
  })
})
