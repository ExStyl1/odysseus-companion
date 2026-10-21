/**
 * UB12.10 — the MAIN session's model on a custom endpoint stays on the endpoint,
 * driven through the REAL Pi server at all three sites that set it:
 * `buildSessionDefinition` (init, reached through `ensure_session_ready`),
 * `handleSetModel` (`set_model`) and `handleUpdateRuntimeConfig`
 * (`update_runtime_config`).
 *
 * The shape is the Nessy Gateway Pi card's: a custom endpoint whose wire
 * protocol is `openai`, so the endpoint's credential is stored under `openai`
 * while pi-ai's built-in `openai` provider stays registered at its public URL.
 * Measured before the fix (2026-10-16, the shipped catalogue): `gpt-5.5` and
 * `pi/gpt-5-mini` resolve to provider `openai` at `https://api.openai.com/v1`,
 * and `getApiKeyAndHeaders` hands that model the stored fixture key. Each site
 * accepted it (init's check was upstream's `resolvedProvider === authProvider`;
 * the other two had none), so the conversation and the endpoint's credential
 * went to the public URL. `mini-model-query.test.ts` pins the helper with a fake
 * registry; this arm proves the wiring on the real one.
 *
 * The control is a plain OpenAI key connection (no custom endpoint) on the same
 * ids: it keeps the built-in model, as before the row.
 *
 * The rig is `utility-model-route-real-server.test.ts`'s (UB4.9): `index.ts`
 * spawned with a `--preload` that wraps `createPiRuntimeAdapter`. Here it records
 * the model each MAIN session is created on and every `session.setModel` call.
 * Nothing is prompted, so nothing reaches the network; the credential is a
 * fixture string. Both servers run at once, so the arm pays one boot.
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

/** From the first `ready`: a session build, a model switch and a runtime update — none prompts. */
const ANSWER_WAIT_MS = 120_000
const ARM_BUDGET_MS = realServerTestBudget(ANSWER_WAIT_MS)

const ENDPOINT = 'http://127.0.0.1:9/v1'
const CODER = 'ub1210-coder'

/** Marks `INIT:` for each main session's model and `SET:` for each `setModel`, as `provider|id|baseUrl`. */
function sessionModelPreload(markerFile: string): string {
  return `
    import { mock } from 'bun:test'
    import { appendFileSync } from 'node:fs'
    const mark = (kind, model) => appendFileSync(${JSON.stringify(markerFile)}, kind + ':' + (model ? model.provider + '|' + model.id + '|' + model.baseUrl : 'none') + '\\n')
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
            if (options?.strategy?.kind === 'memory') return handle
            mark('INIT', options?.sessionOptions?.model)
            const setModel = handle.session.setModel.bind(handle.session)
            handle.session.setModel = async (model, ...rest) => {
              mark('SET', model)
              return setModel(model, ...rest)
            }
            return handle
          },
        }
      },
    }))
  `
}

type Msg = Record<string, any>

interface Scenario {
  tag: string
  /** The connection-specific part of `init` (and of the runtime update). */
  connection: Msg
  initModel: string
  setModel: string
  updateModel: string
}

/** Boots one real server, builds its main session, switches the model, then updates the runtime config. */
async function drive(scenario: Scenario): Promise<{ markers: string[]; update: Msg | undefined }> {
  const { tag } = scenario
  const sessionPath = mkdtempSync(join(tmpdir(), `nessy-${tag}-session-`))
  const cwd = mkdtempSync(join(tmpdir(), `nessy-${tag}-cwd-`))
  const workspaceId = `${tag}-real-server-workspace`
  const sessionId = `${tag}-real-server`
  const markerFile = join(sessionPath, 'markers.log')
  writeFileSync(markerFile, '')
  const preloadPath = join(sessionPath, 'session-model-preload.ts')
  writeFileSync(preloadPath, sessionModelPreload(markerFile))
  const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  let update: Msg | undefined
  let stderr = ''
  let closed = false
  let exited = false
  const write = (msg: Msg) => { if (!closed) child.stdin.write(`${JSON.stringify(msg)}\n`) }
  const readMarkers = (): string[] => {
    try { return readFileSync(markerFile, 'utf8').split('\n').filter(Boolean) } catch { return [] }
  }
  let clock: RealServerClock | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const describeState = () => `markers: ${JSON.stringify(readMarkers())}\n${stderr}`
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
      let asked = false
      lines.on('line', raw => {
        if (closed) return
        let msg: Msg
        try { msg = JSON.parse(raw) } catch { return }
        if (msg.type === 'startup_error') { reject(new Error(`${msg.code}: ${msg.message}\n${stderr}`)); return }
        if (msg.type === 'ready' && !asked) {
          asked = true
          clock?.ready()
          write({ type: 'ensure_session_ready', id: `${tag}-ensure` })
        }
        if (msg.type === 'ensure_session_ready_result') {
          // set_model's handler marks synchronously before its first await, and the
          // runtime update awaits the reasoning-proxy step first, so SET order is fixed.
          write({ type: 'set_model', model: scenario.setModel })
          write({ type: 'update_runtime_config', id: `${tag}-update`, model: scenario.updateModel, ...scenario.connection })
        }
        if (msg.type === 'update_runtime_config_result') {
          update = msg
          resolve()
        }
      })
      write({
        type: 'init',
        model: scenario.initModel,
        cwd,
        workingDirectory: cwd,
        workspaceRootPath: cwd,
        workspaceId,
        sessionId,
        sessionPath,
        plansFolderPath: join(sessionPath, 'plans'),
        thinkingLevel: 'off',
        ...scenario.connection,
        executionManifest: createRealServerExecutionManifest({ workspaceId, sessionId }),
        piAuth: { provider: 'openai', credential: { type: 'api_key', key: `${tag}-fixture-key` } },
      })
    })
    return { markers: readMarkers(), update }
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
}

describe('UB12.10 · the real Pi server keeps a custom endpoint\'s session model on the endpoint', () => {
  it('init, set_model and update_runtime_config never land on the public openai model on the gateway card; a plain key is unchanged', async () => {
    const [gateway, plainKey] = await Promise.all([
      drive({
        tag: 'ub1210-gw',
        // The gateway card's shape: wire protocol `openai`, the credential stored under it.
        connection: { baseUrl: ENDPOINT, customEndpoint: { api: 'openai-completions' }, customModels: [CODER] },
        initModel: 'gpt-5.5',
        setModel: 'pi/gpt-5-mini',
        updateModel: 'gpt-5.2',
      }),
      drive({
        tag: 'ub1210-key',
        connection: {},
        initModel: 'gpt-5.5',
        setModel: 'gpt-5.2',
        updateModel: 'gpt-5.1',
      }),
    ])

    // One comparison per server, so a red names every site at once.
    expect({ markers: gateway.markers, success: gateway.update?.success }).toEqual({
      markers: [
        `INIT:custom-endpoint|gpt-5.5|${ENDPOINT}`,
        `SET:custom-endpoint|gpt-5-mini|${ENDPOINT}`,
        `SET:custom-endpoint|gpt-5.2|${ENDPOINT}`,
      ],
      success: true,
    })
    expect({ markers: plainKey.markers, success: plainKey.update?.success }).toEqual({
      markers: [
        'INIT:openai|gpt-5.5|https://api.openai.com/v1',
        'SET:openai|gpt-5.2|https://api.openai.com/v1',
        'SET:openai|gpt-5.1|https://api.openai.com/v1',
      ],
      success: true,
    })
  }, ARM_BUDGET_MS)
})
