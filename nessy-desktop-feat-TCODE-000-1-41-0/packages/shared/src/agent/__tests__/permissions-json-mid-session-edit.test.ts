/**
 * F1.938 (origin WJ-crit-iii P-2; SIT-ah recorded it as not measured) — do claude and Pi
 * pick up a mid-session edit of the workspace `permissions.json` from their next command?
 *
 * Measured in-process on both runtimes' real pre-tool gates: claude's PreToolUse hook (the
 * one a real `chatImpl` turn registers with the SDK) and Pi's `handlePreToolUseRequest`.
 * Neither compiles the rules once per session. Each reads the permissions context the
 * permission manager holds AT CALL TIME, and on the product path that context is the one
 * `buildPinnedCapabilityContext` publishes at every turn head from the turn's capability
 * snapshot (`SessionManager.createCapabilityTurn` re-inventories the files on every send, and
 * the config watcher's `emitWorkspaceInvalidation('permission')` asks for exactly that,
 * `refresh-before-next-turn`). The published layers are keyed by their content, so a new
 * file compiles a new program.
 *
 * So: an edit made between turns holds from the first command of the next turn, on both
 * runtimes, and a rule removed stops binding the same way. Codex needed F1.928 for that.
 *
 * F1.1045 — an edit made WHILE a turn runs: its NEW deny and ask rules bind from the next
 * command of that same turn (`permissions.md`: "when you add or remove a rule, Claude Code
 * applies the change starting with Claude's next tool call in the same turn"), read from the
 * live, watcher-invalidated config cache ({@link PermissionManager}'s
 * `withLiveTightening`). Tightening only: a removed deny and a new allow wait for the next
 * turn's snapshot. Before F1.1045 the same-turn arms below were red (the turn's layers were
 * pinned to its snapshot, and `materializer.readText` refuses a file that moved since it).
 *
 * Rigs: the snapshot a fresh turn would carry is built from the file on disk (the revision and
 * content hash the inventory records) and read through the REAL snapshot materializer; the SDK
 * `query` is the only double on claude, the permission service the only one on Pi.
 */
import { afterAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import type { PermissionMode } from '../mode-types.ts'
import { createCapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'
import { PI_STATIC_MODEL_CONTRACT_HASHES, PI_TOOL_BINDINGS, getHarnessToolDescriptor } from '../pi-harness/harness-tool-descriptor.ts'
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts'
import { permissionsConfigCache } from '../permissions-config.ts'
import type { PermissionManager } from '../core/permission-manager.ts'
import { evaluatePermissionDslV1 } from '../pi-harness/permission-dsl.ts'

// The module graph (the whole claude and Pi agents) is the cost, not the bodies.
setDefaultTimeout(180_000)

/** A SNAPSHOT of the SDK's exports, never the live namespace (AGENTS.md §Traps, `mock.module`). */
const realSdk = { ...sdkPackage }
type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>
let capturedOptions: Record<string, unknown> | undefined
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = input.options
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    async function* serve(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      }
    }
    const stream = serve() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> }
    stream.interrupt = async () => ({ still_queued: [] })
    return stream
  },
}))

const { ClaudeAgent } = await import('../claude-agent.ts')
const { PiAgent } = await import('../pi-agent.ts')

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'f1938-')))
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
  rmSync(ROOT, { recursive: true, force: true })
})

const COMMAND = 'rm -rf x'
const MODE: PermissionMode = 'bypassPermissions'
const DENY_RM = { id: 'deny-rm-mid-session', action: 'deny', match: { kind: 'bash', executable: 'rm' } }
const DENY_GIT = { id: 'deny-git', action: 'deny', match: { kind: 'bash', executable: 'git' } }
const ALLOW_CURL = { id: 'allow-curl', action: 'allow', match: { kind: 'bash', executable: 'curl' } }

