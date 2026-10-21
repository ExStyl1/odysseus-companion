/**
 * F1.920 + F1.924 `[pi]` `[guardian]` — a Guardian judge child never raises a
 * user card, through ANY door.
 *
 * ## The measured defect
 *
 * F1.861 (`836fe85c1`) closed ONE door: `refuseGuardianJudgeCard` in `PiAgent`
 * answers the judge's out-of-root read `root: null` without a card. The 1.41.0
 * delta review 2 (its judge-ask-card probe, untracked under `work/review-142/`, on F1.902's rig)
 * measured the next one: a judge child whose in-root `Read` matches a workspace
 * `ask` rule still published a `permission_dsl` card, routed to the visible
 * parent labelled `scout: Judge the following planned action`, and the user's
 * Deny refused only the judge's read — the SIT-ae shape F1.861 existed to
 * remove. A PreToolUse hook answering `ask` for the judge's read reaches the same
 * band. F1.924 is a third door beside them: since F1.771 a command hook in
 * `explore` is checked as `default`, so a PLUGIN's PreToolUse command hook
 * inherited by the hidden judge child raises the hook runner's own card — one
 * that never goes through `handleAgentPermissionRequest` — and each judge lookup
 * waits the hook's approval budget for a card nobody can see.
 *
 * ## The fix under test
 *
 * The host refuses at its funnels, for a host-consult child
 * (`isHostConsultRecord` over the child's own `piChildRestrictions`) or any
 * session beneath one: `handleAgentPermissionRequest` (every card that reaches
 * the ordinary pipeline — Pi tool prompts through `requestPiToolApproval`, and
 * the backend's own `onPermissionRequest` door, outside-root included) and
 * `createTelemetryPiPermissionService` (the constructor the Pi tool service, the
 * command-hook runner and the skill-context runner are all built through). A
 * refusal is a DENY with no card and one debug line; it never allows anything.
 *
 * ## The rig
 *
 * The reviewer's (F1.902's): the REAL `PiAgent.handlePreToolUseRequest`, the REAL
 * permission service, the REAL `SessionManager.requestPiToolApproval` whose
 * `permission_request` event IS the card; the rule enters as a workspace
 * settings document. The judge's `piChildRestrictions` are the ones the REAL
 * judge port writes (`createGuardianJudgePort` over the REAL
 * `ChildSessionService`, read once below), cloned onto the child as
 * `startPiChildRuntime` does. F1.924's arm drives the REAL `pluginCommandHookRunner`
 * (F1.771's rig, `SessionManager.hook-plan-mode.test.ts`). Every card is answered
 * Deny, the way the SIT-ae user answered.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAgent, permissionsConfigCache } from '@nessy-agent/shared/agent'
import type { PiChildRestrictionsV1, PiChildSessionPort, PiChildSessionRecordV1, PiChildStartInput } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '@nessy-agent/shared/agent/pi-harness/harness-manifest'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '@nessy-agent/shared/agent/pi-harness/harness-tool-descriptor'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  getHookCommandPreToolDecision,
  isBlockingHookDecision,
  projectHookDecisionForEvent,
} from '@nessy-agent/shared/automations'
import { GUARDIAN_JUDGE_HOST_REFUSAL, GUARDIAN_POLICY_PROMPT, type GuardianJudgeInput } from '@nessy-agent/shared/prompts/guardian'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { ChildSessionService, isHostConsultRecord, isPluginHookAgentRecord } from '../../pi-harness/child-session-service.ts'
import { createPiPermissionService } from '../../pi-harness/permission-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager + PiAgent module graphs dominate this file's wall time on
// this rig (F1.817's reading); the bodies are milliseconds.
setDefaultTimeout(120_000)

const JUDGE_LABEL = 'scout: Judge the following planned action'
/** The sentence the model is told when the host refuses a judge's request. */
const REFUSAL = 'A Guardian safety judge cannot ask the user for permission'
const ASK_READ = JSON.stringify({ permissions: { ask: ['Read(secret.txt)', 'Read(./secret.txt)', 'Read(**/secret.txt)'] } })
/** An ordinary subagent's restrictions: a built-in-style prompt that is not the guardian policy. */
const SUBAGENT_PROMPT = 'You are scout, a fast read-only explorer.'
/** F1.1040 — the hook agent child's name, as `startPiChildRuntime` builds it from the runner's record. */
const HOOK_AGENT_LABEL = 'verifier: Run the declared PreToolUse plugin hook agent.'
/** F1.1040 — the sentence a hook agent's verifier is told when the host refuses its request. */
const HOOK_REFUSAL = 'A plugin hook\'s agent cannot ask the user for permission'

let root = ''
let judgeRestrictions: PiChildRestrictionsV1
let hookAgentRestrictions: PiChildRestrictionsV1

/**
 * The restrictions the REAL judge port starts the judge with — read off the
 * record the REAL `ChildSessionService` hands its runtime. A change to how the
 * judge is started goes red here, not in a hand-written copy.
 */
async function readRealJudgeRestrictions(): Promise<PiChildRestrictionsV1> {
  const records: PiChildSessionRecordV1[] = []
  const service = new ChildSessionService({
    parentSessionKey: { workspaceId: 'workspace-judge', sessionId: 'parent' },
    persist: async () => {},
    disabledByPolicy: () => false,
    runtime: {
      start: async record => {
        records.push(record)
        const output = JSON.stringify({ verdict: 'no_objection', reason: 'a read-only check' })
        return { childSessionKey: record.childSessionKey, transcriptId: `t-${record.agentId}`, status: 'completed', output, result: output }
      },
      resume: async () => ({ status: 'completed' }),
      steer: async () => {},
      stop: async () => {},
    },
  })
  const childPort = {
    start: async (input: PiChildStartInput) => service.start(input),
    stop: async (agentId: string) => service.stop(agentId),
  } as unknown as PiChildSessionPort
  const manager = createTestSessionManager()
  try {
    const judgePort = (manager as any).createGuardianJudgePort(
      { id: 'parent', model: 'gateway-fast', workspace: { id: 'workspace-judge', rootPath: process.cwd() } },
      childPort,
      undefined,
    )
    const input: GuardianJudgeInput = {
      action: { command: 'rm -rf ~/f1920-danger', cwd: process.cwd() },
      trustedIntent: 'Delete the folder f1920-danger in my home directory.',
      facts: { mode: 'auto', workspaceRoot: process.cwd() },
    }
    const result = await judgePort.judge({ input, cwd: process.cwd() })
    // CONTROL (the judge still answers): the port's verdict path is untouched.
    expect(result.verdict).toBe('no_objection')
  } finally {
    await manager.cleanup()
  }
  expect(records).toHaveLength(1)
  // PRECONDITION: this IS the record the host's own predicate calls a consult.
  expect(isHostConsultRecord(records[0]!)).toBe(true)
  return structuredClone(records[0]!.restrictions)
}

