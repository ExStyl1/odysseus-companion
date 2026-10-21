/**
 * F1.352 — a Stop cancels a manual `/compact` on Pi.
 *
 * Two holes, both read at the server entry (`index.ts`):
 *
 * - IN FLIGHT: `handleAbort` called only `piSession.abort()`, which in
 *   pi-coding-agent 0.84 is `abortRetry()` + `agent.abort()` + `waitForIdle()`
 *   (`dist/core/agent-session.js`) and never touches the compaction
 *   controller, so a running manual compaction ran to the end and APPENDED
 *   after the user pressed Stop. The SDK publishes the cancel for exactly this:
 *   `abortCompaction()` — "Cancel in-progress compaction (manual or auto)" —
 *   which aborts `_compactionAbortController`, and `compact()` then throws
 *   `Compaction cancelled` before `appendCompaction`.
 * - QUEUED: `handleCompact` waits for an in-flight AUTO-compaction to drain
 *   (`waitForCompaction`) and then started the manual one regardless of a Stop
 *   that arrived during the wait. craft-agents-oss v0.13.4 closes this with a
 *   `compactionEpoch` that `handleAbort` bumps and `handleCompact` re-checks
 *   after every await (`packages/pi-agent-server/src/index.ts`, Apache-2.0).
 *
 * The rig drives the REAL server entry with a scripted session, the shape of
 * `pi-auto-compaction-thrashing.test.ts`: `session.compact` is replaced by a
 * stand-in holding the SDK's own contract (resolve on its own after a delay,
 * or reject `Compaction cancelled` once `abortCompaction()` fires — the text
 * MEASURED on the real SDK for a Stop mid-summarization (F1.621, 2026-09-26,
 * openai-completions; pi-ai's other providers share its catch): the abort is
 * `stopReason: 'aborted'`, never `Summarization failed: …`, so `compact()`
 * throws exactly this), and
 * `abortCompaction` is WRAPPED — the real SDK method still runs, so the arm
 * fails if a lift renames it. `isCompacting` is driven by a file the test
 * writes, standing in for an auto-compaction that drains on cue. The queued
 * case is sequenced by the SERVER's own signals, never by wall time: the Stop is
 * sent when `waitForCompaction` logs that it is waiting, and the auto-compaction
 * drains when the server's `handleAbort` reaches `abortCompaction()`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href
const repoRoot = join(here, '..', '..', '..', '..')

/** How long the stand-in compaction takes when nothing cancels it. */
const COMPACT_MS = 1_500
/** F1.607 — the ANSWER budget, from the child's first `ready`; the boot has its own (`support/real-server-clock.ts`). */
const ANSWER_WAIT_MS = 120_000

type Scenario = 'in-flight-stop' | 'queued-stop' | 'no-stop'

interface ScenarioResult {
  compactResult: { success?: boolean; errorMessage?: string } | undefined
  rigLines: string[]
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-stop-compact-'))
  const preloadPath = join(root, 'scripted-compact-preload.ts')
  const autoCompactionDrained = join(root, 'auto-compaction-drained')
  if (scenario !== 'queued-stop') writeFileSync(autoCompactionDrained, '')
  writeFileSync(preloadPath, `
    import { mock } from 'bun:test'
    import { existsSync } from 'node:fs'
    const actual = await import(${JSON.stringify(adapterUrl)})
    const createRuntimeAdapter = actual.createPiRuntimeAdapter
    const rig = line => process.stderr.write('RIG:' + line + '\\n')
    mock.module(${JSON.stringify(adapterUrl)}, () => ({
      ...actual,
      createPiRuntimeAdapter(...args) {
        const adapter = createRuntimeAdapter(...args)
        return {
          ...adapter,
          async createSession(options) {
            const handle = await adapter.createSession(options)
            const session = handle.session
            Object.defineProperty(session, 'isCompacting', {
              configurable: true,
              get: () => !existsSync(${JSON.stringify(autoCompactionDrained)}),
            })
            let cancelInFlight
            session.compact = async () => {
              rig('compact-started')
              return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  cancelInFlight = undefined
                  rig('compact-completed')
                  resolve({ summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 100, estimatedTokensAfter: 10 })
                }, ${COMPACT_MS})
                cancelInFlight = () => { clearTimeout(timer); cancelInFlight = undefined; reject(new Error('Compaction cancelled')) }
              })
            }
            const realAbortCompaction = session.abortCompaction
            if (typeof realAbortCompaction !== 'function') throw new Error('the SDK no longer publishes abortCompaction()')
            session.abortCompaction = (...abortArgs) => {
              rig('abort-compaction')
              realAbortCompaction.apply(session, abortArgs)
              cancelInFlight?.()
            }
            return handle
          },
        }
      },
    }))
  `)