let wsCounter = 0
function workspace(): string {
  wsCounter += 1
  const ws = join(ROOT, `ws-${wsCounter}`)
  mkdirSync(ws, { recursive: true })
  writeRules(ws, [])
  return ws
}
/** The user's edit of the workspace store, and what the config watcher does on it. */
function writeRules(ws: string, rules: unknown[]): void {
  writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ permissionDsl: { version: 1, rules } }))
  permissionsConfigCache.invalidateWorkspace(ws)
}

/**
 * The capability runtime a turn starting NOW would carry: the workspace `permissions.json`
 * as a permission layer with the revision and content hash the inventory records for the
 * file on disk, read through the real snapshot materializer.
 */
function turnRuntime(ws: string, generation: string): CapabilityTurnRuntime {
  const path = join(ws, 'permissions.json')
  const resource = {
    source: 'workspace' as const,
    scope: { kind: 'workspace' as const, workspaceId: 'ws-f1938' },
    resourceId: 'permissions.json',
    absolutePath: path,
    revision: String(statSync(path).mtimeMs),
    contentHash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }
  const materializer = createCapabilitySnapshotMaterializer(
    { isLeaseActive: () => true } as never,
    { leaseId: `lease-${generation}`, installedPlugins: [] } as never,
  )
  return {
    provider: 'pi',
    view: {
      generation,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [],
      permissionLayers: [{ key: 'permission::workspace::permissions.json', resource, order: 0, scope: 'workspace' }],
      commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer,
    piExecutionManifestSeed: { snapshotGeneration: generation },
  } as unknown as CapabilityTurnRuntime
}

/** The per-turn step `BaseAgent.chat` runs before the model call. */
async function startTurn(agent: object, runtime: CapabilityTurnRuntime): Promise<void> {
  const typed = agent as unknown as { setCapabilityTurnRuntime(r: CapabilityTurnRuntime): void; buildPinnedCapabilityContext(): Promise<string | null> }
  typed.setCapabilityTurnRuntime(runtime)
  await typed.buildPinnedCapabilityContext()
}

// ---------------------------------------------------------------- claude rig

async function claudeSession(ws: string) {
  capturedOptions = undefined
  const agent = new ClaudeAgent({
    provider: 'anthropic', providerType: 'anthropic', model: 'claude-sonnet-4-6', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'ws-f1938', name: 'F1938', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: `session-f1938-${wsCounter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws, permissionMode: MODE } as never,
  } as BackendConfig)
  agent.setPermissionMode(MODE)
  agent.onPermissionRequest = () => { throw new Error('bypass with a deny rule raises no card') }
  const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<unknown> }).chatImpl.bind(agent)
  for await (const _ of chatImpl('go')) { /* the turn that registers the PreToolUse hook */ }
  const seen = capturedOptions as Record<string, unknown> | undefined
  const hook = (seen?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> } | undefined)?.PreToolUse?.[0]?.hooks?.[0]
  if (!hook) throw new Error('the turn registered no PreToolUse hook')
  let call = 0
  /** One Bash command through the real hook: its decision and reason. */
  const run = async () => {
    call += 1
    const out = (await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_f1938_${call}`, tool_input: { command: COMMAND }, session_id: 'sdk-f1938', transcript_path: join(ROOT, 't.jsonl'), cwd: ws },
      `toolu_f1938_${call}`,
      { signal: new AbortController().signal },
    ) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)?.hookSpecificOutput
    return { decision: String(out?.permissionDecision), reason: String(out?.permissionDecisionReason ?? '') }
  }
  return { agent, run }
}

// ---------------------------------------------------------------- Pi rig