/**
 * F1.1040 — the restrictions the REAL plugin hook agent runner
 * (`SessionManager.pluginAgentHookRunner`, a hook's `type: "agent"`) starts its
 * verifier child with, read off the `port.start` input it hands the child port.
 */
async function readRealHookAgentRestrictions(): Promise<PiChildRestrictionsV1> {
  const starts: PiChildStartInput[] = []
  const agentKey = 'plugin://f1040/agent.verifier@workspace'
  const manager = createTestSessionManager() as any
  manager.appendPiExecutionReceipt = (_managed: unknown, receipt: unknown) => receipt
  manager.piGoalReceiptReference = () => undefined
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  manager.isPluginHookEffectAllowed = async () => true
  const runtime = {
    projectTrustState: 'trusted',
    view: {
      generation: 'f1040-generation', sources: [], skills: [], mcpServers: [], hooks: [], automations: [],
      agents: [{
        key: agentKey,
        name: 'verifier',
        description: 'Checks the planned read before it runs',
        instructionsResource: { pluginInstanceId: 'plugin://f1040@1.0.0#fixture', relativePath: 'agents/verifier.md', contentHash: 'fixture' },
        tools: ['Read'],
      }],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { throw new Error('not used') },
      async readText() { return 'Verify that the planned read is safe; answer {"ok": true} or {"ok": false, "reason": "..."}.' },
      resolveCredential() { throw new Error('not used') },
    },
  }
  const port = {
    start: async (input: PiChildStartInput) => { starts.push(input); return { agentId: String(input.requestedAgentId), status: 'completed', output: '{"ok": true}' } },
    stop: async () => {},
  }
  try {
    await manager.pluginAgentHookRunner(
      { id: 'parent-f1040', workspace: { id: 'workspace-f1040', rootPath: process.cwd() }, model: 'parent-model', piChildSessionPort: port },
      runtime,
    )({ agentName: agentKey, event: 'PreToolUse' })
  } finally {
    await manager.cleanup()
  }
  expect(starts).toHaveLength(1)
  // PRECONDITION: this IS a hook agent by F1.1047's record predicate, and NOT a
  // host consult — so the four other `isHostConsultRecord` behaviours (fan-out,
  // agent panel, managed-hooks lock, subagent hooks) cannot move with F1.1040.
  const record = { agentId: String(starts[0]!.requestedAgentId), restrictions: starts[0]!.restrictions }
  expect(isPluginHookAgentRecord(record)).toBe(true)
  expect(isHostConsultRecord(record)).toBe(false)
  return structuredClone(starts[0]!.restrictions)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'f1920-judge-no-card-'))
  judgeRestrictions = await readRealJudgeRestrictions()
  hookAgentRestrictions = await readRealHookAgentRestrictions()
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
afterEach(() => { permissionsConfigCache.clear() })

type Card = Record<string, unknown>
type Kind = 'top-level' | 'judge' | 'subagent' | 'judge-grandchild' | 'hook-agent' | 'hook-agent-lookalike'
let counter = 0

/**
 * One Pi session of the given kind, with the REAL gate. `wiring: 'host'` builds
 * the permission service the way the host does for a Pi session
 * (`createTelemetryPiPermissionService` over `requestPiToolApproval`);
 * `'direct'` is the reviewer's wiring (the bare service over the same seam), so
 * the `handleAgentPermissionRequest` funnel is measured on its own.
 */