  const executionManifest = createRealServerExecutionManifest({ workspaceId: 'stop-compact-workspace', sessionId: 'stop-compact-session' })
  const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const rigLines: string[] = []
  let stderr = ''
  const observed: string[] = []
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)
  let sentStop = false
  let drainFallback: ReturnType<typeof setTimeout> | undefined
  const drain = () => {
    clearTimeout(drainFallback)
    if (existsSync(root) && !existsSync(autoCompactionDrained)) writeFileSync(autoCompactionDrained, '')
  }
  const stop = () => {
    if (sentStop) return
    sentStop = true
    write({ type: 'abort' })
    // Queued case: the auto-compaction drains only AFTER the server has TAKEN the
    // Stop — keyed to its own signal below (the wrapped abortCompaction), with a
    // 5 s fallback so a build that never calls it (HEAD before F1.352) still
    // drains and fails on the assertion instead of the timeout.
    if (scenario === 'queued-stop') drainFallback = setTimeout(drain, 5_000)
  }
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
    for (const line of String(chunk).split('\n')) {
      // Queued case: send the Stop only once handleCompact is really parked in
      // waitForCompaction — its own debug line, printed right before the poll.
      // (A wall-clock delay after 'ready' was measured to land the Stop while the
      // child was still building its session, so the drain came first and the
      // arm tested nothing: 2026-09-24, run2.)
      if (scenario === 'queued-stop' && line.includes('Waiting for in-flight compaction to finish')) stop()
      if (!line.startsWith('RIG:')) continue
      rigLines.push(line.slice(4))
      if (scenario === 'in-flight-stop' && line === 'RIG:compact-started') stop()
      if (scenario === 'queued-stop' && sentStop && line === 'RIG:abort-compaction') drain()
    }
  })

  write({
    type: 'init',
    apiKey: 'test',
    model: 'stop-compact-model',
    cwd: root,
    workingDirectory: root,
    workspaceRootPath: root,
    workspaceId: 'stop-compact-workspace',
    sessionId: 'stop-compact-session',
    sessionPath: join(root, 'session'),
    plansFolderPath: join(root, 'session', 'plans'),
    thinkingLevel: 'off',
    baseUrl: 'http://127.0.0.1:1/v1',
    customEndpoint: { api: 'openai-completions' },
    customModels: [{ id: 'stop-compact-model', contextWindow: 100_000 }],
    executionManifest,
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
  })

  const compactResult = await new Promise<ScenarioResult['compactResult']>((resolve, reject) => {
    const clock = startRealServerClock({
      answerWaitMs: ANSWER_WAIT_MS,
      onExpire: (_phase, why) => reject(new Error(`stop-compact scenario timeout — ${why}\n${observed.join('\n')}\n${stderr}`)),
    })
    child.on('error', reject)
    lines.on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      observed.push(message.type === 'event' ? `protocol:event:${message.event?.type}` : `protocol:${message.type}`)
      if (message.type === 'startup_error') {
        clock.clear()
        reject(new Error(`${message.code}: ${message.message}\n${stderr}`))
        return
      }
      if (message.type === 'ready') {
        clock.ready()
        write({ type: 'compact', id: 'stop-compact-1' })
        return
      }
      if (message.type === 'compact_result' && message.id === 'stop-compact-1') {
        clock.clear()
        resolve({ success: message.success, errorMessage: message.errorMessage })
      }
    })
  })

  // Give a compaction that WRONGLY kept running the time to report itself.
  await new Promise(resolveWait => setTimeout(resolveWait, scenario === 'no-stop' ? 0 : COMPACT_MS + 300))
  try {
    return { compactResult, rigLines: [...rigLines] }
  } finally {
    // The fallback must not outlive its scenario: fired after `root` is removed
    // it threw ENOENT into the NEXT test (measured 2026-09-24, the CONTROL arm).
    clearTimeout(drainFallback)
    write({ type: 'shutdown' })
    child.kill()
    lines.close()
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  }
}