function allowingService(): PiPermissionServicePort {
  return {
    async authorize(request) {
      const outcome = request.decision.outcome === 'deny' ? 'deny' : 'allow'
      return parseAndFreezePiPermissionReceipt({
        version: 1, sessionKey: request.subject.sessionKey,
        binding: { provider: 'pi', surfaceVersion: request.subject.surfaceVersion, piName: request.subject.piName, bindingName: request.subject.bindingName, semanticId: request.subject.semanticId, descriptorId: request.subject.descriptorId },
        manifest: { generation: request.subject.manifestGeneration, hash: request.subject.manifestHash, provenance: request.subject.manifestProvenance, responseEpoch: request.subject.responseEpoch },
        decisionId: 'f1938', outcome,
        canonicalInput: (request.decision.outcome === 'allow' ? request.decision.canonicalInput : undefined) ?? request.canonicalInput,
        contextProfile: request.subject.contextProfile, sandboxRequirement: request.subject.sandboxRequirement,
        ...(request.decision.outcome === 'deny' ? { reason: request.decision.reason } : {}),
      }, request.subject)
    },
  }
}

function piSession(ws: string) {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-f1938', name: 'W', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: `session-f1938-pi-${wsCounter}`, workspaceRootPath: ws, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws } as never,
    model: 'pi/test-model', isHeadless: true, permissionServicePort: allowingService(), contextProfile: 'bare',
  } as BackendConfig)
  agent.setPermissionMode(MODE)
  const state = agent as unknown as Record<string, any>
  const sent: Array<Record<string, unknown>> = []
  state.send = (message: Record<string, unknown>) => { sent.push(message) }
  state.emitAutomationEvent = async () => ({ matchedCount: 0 })
  let manifest: ReturnType<typeof finalizePiExecutionManifest> | undefined
  /** A turn head: the capability runtime, its pinned layers, and the manifest built for it. */
  const turn = async (generation: string) => {
    await startTurn(agent, turnRuntime(ws, generation))
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2, snapshotGeneration: generation, sessionKey: { workspaceId: 'ws-f1938', sessionId: `session-f1938-pi-${wsCounter}` },
      provenance: [], mcpSources: [],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
        const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
        return modelContractHash ? [{ descriptor: getHarnessToolDescriptor(binding.descriptorId), binding, source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName }, modelContractHash }] : []
      }),
    }
    manifest = finalizePiExecutionManifest(seed, [])
    state.activeExecutionManifest = manifest
  }
  let call = 0
  /** One Bash command through the real host gate: the action the harness is told. */
  const run = async () => {
    call += 1
    const tool = manifest!.tools.find(candidate => candidate.binding.permissionName === 'Bash')!
    await state.handlePreToolUseRequest({
      requestId: `r${call}`, semanticId: tool.descriptor.id, piName: tool.binding.piName, surfaceVersion: manifest!.surfaceVersion,
      manifestResponseEpoch: 0, manifestGeneration: manifest!.snapshotGeneration, manifestHash: manifest!.manifestHash,
      toolName: 'Bash', input: { command: COMMAND },
    })
    const response = sent.filter(message => message.type === 'pre_tool_use_response').at(-1)
    return { action: String(response?.action), reason: String(response?.reason ?? '') }
  }
  return { agent, turn, run }
}

// ---------------------------------------------------------------- the measurement

