/**
 * F1.239 — the subprocess half, measured on the REAL server: each utility
 * request's failure carries ITS id, and a host `cancel_ephemeral_query` aborts
 * exactly the matching ephemeral session.
 *
 * At HEAD `handleMiniCompletion` sent `{ type: 'error', code:
 * 'mini_completion_error' }` with no id (so the host could only fan it out to
 * every pending request), `handleLlmQuery`'s generic half likewise, and the
 * inbound union had no cancel message: a query the host had given up on kept its
 * ephemeral session running until the SDK finished on its own.
 *
 * The rig is `pi-runtime-h1-real-server.test.ts`'s: `index.ts` spawned with a
 * `--preload` that wraps `createPiRuntimeAdapter`, here so each EPHEMERAL
 * session's `prompt` is scripted by its prompt text — no network, and the main
 * session is never prompted.
 *
 * WJ-au (2026-09-24) sharpened the first arm and added the second:
 *
 * - F1.304 — at the cancel a SECOND slow query (`SURVIVOR`) is still in
 *   flight and must still answer, so `cancel(id)` and `cancelAll` no longer
 *   look alike (with one active query they could not be told apart).
 * - F1.305 — a cancelled SLOW mini completion answers `{ text: null }` and no
 *   error (the host's best-effort title contract), and the subprocess deadline
 *   sits inside the host's RPC timeout.
 * - F1.303 — a re-init and a shutdown cancel every in-flight utility query
 *   (upstream craft-agents-oss 0.13.4 calls `cancelAll` in both).
 * - F1.306 — a `prompt()` that returns WITHOUT `agent_end` is disposed before
 *   its request answers, instead of lingering on a post-prompt wait nobody can
 *   cancel.
 *
 * The preload writes every marker to a FILE with `appendFileSync` before the
 * child goes on, so a marker read when an answer arrives on stdout is ordered
 * against that answer (stdout and stderr are two pipes, and their arrival order
 * says nothing about the child's).
 *
 * Budgets: this rig boots the real `index.ts` module graph. On 2026-09-24 that
 * boot took minutes at ~0.5 s of cpu (I/O, not contention — AGENTS.md's
 * slow-filesystem trap), and the old single 120 s clock, started at spawn,
 * expired before `ready` with nothing received. So boot has its own budget and
 * the answer clock starts at the first `ready` — the two-phase clock this suite
 * first kept inline, shared since F1.607 as `support/real-server-clock.ts`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

import { EPHEMERAL_QUERY_DEADLINE_MS } from '../ephemeral-query-lifecycle.ts'
import { LLM_QUERY_TIMEOUT_MS } from '../../../shared/src/agent/llm-tool.ts'
import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { realServerTestBudget, startRealServerClock, type RealServerClock } from './support/real-server-clock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href
const repoRoot = join(here, '..', '..', '..', '..')

/**
 * How long, from the first `ready`, the arm waits for its answers. It covers a RE-INIT (the second arm's second
 * `ready`), which on a slow rig is itself slow; every answer an arm waits for arrives in milliseconds otherwise.
 * The boot before that first `ready` has its own budget, `REAL_SERVER_BOOT_WAIT_MS` (`support/real-server-clock.ts`,
 * whose docblock carries the 2026-09-24 measurement this suite first recorded here).
 */
const ANSWER_WAIT_MS = 300_000
/** Per-arm budget: boot plus answers plus teardown. */
const ARM_BUDGET_MS = realServerTestBudget(ANSWER_WAIT_MS)

/**
 * The scripted ephemeral session. Prompt texts:
 * `SLOW…` waits until its session is aborted; `SURVIVOR` waits until a later
 * `RELEASE` prompt, then answers `survived`; `EARLY` returns with no event at
 * all (no `message_end`, no `agent_end`); `FAIL` ends in an error; anything
 * else answers `fine`.
 */
function scriptedEphemeralPreload(markerFile: string): string {
  return `
    import { mock } from 'bun:test'
    import { appendFileSync } from 'node:fs'
    const mark = line => {
      appendFileSync(${JSON.stringify(markerFile)}, line + '\\n')
      process.stderr.write(line + '\\n')
    }
    const survivors = []
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
            if (options?.strategy?.kind !== 'memory') return handle
            let listener
            let label = 'UNPROMPTED'
            let releaseSlow
            handle.session.subscribe = next => {
              listener = next
              return () => { if (listener === next) listener = undefined }
            }
            handle.session.abort = async () => {
              mark('ABORTED:' + label)
              releaseSlow?.()
            }
            const dispose = handle.dispose
            handle.dispose = () => {
              mark('DISPOSED:' + label)
              return dispose.call(handle)
            }
            handle.session.prompt = async text => {
              label = text
              const emit = event => listener?.(event)
              const answer = content => {
                emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: content }] } })
                emit({ type: 'agent_end', messages: [], willRetry: false })
              }
              if (text.startsWith('SLOW')) {
                mark('WAITING:' + text)
                await new Promise(resolve => { releaseSlow = resolve })
                return
              }
              if (text === 'SURVIVOR') {
                mark('WAITING:' + text)
                await new Promise(resolve => { survivors.push(resolve) })
                answer('survived')
                return
              }
              if (text === 'RELEASE') {
                for (const release of survivors.splice(0)) release()
                answer('released')
                return
              }
              if (text === 'EARLY') {
                mark('RETURNED:' + text)
                return
              }
              if (text === 'FAIL') {
                emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'F1239_UTILITY_FAIL', content: [] } })
                emit({ type: 'agent_end', messages: [], willRetry: false })
                return
              }
              answer('fine')
            }
            return handle
          },
        }
      },
    }))
  `
}