describe('F1.352 — Stop cancels a manual /compact on Pi', () => {
  it('IN FLIGHT: Stop reaches the SDK\'s abortCompaction(), and the compact answers success:false without completing', async () => {
    const { compactResult, rigLines } = await runScenario('in-flight-stop')
    expect(rigLines).toContain('abort-compaction')
    expect(rigLines).not.toContain('compact-completed')
    expect(compactResult?.success).toBe(false)
    expect(compactResult?.errorMessage).toBe('Compaction cancelled')
  }, realServerTestBudget(ANSWER_WAIT_MS))

  it('QUEUED behind an auto-compaction: a Stop during the wait means the manual compaction never starts', async () => {
    const { compactResult, rigLines } = await runScenario('queued-stop')
    expect(rigLines).not.toContain('compact-started')
    expect(compactResult?.success).toBe(false)
  }, realServerTestBudget(ANSWER_WAIT_MS))

  it('CONTROL — with no Stop the manual compaction runs and answers success:true', async () => {
    const { compactResult, rigLines } = await runScenario('no-stop')
    expect(rigLines).toEqual(['compact-started', 'compact-completed'])
    expect(compactResult?.success).toBe(true)
  }, realServerTestBudget(ANSWER_WAIT_MS))
})

/**
 * F1.1080 — the fourth arm: the REAL compaction, no `compact` stand-in. DN-027
 * measured it once for F1.621 (2026-09-26, Pi 0.85.1): the real server entry
 * over a loopback openai-completions stub, the summary request held open, then
 * Stop, answered `compact_result` with `errorMessage: 'Compaction cancelled'` —
 * the text the three arms above take as given. Pinned here, so a Pi lift that
 * changes what a stopped summarization reports fails a test instead of a note.
 *
 * Sequenced by the stub's own signal, never by wall time: auto-compaction is
 * switched off, three turns build history past Pi's recent-tokens floor, the
 * manual `compact` is sent, and the Stop goes out once the stub has the summary
 * request open and has answered its first chunk.
 *
 * The SHAPE is DN-027's and it matters: only the FIRST reply is large, so the
 * cut lands on a turn boundary and Pi summarizes HISTORY. With every turn large
 * the cut splits the last turn and Pi summarizes the TURN PREFIX instead — and
 * that path, measured here 2026-10-09 on Pi 0.85.1, answers a Stop with
 * `Turn prefix summarization failed: The operation was aborted.`, not
 * `Compaction cancelled` (`bigTurns: 'all'`). F1.1298: `handleCompact` answers a
 * stopped compaction `Compaction cancelled` either way — the split-turn arm below.
 */
