/**
 * F1.478 (origin WJ-rr-b P-WJ-rr-b-1, 2026-09-24) — Pi reads a session tool's
 * rule request under BOTH of its names, the alias shape F1.379 gave codex.
 *
 * Pi judges a session tool under its binding's `permissionName` (the handler
 * name, `spawn_session`) and `descriptorId`
 * (`pi-harness/harness-tool-descriptor.ts` `sessionBinding`). Claude is handed
 * the same tool as `mcp__session__spawn_session` (the SDK's own name) and codex
 * projects it under that name too (F1.272, kept by F1.379). So before this row a
 * claude-spelled rule — `deny mcp__session__spawn_session`, `mcp__session`,
 * `mcp__*` — bound on claude and codex and matched NOTHING on Pi: the WJ-hh
 * verifier's probe measured the no-match for `deny mcp__*` and `allow mcp__session`.
 *
 * The consult is driven for real here: `PiAgent.handlePreToolUseRequest`, the
 * one seam every Pi tool call passes, with the rules compiled by the real
 * claude-rule parser into the capability permission layer the gate reads, and a
 * permission service that records the DECISION it is handed (`allow` / `ask` /
 * `deny`) — the last observable point before a receipt or a card. The manifest
 * half drives `buildExecutionManifestForCurrentTurn`, because a whole-tool deny
 * the gate enforces must also leave the model's context (`permissions.md`:
 * "As a deny rule, both forms remove the tool from Claude's context"), and a
 * gate that refuses a tool the manifest still advertises is the disagreement
 * `filterCapabilityIdentitiesByWholeToolDeny`'s own docblock calls a defect.
 *
 * BOUNDARY: a `pi-only` session tool is NOT aliased. Claude is never handed our
 * tool under those names (it runs its own built-in, e.g. `TaskList`), so a
 * claude-spelled `mcp__*` does not reach it there, and must not here — the same
 * registry declaration F1.74's `sessionToolGateName` reads.
 */
import { afterAll, afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
} from '../pi-harness/harness-manifest.ts'
import { parseClaudeRuleString } from '../pi-harness/claude-permission-rules.ts'
import { parsePermissionDslV1 } from '../pi-harness/permission-dsl.ts'
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts'
import { cleanupModeState } from '../mode-manager.ts'

// A PiAgent import costs a module graph measured in tens of seconds on this rig
// (AGENTS.md, the zero-case-control bullet); the budget is the FILE's.
setDefaultTimeout(60_000)

const GENERATION = 'generation-f1478'
const KEY = { workspaceId: 'ws-f1478', sessionId: 'session-f1478' }
// The agent's config watcher needs a real workspace directory (it refuses a missing one).
const ROOT = mkdtempSync(join(tmpdir(), 'nessy-f1478-'))
const WORKSPACE = join(ROOT, 'workspace')
const PROJECT = join(ROOT, 'project')
mkdirSync(WORKSPACE)
mkdirSync(PROJECT)
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

type Rule = readonly [string, 'allow' | 'ask' | 'deny']

const view: AgentRuntimeView = {
  generation: GENERATION,
  sources: [],
  skills: [],
  mcpServers: [],
  hooks: [],
  automations: [],
  agents: [],
  promptLayers: [],
  memory: [],
  permissionLayers: [],
  commands: [],
  promptCommands: [],
  apps: [],
}

const snapshot = {
  context: { workspaceId: KEY.workspaceId, sessionId: KEY.sessionId, projectTrustState: 'none', projectTrustRevision: '' },
  generation: GENERATION,
  leaseId: 'lease-f1478',
  entries: [],
  installedPlugins: [],
  diagnostics: [],
} as EffectiveCapabilitySnapshot

const seed = () => createPiExecutionManifestSeed({ snapshot, view, sessionKey: KEY })

/** A session tool as `buildExecutionManifestForCurrentTurn` hands it to the manifest. */
const sessionTool = (handler: string): PiDynamicToolDefinition => ({
  bindingName: `mcp__session__${handler}`,
  description: `The ${handler} session tool.`,
  inputSchema: { type: 'object', properties: {} },
  modelSchemaVersion: 1,
  bindingSchemaVersion: 1,
  provenance: { capabilityKey: 'runtime:pi-session', generation: GENERATION },
})

