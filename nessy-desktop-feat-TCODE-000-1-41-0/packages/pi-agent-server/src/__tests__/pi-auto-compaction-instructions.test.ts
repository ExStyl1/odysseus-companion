import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'bun:test'

import { composePiCompactionInstructions, composePiReferenceReinjection } from '../../../shared/src/agent/pi-harness/prompt-composer.ts'
import { PROJECT_COMPACT_STEERING_LABEL } from '../../../shared/src/prompts/compaction.ts'
import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts'
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts'

/**
 * F1.587 — each scenario's budget is timed from the child's first `ready`; the boot has its own
 * (`support/real-server-clock.ts`, F1.546). On 2026-09-24 (WJ-lift) the child of this suite's
 * twin rig booted in 81–116 s at ~2 % cpu, so a clock started at spawn spent the answer budget on
 * the boot, and one scenario here timed out on budget alone. The numbers are the old ones.
 */
const THINKING_ANSWER_WAIT_MS = 90_000
const AUTO_ANSWER_WAIT_MS = 120_000
/** The post-compaction poll after `completed` in the routing scenario (its own inline 30 s timer). */
const POST_COMPACTION_POLL_MS = 30_000

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const adapterUrl = new URL('../compat/pi-runtime-adapter.ts', import.meta.url).href
const piAiCompatUrl = import.meta.resolve('@earendil-works/pi-ai/compat')
const piCodingAgentUrl = import.meta.resolve('@earendil-works/pi-coding-agent')
const repoRoot = join(here, '..', '..', '..', '..')

function containsText(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected)
  if (Array.isArray(value)) return value.some(item => containsText(item, expected))
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => containsText(item, expected))
  }
  return false
}

