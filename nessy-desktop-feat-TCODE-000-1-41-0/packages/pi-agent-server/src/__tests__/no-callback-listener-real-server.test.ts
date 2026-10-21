/**
 * F1.710 — the Pi subprocess publishes no callback port, because it runs no
 * callback listener.
 *
 * At HEAD `handleInit` started an `http` server on `127.0.0.1:<ephemeral>` that
 * answered `POST /call-llm` by running a model query on this session's model
 * and credentials, with no token and no session check, and published its port
 * in the `ready` message. Nothing read that port: the host stored it and never
 * used it, and no spawn passed it to the only client (`session-mcp-server`'s
 * `--callback-port`). Any same-user local process that found the port could
 * spend the session's credentials.
 *
 * The rig is `pi-runtime-h1-real-server.test.ts`'s, trimmed to the handshake:
 * the REAL `index.ts`, one `init`, and the `ready` it answers. Nothing is
 * prompted, so the stub upstream exists only so that `init` names a reachable
 * endpoint.
 *
 * THE DEFECT — `ready` carried `callbackPort`, a live listener's port.
 * CONTROL — the handshake itself is unchanged: `ready` still arrives and still
 * names the supported runtime version, which is what the host waits for.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

import { SUPPORTED_PI_RUNTIME_VERSION } from '../compat/pi-runtime-adapter.ts'
import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts'

/** From the child's first `ready`; the boot has its own budget (`support/real-server-clock.ts`). */
const ANSWER_WAIT_MS = 60_000

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const repoRoot = join(here, '..', '..', '..', '..')

describe('F1.710 — the Pi subprocess serves no callback listener', () => {
  it('answers init with a ready that carries no callback port, and the handshake is otherwise intact', async () => {
    const stub = http.createServer((_req, res) => { res.writeHead(404); res.end() })
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve))
    const address = stub.address()
    if (!address || typeof address === 'string') throw new Error('stub did not bind')
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-f1710-session-'))
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-f1710-cwd-'))
    const workspaceId = 'f1710-workspace'
    const sessionId = 'f1710-session'
    const executionManifest = createRealServerExecutionManifest({ workspaceId, sessionId })

    const child = spawn(process.execPath, [entrypoint], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })

    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: ANSWER_WAIT_MS,
        onExpire: (_phase, message) => reject(new Error(`F1.710 ${message}\n${stderr}`)),
      })
      child.on('error', reject)
      lines.on('line', line => {
        let message: Record<string, unknown>
        try { message = JSON.parse(line) } catch { return }
        if (message.type === 'startup_error' || message.type === 'error') {
          clock.clear()
          reject(new Error(`${String(message.code)}: ${String(message.message)}\n${stderr}`))
          return
        }
        if (message.type === 'ready') {
          clock.clear()
          resolve(message)
        }
      })
    })

    child.stdin.write(`${JSON.stringify({
      type: 'init',
      apiKey: 'test',
      model: 'f1710-model',
      cwd,
      workingDirectory: cwd,
      workspaceRootPath: cwd,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      customEndpoint: { api: 'openai-completions' },
      customModels: ['f1710-model'],
      executionManifest,
      piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    })}\n`)

    try {
      const message = await ready
      // THE DEFECT — no port is published, so there is nothing for a local
      // process to find. The key set is exact: a renamed port field fails too.
      expect(Object.keys(message).sort()).toEqual(['runtimeVersion', 'sessionId', 'type'])
      // CONTROL — the handshake the host waits for is the same one.
      expect(message.runtimeVersion).toBe(SUPPORTED_PI_RUNTIME_VERSION)
      expect(stderr).not.toContain('Callback server listening')
    } finally {
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      child.kill()
      lines.close()
      await new Promise<void>(resolve => stub.close(() => resolve()))
      rmSync(sessionPath, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  }, realServerTestBudget(ANSWER_WAIT_MS))
})