function createConfig(permissionServicePort: PiPermissionServicePort): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: KEY.workspaceId,
      name: 'F1.478 Workspace',
      rootPath: WORKSPACE,
      workspaceRootPath: WORKSPACE,
      sessionRootPath: join(ROOT, 'sessions'),
    } as any,
    session: {
      id: KEY.sessionId,
      workspaceRootPath: WORKSPACE,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: PROJECT,
    } as any,
    model: 'pi/test-model',
    isHeadless: false,
    permissionServicePort,
    contextProfile: 'bare',
  }
}

/** Records the decision the gate hands the permission authority, and mints a receipt for it. */
function recordingService(): { port: PiPermissionServicePort; outcomes: string[]; reasons: string[] } {
  const outcomes: string[] = []
  const reasons: string[] = []
  const port: PiPermissionServicePort = {
    async authorize(request) {
      outcomes.push(request.decision.outcome)
      reasons.push(request.decision.outcome === 'allow' ? '' : String(request.decision.reason ?? ''))
      const outcome = request.decision.outcome === 'allow' ? 'allow' : 'deny'
      return parseAndFreezePiPermissionReceipt({
        version: 1,
        sessionKey: request.subject.sessionKey,
        binding: {
          provider: 'pi',
          surfaceVersion: request.subject.surfaceVersion,
          piName: request.subject.piName,
          bindingName: request.subject.bindingName,
          semanticId: request.subject.semanticId,
          descriptorId: request.subject.descriptorId,
        },
        manifest: {
          generation: request.subject.manifestGeneration,
          hash: request.subject.manifestHash,
          provenance: request.subject.manifestProvenance,
          responseEpoch: request.subject.responseEpoch,
        },
        decisionId: 'f1478-decision',
        outcome,
        canonicalInput: request.canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(outcome === 'deny' ? { reason: 'refused' } : {}),
      }, request.subject)
    },
  }
  return { port, outcomes, reasons }
}

/** The rules, through the real claude-rule parser, as the capability permission layer the gate reads. */
function applyRules(agent: PiAgent, rules: readonly Rule[]): void {
  if (rules.length === 0) return
  ;(agent as any).permissionManager.setCapabilityPermissionLayers([], GENERATION, true, parsePermissionDslV1({
    version: 1,
    rules: rules.map(([text, action], index) => {
      const parsed = parseClaudeRuleString(text, action)
      if (!parsed.rule) throw new Error(`rule is inert: ${text}`)
      return { id: `f1478-${index}`, ...parsed.rule, text }
    }),
  }))
}

const TOOLS = ['spawn_session', 'TaskList'] as const

function newAgent(port: PiPermissionServicePort): { agent: PiAgent; sent: Array<Record<string, unknown>> } {
  const agent = new PiAgent(createConfig(port))
  agent.setPermissionMode('default')
  const sent: Array<Record<string, unknown>> = []
  ;(agent as any).send = (message: Record<string, unknown>) => { sent.push(message) }
  ;(agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 })
  ;(agent as any).setCurrentTurnUserMessage('start a worker session')
  return { agent, sent }
}

afterEach(() => { cleanupModeState(KEY) })

/**
 * One Pi tool call through the real gate, in `default` mode; answers the
 * decision the permission authority was handed — `ask` is the card.
 */
async function decide(
  permissionName: (typeof TOOLS)[number],
  rules: readonly Rule[],
  input: Record<string, unknown> = { prompt: 'do the thing' },
): Promise<string> {
  const { port, outcomes } = recordingService()
  const { agent, sent } = newAgent(port)
  const manifest = finalizePiExecutionManifest(seed(), TOOLS.map(sessionTool))
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === permissionName)
  if (!tool) throw new Error(`missing test tool ${permissionName}`)
  agent.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  } as unknown as CapabilityTurnRuntime)
  ;(agent as any).activeExecutionManifest = manifest
  // AFTER the runtime: `setCapabilityTurnRuntime` clears manifest authority.
  applyRules(agent, rules)
  await (agent as any).handlePreToolUseRequest({
    requestId: `f1478-${permissionName}`,
    toolName: tool.binding.permissionName,
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    input,
  })
  agent.destroy()
  // Read into a local before asserting (the toMatchObject mutation trap).
  const outcome = outcomes.at(-1)
  if (outcome === undefined) return `no-decision:${String(sent.at(-1)?.reason ?? '')}`
  return outcome
}

