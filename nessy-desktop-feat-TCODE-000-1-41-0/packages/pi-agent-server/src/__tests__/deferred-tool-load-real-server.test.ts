/**
 * F1.803 — a Pi deferred tool loaded with `mcp__tool_load` must be callable no
 * later than the NEXT MODEL CALL, and must stay loaded when the host
 * re-registers the tool surface.
 *
 * Origin: the 1.41.0 release sittings. SIT-p: on the gateway Pi card
 * `web_search` was loaded three times over three user messages, each load
 * answering "available from the user's next message", and the direct call on
 * the third answered `Tool web_search not found` — no search ever ran. SIT-j
 * (F1.738): a loaded session tool answered "not found" on the next turn after
 * the tool catalogue moved. SIT-m (F1.796): the model says a loaded tool "only
 * becomes callable on your next message", one extra user turn per deferred tool.
 *
 * The shape claude documents (`agent-sdk/tool-search.md#how-tool-search-works`):
 * "Tool search adds one extra round-trip each time Claude searches for tools",
 * and the loaded tools "stay available for subsequent turns until the SDK
 * compacts the messages where the agent discovered them" — same request, one
 * round-trip, then resident.
 *
 * What this drives: the REAL `index.ts` subprocess and the real Pi session.
 * Only the model (a scripted faux provider that records the tool names every
 * model call was offered) and the web-search backend are replaced — see
 * `support/deferred-tool-load-e2e-preload.ts`. Three causes were measured at
 * `6eef56955` before any fix, one per arm below:
 *
 *   1. same request — the load registers the tool into the live session through
 *      the deferred extension, and Pi's tool registry drops it on the floor
 *      because the session's `tools` allowlist names only the tools advertised
 *      at construction (`_refreshToolRegistry` filters every registered tool
 *      through `allowedToolNames`). Pi 0.85.1 already re-reads the active tool
 *      set before every model call (`_installAgentNextTurnRefresh`), so the
 *      mechanism is native; only the allowlist withheld it.
 *   2. re-registration at the same generation (a manifest-hash move, which the
 *      host sends whenever the surface changes) — `handleRegisterTools` pruned
 *      every loaded name that is not an MCP PROXY definition, so a loaded
 *      BUILT-IN such as `web_search` (or a session tool) was forgotten while an
 *      MCP tool survived. This is SIT-p's and SIT-j's shape.
 *   3. a GENERATION move — every activation lease is bound to the catalogue
 *      generation it was taken in, so a move revoked every loaded tool, MCP
 *      included, even when the tool itself had not changed at all.
 *
 * Controls, on the same rig: a tool offered at the first model call is offered
 * at every later one (the load only adds); a deferred tool nobody loaded stays
 * hidden (the widened allowlist does not unhide the catalogue); the system
 * prompt is the host's across the mid-request registration; and a tool the
 * policy denies stays denied after loading — loading never skips the gate.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_PI_ORCHESTRATOR_CONFIG,
  finalizePiExecutionManifest,
  type PiExecutionManifestSeedV2,
  type PiExecutionManifestV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
import { isPiPreToolUseRequest, piPreToolUseResponse } from './support/pi-permission-receipt-fixture.ts'
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')
const repoRoot = join(here, '..', '..', '..', '..')
const preloadPath = join(here, 'support', 'deferred-tool-load-e2e-preload.ts')
const ANSWER_WAIT_MS = 120_000
const TEST_TIMEOUT_MS = realServerTestBudget(ANSWER_WAIT_MS)

type StubTool = { name: string; description: string; inputSchema: Record<string, unknown>; promptSnippet: string }
const ECHO: StubTool = {
  name: 'mcp__stub__echo',
  description: 'Echo stub MCP tool',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  promptSnippet: 'Use mcp__stub__echo to echo',
}
const EXTRA: StubTool = {
  name: 'mcp__stub__extra',
  description: 'A second stub MCP tool that nobody loads',
  inputSchema: { type: 'object', properties: {} },
  promptSnippet: 'Use mcp__stub__extra',
}

function manifestFor(
  sessionKey: { workspaceId: string; sessionId: string },
  generation: string,
  dynamic: readonly StubTool[],
): PiExecutionManifestV2 {
  const provenance = { capabilityKey: 'stub:mcp', generation }
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey,
    provenance: [provenance],
    mcpSources: [{ wireName: 'stub', ...provenance }],
    orchestrator: { ...DEFAULT_PI_ORCHESTRATOR_CONFIG },
    staticTools: PI_TOOL_BINDINGS
      .filter(binding => PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName] !== undefined)
      .map(binding => ({
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash: PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]!,
      })),
  }
  return finalizePiExecutionManifest(seed, dynamic.map(tool => ({
    bindingName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    promptSnippet: tool.promptSnippet,
    modelSchemaVersion: 1 as const,
    bindingSchemaVersion: 1 as const,
    provenance,
  })), { deferredMcpEnabled: true })
}

type Step = { call?: { name: string; args: Record<string, unknown> }; text?: string }
const load = (name: string): Step => ({ call: { name: 'mcp__tool_load', args: { name } } })
const call = (name: string, args: Record<string, unknown> = {}): Step => ({ call: { name, args } })
const say = (text: string): Step => ({ text })

/** What the host does between two model-driven stretches: send a user message, or re-register the surface. */
type Phase =
  | { kind: 'prompt' }
  | { kind: 'register'; manifest: PiExecutionManifestV2; tools: readonly StubTool[] }

