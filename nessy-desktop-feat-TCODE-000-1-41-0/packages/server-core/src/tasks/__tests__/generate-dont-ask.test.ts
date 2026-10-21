/**
 * UA4.5 — the Generate draft authors in `GENERATE_PERMISSION_MODE` (`dontAsk`), and on Pi, Claude and Codex a write
 * no rule pre-approves is REFUSED there with NO card and leaves the folder unchanged (plan UA4.5 "Tests", spec §11
 * "Generate": `dontAsk` is the one mode that never raises a card). `tasks-generate.test.ts` pins that every draft is
 * created in this mode; this file pins what the mode does on each runtime, each through that runtime's own decision
 * point, beside a control in Manual (`default`) on the same rig that DOES raise a card (so a rig that refused
 * everything, or never asked, could not pass).
 *
 * - **Pi** — the REAL `PiAgent` PreToolUse handler, the REAL Pi permission service and the REAL
 *   `SessionManager.requestPiToolApproval` (F1.841's rig, `sessions/__tests__/pi-dont-ask-ask-rule.test.ts`): cards
 *   are the `permission_request` events the SessionManager publishes.
 * - **Claude** — the two halves our side of the SDK owns: the shared PreToolUse gate (`runPreToolUseChecks`, what the
 *   claude hook runs before a tool) and the `canUseTool` callback (`buildClaudeCanUseTool`). The SDK's own `dontAsk`
 *   runs in the closed binary (UNVERIFIED here; `agent-sdk/permissions.md`: "In `dontAsk` mode, this step is skipped
 *   and the tool is denied").
 * - **Codex** — `CodexAgent.handleServerRequest` for a patch approval, ATTENDED (a draft is a visible session): declined
 *   with no card. And the config a real session writes (`buildCodexConfigToml` with the agent's own protected
 *   subpaths): in `dontAsk` its permission profile extends `:read-only` in BOTH positions of the sandbox master switch
 *   (F1.1056), and codex resolves that profile ahead of `sandbox_mode`, so with the switch OFF (the shipped default)
 *   a shell write in the folder is refused by the OS with no card, and a file change reaches the bridge above and is
 *   declined (`config-writer-mode-mapping-live.test.ts` drives the refusal on the shipped binary). Manual is the
 *   control: its profile extends `:workspace`. The generator prompt still asks for the YAML in the message only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAgent, cleanupModeState, initializeModeState, permissionsConfigCache } from '@nessy-agent/shared/agent'
import { buildClaudeCanUseTool, CAN_USE_TOOL_DONT_ASK_DENIAL, type ClaudeToolApprovalRequest } from '@nessy-agent/shared/agent/claude-agent'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '@nessy-agent/shared/agent/pi-harness/harness-manifest'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '@nessy-agent/shared/agent/pi-harness/harness-tool-descriptor'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { GENERATE_PERMISSION_MODE } from '@nessy-agent/shared/tasks/generate-limits'
import { buildCodexConfigToml, type CodexPermissionMode } from '@nessy-agent/codex-responses-adapter/config-writer'

import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { runPreToolUseChecks, type PermissionManagerLike } from '../../../../shared/src/agent/core/pre-tool-use.ts'
import { SANDBOX_ENABLED_DEFAULT } from '../../../../shared/src/config/sandbox-settings.ts'
import { createPiPermissionService } from '../../pi-harness/permission-service.ts'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'ua4-5-dont-ask-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
afterEach(() => { permissionsConfigCache.clear() })

let counter = 0
/** A fresh project folder with one file, and the path of the file a write would create. */
function project(tag: string) {
  const dir = join(root, `${tag}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'project\n')
  return { dir, target: join(dir, 'task.yaml') }
}
const listing = (dir: string) => readdirSync(dir).sort()

test('the draft mode is dontAsk (the arms below run in it)', () => {
  expect(GENERATE_PERMISSION_MODE).toBe('dontAsk')
})

// ---------------------------------------------------------------------------------------------------------------
// Pi — F1.841's rig with the Write binding.
// ---------------------------------------------------------------------------------------------------------------

function piSession(mode: PermissionMode) {
  const id = ++counter
  const workspaceId = `ws-ua45-pi-${id}`
  const { dir, target } = project('pi')
  const managed: Record<string, unknown> & { id: string } = {
    id: `session-ua45-pi-${id}`,
    activeProvider: 'pi',
    permissionMode: mode,
    isProcessing: true,
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: workspaceId, rootPath: dir },
    workingDirectory: dir,
  }
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.sessions.set(encodeSessionKey({ workspaceId, sessionId: managed.id }), managed)
  const cards: Array<Record<string, unknown>> = []
  manager.sendEvent = (event: { type?: string; request?: Record<string, unknown> }) => {
    if (event?.type !== 'permission_request' || !event.request) return
    const card = { ...event.request }
    cards.push(card)
    // Answered Deny, so the control run ends instead of waiting on the card.
    setTimeout(() => { manager.respondToPermission(String(card.sessionId), String(card.requestId), false, false, undefined, workspaceId) }, 0)
  }
  const service = createPiPermissionService({ requestApproval: request => manager.requestPiToolApproval(managed, request) })
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: workspaceId, name: 'UA4.5', rootPath: dir, workspaceRootPath: dir, sessionRootPath: join(root, `sessions-${id}`) },
    session: { id: managed.id, workspaceRootPath: dir, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: dir },
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: service,
    contextProfile: 'bare',
  } as never)
  managed.agent = agent
  agent.setPermissionMode(mode as never)
  const sent: Array<Record<string, unknown>> = []
  const internals = agent as unknown as {
    send: (message: Record<string, unknown>) => void
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>
    setCurrentTurnUserMessage: (message: string) => void
    setCapabilityTurnRuntime: (runtime: unknown) => void
    activeExecutionManifest: unknown
    handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>
    permissionManager: { setCapabilityPermissionLayers: (...args: unknown[]) => void }
  }
  internals.send = message => { sent.push(message) }
  internals.emitAutomationEvent = async () => ({ matchedCount: 0 })
  internals.setCurrentTurnUserMessage('author the task.yaml')
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: `ua45-generation-${id}`,
    sessionKey: { workspaceId, sessionId: managed.id },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
      return modelContractHash
        ? [{ descriptor: getHarnessToolDescriptor(binding.descriptorId), binding, source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName }, modelContractHash }]
        : []
    }),
  }
  const manifest = finalizePiExecutionManifest(seed, [])
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'Write')
  if (!tool) throw new Error('missing Write tool binding')
  internals.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  })
  internals.activeExecutionManifest = manifest
  internals.permissionManager.setCapabilityPermissionLayers([], manifest.snapshotGeneration, true)
  const write = () => internals.handlePreToolUseRequest({
    requestId: `req-ua45-${id}`,
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    toolName: 'Write',
    input: { path: target, content: 'id: x\n' },
  })
  return { agent, cards, sent, write, dir, target }
}

describe('UA4.5 · Pi — a Generate draft\'s write is refused with no card', () => {
  test('dontAsk: no card, the Write is blocked, the folder is unchanged', async () => {
    const pi = piSession(GENERATE_PERMISSION_MODE)
    const before = listing(pi.dir)
    await pi.write()
    pi.agent.destroy()
    expect(pi.cards).toHaveLength(0)
    expect(pi.sent.map(message => message.action)).toEqual(['block'])
    expect(existsSync(pi.target)).toBe(false)
    expect(listing(pi.dir)).toEqual(before)
  })

  test('CONTROL — Manual: the same Write raises a card (answered Deny by the rig)', async () => {
    const pi = piSession('default')
    await pi.write()
    pi.agent.destroy()
    expect(pi.cards).toHaveLength(1)
    expect(pi.sent.map(message => message.action)).toEqual(['block'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Claude — the shared PreToolUse gate and the canUseTool callback.
// ---------------------------------------------------------------------------------------------------------------

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

function claudeGate(mode: PermissionMode, toolName: string, input: Record<string, unknown>, dir: string) {
  const sessionKey = { workspaceId: 'ws-ua45-claude', sessionId: `ua45-claude-${++counter}` }
  initializeModeState(sessionKey, mode)
  try {
    return runPreToolUseChecks({
      toolName,
      input,
      sessionId: sessionKey.sessionId,
      sessionKey,
      permissionMode: mode,
      interactive: true,
      workspaceRootPath: dir,
      workspaceId: 'ws-ua45-claude',
      workingDirectory: dir,
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager,
    })
  } finally {
    cleanupModeState(sessionKey)
  }
}

function canUseTool(mode: PermissionMode) {
  const cards: ClaudeToolApprovalRequest[] = []
  const callback = buildClaudeCanUseTool({
    askUser: async () => ({ type: 'option', value: 'first', optionIndex: 0 }),
    askPermission: (request) => { cards.push(request); return Promise.resolve({ allowed: false }) },
    alreadyApprovedByGate: () => false,
    permissionMode: () => mode,
    debug: () => {},
  })
  return { callback, cards }
}

const sdkOptions = () => ({ signal: new AbortController().signal, toolUseID: `toolu_ua45_${++counter}` }) as never

describe('UA4.5 · Claude — a Generate draft\'s write is refused with no card', () => {
  test('dontAsk: the PreToolUse gate blocks Write and a shell write as "would prompt", and canUseTool denies with no card', async () => {
    const { dir, target } = project('claude')
    const before = listing(dir)
    for (const [toolName, input] of [
      ['Write', { file_path: target, content: 'id: x\n' }],
      ['Bash', { command: `printf 'id: x' > ${target}` }],
    ] as const) {
      const verdict = claudeGate(GENERATE_PERMISSION_MODE, toolName, input as Record<string, unknown>, dir)
      expect(verdict.type, toolName).toBe('block')
      expect(verdict.type === 'block' && verdict.source, toolName).toBe('dont_ask_would_prompt')
    }
    const { callback, cards } = canUseTool(GENERATE_PERMISSION_MODE)
    const answer = await callback('Write', { file_path: target, content: 'id: x\n' }, sdkOptions())
    expect(answer).toMatchObject({ behavior: 'deny', message: CAN_USE_TOOL_DONT_ASK_DENIAL })
    expect(cards).toHaveLength(0)
    expect(listing(dir)).toEqual(before)
  })

  test('CONTROL — Manual: the gate asks for the same Write, and canUseTool raises its card', async () => {
    const { dir, target } = project('claude-control')
    expect(claudeGate('default', 'Write', { file_path: target, content: 'id: x\n' }, dir).type).toBe('prompt')
    const { callback, cards } = canUseTool('default')
    await callback('Write', { file_path: target, content: 'id: x\n' }, sdkOptions())
    expect(cards).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Codex — the approval bridge, and the config codex starts with.
// ---------------------------------------------------------------------------------------------------------------

function codexAgent(mode: PermissionMode, dir: string) {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: 'ws-ua45-codex', name: 'UA4.5', rootPath: dir, workspaceRootPath: dir, sessionRootPath: join(root, 'codex-sessions') },
    session: { id: `session-ua45-codex-${++counter}`, workspaceRootPath: dir, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: dir },
    model: 'codex/test-model',
    isHeadless: true,
  } as never)
  const surfaced: unknown[] = []
  agent.onDebug = () => {}
  // Attended: a Generate draft is a visible session, so a card WOULD reach the user.
  agent.onPermissionRequest = (request) => { surfaced.push(request) }
  agent.getPermissionManager().setCapabilityPermissionLayers([], `generation-ua45-${counter}`, true)
  agent.setPermissionMode(mode)
  return { agent, surfaced }
}

function patchApproval(agent: CodexAgent, path: string) {
  const internals = agent as unknown as {
    readBeforeWriteLedger: Set<string>
    rememberCodexFileChangePaths(item: Record<string, unknown>): void
    handleServerRequest(method: string, params: unknown): unknown
  }
  internals.readBeforeWriteLedger.add(path)
  const itemId = `call-ua45-${++counter}`
  internals.rememberCodexFileChangePaths({ type: 'fileChange', id: itemId, status: 'inProgress', changes: [{ path, kind: 'add', diff: '+id: x' }] })
  return Promise.resolve(internals.handleServerRequest('item/fileChange/requestApproval', { itemId, threadId: 'thread-ua45', turnId: 'turn-ua45', startedAtMs: 0 }))
}

describe('UA4.5 · Codex — a Generate draft\'s write', () => {
  test('dontAsk: a patch approval that reaches us is declined with no card, and the folder is unchanged', async () => {
    const { dir, target } = project('codex')
    const before = listing(dir)
    const { agent, surfaced } = codexAgent(GENERATE_PERMISSION_MODE, dir)
    expect(await patchApproval(agent, target)).toEqual({ decision: 'decline' })
    expect(surfaced).toHaveLength(0)
    expect(listing(dir)).toEqual(before)
  })

  test('CONTROL — Manual: the same patch approval raises a card', async () => {
    const { dir, target } = project('codex-control')
    const { agent, surfaced } = codexAgent('default', dir)
    void patchApproval(agent, target)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(surfaced).toHaveLength(1)
  })

  test('the config a real session writes: dontAsk extends :read-only in BOTH switch positions (F1.1056), Manual :workspace', () => {
    const { dir } = project('codex-config')
    // Built as `CodexAgent` builds it: every real session passes its protected subpaths, which is what emits the
    // profile (D1.357, codex-responses-adapter `config-writer.ts`); codex resolves the profile ahead of `sandbox_mode`.
    const toml = (mode: PermissionMode, sandboxGloballyEnabled: boolean) => {
      const { agent } = codexAgent(mode, dir)
      const protectedWorkspaceSubpaths = (agent as unknown as { codexProtectedWorkspaceSubpaths(): string[] }).codexProtectedWorkspaceSubpaths()
      expect(protectedWorkspaceSubpaths.length).toBeGreaterThan(0)
      return buildCodexConfigToml({
        codexHome: join(root, 'codex-home'), model: 'codex/test-model', adapterPort: 54321,
        mode: mode as CodexPermissionMode, sandboxGloballyEnabled, protectedWorkspaceSubpaths,
      })
    }
    expect(SANDBOX_ENABLED_DEFAULT).toBe(false)
    for (const sandboxGloballyEnabled of [SANDBOX_ENABLED_DEFAULT, true]) {
      const draft = toml(GENERATE_PERMISSION_MODE, sandboxGloballyEnabled)
      expect(draft).toContain('default_permissions = "nessy_runtime"')
      expect(draft).toContain('extends = ":read-only"')
      expect(draft).not.toContain('extends = ":workspace"')
    }
    // CONTROL — Manual, same rig, same instrument, the shipped switch position: the workspace-write parent.
    const manual = toml('default', SANDBOX_ENABLED_DEFAULT)
    expect(manual).toContain('default_permissions = "nessy_runtime"')
    expect(manual).toContain('extends = ":workspace"')
    expect(manual).not.toContain('extends = ":read-only"')
  })
})