type Msg = Record<string, any>

interface RigStep {
  /** Called on every stdout message, stderr chunk and poll; sends what the state now allows. */
  tick(rig: Rig): void
  /** Called for every parsed stdout message before `tick`. */
  onMessage?(msg: Msg, rig: Rig): void
  /** True once the arm has everything it needs. */
  done(rig: Rig): boolean
}

interface Rig {
  readonly received: Msg[]
  readyCount: number
  readonly sent: Set<string>
  write(msg: Msg): void
  markers(): string[]
  stderr(): string
  exitCode: number | null | undefined
  readonly initMessage: Msg
}

async function runRig(tag: string, step: RigStep): Promise<Rig> {
  const sessionPath = mkdtempSync(join(tmpdir(), `nessy-${tag}-session-`))
  const cwd = mkdtempSync(join(tmpdir(), `nessy-${tag}-cwd-`))
  const workspaceId = `${tag}-real-server-workspace`
  const sessionId = `${tag}-real-server`
  const markerFile = join(sessionPath, 'markers.log')
  writeFileSync(markerFile, '')
  const preloadPath = join(sessionPath, 'scripted-ephemeral-preload.ts')
  writeFileSync(preloadPath, scriptedEphemeralPreload(markerFile))
  const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // A write racing the child's exit must not surface as an unhandled stream error in another arm.
  child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  // Once the arm has settled, every late child event (its exit after the teardown kill, a trailing
  // stderr chunk) is ignored, and the markers read from the snapshot taken before the files go.
  let closed = false
  let finalMarkers: string[] = []
  const readMarkers = (): string[] => {
    try { return readFileSync(markerFile, 'utf8').split('\n').filter(Boolean) } catch { return [] }
  }
  const rig: Rig = {
    received: [],
    readyCount: 0,
    sent: new Set(),
    write: msg => { if (!closed) child.stdin.write(`${JSON.stringify(msg)}\n`) },
    markers: () => (closed ? finalMarkers : readMarkers()),
    stderr: () => stderr,
    exitCode: undefined,
    initMessage: {
      type: 'init',
      apiKey: 'test',
      model: 'f1239-model',
      miniModel: 'f1239-model',
      cwd,
      workingDirectory: cwd,
      workspaceRootPath: cwd,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: 'http://127.0.0.1:9/v1',
      customEndpoint: { api: 'openai-completions' },
      customModels: ['f1239-model'],
      executionManifest: createRealServerExecutionManifest({ workspaceId, sessionId }),
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    },
  }
  const describeState = () => `${JSON.stringify(rig.received)}\nmarkers: ${JSON.stringify(rig.markers())}\n${stderr}`
  let poll: ReturnType<typeof setInterval> | undefined
  let clock: RealServerClock | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const advance = () => {
        if (closed) return
        try {
          step.tick(rig)
          if (step.done(rig)) resolve()
        } catch (error) {
          reject(error)
        }
      }
      clock = startRealServerClock({
        answerWaitMs: ANSWER_WAIT_MS,
        onExpire: (_phase, why) => reject(new Error(`${tag} ${why}\n${describeState()}`)),
      })
      child.on('error', reject)
      child.on('exit', code => {
        rig.exitCode = code
        if (closed) return
        advance()
        // A child that exits before the arm is done can never finish it (a no-op once resolved).
        reject(new Error(`${tag} real server exited (${code}) before the arm was done\n${describeState()}`))
      })
      child.stderr.on('data', chunk => { stderr += String(chunk); advance() })
      lines.on('line', raw => {
        if (closed) return
        let msg: Msg
        try { msg = JSON.parse(raw) } catch { return }
        if (msg.type === 'startup_error') {
          reject(new Error(`${msg.code}: ${msg.message}\n${stderr}`))
          return
        }
        if (msg.type === 'ready') {
          rig.readyCount += 1
          // Only the first `ready` moves the clock; the re-init's second one does not restart it.
          clock?.ready()
        }
        if (['ready', 'error', 'llm_query_result', 'mini_completion_result'].includes(msg.type)) {
          rig.received.push(msg)
          step.onMessage?.(msg, rig)
        }
        advance()
      })
      poll = setInterval(advance, 250)
      rig.write(rig.initMessage)
    })
    return rig
  } finally {
    clock?.clear()
    clearInterval(poll)
    finalMarkers = readMarkers()
    closed = true
    if (rig.exitCode === undefined) {
      try { child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`) } catch { /* already gone */ }
      child.kill()
    }
    lines.close()
    rmSync(sessionPath, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

const answered = (rig: Rig, type: string, id: string) => rig.received.find(msg => msg.type === type && msg.id === id)
const sendOnce = (rig: Rig, key: string, msg: Msg) => {
  if (rig.sent.has(key)) return
  rig.sent.add(key)
  rig.write(msg)
}

describe('F1.239 · the real Pi server routes utility failures and cancellations by request id', () => {
  it('F1.305 · the subprocess deadline answers inside the host RPC timeout', () => {
    // The subprocess must answer (and abort its session) BEFORE the host gives up on the RPC.
    expect(EPHEMERAL_QUERY_DEADLINE_MS).toBeGreaterThan(0)
    expect(EPHEMERAL_QUERY_DEADLINE_MS).toBeLessThan(LLM_QUERY_TIMEOUT_MS)
  })

  // The two real-server arms boot their own server CONCURRENTLY: the boot is the whole cost (see REAL_SERVER_BOOT_WAIT_MS).
  // They stay adjacent — bun runs only CONSECUTIVE concurrent tests together.
  it.concurrent('a failure carries its id, a sibling still answers, and a cancel aborts only its own session', async () => {
    const rig = await runRig('f1239', {
      tick(rig) {
        if (rig.readyCount < 1) return
        sendOnce(rig, 'q-slow', { type: 'llm_query', id: 'q-slow', request: { prompt: 'SLOW', model: 'f1239-model' } })
        sendOnce(rig, 'q-fail', { type: 'llm_query', id: 'q-fail', request: { prompt: 'FAIL', model: 'f1239-model' } })
        sendOnce(rig, 'm-fail', { type: 'mini_completion', id: 'm-fail', prompt: 'FAIL' })
        sendOnce(rig, 'q-ok', { type: 'llm_query', id: 'q-ok', request: { prompt: 'OK', model: 'f1239-model' } })
        // F1.304 — still in flight when the cancels land.
        sendOnce(rig, 'q-survivor', { type: 'llm_query', id: 'q-survivor', request: { prompt: 'SURVIVOR', model: 'f1239-model' } })
        // F1.305 — a slow MINI completion, cancelled like the slow query.
        sendOnce(rig, 'm-slow', { type: 'mini_completion', id: 'm-slow', prompt: 'SLOW' })

        // Once the quick ones are in and every slow session is waiting, the host gives up on q-slow and m-slow.
        const markers = rig.markers()
        const quickIn = !!answered(rig, 'llm_query_result', 'q-fail') && !!answered(rig, 'llm_query_result', 'q-ok')
          && rig.received.some(msg => msg.id === 'm-fail')
        const slowWaiting = markers.filter(line => line === 'WAITING:SLOW').length === 2
          && markers.includes('WAITING:SURVIVOR')
        if (quickIn && slowWaiting) {
          sendOnce(rig, 'cancel-q-slow', { type: 'cancel_ephemeral_query', id: 'q-slow' })
          sendOnce(rig, 'cancel-m-slow', { type: 'cancel_ephemeral_query', id: 'm-slow' })
        }
        // Only after both cancels have answered (in any form, so a wrong answer is asserted below rather than
        // timing the arm out) is the survivor released.
        if (answered(rig, 'llm_query_result', 'q-slow') && rig.received.some(msg => msg.id === 'm-slow')) {
          sendOnce(rig, 'q-release', { type: 'llm_query', id: 'q-release', request: { prompt: 'RELEASE', model: 'f1239-model' } })
        }
      },
      done(rig) {
        return !!answered(rig, 'llm_query_result', 'q-survivor') && !!answered(rig, 'llm_query_result', 'q-release')
          && rig.received.some(msg => msg.id === 'm-fail')
      },
    })

    const errors = rig.received.filter(msg => msg.type === 'error')
    // Every utility failure names the request it belongs to — and a cancelled mini completion is not one (F1.305).
    expect(errors.map(msg => ({ code: msg.code, id: msg.id })).sort((a, b) => String(a.id).localeCompare(String(b.id))))
      .toEqual([{ code: 'mini_completion_error', id: 'm-fail' }, { code: 'llm_query_error', id: 'q-fail' }])
    // The sibling answered normally.
    expect(answered(rig, 'llm_query_result', 'q-ok')?.result?.text).toBe('fine')
    // The cancelled query answered as cancelled.
    const slow = answered(rig, 'llm_query_result', 'q-slow')
    expect(slow?.result).toBeNull()
    expect(String(slow?.errorMessage)).toContain('cancelled')
    // F1.305 — the cancelled mini completion answered the host's best-effort null.
    expect(answered(rig, 'mini_completion_result', 'm-slow')).toEqual({ type: 'mini_completion_result', id: 'm-slow', text: null })
    // F1.304 — the query still in flight at the cancels was not cancelled with them.
    expect(answered(rig, 'llm_query_result', 'q-survivor')?.result?.text).toBe('survived')
    // Exactly the two cancelled sessions were aborted — never the survivor.
    expect(rig.markers().filter(line => line.startsWith('ABORTED:')).sort()).toEqual(['ABORTED:SLOW', 'ABORTED:SLOW'])
  }, ARM_BUDGET_MS)

  it.concurrent('F1.303 / F1.306 · an early-returning prompt is disposed before it answers; a re-init and a shutdown cancel in-flight queries', async () => {
    let earlyDisposedAtAnswer: boolean | undefined
    let reinitSentAt = 0
    let reinitLeftRunning = false
    const rig = await runRig('f1303', {
      onMessage(msg, rig) {
        if (msg.type === 'llm_query_result' && msg.id === 'q-early') {
          earlyDisposedAtAnswer = rig.markers().includes('DISPOSED:EARLY')
        }
      },
      tick(rig) {
        if (rig.readyCount < 1) return
        const markers = rig.markers()
        // F1.306 — a prompt that returns with no agent_end; the host then gives up on it.
        sendOnce(rig, 'q-early', { type: 'llm_query', id: 'q-early', request: { prompt: 'EARLY', model: 'f1239-model' } })
        if (markers.includes('RETURNED:EARLY')) {
          sendOnce(rig, 'cancel-q-early', { type: 'cancel_ephemeral_query', id: 'q-early' })
        }
        // F1.303 — a re-init while a utility query is in flight.
        if (answered(rig, 'llm_query_result', 'q-early')) {
          sendOnce(rig, 'q-reinit', { type: 'llm_query', id: 'q-reinit', request: { prompt: 'SLOW_REINIT', model: 'f1239-model' } })
        }
        if (markers.includes('WAITING:SLOW_REINIT') && !rig.sent.has('reinit')) {
          reinitSentAt = Date.now()
          sendOnce(rig, 'reinit', rig.initMessage)
        }
        // A re-init that cancels nothing leaves q-reinit to its own 115 s deadline; after 60 s the arm records
        // that and goes on, so ONE run reports every finding below instead of stopping at the first.
        if (reinitSentAt && !answered(rig, 'llm_query_result', 'q-reinit') && Date.now() - reinitSentAt > 60_000) {
          reinitLeftRunning = true
        }
        // F1.303 — a shutdown while a utility query is in flight.
        if (rig.readyCount >= 2 && (answered(rig, 'llm_query_result', 'q-reinit') || reinitLeftRunning)) {
          sendOnce(rig, 'q-shutdown', { type: 'llm_query', id: 'q-shutdown', request: { prompt: 'SLOW_SHUTDOWN', model: 'f1239-model' } })
        }
        if (markers.includes('WAITING:SLOW_SHUTDOWN')) {
          sendOnce(rig, 'shutdown', { type: 'shutdown' })
        }
      },
      done(rig) {
        return rig.sent.has('shutdown') && rig.exitCode !== undefined
      },
    })

    const reinit = answered(rig, 'llm_query_result', 'q-reinit')
    const markers = rig.markers()
    // One comparison, so a run names every finding at once.
    expect({
      // F1.306 — the early-returning session was disposed BEFORE its request answered, and the request answered
      // as a (textless) completion instead of waiting for the cancel.
      earlyDisposedAtAnswer,
      earlyText: answered(rig, 'llm_query_result', 'q-early')?.result?.text,
      // F1.303 — the re-init cancelled the in-flight query and aborted its session.
      reinitLeftRunning,
      reinitResult: reinit?.result,
      reinitCancelledByReinit: String(reinit?.errorMessage).includes('reinitialized'),
      reinitAborted: markers.includes('ABORTED:SLOW_REINIT'),
      // F1.303 — the shutdown aborted the in-flight session, and the process still exited cleanly.
      shutdownAborted: markers.includes('ABORTED:SLOW_SHUTDOWN'),
      exitCode: rig.exitCode,
    }).toEqual({
      earlyDisposedAtAnswer: true,
      earlyText: '',
      reinitLeftRunning: false,
      reinitResult: null,
      reinitCancelledByReinit: true,
      reinitAborted: true,
      shutdownAborted: true,
      exitCode: 0,
    })
  }, ARM_BUDGET_MS)
})
