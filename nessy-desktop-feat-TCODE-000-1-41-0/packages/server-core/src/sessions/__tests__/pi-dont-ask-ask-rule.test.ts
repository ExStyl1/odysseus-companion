/**
 * F1.841 `[pi]` — in Unattended (`dontAsk`) an explicit ASK rule refuses the
 * call, naming the rule, instead of raising a card nobody can answer.
 *
 * The contract, `permission-modes.md#allow-only-pre-approved-tools-with-dontask-mode`,
 * verbatim: "Claude Code denies calls matching your explicit `ask` rules rather
 * than prompting." Claude's twin already does this
 * (`claudeReadablePermissionAskCheckResult`: "`dontAsk` refuses, naming the
 * rule — the one mode that cannot ask", F1.830).
 *
 * WHERE PI ASKED, measured here rather than inferred. A `Read` of a workspace
 * file is one of the actions dontAsk still runs ("file reads inside your working
 * directories"), so the gate answers `allow`; the readable permission DSL's
 * `ask` match is what turns it into an `ask` decision, in `PiAgent`'s
 * `handlePreToolUseRequest`, and nothing below it knew the mode: the real
 * `createPiPermissionService` hands every `ask` to `requestApproval`, and the
 * real `SessionManager.requestPiToolApproval` publishes it as a
 * `permission_request` — the card. Red at the lane's HEAD: one card per call in
 * dontAsk, the turn waiting on it.
 *
 * THE INSTRUMENT is F1.902's rig (`pi-ask-rule-card-command.test.ts`): the REAL
 * `PiAgent` PreToolUse handler, the REAL permission service and the REAL host
 * seam, with the rule entering as a workspace `permissions.json` through
 * `setCapabilityPermissionLayers`. The row's own CONTROL shape: a structural
 * `{kind:'tool', semanticId:'read'}` ask.
 *
 * CONTROLS: with no rule, the same dontAsk Read runs with no card; in Manual the
 * same rule still raises its card (the mode that can ask keeps asking).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAgent, permissionsConfigCache } from '@nessy-agent/shared/agent'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '@nessy-agent/shared/agent/pi-harness/harness-manifest'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '@nessy-agent/shared/agent/pi-harness/harness-tool-descriptor'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createPiPermissionService } from '../../pi-harness/permission-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** The row's CONTROL rule: a structural ask on the read tool, workspace scope. */
const ASK_READ = JSON.stringify({
  permissionDsl: { version: 1, rules: [{ id: 'ask-read', action: 'ask', match: { kind: 'tool', semanticId: 'read' } }] },
})

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'f1841-pi-dont-ask-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
afterEach(() => { permissionsConfigCache.clear() })

let counter = 0

function piSession(options: { mode: string; permissions?: string }) {
  const id = ++counter
  const workspaceId = `ws-f1841-${id}`
  const workingDirectory = join(root, `project-${id}`)
  mkdirSync(workingDirectory, { recursive: true })
  const target = join(workingDirectory, 'notes.txt')
  writeFileSync(target, 'workspace file\n')
  const workspace = { id: workspaceId, rootPath: workingDirectory }
  const managed: Record<string, unknown> & { id: string } = {
    id: `session-f1841-${id}`,
    activeProvider: 'pi',
    permissionMode: options.mode,
    isProcessing: true,
    backgroundShellCommands: new Map<string, unknown>(),
    workspace,
    workingDirectory,
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
    // Answered, so a red run ends instead of waiting on the card forever.
    setTimeout(() => {
      manager.respondToPermission(String(card.sessionId), String(card.requestId), false, false, undefined, workspaceId)
    }, 0)
  }

  const service = createPiPermissionService({
    requestApproval: request => manager.requestPiToolApproval(managed, request),
  })
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: workspaceId,
      name: 'F1.841 Workspace',
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
  } as never)
  managed.agent = agent
  agent.setPermissionMode(options.mode as never)
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
  internals.setCurrentTurnUserMessage('read the notes')

  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: `f1841-generation-${id}`,
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
  // AFTER the turn runtime, under the MANIFEST's generation (D1.270), as F1.902's rig.
  internals.permissionManager.setCapabilityPermissionLayers(
    options.permissions
      ? [{ content: options.permissions, scope: 'workspace', sourceRoot: workingDirectory }]
      : [],
    manifest.snapshotGeneration,
    true,
  )

  const read = async () => {
    await internals.handlePreToolUseRequest({
      requestId: `req-f1841-${id}`,
      semanticId: tool.descriptor.id,
      piName: tool.binding.piName,
      surfaceVersion: manifest.surfaceVersion,
      manifestResponseEpoch: 0,
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      toolName: 'Read',
      input: { path: target },
    })
  }
  return { agent, cards, sent, read }
}

describe('F1.841 — Pi in Unattended refuses a call an explicit ask rule matches', () => {
  test('dontAsk + a workspace ask on read: no card, the Read is refused and the refusal names the rule', async () => {
    const session = piSession({ mode: 'dontAsk', permissions: ASK_READ })
    await session.read()
    session.agent.destroy()

    // THE ROW: no card in the mode that never prompts.
    expect(session.cards).toHaveLength(0)
    expect(session.sent).toHaveLength(1)
    const reply = session.sent[0]!
    expect(reply.action).toBe('block')
    expect(reply.reason).toBe(
      'Tool blocked: Read requires approval by readable permission policy rule `ask-read` (workspace scope), and Don\'t ask mode never prompts.',
    )
  })

  test('CONTROL — dontAsk with no rule: the same workspace Read runs, no card', async () => {
    const session = piSession({ mode: 'dontAsk' })
    await session.read()
    session.agent.destroy()

    expect(session.cards).toHaveLength(0)
    expect(session.sent.map(message => message.action)).toEqual(['allow'])
  })

  test('CONTROL — Manual with the same rule still raises its card naming the rule', async () => {
    const session = piSession({ mode: 'default', permissions: ASK_READ })
    await session.read()
    session.agent.destroy()

    expect(session.cards).toHaveLength(1)
    expect(session.cards[0]!.description).toBe('Read requires approval by readable permission policy rule `ask-read` (workspace scope).')
    // The rig answered Deny.
    expect(session.sent.map(message => message.action)).toEqual(['block'])
  })
})