function piSession(options: { kind: Kind; wiring: 'host' | 'direct'; permissions?: string; hookAsks?: boolean }) {
  const id = ++counter
  const workspaceId = `ws-f1920-${id}`
  const workingDirectory = join(root, `project-${id}`)
  mkdirSync(workingDirectory, { recursive: true })
  writeFileSync(join(workingDirectory, 'secret.txt'), 'x')
  const workspace = { id: workspaceId, rootPath: workingDirectory }
  const stub = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    id: sessionId,
    activeProvider: 'pi',
    permissionMode: 'plan',
    isProcessing: true,
    backgroundShellCommands: new Map<string, unknown>(),
    workspace,
    workingDirectory,
    ...extra,
  })
  const child = (sessionId: string, parentId: string, name: string, restrictions: PiChildRestrictionsV1) => stub(sessionId, {
    hidden: true,
    name,
    piParentSessionKey: { workspaceId, sessionId: parentId },
    piChildRestrictions: structuredClone(restrictions),
  })
  const sessions: Array<Record<string, unknown> & { id: string }> = []
  let managed: Record<string, unknown> & { id: string }
  if (options.kind === 'top-level') {
    managed = stub(`session-f1920-${id}`)
    sessions.push(managed)
  } else {
    const parent = stub(`parent-f1920-${id}`)
    sessions.push(parent)
    if (options.kind === 'judge-grandchild') {
      // A session BENEATH the judge — the only way there is an `agent`-type
      // hook the judge inherited. Its own prompt is not the guardian policy.
      const judge = child(`judge-f1920-${id}`, parent.id, JUDGE_LABEL, judgeRestrictions)
      sessions.push(judge)
      managed = child(`session-f1920-${id}`, judge.id, 'hook-agent: check the read', { ...judgeRestrictions, prompt: 'You are a hook agent.' })
    } else if (options.kind === 'hook-agent' || options.kind === 'hook-agent-lookalike') {
      // F1.1040: the verifier child of a hook's `type: "agent"`, restrictions off
      // the REAL runner; the lookalike is a named subagent whose definition body
      // copies the runner's sentence — `composeChildPrompt` leads it with the
      // subagent's own text, so the sentence does not lead its prompt.
      managed = child(`session-f1040-${id}`, parent.id, HOOK_AGENT_LABEL, options.kind === 'hook-agent'
        ? hookAgentRestrictions
        : { ...hookAgentRestrictions, prompt: `${SUBAGENT_PROMPT}\n\n${hookAgentRestrictions.prompt}` })
    } else {
      managed = options.kind === 'judge'
        ? child(`session-f1920-${id}`, parent.id, JUDGE_LABEL, judgeRestrictions)
        : child(`session-f1920-${id}`, parent.id, 'scout: list the project files', { ...judgeRestrictions, prompt: SUBAGENT_PROMPT })
    }
    sessions.push(managed)
  }
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.persistBashAlwaysAllowRule = () => undefined
  for (const session of sessions) manager.sessions.set(encodeSessionKey({ workspaceId, sessionId: session.id }), session)
  const cards: Card[] = []
  manager.sendEvent = (event: { type?: string; request?: Card }) => {
    if (event?.type !== 'permission_request' || !event.request) return
    const card = { ...event.request }
    cards.push(card)
    // The SIT-ae user's answer: Deny.
    setTimeout(() => {
      manager.respondToPermission(String(card.sessionId), String(card.requestId), false, false, undefined, workspaceId)
    }, 0)
  }
  const requestApproval = (request: any) => manager.requestPiToolApproval(managed, request)
  const service = options.wiring === 'host'
    ? manager.createTelemetryPiPermissionService(managed, { requestApproval })
    : createPiPermissionService({ requestApproval })
  const childPrompt = (managed.piChildRestrictions as PiChildRestrictionsV1 | undefined)?.prompt
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: workspaceId,
      name: 'F1.920 Workspace',
      rootPath: workingDirectory,
      workspaceRootPath: workingDirectory,
      sessionRootPath: join(root, `sessions-${id}`),
    },
    session: {
      id: managed.id,
      workspaceRootPath: workingDirectory,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory,
    },
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: service,
    contextProfile: 'bare',
    // The host's mapping (`childSystemPrompt: managed.piChildRestrictions?.prompt`).
    ...(childPrompt !== undefined ? { childSystemPrompt: childPrompt, piChildKind: 'named' } : {}),
  } as never)
  managed.agent = agent
  agent.setPermissionMode('plan' as never)
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
  // A PreToolUse hook answering `ask` for the read (hooks.md#pretooluse), or no hook at all.
  internals.emitAutomationEvent = async event => event === 'PreToolUse' && options.hookAsks
    ? { matchedCount: 1, decision: { decision: 'ask', reason: 'A PreToolUse hook wants the user to confirm this read.' } }
    : { matchedCount: 0 }
  internals.setCurrentTurnUserMessage('Judge the following planned action. Command: rm -rf ~/f1920-danger')

  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: `f1920-generation-${id}`,
    sessionKey: { workspaceId, sessionId: managed.id },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
      return modelContractHash
        ? [{
            descriptor: getHarnessToolDescriptor(binding.descriptorId),
            binding,
            source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
            modelContractHash,
          }]
        : []
    }),
  }
  const manifest = finalizePiExecutionManifest(seed, [])
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'Read')
  if (!tool) throw new Error('missing Read tool binding')
  internals.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  })
  internals.activeExecutionManifest = manifest
  internals.permissionManager.setCapabilityPermissionLayers(
    options.permissions
      ? [{ content: options.permissions, scope: 'workspace', sourceRoot: workingDirectory }]
      : [],
    manifest.snapshotGeneration,
    true,
  )
  let calls = 0
  const read = async () => {
    await internals.handlePreToolUseRequest({
      requestId: `req-f1920-${id}-${++calls}`,
      semanticId: tool.descriptor.id,
      piName: tool.binding.piName,
      surfaceVersion: manifest.surfaceVersion,
      manifestResponseEpoch: 0,
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      toolName: 'Read',
      input: { path: join(workingDirectory, 'secret.txt') },
    })
  }
  const verdicts = () => sent.map(message => ({ action: message.action, reason: message.reason }))
  return { agent, manager, managed, cards, verdicts, read }
}

describe('F1.920 — a Guardian judge child raises no card through any door', () => {
  for (const wiring of ['host', 'direct'] as const) {
    test(`the readable-DSL ask arm (the reviewer's probe, ${wiring} wiring): no card, the read is refused, not allowed`, async () => {
      const s = piSession({ kind: 'judge', wiring, permissions: ASK_READ })
      try {
        await s.read()
        expect(s.cards).toEqual([])
        expect(s.verdicts()).toHaveLength(1)
        expect(s.verdicts()[0]!.action).toBe('block')
        expect(String(s.verdicts()[0]!.reason)).toContain(REFUSAL)
        expect(s.manager.pendingPermissionRequests.size).toBe(0)
        expect(s.manager.directPermissionResolvers.size).toBe(0)
      } finally {
        s.agent.destroy()
      }
    })
  }

  test('a PreToolUse hook answering ask for the judge\'s read: no card, the read is refused', async () => {
    const s = piSession({ kind: 'judge', wiring: 'host', hookAsks: true })
    try {
      await s.read()
      expect(s.cards).toEqual([])
      expect(s.verdicts()).toEqual([{ action: 'block', reason: expect.stringContaining(REFUSAL) }])
    } finally {
      s.agent.destroy()
    }
  })

  test('the backend\'s own onPermissionRequest door (outside-root, behind F1.861\'s refusal): the host answers Deny, publishes nothing, records nothing', () => {
    const s = piSession({ kind: 'judge', wiring: 'host' })
    const answers: Array<[string, boolean, boolean]> = []
    const realAgent = s.managed.agent
    s.managed.agent = { respondToPermission: (requestId: string, allowed: boolean, always: boolean) => { answers.push([requestId, allowed, always]) } }
    try {
      s.manager.handleAgentPermissionRequest(s.managed, {
        requestId: 'pi-oroot-f1920-1',
        toolName: 'Read',
        type: 'outside_root',
        command: '/Users/someone/f1920-danger',
        description: 'Allow read access outside the session root: /Users/someone/f1920-danger',
      })
      expect(s.cards).toEqual([])
      expect(answers).toEqual([['pi-oroot-f1920-1', false, false]])
      expect(s.manager.pendingPermissionRequests.size).toBe(0)
      expect(s.managed.pendingApproval).toBeUndefined()
    } finally {
      s.managed.agent = realAgent
      s.agent.destroy()
    }
  })

  test('a session BENEATH the judge (an agent hook\'s child) raises no card either', async () => {
    const s = piSession({ kind: 'judge-grandchild', wiring: 'host', permissions: ASK_READ })
    try {
      await s.read()
      expect(s.cards).toEqual([])
      expect(s.verdicts()).toEqual([{ action: 'block', reason: expect.stringContaining(REFUSAL) }])
    } finally {
      s.agent.destroy()
    }
  })
})

