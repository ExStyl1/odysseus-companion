import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'bun:test'

import type { AgentEvent } from '@nessy-agent/core/types'
import { PiEventAdapter } from '../../../shared/src/agent/backend/pi/event-adapter.ts'
import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts'

/**
 * F1.587 — the scenario's budget, timed from the child's first `ready`; the boot has its own
 * (`support/real-server-clock.ts`, F1.546). Measured 2026-09-24 (WJ-lift): this file's child
 * printed `ready` at +115.8 s and +81.0 s at ~2 % cpu (2 313 of 2 319 samples in `openat`), and
 * each scenario then took ~2 s — so a clock started at spawn spent its whole 120 s on the boot.
 */
const ANSWER_WAIT_MS = 120_000

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href
const repoRoot = join(here, '..', '..', '..', '..')

async function runScenario(settleAfterOneRefill: boolean): Promise<{
  rawEvents: Array<Record<string, unknown>>
  agentEvents: AgentEvent[]
  queueCompletions: number
}> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-auto-compaction-thrashing-'))
  const preloadPath = join(root, 'scripted-overflow-preload.ts')
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
            let promptCalls = 0
            handle.session.prompt = async () => {
              const emit = event => listener?.(event)
              const agentEnd = willRetry => emit({ type: 'agent_end', messages: [], willRetry })
              promptCalls += 1
              if (promptCalls > 1) {
                if (!handle.session.autoCompactionEnabled) {
                  throw new Error('thrashing guard was not reset before the next prompt preflight')
                }
                emit({
                  type: 'message_start',
                  message: { role: 'user', content: [{ type: 'text', text: 'resume' }], timestamp: Date.now() },
                })
                emit({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'resumed' }],
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
                    timestamp: Date.now(),
                  },
                })
                agentEnd(false)
                return
              }
              const overflow = () => emit({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  stopReason: 'error',
                  errorMessage: 'context_length_exceeded',
                  content: [],
                  timestamp: Date.now(),
                },
              })
              const toolUse = () => emit({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  stopReason: 'toolUse',
                  content: [],
                  timestamp: Date.now(),
                },
              })
              const compact = () => {
                emit({ type: 'compaction_start', reason: 'overflow' })
                emit({
                  type: 'compaction_end',
                  reason: 'overflow',
                  result: {
                    summary: 'summary',
                    firstKeptEntryId: 'kept',
                    tokensBefore: 1000,
                    estimatedTokensAfter: 100,
                  },
                  aborted: false,
                  willRetry: true,
                })
              }

              emit({
                type: 'message_start',
                message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.now() },
              })
              overflow()
              agentEnd(true)
              compact()

              if (${JSON.stringify(settleAfterOneRefill)}) {
                toolUse()
                overflow()
                agentEnd(true)
                if (handle.session.autoCompactionEnabled) compact()
                emit({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'settled' }],
                    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
                    timestamp: Date.now(),
                  },
                })
                agentEnd(false)
                return
              }

              for (let refill = 0; refill < 8; refill += 1) {
                toolUse()
                overflow()
                agentEnd(true)
                if (!handle.session.autoCompactionEnabled) return
                compact()
              }
              emit({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  stopReason: 'stop',
                  content: [{ type: 'text', text: 'unbounded' }],
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
                  timestamp: Date.now(),
                },
              })
              agentEnd(false)
            }
            return handle
          },
        }
      },
    }))
  `)

  const executionManifest = createRealServerExecutionManifest({
    workspaceId: 'thrashing-workspace',
    sessionId: 'thrashing-session',
  })
  const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const rawEvents: Array<Record<string, unknown>> = []
  const eventAdapter = new PiEventAdapter()
  eventAdapter.startTurn()
  eventAdapter.setContextWindow(1_000)
  const agentEvents: AgentEvent[] = []
  let queueCompletions = 0
  let resumedAfterGuard = false
  let stderr = ''
  const observed: string[] = []
  child.stderr.on('data', chunk => { stderr += String(chunk) })

  const completed = new Promise<void>((resolve, reject) => {
    // P3.199 — this budget is INSIDE the scenario, not on the suite runner, and
    // the distinction is the whole reason this comment exists. Raising a bun
    // test timeout does nothing to it, and a scenario that blows it reports
    // `thrashing scenario: <the phase that ran out>` with the protocol trace rather than the
    // `(fail) (unnamed) … a beforeEach/afterEach hook timed out` shape the three
    // registered starvation suites show. Read it as its own family.
    //
    // MEASURED FLOOR, 2026-09-03, three consecutive runs of the whole file
    // (2 tests, one child Pi server each) taken with `uptime` beside each:
    // 4.96 s at load 11.79, 5.65 s at 12.69, 7.81 s at 13.83 — so ~2.5-4 s per
    // scenario against a 120 s budget, 30x to 48x headroom, and all three green.
    // A quiet box was not obtainable: eleven other lanes were running.
    //
    // So the budget is NOT the knob-below-the-resting-state trap. If this file
    // times out under wave load it is starvation (AGENTS.md's first cause), and
    // lowering this number toward the floor would manufacture the failure it is
    // being blamed for. It is left where it is deliberately; the reading is
    // recorded so the next lane does not re-derive it, and the entry in
    // `docs/superpowers/specs/2026-07-29-known-failing-tests.md` carries the rest.
    // F1.587 — that 120 s is now the ANSWER budget, from the first `ready`.
    const clock = startRealServerClock({
      answerWaitMs: ANSWER_WAIT_MS,
      onExpire: (_phase, message) => reject(new Error(`thrashing scenario: ${message}\n${observed.join('\n')}\n${stderr}`)),
    })
    child.on('error', reject)
    lines.on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      observed.push(message.type === 'event'
        ? `protocol:event:${message.event?.type}`
        : `protocol:${message.type}`)
      if (message.type === 'startup_error' || message.type === 'error') {
        clock.clear()
        reject(new Error(`${message.code}: ${message.message}\n${stderr}`))
        return
      }
      if (message.type === 'ready') clock.ready()
      if (message.type === 'ready') {
        child.stdin.write(`${JSON.stringify({
          type: 'prompt',
          id: 'thrashing-turn',
          message: 'go',
          systemPrompt: 'SYSTEM',
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        })}\n`)
        return
      }
      if (message.type !== 'event') return
      rawEvents.push(message.event)
      agentEvents.push(...eventAdapter.adaptEvent(message.event))
      if (eventAdapter.shouldCompleteQueue(message.event?.type === 'agent_end')) {
        queueCompletions += 1
      }
      if (
        !settleAfterOneRefill
        && !resumedAfterGuard
        && message.event?.terminalReason === 'auto_compaction_thrashing'
      ) {
        resumedAfterGuard = true
        eventAdapter.startTurn()
        child.stdin.write(`${JSON.stringify({
          type: 'prompt',
          id: 'post-thrashing-turn',
          message: 'resume',
          systemPrompt: 'SYSTEM',
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        })}\n`)
        return
      }
      if (message.event?.type === 'agent_end' && message.event?.willRetry === false) {
        clock.clear()
        resolve()
      }
    })
  })

  child.stdin.write(`${JSON.stringify({
    type: 'init',
    apiKey: 'test',
    model: 'thrashing-model',
    cwd: root,
    workingDirectory: root,
    workspaceRootPath: root,
    workspaceId: 'thrashing-workspace',
    sessionId: 'thrashing-session',
    sessionPath: join(root, 'session'),
    plansFolderPath: join(root, 'session', 'plans'),
    thinkingLevel: 'off',
    baseUrl: 'http://127.0.0.1:1/v1',
    customEndpoint: { api: 'openai-completions' },
    customModels: [{ id: 'thrashing-model', contextWindow: 1_000 }],
    executionManifest,
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
  })}\n`)

  try {
    await completed
    return { rawEvents, agentEvents, queueCompletions }
  } finally {
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
    child.kill()
    lines.close()
    rmSync(root, { recursive: true, force: true })
  }
}

it('stops three consecutive immediate post-compaction refills on the existing terminal-reason wire', async () => {
  const { rawEvents, agentEvents, queueCompletions } = await runScenario(false)

  expect({
    overflows: rawEvents.filter(event => (
      event.type === 'message_end'
      && (event.message as { stopReason?: string } | undefined)?.stopReason === 'error'
    )).length,
    successfulCompactions: rawEvents.filter(event => event.type === 'compaction_end' && event.result).length,
    // Split, rather than one compound `find`: TypeScript infers a type
    // predicate from `event => event.type === 'complete'` but not from that
    // conjoined with a second comparison, so the compound form left `find`
    // returning the whole `AgentEvent` union and `?.terminalReason` unreachable.
    // Same mechanism the `filter` at the end of this file already relies on.
    terminalReason: agentEvents
      .filter(event => event.type === 'complete')
      .find(event => event.terminalReason === 'auto_compaction_thrashing')
      ?.terminalReason,
    resumed: agentEvents.some(event => event.type === 'text_complete' && event.text === 'resumed'),
    queueCompletions,
  }).toEqual({
    overflows: 4,
    successfulCompactions: 3,
    terminalReason: 'auto_compaction_thrashing',
    resumed: true,
    queueCompletions: 2,
  })
}, realServerTestBudget(ANSWER_WAIT_MS))

it('resets after one immediate refill followed by a settled retry', async () => {
  const { rawEvents, agentEvents, queueCompletions } = await runScenario(true)

  expect(rawEvents.filter(event => event.type === 'compaction_end' && event.result)).toHaveLength(2)
  expect(agentEvents.filter(event => event.type === 'complete').at(-1)?.terminalReason).toBeUndefined()
  expect(queueCompletions).toBe(1)
}, realServerTestBudget(ANSWER_WAIT_MS))