describe('F1.938 · claude — a permissions.json edit between turns binds the next turn\'s first command', () => {
  test('no rule → allowed; a deny written after turn 1 → the first command of turn 2 is refused naming it', async () => {
    const ws = workspace()
    const { agent, run } = await claudeSession(ws)
    try {
      await startTurn(agent, turnRuntime(ws, 'gen-1'))
      expect((await run()).decision).toBe('allow')
      writeRules(ws, [DENY_RM])
      await startTurn(agent, turnRuntime(ws, 'gen-2'))
      const refused = await run()
      expect(refused.decision).toBe('deny')
      expect(refused.reason).toContain('deny-rm-mid-session')
    } finally { agent.destroy() }
  })

  test('F1.1045: a deny written DURING turn 1 refuses the next command of turn 1, naming it', async () => {
    const ws = workspace()
    const { agent, run } = await claudeSession(ws)
    try {
      await startTurn(agent, turnRuntime(ws, 'gen-1'))
      expect((await run()).decision).toBe('allow')
      writeRules(ws, [DENY_RM])
      const refused = await run()
      expect(refused.decision).toBe('deny')
      expect(refused.reason).toContain('deny-rm-mid-session')
    } finally { agent.destroy() }
  })

  test('BOUNDARY: the deny removed DURING a turn (another rule in its place) still binds that turn (tightening only); the next turn allows again', async () => {
    const ws = workspace()
    writeRules(ws, [DENY_RM])
    const { agent, run } = await claudeSession(ws)
    try {
      await startTurn(agent, turnRuntime(ws, 'gen-1'))
      expect((await run()).decision).toBe('deny')
      writeRules(ws, [DENY_GIT])
      // A removal loosens, so it waits for the next turn's snapshot.
      expect((await run()).decision).toBe('deny')
      await startTurn(agent, turnRuntime(ws, 'gen-2'))
      expect((await run()).decision).toBe('allow')
    } finally { agent.destroy() }
  })

  test('BOUNDARY: an allow written DURING a turn is not read until the next turn; the deny beside it binds at once', async () => {
    const ws = workspace()
    const { agent } = await claudeSession(ws)
    try {
      await startTurn(agent, turnRuntime(ws, 'gen-1'))
      writeRules(ws, [ALLOW_CURL, DENY_GIT])
      const manager = (agent as unknown as { permissionManager: PermissionManager }).permissionManager
      const program = permissionsConfigCache.getMergedConfig(manager.getCapabilityPermissionsContext()!).permissionDsl!
      const verdict = (command: string) => evaluatePermissionDslV1(program, { generation: 'gen-1', semanticId: 'Bash', toolName: 'Bash', input: { command }, cwd: ws })
      expect(verdict('git status').action).toBe('deny')
      expect(verdict('curl https://example.test').action).toBeUndefined()
      await startTurn(agent, turnRuntime(ws, 'gen-2'))
      const next = permissionsConfigCache.getMergedConfig(manager.getCapabilityPermissionsContext()!).permissionDsl!
      expect(evaluatePermissionDslV1(next, { generation: 'gen-2', semanticId: 'Bash', toolName: 'Bash', input: { command: 'curl https://example.test' }, cwd: ws }).action).toBe('allow')
    } finally { agent.destroy() }
  })
})

describe('F1.938 · Pi — a permissions.json edit between turns binds the next turn\'s first command', () => {
  test('no rule → allowed; a deny written after turn 1 → the first command of turn 2 is refused naming it', async () => {
    const ws = workspace()
    const { agent, turn, run } = piSession(ws)
    try {
      await turn('gen-1')
      expect((await run()).action).not.toBe('block')
      writeRules(ws, [DENY_RM])
      await turn('gen-2')
      const refused = await run()
      expect(refused.action).toBe('block')
      expect(refused.reason).toContain('deny-rm-mid-session')
    } finally { agent.destroy() }
  })

  test('F1.1045: a deny written DURING turn 1 refuses the next command of turn 1, naming it', async () => {
    const ws = workspace()
    const { agent, turn, run } = piSession(ws)
    try {
      await turn('gen-1')
      expect((await run()).action).not.toBe('block')
      writeRules(ws, [DENY_RM])
      const refused = await run()
      expect(refused.action).toBe('block')
      expect(refused.reason).toContain('deny-rm-mid-session')
    } finally { agent.destroy() }
  })

  test('BOUNDARY: the deny removed DURING a turn (another rule in its place) still binds that turn (tightening only); the next turn allows again', async () => {
    const ws = workspace()
    writeRules(ws, [DENY_RM])
    const { agent, turn, run } = piSession(ws)
    try {
      await turn('gen-1')
      expect((await run()).action).toBe('block')
      writeRules(ws, [DENY_GIT])
      // A removal loosens, so it waits for the next turn's snapshot.
      expect((await run()).action).toBe('block')
      await turn('gen-2')
      expect((await run()).action).not.toBe('block')
    } finally { agent.destroy() }
  })
})