async function runRealCompactStop(bigTurns: 'first' | 'all' = 'first'): Promise<{
  compactResult: ScenarioResult['compactResult']
  compactionEnd: Record<string, unknown> | undefined
  summaryRequests: number
}> {
  const large = (word: string) => `${word} `.repeat(24_000)
  let compactSent = false
  let promptRequests = 0
  let summaryRequests = 0
  let onSummaryHeld: (() => void) | undefined
  const held: http.ServerResponse[] = []
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const base = { id: 'real-compact', object: 'chat.completion.chunk', created: 1, model: 'real-compact-model' }
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (compactSent) {
        // The summary request: one chunk, then held open until the Stop lands.
        summaryRequests += 1
        response.write(chunk({ content: 'partial ' }))
        held.push(response)
        onSummaryHeld?.()
        return
      }
      promptRequests += 1
      response.write(chunk({ content: bigTurns === 'all' || promptRequests === 1 ? large('reply') : 'ok' }))
      response.write(chunk({}, 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('real-compact stub did not bind')

  const root = mkdtempSync(join(tmpdir(), 'nessy-real-compact-stop-'))
  const executionManifest = createRealServerExecutionManifest({ workspaceId: 'real-compact-workspace', sessionId: 'real-compact-session' })
  const child = spawn(process.execPath, [entrypoint], { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const prompt = (id: string) => write({
    type: 'prompt', id, message: bigTurns === 'all' ? large(id) : `turn ${id}`, systemPrompt: 'REAL_COMPACT_SYSTEM_PROMPT',
    manifestGeneration: executionManifest.snapshotGeneration, manifestHash: executionManifest.manifestHash,
  })
  onSummaryHeld = () => write({ type: 'abort' })
  let compactionEnd: Record<string, unknown> | undefined

  try {
    const compactResult = await new Promise<ScenarioResult['compactResult']>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: ANSWER_WAIT_MS,
        onExpire: (_phase, why) => reject(new Error(`real-compact timeout — ${why} (${summaryRequests} summary requests)\n${stderr}`)),
      })
      let agentEnds = 0
      child.on('error', reject)
      lines.on('line', line => {
        let message: any
        try { message = JSON.parse(line) } catch { return }
        if (message.type === 'startup_error') {
          clock.clear()
          reject(new Error(`${message.code}: ${message.message}\n${stderr}`))
        } else if (message.type === 'pre_compact_request') {
          write({ type: 'pre_compact_response', requestId: message.requestId })
        } else if (message.type === 'ready') {
          clock.ready()
          write({ type: 'set_auto_compaction', id: 'auto-off', enabled: false, thresholdPercent: 50, contextWindow: 1_000_000 })
        } else if (message.type === 'set_auto_compaction_result' && message.id === 'auto-off') {
          prompt('first')
        } else if (message.type === 'event' && message.event?.type === 'agent_end') {
          agentEnds += 1
          if (agentEnds < 3) prompt(agentEnds === 1 ? 'second' : 'third')
          else {
            compactSent = true
            write({ type: 'compact', id: 'real-compact-1' })
          }
        } else if (message.type === 'event' && message.event?.type === 'compaction_end') {
          compactionEnd = message.event
        } else if (message.type === 'compact_result' && message.id === 'real-compact-1') {
          clock.clear()
          resolve({ success: message.success, errorMessage: message.errorMessage })
        }
      })
      write({
        type: 'init', apiKey: 'test', model: 'real-compact-model', cwd: root, workingDirectory: root, workspaceRootPath: root,
        workspaceId: 'real-compact-workspace', sessionId: 'real-compact-session', sessionPath: join(root, 'session'),
        plansFolderPath: join(root, 'session', 'plans'), thinkingLevel: 'off',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, customEndpoint: { api: 'openai-completions' },
        customModels: [{ id: 'real-compact-model', contextWindow: 1_000_000 }],
        executionManifest, piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
      })
    })
    return { compactResult, compactionEnd, summaryRequests }
  } finally {
    for (const response of held) response.destroy()
    write({ type: 'shutdown' })
    child.kill()
    lines.close()
    server.close()
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  }
}

describe('F1.1080 — the real Pi compaction, stopped mid-summary', () => {
  it('answers success:false with Pi\'s own "Compaction cancelled", and the SDK reports the compaction aborted', async () => {
    const { compactResult, compactionEnd, summaryRequests } = await runRealCompactStop()
    // PRECONDITION: the Stop landed on a real summary request, not before one.
    expect(summaryRequests).toBe(1)
    expect(compactResult).toEqual({ success: false, errorMessage: 'Compaction cancelled' })
    expect(compactionEnd).toMatchObject({ aborted: true })
  }, realServerTestBudget(ANSWER_WAIT_MS))

  // F1.1298 — the cut splits the last turn, so Pi summarizes the TURN PREFIX and throws its own
  // `Turn prefix summarization failed: The operation was aborted.`; a Stop still reads as cancelled.
  it('a Stop during a split-turn (turn prefix) summary also answers "Compaction cancelled"', async () => {
    const { compactResult, summaryRequests } = await runRealCompactStop('all')
    expect(summaryRequests).toBeGreaterThanOrEqual(1) // PRECONDITION: the Stop landed on a real summary request
    expect(compactResult).toEqual({ success: false, errorMessage: 'Compaction cancelled' })
  }, realServerTestBudget(ANSWER_WAIT_MS))
})
