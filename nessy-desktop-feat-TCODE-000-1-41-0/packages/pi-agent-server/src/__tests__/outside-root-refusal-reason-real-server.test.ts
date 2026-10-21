/**
 * F1.959 — what a Guardian judge is TOLD when the host refuses its read outside
 * the session root.
 *
 * F1.861's early door (`refuseGuardianJudgeCard`, `agent/pi-agent.ts`) answers a
 * judge child's `outside_root_request` with `root: null` and shows no card. F1.955
 * measured that the OpenAI-completions wire drops a tool result's `isError`, so
 * the TEXT is all a gateway judge sees, and gave the host's other doors a
 * no-content header. This door had none: the suspended call failed with the scope
 * error's own sentence.
 *
 * The instrument is the one that cannot be wrong about it: the REAL `index.ts`
 * subprocess against a local OpenAI-completions stub (the H1A rig,
 * `pi-runtime-h1-real-server.test.ts`), reading the `role: 'tool'` message in
 * the NEXT request body — the bytes the gateway judge receives. The model is
 * scripted to read two files outside the session root; this test plays the host
 * and refuses both, the first the way the judge door now does (with the host's
 * `reason`), the second the way an ordinary Deny does (`root: null` alone).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

import { GUARDIAN_JUDGE_HOST_REFUSAL } from '../../../shared/src/prompts/guardian.ts'
import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { isPiPreToolUseRequest, piPreToolUseResponse } from './support/pi-permission-receipt-fixture.ts'
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts'

const ANSWER_WAIT_MS = 120_000

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const repoRoot = join(here, '..', '..', '..', '..')

/** One scripted completion per request: a `read` tool call, or the final text. */
type Step = { read: string } | { text: string }

async function startStub(steps: Step[]): Promise<{ baseUrl: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      const index = requests.length
      requests.push(body)
      const step = steps[Math.min(index, steps.length - 1)]!
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = { id: `f1959-${index}`, object: 'chat.completion.chunk', created: 1, model: 'f1959-model' }
      if ('read' in step) {
        const call = { index: 0, id: `f1959-call-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: step.read }) } }
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: step.text }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stub did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

/** The `role: 'tool'` message contents of one request body, in order. */
function toolMessages(body: string | undefined): string[] {
  const messages = (JSON.parse(body ?? '{}') as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []
  return messages
    .filter(message => message.role === 'tool')
    .map(message => typeof message.content === 'string'
      ? message.content
      : (message.content as Array<{ type?: string; text?: string }> | undefined ?? []).map(part => part.text ?? '').join(''))
}

describe('F1.959 — the out-of-root refusal the model reads on the completions wire', () => {
  it('a refusal that carries the host reason reaches the model as that reason; a bare Deny keeps the scope sentence', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1959-cwd-')))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1959-outside-')))
    const sessionPath = mkdtempSync(join(tmpdir(), 'nessy-f1959-session-'))
    const judged = join(outside, 'report.txt')
    const ordinary = join(outside, 'notes.txt')
    writeFileSync(judged, 'F1959-SECRET-REPORT')
    writeFileSync(ordinary, 'F1959-SECRET-NOTES')
    const stub = await startStub([{ read: judged }, { read: ordinary }, { text: 'done' }])
    const workspaceId = 'f1959-ws'
    const sessionId = 'f1959-outside-root'
    const manifest = createRealServerExecutionManifest({ workspaceId, sessionId })
    const outsideRequests: Array<{ canonicalTarget: string; access: string }> = []
    const child = spawn(process.execPath, [entrypoint], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    try {
      await new Promise<void>((resolve, reject) => {
        const clock = startRealServerClock({
          answerWaitMs: ANSWER_WAIT_MS,
          onExpire: (_phase, message) => reject(new Error(`F1.959 ${message}\n${stderr.slice(-4000)}`)),
        })
        let prompted = false
        child.on('error', reject)
        lines.on('line', line => {
          let message: Record<string, any>
          try { message = JSON.parse(line) } catch { return }
          if (message.type === 'startup_error' || message.type === 'error') {
            clock.clear()
            reject(new Error(`${message.code}: ${message.message}\n${stderr.slice(-4000)}`))
            return
          }
          if (message.type === 'ready') {
            clock.ready()
            if (prompted) return
            prompted = true
            write({
              type: 'prompt', id: 'f1959', message: 'read the two files', systemPrompt: 'F1959_PROMPT',
              manifestGeneration: manifest.snapshotGeneration, manifestHash: manifest.manifestHash,
            })
            return
          }
          if (isPiPreToolUseRequest(message)) {
            write(piPreToolUseResponse({ manifest, request: message }))
            return
          }
          if (message.type === 'post_tool_use_request') {
            write({ type: 'post_tool_use_response', requestId: message.requestId })
            return
          }
          if (message.type === 'outside_root_request') {
            outsideRequests.push({ canonicalTarget: message.canonicalTarget, access: message.access })
            // The first refusal is the judge door's (F1.861 + F1.959); the second
            // is an ordinary user Deny, which names no reason.
            write(outsideRequests.length === 1
              ? { type: 'outside_root_response', requestId: message.requestId, root: null, reason: GUARDIAN_JUDGE_HOST_REFUSAL }
              : { type: 'outside_root_response', requestId: message.requestId, root: null })
            return
          }
          if (message.type === 'event' && message.event?.type === 'agent_end') {
            clock.clear()
            resolve()
          }
        })
        write({
          type: 'init',
          apiKey: 'test',
          model: 'f1959-model',
          cwd,
          workingDirectory: cwd,
          workspaceRootPath: cwd,
          workspaceId,
          sessionId,
          sessionPath,
          plansFolderPath: join(sessionPath, 'plans'),
          thinkingLevel: 'off',
          baseUrl: stub.baseUrl,
          customEndpoint: { api: 'openai-completions' },
          customModels: ['f1959-model'],
          executionManifest: manifest,
          piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
        })
      })

      // PRECONDITION: both reads really went through the outside-root door.
      expect(outsideRequests).toEqual([
        { canonicalTarget: judged, access: 'read' },
        { canonicalTarget: ordinary, access: 'read' },
      ])
      expect(stub.requests).toHaveLength(3)
      const [judgeResult, ordinaryResult] = toolMessages(stub.requests[2])
      // The judge door: the model reads the host's no-content refusal, verbatim,
      // and not the scope sentence it could mistake for the file.
      expect(judgeResult).toBe(GUARDIAN_JUDGE_HOST_REFUSAL)
      expect(judgeResult!.startsWith('(no file content — ')).toBe(true)
      // CONTROL: an ordinary Deny is unchanged — the scope error's own sentence.
      expect(ordinaryResult).toBe(`Path is outside the session filesystem scope: ${ordinary}`)
      // Neither refusal leaks the file.
      expect(stub.requests.join('\n')).not.toContain('F1959-SECRET')
    } finally {
      try { write({ type: 'shutdown' }) } catch { /* the child may already be gone */ }
      child.kill()
      lines.close()
      await stub.close()
      for (const dir of [cwd, outside, sessionPath]) rmSync(dir, { recursive: true, force: true })
    }
  }, realServerTestBudget(ANSWER_WAIT_MS))
})