it('preserves the model-derived threshold after an effective thinking-level change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nessy-auto-compaction-thinking-'))
  const sessionPath = join(root, 'session')
  const executionManifest = createRealServerExecutionManifest({
    workspaceId: 'auto-thinking-workspace',
    sessionId: 'auto-thinking-session',
  })
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  let initialUsage: Record<string, unknown> | undefined
  let switchedUsage: Record<string, unknown> | undefined
  let postThinkingUsageRequested = false
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
    if (!postThinkingUsageRequested
      && stderr.includes('[set_thinking_level] Thinking level changed to: high')) {
      postThinkingUsageRequested = true
      child.stdin.write(`${JSON.stringify({ type: 'get_context_usage', id: 'post-thinking-usage' })}\n`)
    }
  })

  const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
    const clock = startRealServerClock({
      answerWaitMs: THINKING_ANSWER_WAIT_MS,
      onExpire: (_phase, message) => reject(new Error(`thinking-level threshold: ${message}\n${stderr}`)),
    })
    let thinkingRequested = false
    child.on('error', reject)
    lines.on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      if (message.type === 'startup_error' || message.type === 'error') {
        clock.clear()
        reject(new Error(`${message.code}: ${message.message}\n${stderr}`))
        return
      }
      // R73 · the host owes an answer to every `pre_compact_request`, because
      // `session_before_compact` now AWAITS it (hooks.md#precompact: exit 2 or
      // `decision: "block"` blocks compaction). This harness stands in for the
      // host, so it answers non-blocking; without it every compaction below
      // would wait forever and the failure would read as a compaction bug.
      if (message.type === 'pre_compact_request') {
        child.stdin.write(`${JSON.stringify({ type: 'pre_compact_response', requestId: message.requestId })}\n`)
        return
      }
      if (message.type === 'ready') clock.ready()
      if (message.type === 'ready') {
        child.stdin.write(`${JSON.stringify({
          type: 'set_auto_compaction',
          id: 'thinking-policy',
          enabled: true,
          thresholdPercent: 50,
        })}\n`)
        return
      }
      if (message.type === 'set_auto_compaction_result' && message.id === 'thinking-policy') {
        child.stdin.write(`${JSON.stringify({ type: 'get_context_usage', id: 'initial-thinking-usage' })}\n`)
        return
      }
      if (message.type === 'context_usage_result' && message.id === 'initial-thinking-usage') {
        initialUsage = message.usage
        child.stdin.write(`${JSON.stringify({ type: 'set_model', model: 'gpt-5' })}\n`)
        return
      }
      if (message.type === 'event'
        && message.event?.type === 'context_usage_update'
        && message.event.usage?.modelId === 'gpt-5'
        && !thinkingRequested) {
        thinkingRequested = true
        switchedUsage = message.event.usage
        child.stdin.write(`${JSON.stringify({ type: 'set_thinking_level', level: 'high' })}\n`)
        return
      }
      if (message.type === 'context_usage_result' && message.id === 'post-thinking-usage') {
        clock.clear()
        resolve(message.usage)
      }
    })
  })

  child.stdin.write(`${JSON.stringify({
    type: 'init',
    // Pi 0.84's builtin openai catalog dropped `gpt-5.1-chat-latest`.
    // `gpt-5-chat-latest` is its surviving equivalent for what this case needs:
    // a 128k, non-reasoning model whose window differs from the `gpt-5` it
    // switches to (400k), so the derived threshold is observably re-derived.
    model: 'gpt-5-chat-latest',
    cwd: root,
    workingDirectory: root,
    workspaceRootPath: root,
    workspaceId: 'auto-thinking-workspace',
    sessionId: 'auto-thinking-session',
    sessionPath,
    plansFolderPath: join(sessionPath, 'plans'),
    thinkingLevel: 'off',
    executionManifest,
    piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'test' } },
  })}\n`)

  try {
    const postThinkingUsage = await completed
    expect(initialUsage).toMatchObject({
      modelId: 'gpt-5-chat-latest',
      contextWindow: 128_000,
      autoCompactionThreshold: 64_000,
      reserveTokens: 64_000,
    })
    expect(switchedUsage).toMatchObject({
      modelId: 'gpt-5',
      contextWindow: 400_000,
      autoCompactionThreshold: 200_000,
      reserveTokens: 200_000,
    })
    expect(postThinkingUsage).toMatchObject({
      modelId: 'gpt-5',
      contextWindow: 400_000,
      autoCompactionThreshold: 200_000,
      reserveTokens: 200_000,
    })
  } finally {
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
    child.kill()
    lines.close()
    rmSync(root, { recursive: true, force: true })
  }
}, realServerTestBudget(THINKING_ANSWER_WAIT_MS))

