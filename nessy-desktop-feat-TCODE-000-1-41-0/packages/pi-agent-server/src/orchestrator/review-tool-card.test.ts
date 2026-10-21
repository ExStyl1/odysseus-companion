/**
 * F1.883 `[pi]` `[measure]` — can the Pi `review` tool's reviewer child, a
 * host-run Pi child with read tools, raise the kind of card F1.861 and F1.920
 * closed for the Guardian judge?
 *
 * ## What was measured
 *
 * It raises a card — through each door the judge's rig drives (a workspace `ask`
 * rule on its in-root Read, a PreToolUse hook answering `ask`, an outside-root
 * read) — because the host-consult identity (`isHostConsultRecord`,
 * F1.739/F1.920) is the Guardian policy prompt and the reviewer's is the review
 * rubric. It is NOT the card F1.861 closed. That card was harmful because it
 * showed the PLANNED action under judgment ('scout: Judge the following planned
 * action… rm -rf ~/…') and its Deny refused only the judge's read while the
 * action went on. The reviewer's card names the reviewer and its review target,
 * nothing pending rides on it, and Deny refuses exactly the call it asked about;
 * the review goes on and returns its findings.
 *
 * ## Why the card stays (read, not invented)
 *
 * The Pi `review` tool follows Claude's `/code-review` (`review-tool.ts` cites it
 * throughout), and Pi follows Claude's pages. `code-review.md#review-a-diff-locally`:
 * "The review runs as a background subagent with its own context window". For a
 * subagent, `sub-agents.md#run-subagents-in-foreground-or-background`: "When a
 * background subagent reaches a tool call that needs permission, Claude Code
 * surfaces the prompt in your main session and names the subagent that is
 * asking. Approve to let the subagent continue, or press Esc to deny that one
 * tool call without stopping the subagent." That is this card. Codex's own
 * `/review` delegate is pinned to `approval_policy = never`
 * (`codex-rs/core/src/tasks/review.rs` line 121 at rust-v0.156.1) — codex's
 * posture for codex's runtime, which runs its own `/review`; it is recorded,
 * not imported. So the host-consult identity is NOT widened to the reviewer.
 *
 * ## The rig
 *
 * The reviewer's restrictions are the ones the REAL `review` tool starts it
 * with: the real tool through the real `spawnChildSession` into the real host
 * child port (F1.890's rig, `review-tool-skill-free.test.ts`), with only
 * `startPiChildRuntime` replaced to capture the record. The child session is
 * then built as `startPiChildRuntime` builds it (hidden, `piParentSessionKey`,
 * `piChildRestrictions` cloned, named `<agent>: <task…>`) over the REAL gate:
 * `PiAgent.handlePreToolUseRequest`, the host's own permission service
 * (`createTelemetryPiPermissionService` over `requestPiToolApproval`), and for
 * the outside-root door the REAL `PiAgent.handleOutsideRootRequest` wired to the
 * host's `handleAgentPermissionRequest`. Every card is answered Deny.
 *
 * CONTROL: the SAME rig with the judge's identity (the Guardian policy prompt)
 * raises no card through the same doors — so the reviewer arms are able to fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encodeSessionKey } from '../../../shared/src/sessions/session-key.ts'
import { PiAgent } from '../../../shared/src/agent/pi-agent.ts'
import { permissionsConfigCache } from '../../../shared/src/agent/permissions-config.ts'
import type { PiChildRestrictionsV1, PiChildSessionRecordV1 } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
import { GUARDIAN_POLICY_PROMPT } from '../../../shared/src/prompts/guardian.ts'
import { REVIEW_RUBRIC_PROMPT } from '../../../shared/src/prompts/review.ts'
import { isHostConsultRecord } from '../../../server-core/src/pi-harness/child-session-service.ts'
import { createPiPermissionService } from '../../../server-core/src/pi-harness/permission-service.ts'
import { createTestSessionManager } from '../../../server-core/src/sessions/__tests__/test-session-manager.ts'
import { createReviewTool } from './review-tool.ts'
import { configureSpawner } from './spawner.ts'

// The SessionManager + PiAgent module graphs dominate this file's wall time
// (F1.817's reading on the judge twins); the bodies are milliseconds.
setDefaultTimeout(120_000)

const FINDINGS = JSON.stringify({ findings: [], verdict: 'patch is correct', explanation: 'Nothing to report.' })
const DIFF = '+++ b/README.md\n+A line under review.'
const ASK_READ = JSON.stringify({ permissions: { ask: ['Read(secret.txt)', 'Read(./secret.txt)', 'Read(**/secret.txt)'] } })
const USER_DENY = 'Permission denied by user.'
/** The sentence the host tells a Guardian judge whose request it refused (F1.920). */
const JUDGE_REFUSAL = 'A Guardian safety judge cannot ask the user for permission'