describe('F1.478 · Pi reads a session tool\'s rule under both names', () => {
  it('CONTROL: with no rules nothing changes — spawn_session cards in default mode, TaskList runs', async () => {
    expect({
      spawn: await decide('spawn_session', []),
      taskList: await decide('TaskList', []),
    }).toEqual({ spawn: 'ask', taskList: 'allow' })
  })

  it('CONTROL: the Pi spelling still binds — deny spawn_session refuses, allow spawn_session answers the card', async () => {
    expect({
      deny: await decide('spawn_session', [['spawn_session', 'deny']]),
      allow: await decide('spawn_session', [['spawn_session', 'allow']]),
    }).toEqual({ deny: 'deny', allow: 'allow' })
  })

  it('deny mcp__session__spawn_session refuses the call on Pi, as on claude and codex', async () => {
    expect(await decide('spawn_session', [['mcp__session__spawn_session', 'deny']])).toBe('deny')
  })

  it('the server-wide and all-server spellings refuse it too — deny mcp__session, deny mcp__*', async () => {
    expect({
      server: await decide('spawn_session', [['mcp__session', 'deny']]),
      everyServer: await decide('spawn_session', [['mcp__*', 'deny']]),
    }).toEqual({ server: 'deny', everyServer: 'deny' })
  })

  it('an allow in claude\'s spelling answers the card, as it does on codex (F1.272)', async () => {
    expect(await decide('spawn_session', [['mcp__session__spawn_session', 'allow']])).toBe('allow')
  })

  it('ONE subject: a deny under either name outranks an allow under the other, and an ask outranks an allow', async () => {
    expect({
      claudeDenyPiAllow: await decide('spawn_session', [['spawn_session', 'allow'], ['mcp__session__spawn_session', 'deny']]),
      piDenyClaudeAllow: await decide('spawn_session', [['mcp__session__spawn_session', 'allow'], ['spawn_session', 'deny']]),
      claudeAskPiAllow: await decide('spawn_session', [['spawn_session', 'allow'], ['mcp__session__spawn_session', 'ask']]),
    }).toEqual({ claudeDenyPiAllow: 'deny', piDenyClaudeAllow: 'deny', claudeAskPiAllow: 'ask' })
  })

  it('BOUNDARY: a pi-only session tool is not aliased — mcp__* leaves TaskList alone, deny TaskList still binds', async () => {
    expect({
      everyServer: await decide('TaskList', [['mcp__*', 'deny']]),
      byName: await decide('TaskList', [['TaskList', 'deny']]),
    }).toEqual({ everyServer: 'allow', byName: 'deny' })
  })
})

describe('F1.478 · the advertised manifest agrees with the gate', () => {
  /** The bindings `buildExecutionManifestForCurrentTurn` advertises under these rules. */
  function advertised(rules: readonly Rule[]): string[] {
    const { port } = recordingService()
    const { agent } = newAgent(port)
    const manifestSeed = seed()
    agent.setCapabilityTurnRuntime({
      view: { generation: GENERATION },
      materializer: { assertActive() {} },
      piExecutionManifestSeed: manifestSeed,
    } as unknown as CapabilityTurnRuntime)
    applyRules(agent, rules)
    ;(agent as any).buildCurrentProxyToolDefinitions = () => TOOLS.map(handler => ({
      name: `mcp__session__${handler}`,
      description: `The ${handler} session tool.`,
      inputSchema: { type: 'object', properties: {} },
    }))
    const names = (agent as any).buildExecutionManifestForCurrentTurn().manifest.tools
      .map((tool: { binding: { bindingName: string } }) => tool.binding.bindingName) as string[]
    agent.destroy()
    return names.filter(name => name.startsWith('mcp__session__'))
  }

  it('CONTROL: a Pi-spelled whole-tool deny removes spawn_session and nothing else', () => {
    expect(advertised([['spawn_session', 'deny']])).toEqual(['mcp__session__TaskList'])
  })

  it('a claude-spelled whole-tool deny removes it too, so the model is not shown a tool every call of which is refused', () => {
    expect({
      exact: advertised([['mcp__session__spawn_session', 'deny']]),
      everyServer: advertised([['mcp__*', 'deny']]),
    }).toEqual({ exact: ['mcp__session__TaskList'], everyServer: ['mcp__session__TaskList'] })
  })

  it('CONTROL: a rule naming neither leaves both advertised', () => {
    expect(advertised([['Bash(git push *)', 'deny']])).toEqual(['mcp__session__spawn_session', 'mcp__session__TaskList'])
  })
})