interface ModelCall { step: number; tools: string[]; systemPromptHead: string; deferredSummary: string[] | null }
interface ToolEnd { toolName: string; isError: boolean; text: string }
interface Lease { schemaVersion: number; semanticId: string; capabilityGeneration: string; digest: string }
interface RunResult {
  modelCalls: ModelCall[]
  searches: string[]
  executed: string[]
  toolEnds: ToolEnd[]
  /** Every `continuation_state` the subprocess published — what the host keeps for a restart. */
  continuation: Array<{ capabilityGeneration: string; activatedTools: Lease[] }>
  stderr: string
}

async function runScenario(options: {
  label: string
  script: Step[]
  initial: { manifest: PiExecutionManifestV2; tools: readonly StubTool[] }
  phases: Phase[]
  deny?: (piName: string) => boolean
  /** F1.835 — the leases the host hands a RESTARTED subprocess at init (`continuationActivatedTools`). */
  continuationActivatedTools?: readonly Lease[]
}): Promise<RunResult> {
  const workspaceRootPath = realpathSync(mkdtempSync(join(tmpdir(), 'f1803-ws-')))
  const sessionPath = realpathSync(mkdtempSync(join(tmpdir(), 'f1803-session-')))
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'f1803-config-')))
  const logPath = join(sessionPath, 'model-calls.jsonl')
  const sessionKey = options.initial.manifest.sessionKey
  let active = options.initial.manifest

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // The agent shell exports names this product reads (AGENTS.md §Traps, WI-u).
    if (/^(CLAUDE_|ANTHROPIC_|MCP_|DISABLE_)/.test(key)) continue
    env[key] = value
  }
  Object.assign(env, {
    NO_COLOR: '1',
    FAUX_API_KEY: 'test',
    NESSY_CONFIG_DIR: configDir,
    F1803_LOG: logPath,
    F1803_SCRIPT: JSON.stringify(options.script),
  })

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--preload', preloadPath, entrypoint], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const events: Array<Record<string, any>> = []
  const executed: string[] = []
  const continuation: RunResult['continuation'] = []
  const phases = [...options.phases]
  let registered = false
  let promptCount = 0

  const sendPrompt = () => {
    promptCount += 1
    write({
      type: 'prompt',
      id: `${options.label}-prompt-${promptCount}`,
      message: `user message ${promptCount}`,
      systemPrompt: 'F1803 host system prompt',
      manifestGeneration: active.snapshotGeneration,
      manifestHash: active.manifestHash,
    })
  }
  const nextPhase = (): boolean => {
    const phase = phases.shift()
    if (!phase) return false
    if (phase.kind === 'prompt') {
      sendPrompt()
      return true
    }
    const previous = { generation: active.snapshotGeneration, manifestHash: active.manifestHash }
    active = phase.manifest
    write({ type: 'register_tools', id: `${options.label}-reg-${phases.length}`, tools: phase.tools, manifest: phase.manifest, previous })
    return true
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const clock = startRealServerClock({
        answerWaitMs: ANSWER_WAIT_MS,
        onExpire: (_phase, message) => reject(new Error(`${message}\n${stderr.slice(-4000)}`)),
      })
      child.on('exit', code => {
        clock.clear()
        reject(new Error(`pi-agent-server exited early (${code})\n${stderr.slice(-4000)}`))
      })
      createInterface({ input: child.stdout }).on('line', line => {
        let message: Record<string, any>
        try { message = JSON.parse(line) } catch { return }
        if (message.type === 'ready') {
          clock.ready()
          if (registered) return
          registered = true
          write({
            type: 'register_tools',
            id: `${options.label}-reg-initial`,
            tools: options.initial.tools,
            manifest: options.initial.manifest,
            previous: { generation: options.initial.manifest.snapshotGeneration, manifestHash: options.initial.manifest.manifestHash },
          })
          return
        }
        if (message.type === 'register_tools_result') {
          if (!message.ok) {
            clock.clear()
            reject(new Error(`register_tools refused: ${message.error}\n${stderr.slice(-4000)}`))
            return
          }
          nextPhase()
          return
        }
        if (isPiPreToolUseRequest(message)) {
          write(piPreToolUseResponse({
            manifest: active,
            request: message,
            outcome: options.deny?.(message.piName) ? 'deny' : 'allow',
            ...(options.deny?.(message.piName) ? { reason: 'F1803 control: the policy denies this tool' } : {}),
          }))
          return
        }
        if (message.type === 'continuation_state') {
          continuation.push({ capabilityGeneration: message.capabilityGeneration, activatedTools: message.activatedTools })
          return
        }
        if (message.type === 'post_tool_use_request') {
          write({ type: 'post_tool_use_response', requestId: message.requestId })
          return
        }
        if (message.type === 'tool_execute_request') {
          executed.push(String(message.piName ?? message.toolName))
          write({
            type: 'tool_execute_response',
            requestId: message.requestId,
            result: { content: `echoed ${JSON.stringify(message.args)}`, isError: false },
          })
          return
        }
        if (message.type === 'error') {
          clock.clear()
          reject(new Error(`${message.code}: ${message.message}\n${stderr.slice(-4000)}`))
          return
        }
        if (message.type === 'event') {
          events.push(message.event)
          if (message.event?.type === 'agent_end' && !nextPhase()) {
            clock.clear()
            resolve()
          }
        }
      })
      write({
        type: 'init',
        apiKey: 'test',
        model: 'f1803-model',
        cwd: workspaceRootPath,
        workingDirectory: workspaceRootPath,
        workspaceRootPath,
        workspaceId: sessionKey.workspaceId,
        sessionId: sessionKey.sessionId,
        sessionPath,
        plansFolderPath: join(sessionPath, 'plans'),
        thinkingLevel: 'off',
        executionManifest: options.initial.manifest,
        piAuth: { provider: 'faux', credential: { type: 'api_key', key: 'test' } },
        ...(options.continuationActivatedTools ? { continuationActivatedTools: options.continuationActivatedTools } : {}),
      })
    })
  } finally {
    child.removeAllListeners('exit')
    try { write({ type: 'shutdown' }) } catch { /* the child may already be gone */ }
    child.kill()
  }

  const records = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
    : []
  for (const dir of [workspaceRootPath, sessionPath, configDir]) rmSync(dir, { recursive: true, force: true })
  return {
    modelCalls: records.filter(record => record.type === 'model_call') as unknown as ModelCall[],
    searches: records.filter(record => record.type === 'search_ran').map(record => String(record.query)),
    executed,
    toolEnds: events
      .filter(event => event?.type === 'tool_execution_end')
      .map(event => ({
        toolName: String(event.toolName),
        isError: event.isError === true,
        text: String(event.result?.content?.[0]?.text ?? JSON.stringify(event.result)),
      })),
    continuation,
    stderr,
  }
}