let root = ''
let reviewer: PiChildSessionRecordV1

/** The record the REAL review tool starts its reviewer with, from a parent in Ask (`default`) mode. */
async function readRealReviewerRecord(): Promise<PiChildSessionRecordV1> {
  const manager = createTestSessionManager() as any
  const parent: any = {
    id: 'parent', workspace: { id: 'workspace-f1883', rootPath: process.cwd() }, permissionMode: 'default',
    thinkingLevel: 'off', llmConnection: 'pi', model: 'm', messagesLoaded: true, messages: [],
    backgroundShellCommands: new Map(),
  }
  manager.sessions.set(encodeSessionKey({ workspaceId: 'workspace-f1883', sessionId: 'parent' }), parent)
  manager.persistSession = () => {}
  const records: PiChildSessionRecordV1[] = []
  manager.startPiChildRuntime = async (_parent: unknown, record: PiChildSessionRecordV1) => {
    records.push(structuredClone(record))
    return {
      childSessionKey: { workspaceId: 'workspace-f1883', sessionId: `child-${record.agentId}` },
      transcriptId: `child-${record.agentId}`, status: 'completed', output: FINDINGS, result: FINDINGS,
    }
  }
  const view: any = {
    generation: 'g-f1883', hooks: [], automations: [], promptLayers: [], memory: [], permissionLayers: [],
    commands: [], promptCommands: [], apps: [], agents: [], skills: [], sources: [], mcpServers: [],
  }
  const materializer: any = {
    assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
    readText: async () => '', resolveCredential() { throw new Error('unused') },
  }
  try {
    const port = await manager.createPiChildSessionPort(
      parent, { view, materializer }, createPiPermissionService({}), async () => {}, async () => {}, async () => {},
    )
    configureSpawner({ childSessionPort: port, modelId: 'm', retryBaseDelayMs: () => 0 })
    const tool = createReviewTool({ getCwd: () => process.cwd(), computeDiff: async () => DIFF })
    const result = await tool.execute('review-f1883', { background: false }, undefined, undefined, {} as never)
    expect(result.details?.verdict).toBe('patch is correct')
  } finally {
    await manager.cleanup()
  }
  expect(records).toHaveLength(1)
  return records[0]!
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'f1883-review-card-'))
  reviewer = await readRealReviewerRecord()
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
afterEach(() => { permissionsConfigCache.clear() })

type Card = Record<string, unknown>
let counter = 0

/**
 * A hidden Pi child beneath a visible parent, built the way
 * `startPiChildRuntime` builds it, over the REAL gate. `as: 'judge'` swaps in
 * the Guardian judge's identity on the same record (the control).
 */
