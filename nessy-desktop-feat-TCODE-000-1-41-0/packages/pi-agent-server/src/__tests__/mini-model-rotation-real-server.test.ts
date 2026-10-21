/**
 * UB12.11 — a live Pi subprocess's mini model follows the host's re-resolution,
 * driven through the REAL Pi server.
 *
 * The host resolves the background tier's model (`getMiniModel`, which asks the
 * gateway's `fast` alias first) when it builds the agent, and the subprocess
 * reads it as `config.miniModel` on every title and mini completion
 * (`queryLlm`). The gateway rotates the id behind the alias and keeps the alias,
 * and the catalogue refresh reaches a live session through
 * `update_runtime_config` (`SessionManager.runAgentRuntimeRefresh`, with the
 * connection's models in the runtime signature). Before this row that envelope
 * carried no `miniModel`, so after a rotation the subprocess kept asking for the
 * retired fast id, which the refreshed endpoint registry no longer lists, and
 * UB4.9's `pickCustomEndpointUtilityModel` sent every title to the session's
 * (coder) model until a respawn: correct, but billed at the flagship rate.
 *
 * The rig is `utility-model-route-real-server.test.ts`'s: `index.ts` spawned
 * with a `--preload` that wraps `createPiRuntimeAdapter`, so each EPHEMERAL
 * session answers `by:<the model it was built on>` with no network. One child,
 * three titles in sequence:
 *  - `before`: the init's mini model (the control the other two move from);
 *  - `absentKeeps` (NEGATIVE): an update that carries no `miniModel` (an older
 *    host, or a connection whose resolution answers nothing) leaves the init's
 *    mini model in place rather than clearing it;
 *  - `rotated` (POSITIVE): the catalogue rotates `fast` to a new id and the
 *    update carries the host's re-resolved id; the next title runs on it.
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

/** From the first `ready`: three titles and two updates, each answered in milliseconds. */
const ANSWER_WAIT_MS = 120_000
const ARM_BUDGET_MS = realServerTestBudget(ANSWER_WAIT_MS)

/** The id the gateway's `fast` alias named at spawn, the one it names after the rotation, and `coder`. */
const FAST_OLD = 'ub1211-fast-retired'
const FAST_NEW = 'ub1211-fast-current'
const CODER = 'ub1211-coder'

const ENDPOINT = {
  baseUrl: 'http://127.0.0.1:9/v1',
  customEndpoint: { api: 'openai-completions' },
}

/** Every ephemeral session marks `MODEL:<provider>|<id>|<baseUrl>` and answers `by:<model id>`. */
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
            handle.session.prompt = async () => {
              const emit = event => listener?.(event)
              emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'by:' + model.id }] } })
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

describe('UB12.11 · the real Pi server takes the mini model an update_runtime_config carries', () => {
  it('a title after a fast-alias rotation runs on the re-resolved id, and an update without one keeps the init mini model', async () => {
    const tag = 'ub1211'
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
    const titleOf = (id: string) => received.find(msg => msg.type === 'mini_completion_result' && msg.id === id)
    const updateOf = (id: string) => received.find(msg => msg.type === 'update_runtime_config_result' && msg.id === id)
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
          if (msg.type === 'error') { received.push(msg); reject(new Error(`${tag} error: ${raw}\n${stderr}`)); return }
          if (msg.type === 'ready') {
            clock?.ready()
            write({ type: 'mini_completion', id: 'title-before', prompt: 'title' })
            return
          }
          if (msg.type !== 'mini_completion_result' && msg.type !== 'update_runtime_config_result') return
          received.push(msg)
          if (msg.id === 'title-before') {
            // The same catalogue, and no `miniModel` on the envelope.
            write({ type: 'update_runtime_config', id: 'update-absent', model: CODER, ...ENDPOINT, customModels: [FAST_OLD, CODER] })
          } else if (msg.id === 'update-absent') {
            write({ type: 'mini_completion', id: 'title-absent', prompt: 'title' })
          } else if (msg.id === 'title-absent') {
            // The gateway rotated `fast`; the host re-resolved it and carries the new id.
            write({ type: 'update_runtime_config', id: 'update-rotated', model: CODER, ...ENDPOINT, customModels: [FAST_NEW, CODER], miniModel: FAST_NEW })
          } else if (msg.id === 'update-rotated') {
            write({ type: 'mini_completion', id: 'title-rotated', prompt: 'title' })
          } else if (msg.id === 'title-rotated') {
            resolve()
          }
        })
        write({
          type: 'init',
          model: CODER,
          miniModel: FAST_OLD,
          cwd,
          workingDirectory: cwd,
          workspaceRootPath: cwd,
          workspaceId,
          sessionId,
          sessionPath,
          plansFolderPath: join(sessionPath, 'plans'),
          thinkingLevel: 'off',
          ...ENDPOINT,
          customModels: [FAST_OLD, CODER],
          executionManifest: createRealServerExecutionManifest({ workspaceId, sessionId }),
          // The gateway card's shape: the wire protocol names the provider the credential is stored under.
          piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'ub1211-fixture-key' } },
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
      updates: [updateOf('update-absent')?.success, updateOf('update-rotated')?.success],
      before: titleOf('title-before')?.text,
      absentKeeps: titleOf('title-absent')?.text,
      rotated: titleOf('title-rotated')?.text,
      providers: [...new Set(markers.map(line => line.slice('MODEL:'.length).split('|')[0]))],
    }).toEqual({
      updates: [true, true],
      before: `by:${FAST_OLD}`,
      absentKeeps: `by:${FAST_OLD}`,
      rotated: `by:${FAST_NEW}`,
      providers: ['custom-endpoint'],
    })
  }, ARM_BUDGET_MS)
})
