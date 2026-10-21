/**
 * F1.932 — a gateway `429 insufficient_quota` is not presented as a rate limit
 * that "will auto-retry shortly".
 *
 * SIT-ag (2026-09-25): the Pi turn got the gateway's quota refusal, the row read
 * "Rate Limited: Rate limit reached. Will auto-retry shortly.", and the runtime
 * log showed ONE request. The Pi SDK declined the retry on purpose: pi-ai's
 * `isRetryableAssistantError` checks its non-retryable limit list, which carries
 * `insufficient_quota`, before the retryable one. Only the host copy was wrong.
 *
 * The error text below is the shape pi-ai's `formatProviderError`
 * (`dist/utils/error-body.js`) builds for an OpenAI-SDK error whose body the
 * message does not carry: `<status>: <body>`. The body's fields are
 * OpenAI-style. The gateway's exact field set was not captured, so only
 * `insufficient_quota` and the Russian sentence come from the sitting note.
 *
 * Driven through the REAL host path, JSONL through `PiAgent.handleLine`, the
 * same rig as `pi-exhausted-retry-typed-error.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { isRetryableAssistantError } from '@earendil-works/pi-ai'
import { PiAgent } from '../pi-agent.ts'
import { isQuotaExhaustedText, parseError } from '../errors.ts'
import type { BackendConfig } from '../backend/types.ts'

const QUOTA_429 = '429: {"message":"лимит токенов исчерпан","type":"insufficient_quota","param":null,"code":"insufficient_quota"}'
const RATE_LIMIT_429 = '429: {"message":"Too many requests","type":"rate_limit_error","param":null,"code":"rate_limit_exceeded"}'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1932',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-f1932',
      workspaceRootPath: '/tmp/nessy-f1932',
      sessionRootPath: '/tmp/nessy-f1932-sessions/ws-f1932',
    } as any,
    session: {
      id: 'session-f1932',
      workspaceRootPath: '/tmp/nessy-f1932',
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
  return { agent, runtime, feed, errors }
}

const failed = (errorMessage: string, id: string) => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason: 'error', errorMessage, content: [], id },
})
const turn = (...inner: Array<Record<string, unknown>>) => [{ type: 'turn_start' }, ...inner, { type: 'turn_end' }]
const hasRetryAction = (error: any) => (error?.actions ?? []).some((action: any) => action.action === 'retry')

describe('F1.932 — a quota refusal does not promise an auto-retry', () => {
  it('the SDK declines to retry the quota 429 and does retry a plain 429 (the premise, read from pi-ai)', () => {
    const asMessage = (errorMessage: string) => ({ stopReason: 'error', errorMessage }) as any
    expect(isRetryableAssistantError(asMessage(QUOTA_429))).toBe(false)
    expect(isRetryableAssistantError(asMessage('429: quota exceeded for this model'))).toBe(false)
    expect(isRetryableAssistantError(asMessage(RATE_LIMIT_429))).toBe(true)
  })

  it('a non-retried quota 429 on the Pi host path ends as ONE quota error with no auto-retry', () => {
    const { agent, feed, errors } = rig()
    // The SDK's own order for an error it will not retry: `agent_end{willRetry:false}`.
    feed(
      { type: 'agent_start' },
      ...turn(failed(QUOTA_429, 'm1')),
      { type: 'agent_end', messages: [], willRetry: false },
    )
    const seen = errors()
    agent.destroy()
    expect(seen).toHaveLength(1)
    const error = seen[0]?.error
    expect(seen[0]?.type).toBe('typed_error')
    expect(error?.title).toBe('Quota Exhausted')
    expect(error?.message).not.toMatch(/auto-retry/i)
    expect(error?.message).toContain('Switch to another model')
    expect(error?.canRetry).toBe(false)
    expect(error?.retryDelayMs).toBeUndefined()
    expect(error?.details).toEqual(['API message: лимит токенов исчерпан'])
    // Code stays `rate_limited` on purpose (see `QUOTA_EXHAUSTED_DEFINITION`).
    expect(error?.code).toBe('rate_limited')
    expect(hasRetryAction(error)).toBe(true)
  })

  it('control: a plain 429 rate limit keeps its retry copy, canRetry and delay', () => {
    const parsed = parseError(new Error(RATE_LIMIT_429))
    expect(isQuotaExhaustedText(RATE_LIMIT_429)).toBe(false)
    expect(parsed.code).toBe('rate_limited')
    expect(parsed.title).toBe('Rate Limited')
    expect(parsed.canRetry).toBe(true)
    expect(parsed.retryDelayMs).toBe(5000)
  })

  // F1.1090 (origin DN-045) — the plain rate-limit copy promised "Will auto-retry shortly." and nothing retries:
  // `canAutoRetry` has no caller, the card's Retry runs on a click, and the runtime's own retries (Pi SDK, Claude
  // SDK) are already spent when the typed error lands. The copy says what the user can do instead.
  it('F1.1090: a plain 429 rate limit no longer promises an auto-retry, and points at the Retry action', () => {
    const parsed = parseError(new Error(RATE_LIMIT_429))
    expect(parsed.message).not.toMatch(/auto-retry/i)
    expect(parsed.message).toBe('Rate limit reached. Wait a moment, then retry.')
    expect(hasRetryAction(parsed)).toBe(true) // CONTROL: the Retry button the copy points at is still there
  })

  it('the thrown-error path (`parsePiError`) agrees: quota gets the quota copy, a plain 429 keeps its retry', () => {
    const { agent, runtime } = rig()
    const quota = runtime.parsePiError(new Error(QUOTA_429))
    const plain = runtime.parsePiError(new Error('429 Too Many Requests'))
    agent.destroy()
    expect(quota.title).toBe('Quota Exhausted')
    expect(quota.canRetry).toBe(false)
    expect(quota.retryDelayMs).toBeUndefined()
    expect(plain.code).toBe('rate_limited')
    expect(plain.canRetry).toBe(true)
    expect(plain.retryDelayMs).toBe(5000)
  })
})
