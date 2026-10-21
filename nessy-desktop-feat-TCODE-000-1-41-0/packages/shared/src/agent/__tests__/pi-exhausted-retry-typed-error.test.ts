/**
 * F1.350 — when Pi's auto-retry gives up, the error the user gets is ONE typed
 * error with a Retry, not the raw transport string.
 *
 * F1.235 parks a failed attempt's error while the SDK retries and releases it
 * once the ladder is exhausted. What it releases was built at `message_end` by
 * `parseError`, which knew neither `529` nor `overloaded` and matches nothing in
 * `terminated` / `socket hang up` / `stream ended` — so the released error was
 * a raw `{ type: 'error', message: 'terminated' }`, the one shape that carries
 * no recovery action. pi-ai's own classifier (`isRetryableAssistantError`,
 * `dist/utils/retry.js`) already calls every one of them transient: the SDK
 * retried them. Ported from craft-agents-oss v0.13.3/0.13.4 (Apache-2.0):
 * `createAgentError` + `classifyAssistantError` with
 * `RETRYABLE_PROVIDER_SIDE_PATTERN` (a provider-side incident → `service_error`,
 * a transport failure → `network_error`), and `529` / `overloaded` in
 * `parseError`'s service branch.
 *
 * Driven through the REAL host path — JSONL through `PiAgent.handleLine` into
 * the turn's queue — with the exhausted ladder's wire order read from the
 * vendored pi-coding-agent 0.84.4 (`dist/core/agent-session.js`): the last
 * attempt's `message_end(error)` → `agent_end{willRetry:false}` → the post-run
 * `auto_retry_end{success:false}`.
 */
import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { parseError } from '../errors.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1350',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-f1350',
      workspaceRootPath: '/tmp/nessy-f1350',
      sessionRootPath: '/tmp/nessy-f1350-sessions/ws-f1350',
    } as any,
    session: {
      id: 'session-f1350',
      workspaceRootPath: '/tmp/nessy-f1350',
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
  const errors = () => log.flatMap(entry => (
    entry.kind === 'event' && (entry.event.type === 'typed_error' || entry.event.type === 'error') ? [entry.event] : []
  ))
  const completions = () => log.filter(entry => entry.kind === 'complete').length
  return { agent, feed, errors, completions }
}

const failed = (errorMessage: string, id: string) => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason: 'error', errorMessage, content: [], id },
})
const turn = (...inner: Array<Record<string, unknown>>) => [{ type: 'turn_start' }, ...inner, { type: 'turn_end' }]

/** One retry, then the ladder is exhausted on the same error — the SDK's own order. */
function exhaust(errorMessage: string) {
  const { agent, feed, errors, completions } = rig()
  feed(
    { type: 'agent_start' },
    ...turn(failed(errorMessage, 'm1')),
    { type: 'agent_end', messages: [], willRetry: true },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 10, errorMessage },
    { type: 'agent_start' },
    ...turn(failed(errorMessage, 'm2')),
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'auto_retry_end', success: false, attempt: 1, finalError: errorMessage },
  )
  const result = { errors: errors(), completions: completions() }
  agent.destroy()
  return result
}

const hasRetryAction = (event: any) => (event.error?.actions ?? []).some((action: any) => action.action === 'retry')

describe('F1.350 — an exhausted Pi retry releases one TYPED error with Retry', () => {
  it('a transport failure pi-ai retried ("terminated") ends as one network_error with Retry', () => {
    const { errors, completions } = exhaust('terminated')
    expect(completions).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.type).toBe('typed_error')
    expect(errors[0]?.error?.code).toBe('network_error')
    expect(errors[0]?.error?.originalError).toBe('terminated')
    expect(hasRetryAction(errors[0])).toBe(true)
  })

  it('a provider-side incident pi-ai retried ("Provider returned error") ends as one service_error', () => {
    const { errors } = exhaust('Provider returned error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error?.code).toBe('service_error')
    expect(hasRetryAction(errors[0])).toBe(true)
  })

  it('529 and "overloaded" are parseError service errors on every path, not only the thrown one', () => {
    expect(parseError(new Error('529 {"type":"error","error":{"type":"overloaded_error"}}')).code).toBe('service_error')
    expect(parseError(new Error('Overloaded')).code).toBe('service_error')
    const { errors } = exhaust('overloaded')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error?.code).toBe('service_error')
  })

  it('CONTROL — an unknown error pi-ai does NOT retry stays a raw error, shown at once', () => {
    const { agent, feed, errors, completions } = rig()
    feed(
      { type: 'agent_start' },
      ...turn(failed('the model produced something odd', 'm1')),
      { type: 'agent_end', messages: [], willRetry: false },
    )
    expect(errors()).toEqual([{ type: 'error', message: 'the model produced something odd' }])
    expect(completions()).toBe(1)
    agent.destroy()
  })

  it('CONTROL — an error parseError already types keeps its own code (a 429 stays rate_limited)', () => {
    const { errors } = exhaust('429 Too Many Requests')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error?.code).toBe('rate_limited')
  })
})
