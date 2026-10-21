/**
 * UB4.9 — the custom-endpoint route rule, driven through the REAL Pi server.
 *
 * `mini-model-query.test.ts` pins the two helpers and the loop with a fake
 * registry; this arm drives `index.ts`'s `queryLlm` (the entry guard, the
 * `queryMiniModel` loop and the route refusal in `runQueryWithModel`) against
 * the shipped Pi catalogue, on the Nessy Gateway Pi card's shape: a custom
 * endpoint whose wire protocol is `openai`, so the endpoint's credential is
 * stored under `openai` while pi-ai's built-in `openai` provider stays
 * registered at its public URL.
 *
 * Measured before the fix (2026-10-16, the same registry composition):
 * `pi/gpt-5-mini`, all seven `PI_PREFERRED_DEFAULTS.openai` ids and the entry
 * guard's provider default `gpt-6-luna` resolve to provider `openai` at
 * `https://api.openai.com/v1`. So at HEAD:
 *  - a rejected endpoint mini model was retried on `pi/gpt-5-mini` (public API);
 *  - a request naming a model the endpoint does not serve (`call_llm` with
 *    `haiku` → `claude-haiku-5-5`) ran on `gpt-6-luna` (public API).
 * Both now stay on the endpoint: the loop goes to the session's model, the entry
 * guard to the host-resolved mini model.
 *
 * The rig is `ephemeral-query-routing-real-server.test.ts`'s: `index.ts` spawned
 * with a `--preload` that wraps `createPiRuntimeAdapter`, so each EPHEMERAL
 * session records the model it was built on and its `prompt` is scripted — no
 * network, and the main session is never prompted. The credential is a fixture
 * string.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { realServerTestBudget, startRealServerClock, type RealServerClock } from './support/real-server-clock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href
const repoRoot = join(here, '..', '..', '..', '..')

/** From the first `ready`: two utility queries, each answered in milliseconds by the scripted session. */
const ANSWER_WAIT_MS = 120_000
const ARM_BUDGET_MS = realServerTestBudget(ANSWER_WAIT_MS)

const FAST = 'ub49-fast'
const CODER = 'ub49-coder'

/**
 * Every ephemeral session marks `MODEL:<provider>|<id>|<baseUrl>` at creation.
 * Prompt `REJECT_FAST` fails on the endpoint's fast model with a rejection that
 * names it; anything else answers `by:<model id>`.
 */
function scriptedEphemeralPreload(markerFile: string): string {
  return `
    import { mock } from 'bun:test'
    import { appendFileSync } from 'node:fs'
    const mark = line => appendFileSync(${JSON.stringify(markerFile)}, line + '\\n')
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
            const model = options?.sessionOptions?.model ?? {}
            mark('MODEL:' + model.provider + '|' + model.id + '|' + model.baseUrl)
            let listener
            handle.session.subscribe = next => {
              listener = next
              return () => { if (listener === next) listener = undefined }
            }
            handle.session.prompt = async text => {
              const emit = event => listener?.(event)
              if (text === 'REJECT_FAST' && model.id === ${JSON.stringify(FAST)}) {
                emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '404 The model \`' + model.id + '\` does not exist', content: [] } })
              } else {
                emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'by:' + model.id }] } })
              }
              emit({ type: 'agent_end', messages: [], willRetry: false })
            }
            return handle
          },
        }
      },
    }))
  `
}

type Msg = Record<string, any>

describe('UB4.9 · the real Pi server keeps a custom endpoint\'s utility queries on the endpoint', () => {
  it('a rejected mini model falls to the session model, and an unserved request model to the mini model — never the public API', async () => {
    const tag = 'ub49'
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
    child.stdin.on('error', () => {})
    const lines = createInterface({ input: child.stdout })
    const received: Msg[] = []
    let stderr = ''
    let closed = false
    let exited = false
    const write = (msg: Msg) => { if (!closed) child.stdin.write(`${JSON.stringify(msg)}\n`) }
    const readMarkers = (): string[] => {
      try { return readFileSync(markerFile, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    }
    const result = (id: string) => received.find(msg => msg.type === 'llm_query_result' && msg.id === id)
    let clock: RealServerClock | undefined
    let markers: string[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const describeState = () => `${JSON.stringify(received)}\nmarkers: ${JSON.stringify(readMarkers())}\n${stderr}`
        clock = startRealServerClock({
          answerWaitMs: ANSWER_WAIT_MS,
          onExpire: (_phase, why) => reject(new Error(`${tag} ${why}\n${describeState()}`)),
        })
        child.on('error', reject)
        child.on('exit', code => {
          exited = true
          if (!closed) reject(new Error(`${tag} real server exited (${code}) before the arm was done\n${describeState()}`))
        })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        lines.on('line', raw => {
          if (closed) return
          let msg: Msg
          try { msg = JSON.parse(raw) } catch { return }
          if (msg.type === 'startup_error') { reject(new Error(`${msg.code}: ${msg.message}\n${stderr}`)); return }
          if (msg.type === 'ready') {
            clock?.ready()
            // The mini model (the endpoint's fast id) rejects; the loop must go to the session's model.
            write({ type: 'llm_query', id: 'q-reject', request: { prompt: 'REJECT_FAST' } })
            // A model the endpoint does not serve (what `call_llm` sends for `haiku`).
            write({ type: 'llm_query', id: 'q-unserved', request: { prompt: 'OK', model: 'claude-haiku-5-5' } })
          }
          if (msg.type === 'llm_query_result') received.push(msg)
          if (result('q-reject') && result('q-unserved')) resolve()
        })
        write({
          type: 'init',
          model: CODER,
          miniModel: FAST,
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
          customModels: [FAST, CODER],
          executionManifest: createRealServerExecutionManifest({ workspaceId, sessionId }),
          // The gateway card's shape: the wire protocol names the provider the credential is stored under.
          piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'ub49-fixture-key' } },
        })
      })
      markers = readMarkers()
    } finally {
      clock?.clear()
      closed = true
      if (!exited) {
        try { child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`) } catch { /* already gone */ }
        child.kill()
      }
      lines.close()
      rmSync(sessionPath, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }

    // One comparison, so a red names every finding at once.
    expect({
      reject: result('q-reject')?.result,
      unserved: result('q-unserved')?.result,
      providers: [...new Set(markers.map(line => line.slice('MODEL:'.length).split('|')[0]))],
    }).toEqual({
      reject: { text: `by:${CODER}`, model: CODER },
      unserved: { text: `by:${FAST}`, model: FAST },
      providers: ['custom-endpoint'],
    })
  }, ARM_BUDGET_MS)
})