describe('F1.920 — controls: every other session\'s cards are unchanged', () => {
  test('CONTROL: the judge\'s in-root read with no rule and no hook is allowed with no card (the judge still investigates)', async () => {
    const s = piSession({ kind: 'judge', wiring: 'host' })
    try {
      await s.read()
      expect(s.cards).toEqual([])
      expect(s.verdicts().map(v => v.action)).toEqual(['allow'])
    } finally {
      s.agent.destroy()
    }
  })

  test('CONTROL: an ordinary subagent\'s ask-rule card still reaches the visible parent, labelled, and its Deny refuses', async () => {
    const s = piSession({ kind: 'subagent', wiring: 'host', permissions: ASK_READ })
    try {
      await s.read()
      expect(s.cards).toHaveLength(1)
      expect(s.cards[0]).toMatchObject({
        toolName: 'Read',
        type: 'permission_dsl',
        parentSessionId: `parent-f1920-${counter}`,
        agentLabel: 'scout: list the project files',
      })
      expect(s.verdicts()).toEqual([{ action: 'block', reason: 'Permission denied by user.' }])
    } finally {
      s.agent.destroy()
    }
  })

  test('CONTROL: an ordinary subagent\'s hook ask still cards', async () => {
    const s = piSession({ kind: 'subagent', wiring: 'host', hookAsks: true })
    try {
      await s.read()
      expect(s.cards).toHaveLength(1)
      expect(s.verdicts()).toEqual([{ action: 'block', reason: 'Permission denied by user.' }])
    } finally {
      s.agent.destroy()
    }
  })

  test('CONTROL: a top-level session\'s ask-rule card is unchanged (no routing, Deny refuses)', async () => {
    const s = piSession({ kind: 'top-level', wiring: 'host', permissions: ASK_READ })
    try {
      await s.read()
      expect(s.cards).toHaveLength(1)
      expect(s.cards[0]!.type).toBe('permission_dsl')
      expect(s.cards[0]!.parentSessionId).toBeUndefined()
      expect(s.verdicts()).toEqual([{ action: 'block', reason: 'Permission denied by user.' }])
    } finally {
      s.agent.destroy()
    }
  })

  test('CONTROL: an ordinary subagent\'s onPermissionRequest card still reaches the parent', () => {
    const s = piSession({ kind: 'subagent', wiring: 'host' })
    const answers: Array<[string, boolean]> = []
    const realAgent = s.managed.agent
    s.managed.agent = { respondToPermission: (requestId: string, allowed: boolean) => { answers.push([requestId, allowed]) } }
    try {
      s.manager.handleAgentPermissionRequest(s.managed, {
        requestId: 'pi-oroot-f1920-control',
        toolName: 'Read',
        type: 'outside_root',
        command: '/Users/someone/f1920-danger',
        description: 'Allow read access outside the session root: /Users/someone/f1920-danger',
      })
      expect(s.cards).toHaveLength(1)
      expect(s.cards[0]).toMatchObject({ type: 'outside_root', agentLabel: 'scout: list the project files' })
    } finally {
      s.managed.agent = realAgent
      s.agent.destroy()
    }
  })
})

/** A plugin PreToolUse command hook whose command the gate classifies `ask` in `default` (F1.771's plugin arm). */
const PLUGIN_HOOK = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"f1924"}}'`
/** The judge arm's approval budget: long enough that a card-and-wait cannot pass for "at once". */
const JUDGE_HOOK_BUDGET_MS = 10_000

async function runPluginHookIn(kind: 'judge' | 'subagent', budgetMs: number) {
  const hookRoot = mkdtempSync(join(root, `f1924-${kind}-`))
  const workspaceId = `ws-f1924-${kind}`
  const manager = createTestSessionManager() as any
  const sent: Array<{ type: string }> = []
  manager.appendPiExecutionReceipt = () => undefined
  manager.piGoalReceiptReference = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.persistSession = () => undefined
  manager.sendEvent = (event: { type: string }) => { sent.push(event) }
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  const managed = {
    id: `session-f1924-${kind}`,
    activeProvider: 'pi',
    permissionMode: 'plan',
    workspace: { id: workspaceId, rootPath: hookRoot },
    workingDirectory: hookRoot,
    messages: [] as Array<{ role: string; content?: string }>,
    hidden: true,
    name: kind === 'judge' ? JUDGE_LABEL : 'scout: list the project files',
    piParentSessionKey: { workspaceId, sessionId: `parent-f1924-${kind}` },
    piChildRestrictions: kind === 'judge' ? structuredClone(judgeRestrictions) : { ...structuredClone(judgeRestrictions), prompt: SUBAGENT_PROMPT },
  }
  const runner = manager.pluginCommandHookRunner(managed, {
    projectTrustState: 'none' as const,
    view: { generation: 'gen-f1924', hooks: [], permissionLayers: [] },
    materializer: { assertActive() {}, async readText() { return '' } },
  })
  // `blockOnNonZero: false` is how `pluginHookAction` imports a plugin's hook
  // (Claude's three-way exit semantics): a hook that did not run is a notice,
  // not a block, so the judge's read goes on without the plugin's opinion.
  const action = { type: 'command' as const, command: PLUGIN_HOOK, timeoutMs: budgetMs, blockOnNonZero: false }
  const startedAt = Date.now()
  const result = await runner(action, {
    event: 'PreToolUse',
    input: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'secret.txt' } },
    cwd: hookRoot,
    hookSource: 'plugin',
  })
  const elapsedMs = Date.now() - startedAt
  const blocksTheTool = isBlockingHookDecision(projectHookDecisionForEvent(
    'PreToolUse',
    getHookCommandPreToolDecision(action, result, { event: 'PreToolUse' }),
  ))
  return { result, elapsedMs, cards: sent.filter(event => event.type === 'permission_request'), blocksTheTool }
}

