/**
 * F1.297 — P6.443's provider verdict must not outrank the SDK's own retry.
 *
 * pi-ai mints `Provider finish_reason: network_error` for a stream the provider
 * ended with that finish reason (`mapStopReason`, `dist/api/openai-completions.js`),
 * and its own classifier calls that retryable (`isRetryableAssistantError`,
 * `network.?error` in `dist/utils/retry.js`), so pi-coding-agent stamps the
 * `agent_end` that closes the failed attempt `willRetry: true`
 * (`_willRetryAfterAgentEnd`, `dist/core/agent-session.js`) and then really does
 * retry (`_prepareRetry` → `continue()`). P6.443's reader armed a
 * `provider_error` verdict off the same message and stamped it onto that same
 * `agent_end` — and F1.235's host machine lets an own-side verdict win, so the
 * turn ENDED on the first attempt and the SDK's retried answer was dropped.
 *
 * The rig drives the REAL server entry (`index.ts`, from source) with a
 * scripted Pi session that emits the SDK's own wire order, and feeds every
 * forwarded event through the REAL `PiEventAdapter`, counting queue
 * completions the way `PiAgent` does — the shape of
 * `pi-auto-compaction-thrashing.test.ts`.
 *
 * - retried: failed attempt → `agent_end{willRetry:true}` → `auto_retry_start`
 *   → the retried run answers → `agent_end{willRetry:false}`. One completion,
 *   at the END, carrying the answer and no verdict.
 * - CONTROL, not retried (ladder off or exhausted): the same failure closes
 *   with `willRetry:false`, and the verdict still rides it — the fix must not
 *   cost P6.443 its reading.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

import type { AgentEvent } from '@nessy-agent/core/types'
import { PiEventAdapter } from '../../../shared/src/agent/backend/pi/event-adapter.ts'
import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts'

/**
 * F1.587 — the scenario's budget, timed from the child's first `ready`; the boot has its own
 * (`support/real-server-clock.ts`, F1.546). The child's boot measured 81–116 s at ~2 % cpu on
 * 2026-09-24 (WJ-lift, the thrashing rig's twin), which a clock started at spawn spent in full.
 */
const ANSWER_WAIT_MS = 120_000

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href
const repoRoot = join(here, '..', '..', '..', '..')

/** The exact spelling pi-ai's `mapStopReason` mints for a `network_error` finish reason. */
const NETWORK_ERROR = 'Provider finish_reason: network_error'

interface ScenarioResult {
  rawAgentEnds: Array<Record<string, unknown>>
  agentEvents: AgentEvent[]
  completionsAtFirstAgentEnd: number
  queueCompletions: number
}