it('routes composed instructions through the Pi auto-compaction event', async () => {
  const requests: string[] = []
  const stableSkillListing = '<available_skills>\n- [skill:review] — Reviews code\n</available_skills>'
  const systemPrompt = `AUTO_SYSTEM_PROMPT\n\n${stableSkillListing}`
  const queuedPrompt = 'queued while auto-compaction begins'
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(body)
      const base = { id: 'auto', object: 'chat.completion.chunk', created: 1, model: 'auto-model' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 45_000, completion_tokens: 1, total_tokens: 45_001 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('auto-compaction stub did not bind')

  const root = mkdtempSync(join(tmpdir(), 'nessy-auto-compaction-'))
  const sessionPath = join(root, 'session')
  const cwd = join(root, 'cwd')
  const executionManifest = createRealServerExecutionManifest({
    workspaceId: 'auto-workspace',
    sessionId: 'auto-session',
  })
  const seedTurnReferences = {
    taskIds: ['seed-turn-task'],
    capabilityRefs: ['seed-turn-capability'],
    permissionRefs: ['seed-turn-permission'],
    resourceRefs: ['seed-turn-resource'],
  }
  const completedTurnReferences = {
    taskIds: ['completed-turn-task'],
    capabilityRefs: ['completed-turn-capability'],
    permissionRefs: ['completed-turn-permission'],
    resourceRefs: ['completed-turn-resource'],
  }
  const queuedTurnReferences = {
    taskIds: ['queued-turn-task'],
    capabilityRefs: ['queued-turn-capability'],
    permissionRefs: ['queued-turn-permission'],
    resourceRefs: ['queued-turn-resource'],
  }
  const completedTurnMarker = composePiReferenceReinjection(completedTurnReferences)
  const queuedTurnMarker = composePiReferenceReinjection(queuedTurnReferences)
  const largeMessage = 'automatic compaction context '.repeat(4_000)
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  let configuredUsage: Record<string, unknown> | undefined
  child.stderr.on('data', chunk => { stderr += String(chunk) })

  const completed = new Promise<void>((resolve, reject) => {
    const clock = startRealServerClock({
      answerWaitMs: AUTO_ANSWER_WAIT_MS,
      onExpire: (_phase, message) => reject(new Error(`auto-compaction: ${message} (${requests.length} requests)\n${stderr}`)),
    })
    let agentEnds = 0
    child.on('error', reject)
    lines.on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      if (message.type === 'startup_error' || message.type === 'error') {
        clock.clear()
        reject(new Error(`${message.code}: ${message.message}\n${stderr}`))
        return
      }
      // R73 · the host owes an answer to every `pre_compact_request`, because
      // `session_before_compact` now AWAITS it (hooks.md#precompact: exit 2 or
      // `decision: "block"` blocks compaction). This harness stands in for the
      // host, so it answers non-blocking; without it every compaction below
      // would wait forever and the failure would read as a compaction bug.
      if (message.type === 'pre_compact_request') {
        child.stdin.write(`${JSON.stringify({ type: 'pre_compact_response', requestId: message.requestId })}\n`)
        return
      }
      if (message.type === 'ready') clock.ready()
      if (message.type === 'ready') {
        child.stdin.write(`${JSON.stringify({
          type: 'set_auto_compaction',
          id: 'auto-off',
          enabled: false,
          thresholdPercent: 50,
          contextWindow: 100_000,
        })}\n`)
        return
      }
      if (message.type === 'set_auto_compaction_result' && message.id === 'auto-off') {
        child.stdin.write(`${JSON.stringify({ type: 'get_context_usage', id: 'configured-usage' })}\n`)
        return
      }
      if (message.type === 'context_usage_result' && message.id === 'configured-usage') {
        configuredUsage = message.usage
        child.stdin.write(`${JSON.stringify({
          type: 'set_auto_compaction',
          id: 'auto-on',
          enabled: true,
          thresholdPercent: 50,
          contextWindow: 100_000,
        })}\n`)
        return
      }
      if (message.type === 'set_auto_compaction_result' && message.id === 'auto-on') {
        child.stdin.write(`${JSON.stringify({
          type: 'prompt',
          id: 'seed-turn',
          message: largeMessage,
          systemPrompt,
          autoCompactionInstructions: composePiCompactionInstructions(undefined, seedTurnReferences),
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        })}\n`)
        return
      }
      if (message.type === 'event' && message.event?.type === 'agent_end') {
        agentEnds += 1
        if (agentEnds === 1) {
          child.stdin.write(`${JSON.stringify({
            type: 'prompt',
            id: 'auto-turn',
            message: largeMessage,
            systemPrompt,
            autoCompactionInstructions: composePiCompactionInstructions(undefined, completedTurnReferences),
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          })}\n`)
        } else if (agentEnds === 2) {
          child.stdin.write(`${JSON.stringify({
            type: 'prompt',
            id: 'queued-turn',
            message: queuedPrompt,
            systemPrompt,
            autoCompactionInstructions: composePiCompactionInstructions(undefined, queuedTurnReferences),
            manifestGeneration: executionManifest.snapshotGeneration,
            manifestHash: executionManifest.manifestHash,
          })}\n`)
        }
        return
      }
      if (message.type === 'event' && message.event?.type === 'compaction_end') {
        clock.clear()
        resolve()
      }
    })
  })

  child.stdin.write(`${JSON.stringify({
    type: 'init',
    apiKey: 'test',
    model: 'auto-model',
    cwd,
    workingDirectory: cwd,
    workspaceRootPath: cwd,
    workspaceId: 'auto-workspace',
    sessionId: 'auto-session',
    sessionPath,
    plansFolderPath: join(sessionPath, 'plans'),
    thinkingLevel: 'off',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    customEndpoint: { api: 'openai-completions' },
    customModels: [{ id: 'auto-model', contextWindow: 50_000 }],
    executionManifest,
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
  })}\n`)

  try {
    await completed
    const postCompactionRequest = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(poll)
        reject(new Error(`post-compaction request timeout (${requests.length} requests)\n${stderr}`))
      }, POST_COMPACTION_POLL_MS)
      const poll = setInterval(() => {
        const request = requests.find(body => containsText(JSON.parse(body), queuedPrompt))
        if (!request) return
        clearTimeout(timeout)
        clearInterval(poll)
        resolve(request)
      }, 20)
    })
    expect(configuredUsage).toMatchObject({
      contextWindow: 50_000,
      autoCompactionEnabled: false,
      autoCompactionThreshold: 25_000,
      reserveTokens: 25_000,
    })
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect({
      completed: requests.some(body => containsText(JSON.parse(body), completedTurnMarker)),
      queued: requests.some(body => containsText(JSON.parse(body), queuedTurnMarker)),
    }).toEqual({ completed: true, queued: false })
    // Deliberate R8 divergence: Claude drops the skill listing after
    // compaction; Nessy's stable prompt parts retain it, so we stay ahead.
    expect(containsText(JSON.parse(postCompactionRequest), stableSkillListing)).toBe(true)
  } finally {
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
    child.kill()
    lines.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}, realServerTestBudget(AUTO_ANSWER_WAIT_MS + POST_COMPACTION_POLL_MS))