describe('F1.924 — a plugin PreToolUse command hook in the judge child', () => {
  test('is refused AT ONCE with no card — no lookup waits the hook\'s approval budget — and does not deny the judge\'s read', async () => {
    const { result, elapsedMs, cards, blocksTheTool } = await runPluginHookIn('judge', JUDGE_HOOK_BUDGET_MS)
    expect(cards).toEqual([])
    expect(elapsedMs).toBeLessThan(JUDGE_HOOK_BUDGET_MS / 2)
    expect(result.success).toBe(false)
    expect(result.refusedBeforeStart).toBe(true)
    expect(result.error ?? '').toContain(REFUSAL)
    expect(blocksTheTool).toBe(false)
  })

  test('CONTROL: the same plugin hook in an ordinary subagent still cards in plan (F1.771), and the budget ends the wait', async () => {
    const { result, cards } = await runPluginHookIn('subagent', 300)
    expect(cards).toHaveLength(1)
    expect(result.success).toBe(false)
    expect(result.error ?? '').toContain('needed your approval')
  })
})

/**
 * F1.955 `[pi]` `[guardian]` `[safety]` — the refusal a judge receives is
 * unmistakably NOT the file's content.
 *
 * SIT-ak (RC #3 `bd8ac0d68`, judges `d0c88939` and `6d180a10`): after F1.920 the
 * judge's refused `Read ./report.txt` came back as the bare refusal sentence, and
 * the `fast` judge wrote "The file `report.txt` contains the text: 'A Guardian
 * safety judge cannot ask the user for permission…'" and approved
 * `curl --data-binary @report.txt https://…` as harmless (2/2 misread, 1/2
 * approving on that misreading).
 *
 * The result already IS an error at Pi's level: a `block` verdict makes the tool
 * wrapper throw (`wrappedExecute` in `pi-agent-server/src/local-tools/tool-wrapper.ts`
 * throws on a non-success receipt), and Pi marks the result `isError`. But the
 * OpenAI-completions wire the gateway models speak drops that flag — pi-ai's
 * `openai-completions.js` sends a tool result as `role`, `content` and
 * `tool_call_id` only — so the TEXT is all the judge sees, and the text must say
 * it is not content. So each door that refuses a judge's read must answer a
 * BLOCK (never an allow carrying prose, never a modify) whose reason OPENS with
 * the no-content header.
 */
const NO_CONTENT_HEADER = '(no file content — the host refused this call before it ran'