async function runScenario(retried: boolean): Promise<ScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-provider-verdict-retry-'))
  const preloadPath = join(root, 'scripted-retry-preload.ts')
  writeFileSync(preloadPath, `
    import { mock } from 'bun:test'
    const actual = await import(${JSON.stringify(adapterUrl)})
    const createRuntimeAdapter = actual.createPiRuntimeAdapter
    mock.module(${JSON.stringify(adapterUrl)}, () => ({
      ...actual,
      createPiRuntimeAdapter(...args) {
        const adapter = createRuntimeAdapter(...args)
        return {
          ...adapter,
          async createSession(options) {
            const handle = await adapter.createSession(options)
            let listener
            handle.session.subscribe = next => {
              listener = next
              return () => { if (listener === next) listener = undefined }
            }
            handle.session.prompt = async () => {
              const emit = event => listener?.(event)
              const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }
              const failed = {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: ${JSON.stringify(NETWORK_ERROR)},
                content: [],
                timestamp: Date.now(),
              }
              emit({ type: 'agent_start' })
              emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.now() } })
              emit({ type: 'turn_start' })
              emit({ type: 'message_end', message: failed })
              emit({ type: 'turn_end' })
              if (!${JSON.stringify(retried)}) {
                emit({ type: 'agent_end', messages: [failed], willRetry: false })
                return
              }
              emit({ type: 'agent_end', messages: [failed], willRetry: true })
              emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 10, errorMessage: ${JSON.stringify(NETWORK_ERROR)} })
              emit({ type: 'agent_start' })
              emit({ type: 'turn_start' })
              emit({
                type: 'message_end',
                message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Full answer' }], usage, timestamp: Date.now() },
              })
              emit({ type: 'turn_end' })
              emit({ type: 'auto_retry_end', success: true, attempt: 1 })
              emit({ type: 'agent_end', messages: [], willRetry: false })
            }
            return handle
          },
        }
      },
    }))
  `)

  const executionManifest = createRealServerExecutionManifest({
    workspaceId: 'verdict-retry-workspace',
    sessionId: 'verdict-retry-session',
  })
  const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const rawAgentEnds: Array<Record<string, unknown>> = []
  const eventAdapter = new PiEventAdapter()
  eventAdapter.startTurn()
  const agentEvents: AgentEvent[] = []
  let queueCompletions = 0
  let completionsAtFirstAgentEnd = -1
  let stderr = ''
  const observed: string[] = []
  child.stderr.on('data', chunk => { stderr += String(chunk) })

  const completed = new Promise<void>((resolve, reject) => {
    // Budget INSIDE the scenario (the thrashing rig's reading: ~2.5-4 s per
    // scenario at load 12-14, 2026-09-03), so a starved run reports this
    // message with the protocol trace rather than a bare hook timeout.
    // F1.587 — two phases: the boot, then ANSWER_WAIT_MS from the first `ready`.
    const clock = startRealServerClock({
      answerWaitMs: ANSWER_WAIT_MS,
      onExpire: (_phase, message) => reject(new Error(`verdict-retry scenario: ${message}\n${observed.join('\n')}\n${stderr}`)),
    })
    child.on('error', reject)
    lines.on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      observed.push(message.type === 'event' ? `protocol:event:${message.event?.type}` : `protocol:${message.type}`)
      if (message.type === 'startup_error' || message.type === 'error') {
        clock.clear()
        reject(new Error(`${message.code}: ${message.message}\n${stderr}`))
        return
      }
      if (message.type === 'ready') clock.ready()
      if (message.type === 'ready') {
        child.stdin.write(`${JSON.stringify({
          type: 'prompt',
          id: 'verdict-retry-turn',
          message: 'go',
          systemPrompt: 'SYSTEM',
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        })}\n`)
        return
      }
      if (message.type !== 'event') return
      const event = message.event as Record<string, unknown>
      agentEvents.push(...eventAdapter.adaptEvent(event as never))
      if (eventAdapter.shouldCompleteQueue(event.type === 'agent_end')) queueCompletions += 1
      if (event.type === 'agent_end') {
        rawAgentEnds.push(event)
        if (completionsAtFirstAgentEnd < 0) completionsAtFirstAgentEnd = queueCompletions
        if (event.willRetry === false) {
          clock.clear()
          resolve()
        }
      }
    })
  })

  child.stdin.write(`${JSON.stringify({
    type: 'init',
    apiKey: 'test',
    model: 'verdict-retry-model',
    cwd: root,
    workingDirectory: root,
    workspaceRootPath: root,
    workspaceId: 'verdict-retry-workspace',
    sessionId: 'verdict-retry-session',
    sessionPath: join(root, 'session'),
    plansFolderPath: join(root, 'session', 'plans'),
    thinkingLevel: 'off',
    baseUrl: 'http://127.0.0.1:1/v1',
    customEndpoint: { api: 'openai-completions' },
    customModels: [{ id: 'verdict-retry-model', contextWindow: 100_000 }],
    executionManifest,
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
  })}\n`)

  try {
    await completed
    return { rawAgentEnds, agentEvents, completionsAtFirstAgentEnd, queueCompletions }
  } finally {
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
    child.kill()
    lines.close()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('F1.297 — a provider verdict does not end a turn the SDK is retrying', () => {
  it('willRetry:true — the verdict is not stamped, the turn holds, and the retried answer completes it once', async () => {
    const { rawAgentEnds, agentEvents, completionsAtFirstAgentEnd, queueCompletions } = await runScenario(true)
    expect({
      firstAgentEnd: { willRetry: rawAgentEnds[0]?.willRetry, terminalReason: rawAgentEnds[0]?.terminalReason },
      completionsAtFirstAgentEnd,
      queueCompletions,
      texts: agentEvents.flatMap(event => event.type === 'text_complete' ? [event.text] : []),
      errors: agentEvents.filter(event => event.type === 'error' || event.type === 'typed_error').length,
      verdicts: agentEvents.flatMap(event => event.type === 'complete' && event.terminalReason ? [event.terminalReason] : []),
    }).toEqual({
      firstAgentEnd: { willRetry: true, terminalReason: undefined },
      completionsAtFirstAgentEnd: 0,
      queueCompletions: 1,
      texts: ['Full answer'],
      errors: 0,
      verdicts: [],
    })
  }, realServerTestBudget(ANSWER_WAIT_MS))

  it('CONTROL — willRetry:false keeps P6.443\'s verdict on the agent_end and the turn ends on it', async () => {
    const { rawAgentEnds, agentEvents, queueCompletions } = await runScenario(false)
    expect(rawAgentEnds).toHaveLength(1)
    expect(rawAgentEnds[0]?.terminalReason).toBe('provider_error')
    expect(queueCompletions).toBe(1)
    expect(agentEvents.flatMap(event => event.type === 'complete' && event.terminalReason ? [event.terminalReason] : []))
      .toEqual(['provider_error'])
  }, realServerTestBudget(ANSWER_WAIT_MS))
})