function endsFor(result: RunResult, toolName: string): ToolEnd[] {
  return result.toolEnds.filter(end => end.toolName === toolName)
}

describe("F1.803 · a loaded Pi deferred tool is callable from the next model call and stays loaded", () => {
  it('same request: a loaded built-in (web_search) and a loaded MCP tool are offered at the next model call and run', async () => {
    const sessionKey = { workspaceId: 'f1803-ws', sessionId: 'f1803-same-request' }
    const manifest = manifestFor(sessionKey, 'f1803-gen-1', [ECHO, EXTRA])
    const result = await runScenario({
      label: 'same-request',
      initial: { manifest, tools: [ECHO, EXTRA] },
      phases: [{ kind: 'prompt' }],
      script: [
        load('web_search'),
        call('web_search', { query: 'bun latest' }),
        load(ECHO.name),
        call(ECHO.name, { text: 'a' }),
        say('done'),
      ],
    })

    expect(result.modelCalls.map(entry => entry.step)).toEqual([0, 1, 2, 3, 4])
    // Precondition that makes the arm mean something: both are DEFERRED at the first call.
    expect(result.modelCalls[0]!.tools).toContain('mcp__tool_load')
    expect(result.modelCalls[0]!.tools).not.toContain('web_search')
    expect(result.modelCalls[0]!.tools).not.toContain(ECHO.name)

    // THE DEFECT: offered at the very next model call, and it runs.
    expect(result.modelCalls[1]!.tools).toContain('web_search')
    expect(endsFor(result, 'web_search')).toEqual([
      expect.objectContaining({ isError: false, text: expect.stringContaining('Bun 9.9.9') }),
    ])
    expect(result.searches).toEqual(['bun latest'])
    expect(result.modelCalls[3]!.tools).toContain(ECHO.name)
    expect(endsFor(result, ECHO.name)).toEqual([
      expect.objectContaining({ isError: false, text: expect.stringContaining('echoed') }),
    ])
    expect(result.executed).toEqual([ECHO.name])

    // The load answer is truthful about WHEN, and no longer sends the model back to the user.
    const loads = endsFor(result, 'mcp__tool_load')
    expect(loads).toHaveLength(2)
    for (const answer of loads) {
      expect(answer.isError).toBe(false)
      expect(answer.text).not.toContain("user's next message")
      expect(answer.text).toContain('callable from your next step')
    }

    // CONTROL — a tool offered at the first call is offered at every later one: the load only adds.
    for (const later of result.modelCalls.slice(1)) {
      for (const name of result.modelCalls[0]!.tools) expect(later.tools).toContain(name)
    }
    expect(result.modelCalls[0]!.tools).toContain('bash')
    // CONTROL — a deferred tool nobody loaded stays hidden at every call.
    for (const entry of result.modelCalls) expect(entry.tools).not.toContain(EXTRA.name)
    // CONTROL — the host's system prompt survives the mid-request registration.
    for (const entry of result.modelCalls) expect(entry.systemPromptHead).toBe(result.modelCalls[0]!.systemPromptHead)
    expect(result.modelCalls[0]!.systemPromptHead.startsWith('F1803 host system prompt')).toBe(true)

    // F1.838 — the `<deferred-tools>` summary follows the live loaded set inside the SAME request.
    const listed = result.modelCalls.map(entry => entry.deferredSummary ?? [])
    // Precondition: all three are listed as deferred at the first call.
    for (const name of ['web_search', ECHO.name, EXTRA.name]) expect(listed[0]).toContain(name)
    // THE DEFECT: the model call right after each load no longer lists the loaded tool…
    expect(listed[1]).not.toContain('web_search')
    expect(listed[1]).toContain(ECHO.name)
    expect(listed[3]).not.toContain(ECHO.name)
    // …and it stays off the list for the rest of the request.
    for (const later of listed.slice(1)) expect(later).not.toContain('web_search')
    for (const later of listed.slice(3)) expect(later).not.toContain(ECHO.name)
    // CONTROL — the tool nobody loaded is listed at every call: the summary drops only what loaded.
    for (const names of listed) expect(names).toContain(EXTRA.name)
  }, TEST_TIMEOUT_MS)

  it('a loaded built-in and MCP tool survive a same-generation re-registration AND a generation move', async () => {
    const sessionKey = { workspaceId: 'f1803-ws', sessionId: 'f1803-survival' }
    const initial = manifestFor(sessionKey, 'f1803-gen-1', [ECHO])
    // Same generation, different manifest hash: what the host sends when the surface
    // changes inside one capability generation (SIT-p's and SIT-j's shape).
    const sameGeneration = manifestFor(sessionKey, 'f1803-gen-1', [ECHO, EXTRA])
    // A new generation whose entries for the two loaded tools are unchanged (F1.738's shape).
    const nextGeneration = manifestFor(sessionKey, 'f1803-gen-2', [ECHO, EXTRA])
    expect(sameGeneration.manifestHash).not.toBe(initial.manifestHash)

    const result = await runScenario({
      label: 'survival',
      initial: { manifest: initial, tools: [ECHO] },
      phases: [
        { kind: 'prompt' },
        { kind: 'register', manifest: sameGeneration, tools: [ECHO, EXTRA] },
        { kind: 'prompt' },
        { kind: 'register', manifest: nextGeneration, tools: [ECHO, EXTRA] },
        { kind: 'prompt' },
      ],
      script: [
        load('web_search'), load(ECHO.name), say('t1'),
        call('web_search', { query: 'after re-registration' }), call(ECHO.name, { text: 'b' }), say('t2'),
        call('web_search', { query: 'after generation move' }), call(ECHO.name, { text: 'c' }), say('t3'),
      ],
    })

    expect(result.modelCalls.map(entry => entry.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    // After the same-generation re-registration (user message 2).
    expect(result.modelCalls[3]!.tools).toContain('web_search')
    expect(result.modelCalls[3]!.tools).toContain(ECHO.name)
    // After the generation move (user message 3).
    expect(result.modelCalls[6]!.tools).toContain('web_search')
    expect(result.modelCalls[6]!.tools).toContain(ECHO.name)
    expect(endsFor(result, 'web_search').map(end => end.isError)).toEqual([false, false])
    expect(endsFor(result, ECHO.name).map(end => end.isError)).toEqual([false, false])
    expect(result.searches).toEqual(['after re-registration', 'after generation move'])
    // CONTROL — EXTRA arrived deferred and was never loaded: hidden throughout.
    for (const entry of result.modelCalls) expect(entry.tools).not.toContain(EXTRA.name)
  }, TEST_TIMEOUT_MS)

  // F1.835 — the same carry across a subprocess RESTART. The host keeps the leases the
  // subprocess published and hands them to the next one at init; before the fix init
  // dropped every lease from an older generation, so a restart after a catalogue move
  // forgot a tool the model had loaded although its entry had not changed at all.
  it('F1.835: a restart at a new generation keeps a loaded tool whose entry is unchanged and drops one whose entry changed', async () => {
    const sessionKey = { workspaceId: 'f1803-ws', sessionId: 'f1835-restart' }
    const EXTRA_CHANGED: StubTool = { ...EXTRA, description: 'A second stub MCP tool whose contract changed' }
    const before = manifestFor(sessionKey, 'f1835-gen-1', [ECHO, EXTRA])
    const after = manifestFor(sessionKey, 'f1835-gen-2', [ECHO, EXTRA_CHANGED])

    const first = await runScenario({
      label: 'restart-before',
      initial: { manifest: before, tools: [ECHO, EXTRA] },
      phases: [{ kind: 'prompt' }],
      script: [load(ECHO.name), load(EXTRA.name), say('t1')],
    })
    const leases = first.continuation.at(-1)?.activatedTools ?? []
    // Precondition: the host holds both leases, bound to the OLD generation.
    expect(leases.map(lease => [lease.semanticId, lease.capabilityGeneration]).sort()).toEqual([
      [ECHO.name, 'f1835-gen-1'],
      [EXTRA.name, 'f1835-gen-1'],
    ])

    const second = await runScenario({
      label: 'restart-after',
      initial: { manifest: after, tools: [ECHO, EXTRA_CHANGED] },
      continuationActivatedTools: leases,
      phases: [{ kind: 'prompt' }],
      script: [call(ECHO.name, { text: 'after restart' }), say('t2')],
    })
    // THE DEFECT: the unchanged tool is still loaded in the new process — offered at its first model call, and it runs.
    expect(second.modelCalls[0]!.tools).toContain(ECHO.name)
    expect(endsFor(second, ECHO.name)).toEqual([
      expect.objectContaining({ isError: false, text: expect.stringContaining('echoed') }),
    ])
    expect(second.executed).toEqual([ECHO.name])
    expect(second.modelCalls[0]!.deferredSummary ?? []).not.toContain(ECHO.name)
    // Its lease is re-issued at the NEW generation, so the next restart carries it again.
    const published = second.continuation.at(-1)
    expect(published?.capabilityGeneration).toBe('f1835-gen-2')
    expect(published?.activatedTools.map(lease => [lease.semanticId, lease.capabilityGeneration])).toEqual([
      [ECHO.name, 'f1835-gen-2'],
    ])
    // CONTROL — the changed entry's lease is dropped: hidden and listed as deferred again, so the model must load it
    // and read its new contract.
    for (const entry of second.modelCalls) expect(entry.tools).not.toContain(EXTRA.name)
    expect(second.modelCalls[0]!.deferredSummary).toContain(EXTRA.name)
    expect(second.modelCalls[0]!.tools).toContain('mcp__tool_load')
  }, 2 * TEST_TIMEOUT_MS)

  it('CONTROL: a tool the policy denies stays denied after loading', async () => {
    const sessionKey = { workspaceId: 'f1803-ws', sessionId: 'f1803-deny' }
    const manifest = manifestFor(sessionKey, 'f1803-gen-1', [ECHO])
    const result = await runScenario({
      label: 'deny',
      initial: { manifest, tools: [ECHO] },
      phases: [{ kind: 'prompt' }],
      deny: piName => piName === 'web_search',
      script: [load('web_search'), call('web_search', { query: 'must not run' }), say('done')],
    })

    // Loading made it visible…
    expect(result.modelCalls[1]!.tools).toContain('web_search')
    // …and the permission gate still refuses it: no search ran, the call is an error.
    expect(endsFor(result, 'web_search')).toEqual([expect.objectContaining({ isError: true })])
    expect(result.searches).toEqual([])
  }, TEST_TIMEOUT_MS)
})