function childSession(options: { as: 'reviewer' | 'judge'; permissions?: string; hookAsks?: boolean }) {
  const id = ++counter
  const workspaceId = `ws-f1883-${id}`
  const workingDirectory = join(root, `project-${id}`)
  mkdirSync(workingDirectory, { recursive: true })
  writeFileSync(join(workingDirectory, 'secret.txt'), 'x')
  const workspace = { id: workspaceId, rootPath: workingDirectory }
  const restrictions: PiChildRestrictionsV1 = options.as === 'reviewer'
    ? structuredClone(reviewer.restrictions)
    : { ...structuredClone(reviewer.restrictions), prompt: GUARDIAN_POLICY_PROMPT }
  const permissionMode = restrictions.permissionMode ?? 'default'
  const stub = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    id: sessionId, activeProvider: 'pi', permissionMode, isProcessing: true,
    backgroundShellCommands: new Map<string, unknown>(), workspace, workingDirectory, ...extra,
  })
  const parent = stub(`parent-f1883-${id}`)
  const name = `${reviewer.agent}: ${reviewer.task.slice(0, 80)}`
  const managed: Record<string, unknown> & { id: string } = stub(`child-f1883-${id}`, {
    hidden: true,
    name,
    piParentSessionKey: { workspaceId, sessionId: parent.id },
    piChildRestrictions: restrictions,
  })
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.persistBashAlwaysAllowRule = () => undefined
  for (const session of [parent, managed]) manager.sessions.set(encodeSessionKey({ workspaceId, sessionId: session.id }), session)
  const cards: Card[] = []
  manager.sendEvent = (event: { type?: string; request?: Card }) => {
    if (event?.type !== 'permission_request' || !event.request) return
    const card = { ...event.request }
    cards.push(card)
    setTimeout(() => {
      manager.respondToPermission(String(card.sessionId), String(card.requestId), false, false, undefined, workspaceId)
    }, 0)
  }
  const service = manager.createTelemetryPiPermissionService(managed, {
    requestApproval: (request: unknown) => manager.requestPiToolApproval(managed, request),
  })
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: workspaceId, name: 'F1.883 Workspace', rootPath: workingDirectory,
      workspaceRootPath: workingDirectory, sessionRootPath: join(root, `sessions-${id}`),
    },
    session: { id: managed.id, workspaceRootPath: workingDirectory, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory },
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: service,
    contextProfile: 'bare',
    // The host's mapping (`childSystemPrompt: managed.piChildRestrictions?.prompt`).
    childSystemPrompt: restrictions.prompt,
    piChildKind: 'named',
  } as never)
  managed.agent = agent
  agent.setPermissionMode(permissionMode as never)
  // The backend's own door, wired as the host wires it.
  agent.onPermissionRequest = request => manager.handleAgentPermissionRequest(managed, request)
  const sent: Array<Record<string, unknown>> = []
  const internals = agent as unknown as {
    send: (message: Record<string, unknown>) => void
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>
    setCurrentTurnUserMessage: (message: string) => void
    setCapabilityTurnRuntime: (runtime: unknown) => void
    activeExecutionManifest: unknown
    handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>
    handleOutsideRootRequest: (request: { requestId: string; canonicalTarget: string; access: 'read' | 'write' }) => void
    permissionManager: { setCapabilityPermissionLayers: (...args: unknown[]) => void }
  }
  internals.send = message => { sent.push(message) }
  internals.emitAutomationEvent = async event => event === 'PreToolUse' && options.hookAsks
    ? { matchedCount: 1, decision: { decision: 'ask', reason: 'A PreToolUse hook wants the user to confirm this read.' } }
    : { matchedCount: 0 }
  internals.setCurrentTurnUserMessage(reviewer.task)

  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: `f1883-generation-${id}`,
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
    options.permissions ? [{ content: options.permissions, scope: 'workspace', sourceRoot: workingDirectory }] : [],
    manifest.snapshotGeneration,
    true,
  )
  let calls = 0
  const read = async () => {
    await internals.handlePreToolUseRequest({
      requestId: `req-f1883-${id}-${++calls}`,
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
  const readOutsideRoot = async () => {
    internals.handleOutsideRootRequest({ requestId: `oroot-f1883-${id}`, canonicalTarget: join(root, 'outside', 'notes.md'), access: 'read' })
    // The rig answers a card Deny on the next macrotask.
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const verdicts = () => sent.filter(message => message.action !== undefined).map(message => ({ action: message.action, reason: message.reason }))
  const outsideRootAnswers = () => sent.filter(message => message.type === 'outside_root_response')
  return { agent, manager, parent, name, cards, verdicts, outsideRootAnswers, read, readOutsideRoot }
}

describe('F1.883 — the review tool\'s reviewer child is not a host consult', () => {
  test('the record the real review tool writes is the reviewer with the review rubric, and the host-consult identity does not match it', () => {
    expect(reviewer.agent).toBe('reviewer')
    expect(reviewer.task.startsWith('Review the following ')).toBe(true)
    // `composeChildPrompt` (spawner.ts): the agent safety core, then the rubric.
    expect(reviewer.restrictions.prompt).toContain(REVIEW_RUBRIC_PROMPT.trim())
    expect(isHostConsultRecord(reviewer)).toBe(false)
    // BOUNDARY: the same record under the judge's prompt IS one — the identity is the prompt.
    expect(isHostConsultRecord({ restrictions: { ...reviewer.restrictions, prompt: GUARDIAN_POLICY_PROMPT } })).toBe(true)
  })
})

describe('F1.883 — the reviewer\'s card is the documented subagent card, not F1.861\'s', () => {
  test('a workspace ask rule on its in-root Read: one card in the visible parent, naming the reviewer and its target, and Deny refuses that one call', async () => {
    const s = childSession({ as: 'reviewer', permissions: ASK_READ })
    try {
      await s.read()
      expect(s.cards).toHaveLength(1)
      const card = s.cards[0]!
      expect(card).toMatchObject({ toolName: 'Read', type: 'permission_dsl', parentSessionId: s.parent.id })
      const label = String(card.agentLabel)
      expect(label).toBe(s.name)
      expect(label.startsWith('reviewer: Review the following ')).toBe(true)
      // Nothing of the diff under review is on the card's label.
      expect(label).not.toContain('A line under review')
      expect(s.verdicts()).toEqual([{ action: 'block', reason: USER_DENY }])
      expect(s.manager.pendingPermissionRequests.size).toBe(0)
    } finally {
      s.agent.destroy()
    }
  })

  test('a PreToolUse hook answering ask: one card in the parent, and Deny refuses that one call', async () => {
    const s = childSession({ as: 'reviewer', hookAsks: true })
    try {
      await s.read()
      expect(s.cards).toHaveLength(1)
      expect(s.cards[0]).toMatchObject({ parentSessionId: s.parent.id, agentLabel: s.name })
      expect(s.verdicts()).toEqual([{ action: 'block', reason: USER_DENY }])
    } finally {
      s.agent.destroy()
    }
  })

  test('an outside-root read: the backend\'s own card reaches the parent, and Deny answers that read with no root', async () => {
    const s = childSession({ as: 'reviewer' })
    try {
      await s.readOutsideRoot()
      expect(s.cards).toHaveLength(1)
      expect(s.cards[0]).toMatchObject({ type: 'outside_root', parentSessionId: s.parent.id, agentLabel: s.name })
      const answers = s.outsideRootAnswers()
      expect(answers).toHaveLength(1)
      const answer = answers[0]!
      expect(String(answer.requestId).startsWith('oroot-f1883-')).toBe(true)
      expect(answer.root).toBeNull()
    } finally {
      s.agent.destroy()
    }
  })

  test('CONTROL: an in-root read with no rule and no hook is allowed with no card', async () => {
    const s = childSession({ as: 'reviewer' })
    try {
      await s.read()
      expect(s.cards).toEqual([])
      expect(s.verdicts().map(v => v.action)).toEqual(['allow'])
    } finally {
      s.agent.destroy()
    }
  })
})

describe('F1.883 — CONTROL: the same rig under the judge\'s identity raises no card (F1.861 + F1.920 still hold)', () => {
  test('ask rule, hook ask and outside-root read: no card, each refused', async () => {
    for (const options of [{ permissions: ASK_READ }, { hookAsks: true }]) {
      const s = childSession({ as: 'judge', ...options })
      try {
        await s.read()
        expect(s.cards).toEqual([])
        expect(s.verdicts()).toEqual([{ action: 'block', reason: expect.stringContaining(JUDGE_REFUSAL) }])
      } finally {
        s.agent.destroy()
      }
    }
    const s = childSession({ as: 'judge' })
    try {
      await s.readOutsideRoot()
      expect(s.cards).toEqual([])
      const answers = s.outsideRootAnswers()
      expect(answers).toHaveLength(1)
      expect(answers[0]!.root).toBeNull()
    } finally {
      s.agent.destroy()
    }
  })
})