async function runCustomStreamCompactionScenario(failReplacement: boolean): Promise<{
  requests: string[]
  compactionEvent: Record<string, unknown>
  attempts: number
  stderr: string
  steeringMarker: string
}> {
  const requests: string[] = []
  const observed: string[] = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      requests.push(body)
      observed.push(`http_request:${requests.length}`)
      const base = { id: 'custom-stream', object: 'chat.completion.chunk', created: 1, model: 'auto-model' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 45_000, completion_tokens: 1, total_tokens: 45_001 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('custom-stream stub did not bind')

  const root = mkdtempSync(join(tmpdir(), 'nessy-auto-compaction-custom-stream-'))
  const attemptPath = join(root, 'replacement-attempts')
  const preloadPath = join(root, 'custom-stream-preload.ts')
  const references = {
    taskIds: ['custom-stream-task'],
    capabilityRefs: ['custom-stream-capability'],
    permissionRefs: ['custom-stream-permission'],
    resourceRefs: ['custom-stream-resource'],
  }
  const marker = composePiReferenceReinjection(references)
  const largeMessage = 'automatic compaction context '.repeat(4_000)
  // P6.54 · the project's standing `Compact Instructions` section, delivered the
  // way production delivers instruction files: as an `agent-instruction` context
  // resource whose body the HOST already composed. The subprocess folds it into
  // the AUTO path's instructions, so this marker must reach the summarizer's own
  // request — the request `marker` above identifies.
  const steeringMarker = 'CUSTOM_STREAM_COMPACT_STEERING_MARKER'
  const instructionFileBody =
    `# Project\n\n## Compact Instructions\n${steeringMarker}\n\n## Commands\nbun test\n`
  // The subprocess re-digests every curated resource at ingress
  // (`resource-loader.ts`: "Curated Pi resource digest mismatch"), so the
  // descriptor is built the way the host builds it rather than stubbed.
  const instructionFileSha256 = createHash('sha256').update(instructionFileBody).digest('hex')
  writeFileSync(preloadPath, `
    import { mock } from 'bun:test'
    import { appendFileSync } from 'node:fs'
    const actual = await import(${JSON.stringify(adapterUrl)})
    const { streamSimple } = await import(${JSON.stringify(piAiCompatUrl)})
    const { ModelRegistry } = await import(${JSON.stringify(piCodingAgentUrl)})
    const createRuntimeAdapter = actual.createPiRuntimeAdapter

    // Pi 0.84 · AgentSession no longer exposes \`modelRegistry\`; the extension
    // context the production handler reads gets a FRESH
    // \`new ModelRegistry(this._modelRuntime)\` built inside AgentSession
    // (agent-session.js: \`new ExtensionRunner(..., new ModelRegistry(this._modelRuntime))\`),
    // so patching any single instance cannot reach it. The prototype is the one
    // seam that does, and this preload owns its whole subprocess.
    let registryAuthUnavailable = false
    const originalGetApiKeyAndHeaders = ModelRegistry.prototype.getApiKeyAndHeaders
    ModelRegistry.prototype.getApiKeyAndHeaders = function (...authArgs) {
      return registryAuthUnavailable
        ? Promise.resolve({ ok: false, error: 'INJECTED_REGISTRY_AUTH_FAILURE' })
        : originalGetApiKeyAndHeaders.apply(this, authArgs)
    }

    mock.module(${JSON.stringify(adapterUrl)}, () => ({
      ...actual,
      createPiRuntimeAdapter(...args) {
        const adapter = createRuntimeAdapter(...args)
        return {
          ...adapter,
          async createSession(options) {
            const handle = await adapter.createSession(options)
            // Pi 0.84 renamed \`Agent.streamFn\` to \`Agent.streamFunction\`.
            handle.session.agent.streamFunction = (model, context, streamOptions) => {
              const isInstructionReplacement = JSON.stringify(context).includes(${JSON.stringify(JSON.stringify(marker).slice(1, -1))})
              if (isInstructionReplacement) {
                appendFileSync(${JSON.stringify(attemptPath)}, 'attempt\\n')
                if (${JSON.stringify(failReplacement)}) {
                  throw new Error('INJECTED_COMPACTION_REPLACEMENT_FAILURE')
                }
              }
              return streamSimple(model, context, { ...streamOptions, apiKey: 'test' })
            }
            const originalSubscribe = handle.session.subscribe.bind(handle.session)
            let agentEnds = 0
            handle.session.subscribe = listener => originalSubscribe(event => {
              if (event.type === 'agent_end') {
                agentEnds += 1
                if (agentEnds >= 2) registryAuthUnavailable = true
              }
              return listener(event)
            })
            return handle
          },
        }
      },
    }))
  `)

  const sessionPath = join(root, 'session')
  const cwd = join(root, 'cwd')
  const executionManifest = createRealServerExecutionManifest({
    workspaceId: 'custom-stream-workspace',
    sessionId: 'custom-stream-session',
  })
  const child = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })

  const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
    const clock = startRealServerClock({
      answerWaitMs: AUTO_ANSWER_WAIT_MS,
      onExpire: (_phase, message) => {
        const attempts = existsSync(attemptPath)
          ? readFileSync(attemptPath, 'utf8').trim().split('\n').filter(Boolean).length
          : 0
        reject(new Error(
          `custom-stream compaction: ${message} (${requests.length} requests, ${attempts} replacement attempts)\n`
          + `${observed.join('\n')}\n${stderr}`,
        ))
      },
    })
    let queuedFollowUp = false
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
      // R73 · the host owes an answer to every `pre_compact_request`, because
      // `session_before_compact` now AWAITS it (hooks.md#precompact: exit 2 or
      // `decision: "block"` blocks compaction). This harness stands in for the
      // host, so it answers non-blocking; without it every compaction below
      // would wait forever and the failure would read as a compaction bug.
      if (message.type === 'pre_compact_request') {
        child.stdin.write(`${JSON.stringify({ type: 'pre_compact_response', requestId: message.requestId })}\n`)
        return
      }
      if (message.type === 'ready') clock.ready()
      if (message.type === 'ready') {
        child.stdin.write(`${JSON.stringify({ type: 'set_auto_compaction', id: 'auto-on', enabled: true })}\n`)
        return
      }
      if (message.type === 'set_auto_compaction_result' && message.id === 'auto-on') {
        child.stdin.write(`${JSON.stringify({
          type: 'prompt',
          id: 'seed-turn',
          message: largeMessage,
          systemPrompt: 'AUTO_SYSTEM_PROMPT',
          autoCompactionInstructions: composePiCompactionInstructions(undefined, references),
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        })}\n`)
        return
      }
      if (message.type === 'event' && message.event?.type === 'agent_end' && !queuedFollowUp) {
        queuedFollowUp = true
        child.stdin.write(`${JSON.stringify({
          type: 'prompt',
          id: 'queued-turn',
          message: largeMessage,
          systemPrompt: 'AUTO_SYSTEM_PROMPT',
          autoCompactionInstructions: composePiCompactionInstructions(undefined, references),
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        })}\n`)
        return
      }
      if (message.type === 'event' && message.event?.type === 'compaction_end') {
        clock.clear()
        resolve(message.event)
      }
    })
  })

  child.stdin.write(`${JSON.stringify({
    type: 'init',
    apiKey: 'test',
    model: 'auto-model',
    cwd,
    workingDirectory: cwd,
    workspaceRootPath: cwd,
    workspaceId: 'custom-stream-workspace',
    sessionId: 'custom-stream-session',
    sessionPath,
    plansFolderPath: join(sessionPath, 'plans'),
    thinkingLevel: 'off',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    customEndpoint: { api: 'openai-completions' },
    customModels: [{ id: 'auto-model', contextWindow: 50_000 }],
    executionManifest,
    piContextResources: [{
      schemaVersion: 1,
      id: `cap-instruction-CLAUDE_md-00000000-${instructionFileSha256.slice(0, 12)}`,
      kind: 'agent-instruction',
      content: instructionFileBody,
      sha256: instructionFileSha256,
      provenance: 'CLAUDE.md@custom-stream-generation',
    }],
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
  })}\n`)

  try {
    const compactionEvent = await completed
    const attempts = existsSync(attemptPath)
      ? readFileSync(attemptPath, 'utf8').trim().split('\n').filter(Boolean).length
      : 0
    return { requests: [...requests], compactionEvent, attempts, stderr, steeringMarker }
  } finally {
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
    child.kill()
    lines.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

it('permits instruction replacement through a non-default stream without registry auth', async () => {
  const result = await runCustomStreamCompactionScenario(false)
  expect({
    attempts: result.attempts,
    aborted: result.compactionEvent.aborted,
    result: Boolean(result.compactionEvent.result),
    error: result.stderr.match(/Auto-compaction instruction replacement failed: .*/)?.[0],
  }).toEqual({ attempts: 1, aborted: false, result: true, error: undefined })

  // P6.54 · the project's `Compact Instructions` section reaches the AUTO path's
  // summarizer request. Before this row nothing read the section and the auto
  // path's `customInstructions` were fixed at `undefined`, so this assertion is
  // the whole capability, end to end and on the real subprocess.
  //
  // The control that makes it a measurement rather than a coincidence: the
  // asserted string is the LABEL followed immediately by the section body. The
  // marker alone would also match the instruction file's own delivery as a
  // context resource; label-then-body can only come from the extractor, and it
  // additionally proves the SECTION was taken rather than the whole file (the
  // sibling `## Commands` content would sit between them otherwise).
  const steeringBlock = `${PROJECT_COMPACT_STEERING_LABEL}\n\n${result.steeringMarker}`
  expect(result.requests.some(body => containsText(JSON.parse(body), steeringBlock))).toBe(true)
}, realServerTestBudget(AUTO_ANSWER_WAIT_MS))

it('cancels auto-compaction when instruction replacement fails', async () => {
  const result = await runCustomStreamCompactionScenario(true)
  expect(result.attempts).toBe(1)
  expect(result.compactionEvent.aborted).toBe(true)
  expect(result.compactionEvent.result).toBeUndefined()
  expect(result.requests).toHaveLength(2)
}, realServerTestBudget(AUTO_ANSWER_WAIT_MS))