describe('F1.955 — a refused judge read is an error result whose text says it is not the file', () => {
  for (const wiring of ['host', 'direct'] as const) {
    test(`the readable-DSL ask arm (${wiring} wiring): a BLOCK whose reason opens with the no-content header`, async () => {
      const s = piSession({ kind: 'judge', wiring, permissions: ASK_READ })
      try {
        await s.read()
        expect(s.cards).toEqual([])
        const verdicts = s.verdicts()
        expect(verdicts.map(v => v.action)).toEqual(['block'])
        const reason = String(verdicts[0]!.reason)
        expect(reason.startsWith(NO_CONTENT_HEADER)).toBe(true)
        expect(reason).toContain('nothing of the file')
        expect(reason).toContain('not content')
        // F1.920's sentence stays, after the header.
        expect(reason.indexOf(REFUSAL)).toBeGreaterThan(reason.indexOf(NO_CONTENT_HEADER))
      } finally {
        s.agent.destroy()
      }
    })
  }

  test('a PreToolUse hook answering ask, and a session beneath the judge: the same header opens the refusal', async () => {
    for (const options of [
      { kind: 'judge' as const, wiring: 'host' as const, hookAsks: true },
      { kind: 'judge-grandchild' as const, wiring: 'host' as const, permissions: ASK_READ },
    ]) {
      const s = piSession(options)
      try {
        await s.read()
        expect(s.cards).toEqual([])
        expect(s.verdicts()).toEqual([{ action: 'block', reason: expect.stringMatching(/^\(no file content — the host refused this call before it ran/) }])
      } finally {
        s.agent.destroy()
      }
    }
  })

  test('CONTROL: the judge\'s allowed in-root read is an allow with no refusal text (the file is read and returned as before)', async () => {
    const s = piSession({ kind: 'judge', wiring: 'host' })
    try {
      await s.read()
      expect(s.cards).toEqual([])
      expect(s.verdicts()).toEqual([{ action: 'allow', reason: undefined }])
    } finally {
      s.agent.destroy()
    }
  })

  test('CONTROL: an ordinary subagent\'s user Deny keeps its own words — the header is the judge\'s alone', async () => {
    const s = piSession({ kind: 'subagent', wiring: 'host', permissions: ASK_READ })
    try {
      await s.read()
      expect(s.cards).toHaveLength(1)
      expect(s.verdicts()).toEqual([{ action: 'block', reason: 'Permission denied by user.' }])
    } finally {
      s.agent.destroy()
    }
  })
})

/**
 * F1.960 — the backend's own `onPermissionRequest` door (the `respondToPermission`
 * branch of `refuseHostConsultPermissionRequest`) denied with no reason, while the
 * direct branch and the permission-service half hand F1.955's header. The host now
 * hands it on this door too, as the Deny's `comment` (`PermissionResponseOptions`,
 * P6.951: the note a denial carries). The first two tests pin the HOST half; the
 * last two pin Pi's BACKEND half (DN-123), which carries that comment to the
 * subprocess and no other note.
 */
describe('F1.960 — the backend-door Deny carries the no-content header as its reason', () => {
  type Answer = [requestId: string, allowed: boolean, always: boolean, options: { comment?: string } | undefined]
  const outsideRoot = (requestId: string) => ({
    requestId,
    toolName: 'Read',
    type: 'outside_root' as const,
    command: '/Users/someone/f1960-danger',
    description: 'Allow read access outside the session root: /Users/someone/f1960-danger',
  })

  test('a judge, and a session beneath one: the one Deny the backend receives opens with the header and keeps F1.920\'s sentence', () => {
    for (const kind of ['judge', 'judge-grandchild'] as const) {
      const s = piSession({ kind, wiring: 'host' })
      const answers: Answer[] = []
      const realAgent = s.managed.agent
      s.managed.agent = { respondToPermission: (requestId: string, allowed: boolean, always: boolean, options?: { comment?: string }) => { answers.push([requestId, allowed, always, options]) } }
      try {
        s.manager.handleAgentPermissionRequest(s.managed, outsideRoot(`pi-oroot-f1960-${kind}`))
        expect(s.cards).toEqual([])
        expect(answers.map(([requestId, allowed, always]) => [requestId, allowed, always])).toEqual([[`pi-oroot-f1960-${kind}`, false, false]])
        const comment = String(answers[0]?.[3]?.comment)
        expect(comment.startsWith(NO_CONTENT_HEADER)).toBe(true)
        expect(comment.indexOf(REFUSAL)).toBeGreaterThan(comment.indexOf(NO_CONTENT_HEADER))
      } finally {
        s.managed.agent = realAgent
        s.agent.destroy()
      }
    }
  })

  test('CONTROL: an ordinary subagent\'s backend-door card, denied by the user with no note, reaches the backend with no host reason', async () => {
    const s = piSession({ kind: 'subagent', wiring: 'host' })
    const answers: Answer[] = []
    const realAgent = s.managed.agent
    s.managed.agent = { respondToPermission: (requestId: string, allowed: boolean, always: boolean, options?: { comment?: string }) => { answers.push([requestId, allowed, always, options]) } }
    try {
      s.manager.handleAgentPermissionRequest(s.managed, outsideRoot('pi-oroot-f1960-control'))
      expect(s.cards).toHaveLength(1)
      // The rig answers every card Deny on the next macrotask, with no note.
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(answers.map(([requestId, allowed]) => [requestId, allowed])).toEqual([['pi-oroot-f1960-control', false]])
      expect(answers[0]?.[3]?.comment).toBeUndefined()
    } finally {
      s.managed.agent = realAgent
      s.agent.destroy()
    }
  })

  /**
   * The BACKEND half (DN-123). The REAL PiAgent's outside-root door, wired to the REAL host
   * funnel the way production wires it (`onPermissionRequest` → `handleAgentPermissionRequest`),
   * must answer the subprocess with the host's refusal as `outside_root_response.reason` — the
   * field F1.959 gave that wire, which fails the call with that text in place of the scope
   * sentence (measured on the real completions wire by
   * `pi-agent-server/src/__tests__/outside-root-refusal-reason-real-server.test.ts`). The judge
   * is refused one step earlier by F1.861's door with the same text; a session BENEATH it has
   * only this door, which is the arm that was red.
   */
  type PiWire = { send: (message: Record<string, unknown>) => void; handleLine: (line: string) => void }
  const outsideRootRequestLine = (requestId: string) =>
    JSON.stringify({ type: 'outside_root_request', requestId, canonicalTarget: '/Users/someone/f1960-danger', access: 'read' })

  test('the backend half: for a judge and a session beneath one, the REAL PiAgent answers the subprocess with the host\'s refusal as the reason', () => {
    for (const kind of ['judge', 'judge-grandchild'] as const) {
      const s = piSession({ kind, wiring: 'host' })
      const wire: Array<Record<string, unknown>> = []
      const runtime = s.agent as unknown as PiWire
      runtime.send = message => { wire.push(message) }
      s.agent.onPermissionRequest = request => s.manager.handleAgentPermissionRequest(s.managed, request)
      try {
        const requestId = `pi-oroot-f1960-backend-${kind}`
        runtime.handleLine(outsideRootRequestLine(requestId))
        expect(s.cards).toEqual([])
        expect(wire).toEqual([{ type: 'outside_root_response', requestId, root: null, reason: GUARDIAN_JUDGE_HOST_REFUSAL }])
        expect(GUARDIAN_JUDGE_HOST_REFUSAL.startsWith(NO_CONTENT_HEADER)).toBe(true)
      } finally {
        s.agent.destroy()
      }
    }
  })

  test('CONTROL: an ordinary subagent\'s outside-root card denied by the user WITH a note — the note reaches the backend and is not sent to the model (owner call)', async () => {
    const note = 'Not that folder, use the project copy.'
    const s = piSession({ kind: 'subagent', wiring: 'host' })
    const wire: Array<Record<string, unknown>> = []
    const received: Array<string | undefined> = []
    const runtime = s.agent as unknown as PiWire
    runtime.send = message => { wire.push(message) }
    const respond = s.agent.respondToPermission.bind(s.agent)
    s.agent.respondToPermission = (requestId, allowed, always, options) => {
      received.push(options?.comment)
      respond(requestId, allowed, always, options)
    }
    s.agent.onPermissionRequest = request => s.manager.handleAgentPermissionRequest(s.managed, request)
    // The user's answer: Deny, with a note (a client that offers one; the desktop card does not on this type).
    s.manager.sendEvent = (event: { type?: string; request?: Card }) => {
      if (event?.type !== 'permission_request' || !event.request) return
      const card = { ...event.request }
      s.cards.push(card)
      setTimeout(() => {
        s.manager.respondToPermission(String(card.sessionId), String(card.requestId), false, false, { comment: note }, (s.managed.workspace as { id: string }).id)
      }, 0)
    }
    try {
      runtime.handleLine(outsideRootRequestLine('pi-oroot-f1960-user-note'))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(s.cards).toHaveLength(1)
      // PRECONDITION: the note did reach the backend, so what follows is the backend's own choice.
      expect(received).toEqual([note])
      expect(wire).toEqual([{ type: 'outside_root_response', requestId: 'pi-oroot-f1960-user-note', root: null }])
      expect(wire[0]).not.toHaveProperty('reason')
    } finally {
      s.agent.destroy()
    }
  })
})

/**
 * F1.1040 (DECISIONS-2 Q4) — the verifier child of a plugin hook's `type:
 * "agent"` is a host consult on a pending action, like the judge: nothing waits
 * on its card (the F1.861 shape), and Claude's hooks.md, the section on how agent
 * hooks work, names no permission prompt for that subagent ("The subagent can use
 * tools like Read, Grep, and Glob to investigate"). The host refuses it at the
 * same two funnels with a text of its own (no Guardian wording), header first as
 * F1.955 requires. The four other `isHostConsultRecord` behaviours stay the
 * judge's alone (the precondition in `readRealHookAgentRestrictions`).
 */
describe('F1.1040 — a plugin hook agent\'s verifier raises no card, and is told why', () => {
  const expectHookRefusal = (reason: unknown) => {
    const text = String(reason)
    expect(text.startsWith(NO_CONTENT_HEADER)).toBe(true)
    expect(text.indexOf(HOOK_REFUSAL)).toBeGreaterThan(text.indexOf(NO_CONTENT_HEADER))
    expect(text).not.toContain('Guardian')
  }

  for (const wiring of ['host', 'direct'] as const) {
    test(`the readable-DSL ask arm (${wiring} wiring): no card, the read is refused with the hook agent's text`, async () => {
      const s = piSession({ kind: 'hook-agent', wiring, permissions: ASK_READ })
      try {
        await s.read()
        expect(s.cards).toEqual([])
        expect(s.verdicts().map(v => v.action)).toEqual(['block'])
        expectHookRefusal(s.verdicts()[0]!.reason)
        expect(s.manager.pendingPermissionRequests.size).toBe(0)
        expect(s.manager.directPermissionResolvers.size).toBe(0)
      } finally {
        s.agent.destroy()
      }
    })
  }

  test('a PreToolUse hook answering ask for the verifier\'s read: no card, the read is refused', async () => {
    const s = piSession({ kind: 'hook-agent', wiring: 'host', hookAsks: true })
    try {
      await s.read()
      expect(s.cards).toEqual([])
      expect(s.verdicts().map(v => v.action)).toEqual(['block'])
      expectHookRefusal(s.verdicts()[0]!.reason)
    } finally {
      s.agent.destroy()
    }
  })

  test('the outside-root door: the host answers Deny with the hook agent\'s text, and the REAL PiAgent sends it to the subprocess as the reason', () => {
    const s = piSession({ kind: 'hook-agent', wiring: 'host' })
    const wire: Array<Record<string, unknown>> = []
    const received: Array<string | undefined> = []
    const runtime = s.agent as unknown as { send: (message: Record<string, unknown>) => void; handleLine: (line: string) => void }
    runtime.send = message => { wire.push(message) }
    const respond = s.agent.respondToPermission.bind(s.agent)
    s.agent.respondToPermission = (requestId, allowed, always, options) => {
      received.push(options?.comment)
      respond(requestId, allowed, always, options)
    }
    s.agent.onPermissionRequest = request => s.manager.handleAgentPermissionRequest(s.managed, request)
    try {
      runtime.handleLine(JSON.stringify({ type: 'outside_root_request', requestId: 'pi-oroot-f1040', canonicalTarget: '/Users/someone/f1040-danger', access: 'read' }))
      expect(s.cards).toEqual([])
      expect(s.manager.pendingPermissionRequests.size).toBe(0)
      expect(received).toHaveLength(1)
      expectHookRefusal(received[0])
      expect(wire).toEqual([{ type: 'outside_root_response', requestId: 'pi-oroot-f1040', root: null, reason: received[0] }])
    } finally {
      s.agent.destroy()
    }
  })

  test('BOUNDARY: a named subagent whose definition copies the runner\'s sentence (not leading its prompt) still cards, and its Deny is the user\'s', async () => {
    const s = piSession({ kind: 'hook-agent-lookalike', wiring: 'host', permissions: ASK_READ })
    try {
      await s.read()
      expect(s.cards).toHaveLength(1)
      expect(s.cards[0]).toMatchObject({ toolName: 'Read', type: 'permission_dsl', agentLabel: HOOK_AGENT_LABEL })
      expect(s.verdicts()).toEqual([{ action: 'block', reason: 'Permission denied by user.' }])
    } finally {
      s.agent.destroy()
    }
  })
})

/**
 * F1.940 — the host-raised cards that settle through `directPermissionResolvers`
 * (Monitor ws and command, EnterWorktree, archive_session, the composer `!`
 * command, the cross-session message dialog) have raise sites of their own, so
 * F1.920's two funnels never saw them. Every one of them counts its card through
 * `countHostRaisedCard` (D1.355), which now refuses a host consult before anything
 * is counted or shown; the cross-session dialog is refused before the message is
 * held. No judge tool reaches these today (the judge's `restrictions.tools`), so
 * each site is driven directly, F1.208's rig (`host-card-user-stop.test.ts`).
 */
describe('F1.940 — a Guardian judge raises no host card through the host-raised sites', () => {
  type Stub = Record<string, unknown> & { id: string; workspace: { id: string; rootPath: string } }
  const hostCardSessions = (kind: 'judge' | 'top-level' | 'hook-agent', extra: Record<string, unknown> = {}) => {
    const id = ++counter
    const workspace = { id: `ws-f1940-${id}`, rootPath: process.cwd() }
    const stub = (sessionId: string, more: Record<string, unknown> = {}): Stub => ({
      // F1.1050: `default`, a prompting-class mode — this rig used explore; plan counts as bypassing where bypass is
      // available (P6.182), which would make the pair match and nothing be held.
      id: sessionId, activeProvider: 'pi', permissionMode: 'default', isProcessing: true, messages: [], messageQueue: [],
      backgroundShellCommands: new Map<string, unknown>(), workspace, workingDirectory: process.cwd(), ...more,
    })
    const parent = stub(`parent-f1940-${id}`, { permissionMode: 'bypassPermissions' })
    const asking = kind === 'top-level'
      ? stub(`session-f1940-${id}`, extra)
      : stub(`judge-f1940-${id}`, {
        hidden: true,
        name: kind === 'judge' ? JUDGE_LABEL : HOOK_AGENT_LABEL,
        piParentSessionKey: { workspaceId: workspace.id, sessionId: parent.id },
        piChildRestrictions: structuredClone(kind === 'judge' ? judgeRestrictions : hookAgentRestrictions),
        ...extra,
      })
    const manager = createTestSessionManager() as any
    manager.persistSession = () => undefined
    manager.emitPiHarnessInvalidation = () => undefined
    for (const session of [parent, asking]) manager.sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: session.id }), session)
    const cards: Card[] = []
    manager.sendEvent = (event: { type?: string; request?: Card }) => {
      if (event?.type === 'permission_request' && event.request) cards.push({ ...event.request })
    }
    return { manager, parent, asking, cards }
  }
  const settled = (wait: Promise<unknown>) => Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 40) })])
  const asText = (wait: Promise<unknown>) => wait.then(value => `resolved:${String(value)}`, (error: Error) => error.message)

  const sites: Array<{ name: string; raise: (s: ReturnType<typeof hostCardSessions>) => Promise<unknown> }> = [
    {
      name: 'Monitor (ws)',
      raise: s => {
        s.manager.resolveMonitorTargetHost = async () => 'example.test'
        s.manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
        return s.manager.authorizeMonitor({ sessionKey: { workspaceId: s.asking.workspace.id, sessionId: s.asking.id }, ws: { url: 'wss://example.test/feed' } })
      },
    },
    {
      name: 'Monitor (command)',
      raise: s => {
        s.manager.monitorGateSessionIsPi = () => false
        s.manager.evaluateMonitorCommandRules = () => undefined
        return s.manager.authorizeMonitorCommand({ sessionKey: { workspaceId: s.asking.workspace.id, sessionId: s.asking.id }, command: 'tail -f build.log' })
      },
    },
    {
      name: 'EnterWorktree',
      raise: s => {
        const repoRoot = join(root, `f1940-repo-${s.asking.id}`)
        mkdirSync(repoRoot, { recursive: true })
        Object.assign(s.asking, { projectKey: repoRoot, workingDirectory: repoRoot })
        return s.manager.authorizeWorktreeEnter(s.asking, { path: join(tmpdir(), 'f1940-elsewhere') })
      },
    },
    // UA3.8 — the parent is made idle so the judge's own refusal is what this site measures; a parent mid-turn is refused
    // earlier by the ported processing arm (orchestrator-delete-cascade.test.ts), also with no card.
    { name: 'archive_session', raise: s => { s.parent.isProcessing = false; return s.manager.archiveSessionForAgent(s.asking, s.parent.id, true) } },
    { name: 'the composer ! command', raise: s => s.manager.requestDirectShellPermission(s.asking, 'ls -la') },
  ]

  for (const site of sites) {
    test(`${site.name}: no card, nothing counted, the call is refused with the judge's text`, async () => {
      const s = hostCardSessions('judge')
      const outcome = await settled(asText(site.raise(s)))
      expect(s.cards).toEqual([])
      expect(s.manager.pendingPermissionRequests.size).toBe(0)
      expect(s.manager.directPermissionResolvers.size).toBe(0)
      expect(String(outcome)).toContain(REFUSAL)
    })
  }

  test('send_agent_message from a judge into a session that holds it for approval: refused before it is held, no dialog', () => {
    const s = hostCardSessions('judge')
    // The judge is in a prompting-class mode, the receiver bypasses: the default hold, whose dialog is a card.
    const verdict = s.manager.admitAgentMessage(s.asking, s.parent, 'please look at this')
    expect(s.cards).toEqual([])
    expect(s.manager.pendingPermissionRequests.size).toBe(0)
    expect(verdict.status).toBe('refused')
    expect(String(verdict.note)).toContain(REFUSAL)
    expect(s.manager.crossSessionInboundStates.size).toBe(0)
  })

  test('send_agent_message INTO a judge that would hold it: refused before it is held, the sender told why', () => {
    const s = hostCardSessions('judge', { permissionMode: 'bypassPermissions' })
    const sender = { ...s.parent, id: `sender-f1940-${s.parent.id}`, permissionMode: 'default' } // F1.1050: was explore (prompting class)
    s.manager.sessions.set(encodeSessionKey({ workspaceId: sender.workspace.id, sessionId: sender.id }), sender)
    const verdict = s.manager.admitAgentMessage(sender, s.asking, 'please look at this')
    expect(s.cards).toEqual([])
    expect(verdict.status).toBe('refused')
    expect(String(verdict.note)).toContain('cannot show its user an approval dialog')
    expect(s.manager.crossSessionInboundStates.size).toBe(0)
  })

  test('a plugin hook agent\'s verifier (F1.1040) is refused at the same seam with its own text', async () => {
    const s = hostCardSessions('hook-agent')
    const outcome = await settled(asText(sites[0]!.raise(s)))
    expect(s.cards).toEqual([])
    expect(String(outcome)).toContain(HOOK_REFUSAL)
  })

  test('CONTROL: an ordinary session\'s Monitor card still appears, and the dialog for its held message too', async () => {
    const s = hostCardSessions('top-level')
    const wait = asText(sites[0]!.raise(s))
    expect(await settled(wait)).toBe('STILL WAITING')
    expect(s.cards).toHaveLength(1)
    expect(s.cards[0]).toMatchObject({ toolName: 'Monitor', sessionId: s.asking.id })
    s.manager.respondToPermission(s.asking.id, String(s.cards[0]!.requestId), false, false, undefined, s.asking.workspace.id)
    expect(String(await wait)).not.toContain(REFUSAL)
    const verdict = s.manager.admitAgentMessage(s.asking, s.parent, 'please look at this')
    expect(verdict).toMatchObject({ status: 'held', awaitingApproval: true })
    expect(s.cards).toHaveLength(2)
    expect(s.cards[1]).toMatchObject({ toolName: 'send_agent_message', sessionId: s.parent.id })
    s.manager.cancelCrossSessionApprovalDialog(s.parent, String(s.cards[1]!.requestId))
  })
})
