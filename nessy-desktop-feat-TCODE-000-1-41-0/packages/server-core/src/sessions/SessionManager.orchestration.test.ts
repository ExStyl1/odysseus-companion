import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { SessionBundle } from '@nessy-agent/shared/sessions/bundle'
import { appendRunLog } from '@nessy-agent/shared/tasks'
import { createTestCapabilityResolver, createTestSessionManager } from './__tests__/test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from './SessionManager.ts'
import { createHeadlessPlatform } from '../runtime/platform-headless.ts'
import { TaskService } from '../pi-harness/task-service.ts'
import { materializePiRuntimeAgentDefinitions } from '@nessy-agent/shared/agent/pi-harness/runtime-agent-definition'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import type { PiChildSessionPort, PiChildStartInput } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import type { BackendConfig } from '@nessy-agent/shared/agent/backend/types'
import type { GuardianJudgeInput } from '@nessy-agent/shared/prompts/guardian'
import { createPiPermissionService } from '../pi-harness/permission-service.ts'

const inertMaterializer = {
  assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
  async readText() { return '' }, resolveCredential() { throw new Error('not used') },
}
const allowAgentAdmission = createPiPermissionService({})

describe('SessionManager Pi child orchestration composition', () => {
  test('skips a pre-aborted Guardian child and stops the exact preassigned child after start', async () => {
    const manager = createTestSessionManager()
    let startInput: PiChildStartInput | undefined
    let resolveStart!: (value: Awaited<ReturnType<PiChildSessionPort['start']>>) => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const startResult = new Promise<Awaited<ReturnType<PiChildSessionPort['start']>>>(resolve => {
      resolveStart = resolve
    })
    const stopped: string[] = []
    const childPort = {
      async start(input: PiChildStartInput) {
        startInput = input
        markStarted()
        return startResult
      },
      async stop(agentId: string) {
        stopped.push(agentId)
      },
    } as PiChildSessionPort
    const judgePort = (manager as any).createGuardianJudgePort(
      {
        id: 'parent',
        model: 'session-model',
        workspace: { id: 'workspace-a', rootPath: process.cwd() },
      },
      childPort,
      undefined,
    )
    const controller = new AbortController()
    const input: GuardianJudgeInput = {
      action: { command: 'git status', cwd: process.cwd() },
      trustedIntent: 'Inspect repository status.',
      facts: { mode: 'auto', workspaceRoot: process.cwd() },
    }
    const preAborted = new AbortController()
    preAborted.abort()
    const preAbortedResult = await judgePort.judge({
      input,
      cwd: process.cwd(),
      signal: preAborted.signal,
    })
    expect(preAbortedResult.failure).toBe('aborted')
    expect(startInput).toBeUndefined()
    expect(stopped).toEqual([])

    const pending = judgePort.judge({ input, cwd: process.cwd(), signal: controller.signal })
    const startup = await Promise.race([
      started.then(() => 'started' as const),
      pending.then(() => 'completed' as const),
    ])
    expect(startup).toBe('started')
    if (!startInput) throw new Error('Guardian child did not start')

    controller.abort()
    await new Promise(resolve => setImmediate(resolve))
    try {
      const agentId = startInput.requestedAgentId
      expect(agentId).toEqual(expect.any(String))
      if (!agentId) throw new Error('Guardian child id was not preassigned')
      expect(stopped).toEqual([agentId])
    } finally {
      resolveStart({
        agentId: startInput.requestedAgentId ?? 'unassigned',
        status: 'stopped',
        output: '',
      })
      await pending
      await manager.cleanup()
    }
  })

  test('pins idle ConfigChange hooks for model and thinking commits exactly once', async () => {
    const resolver = createTestCapabilityResolver()
    const manager = createTestSessionManager({ resolver })
    const workspace = {
      id: 'workspace-a', name: 'Workspace A', rootPath: '/tmp/nessy-config-change',
      workspaceRootPath: '/tmp/nessy-config-change', sessionRootPath: '/tmp/nessy-config-change-sessions',
      config: { id: 'workspace-a', name: 'Workspace A', createdAt: 1, updatedAt: 1 },
      lastAccessedAt: 1,
    }
    const agent = new PiAgent({
      provider: 'pi', workspace,
      session: { id: 'idle-session', workspaceId: workspace.id, workspaceRootPath: workspace.rootPath, createdAt: 1, lastUsedAt: 1 },
      model: 'old-model', isHeadless: true,
    } as BackendConfig)
    const managed: any = {
      id: 'idle-session', workspace, permissionMode: 'default', thinkingLevel: 'off', model: 'old-model',
      llmConnection: 'pi', agent, messages: [], messagesLoaded: true, backgroundShellCommands: new Map(),
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), managed)
    ;(manager as any).writeSessionMetadata = async () => {}
    ;(manager as any).persistSession = () => {}
    const events: Array<{ event: string; input: Record<string, unknown> }> = []
    ;(manager as any).buildAgentAutomationSystem = async () => ({
      async executeAgentEvent(event: string, input: Record<string, unknown>) {
        events.push({ event, input })
        return { matchedCount: 1 }
      },
    })

    await manager.updateSessionModel(managed.id, workspace.id, 'new-model')
    await manager.setSessionThinkingLevel(managed.id, 'high', workspace.id)
    await (manager as any).runAgentRuntimeRefresh(
      managed,
      { connection: undefined, resolvedModel: 'runtime-model', provider: 'pi', authType: 'none' },
      'runtime-signature',
      'restart-signature',
      false,
      'test-runtime-refresh',
    )

    // P3.374 — `updateSessionModel` now emits the documented model-switch pair
    // around its commit, through `withPinnedConfigChange`, which is what builds
    // the automation system between turns. So this fixture sees FIVE events, and
    // the two new ones bracket the `ConfigChange` they belong to: that ORDER is
    // the assertion worth keeping, because a Post that fired before the write
    // would be reporting a switch that had not happened.
    expect(events.map(entry => entry.event)).toEqual([
      'PreModelSwitch', 'ConfigChange', 'PostModelSwitch', 'ConfigChange', 'ConfigChange',
    ])
    const configChanges = events.filter(entry => entry.event === 'ConfigChange')
    expect(configChanges.map(entry => entry.input.config_keys)).toEqual([
      ['model'],
      ['thinkingLevel'],
      ['authType', 'model', 'providerType', 'runtime'],
    ])
    expect(events.every(entry => entry.input.hook_event_name === entry.event)).toBe(true)
    expect(resolver.leaseCount()).toBe(0)

    // P2.223 · CLEARING the model must not blank the agent's.
    //
    // `updateSessionModel(…, null)` is the documented "clear the
    // session-specific model" call. Its fallback chain ended
    // `?? sessionConn?.defaultModel!`, and the `!` asserted non-null on an
    // expression that is `undefined` whenever no connection resolves (or one
    // resolves without a `defaultModel` — `z.string().optional()`). `setModel`
    // is a bare assignment, so `_model` became `undefined` while typed `string`
    // and `getModel()` returned it. This session has no workspace default and no
    // resolvable connection, which is exactly that shape.
    const modelBeforeClear = agent.getModel()
    await manager.updateSessionModel(managed.id, workspace.id, null)
    // The assertion is on the TYPE as much as the value: `toBeDefined()` alone
    // would pass for the empty string, and `undefined` is the defect.
    expect(typeof agent.getModel()).toBe('string')
    // The agent keeps what it had rather than being reset — the stated residue
    // of fixing the fallback instead of the assertion. Compared against what it
    // held BEFORE the clear rather than against a literal: `runAgentRuntimeRefresh`
    // above already moved it to `runtime-model`, and a literal here would pin
    // this row to that fixture's history instead of to the property.
    expect(agent.getModel()).toBe(modelBeforeClear)
    agent.destroy()
    await manager.cleanup()
  })

  /**
   * W3 — the project-less named subagent (AGT-5). sub-agents.md:263: "A
   * subagent starts in the main conversation's current working directory. …
   * To give the subagent an isolated copy of the repository instead, set
   * `isolation: worktree`." The parent's checkout is the documented baseline,
   * and the isolated-worktree DEFAULT this host derives from a full toolset
   * is a hardening on top of it — so a session with NO bound project degrades
   * that default to `shared` instead of refusing every named spawn with
   * `worktree-project-required` before any model turn. An EXPLICIT
   * `isolation: worktree` in the definition is an author's requirement and
   * still fails closed with that exact error.
   */
  test('a project-less session degrades the derived worktree default to shared; explicit isolation still refuses', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent', workspace: { id: 'workspace-w3', rootPath: process.cwd() }, permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true, messages: [],
      backgroundShellCommands: new Map(),
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-w3', sessionId: 'parent' }), parent)
    ;(manager as any).persistSession = () => {}
    const materializer = {
      assertActive() {},
      readText: async (resource: any) => resource.resourceId === 'isolated'
        ? '---\nisolation: worktree\n---\nIsolated instructions.'
        : 'Builder instructions.',
    } as any
    const view: any = {
      generation: 'g1', sources: [], hooks: [], automations: [], promptLayers: [], memory: [], permissionLayers: [],
      commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
      agents: [
        {
          key: 'agent://builder', name: 'builder', description: 'Full-toolset builder', selectedAsUnqualifiedAlias: true,
          instructionsResource: { source: 'workspace', resourceId: 'builder' },
          tools: ['Bash', 'ReadFile'],
        },
        {
          key: 'agent://isolated', name: 'isolated', description: 'Explicitly isolated reader', selectedAsUnqualifiedAlias: true,
          instructionsResource: { source: 'workspace', resourceId: 'isolated' },
          tools: ['ReadFile', 'Grep'],
        },
      ],
    }
    const definitions = await materializePiRuntimeAgentDefinitions({ view, materializer })
    const builder = definitions.find(definition => definition.name === 'builder')!
    const isolated = definitions.find(definition => definition.name === 'isolated')!
    // The explicit half's precondition, pinned so a frontmatter parsing change
    // cannot silently turn it into a second copy of the implicit half.
    expect(isolated.isolation).toBe('worktree')
    const port = await (manager as any).createPiChildSessionPort(
      parent,
      { view, materializer },
      allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    const admitted: any[] = []
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted.push(record)
      return {
        childSessionKey: { workspaceId: 'workspace-w3', sessionId: `child-${admitted.length}` },
        transcriptId: `child-${admitted.length}`, status: 'completed', output: 'done', result: 'done',
      }
    }
    const input = (definition: typeof builder, agentId: string): any => ({
      requestedAgentId: agentId, agent: definition.name, task: 'do the task', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition.systemPrompt}`,
        model: 'session-model',
        tools: definition.name === 'builder' ? ['bash', 'read'] : ['read', 'grep'],
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'g1', definitionKey: definition.key, definitionDigest: definition.definitionDigest,
      },
      budgets: { depth: 1, maxDepth: 2, fanout: 4, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
    })

    // No bound project + toolset-DERIVED isolation: the spawn is admitted and
    // the child record runs shared — in the parent's own checkout.
    await port.start(input(builder, 'agent-w3-implicit'))
    expect(admitted).toHaveLength(1)
    expect(admitted[0].restrictions.worktreePolicy).toBe('shared')

    // No bound project + EXPLICIT `isolation: worktree`: the request is NOT
    // degraded — the record keeps the isolation the author asked for, and the
    // downstream lease authority refuses it with the named error.
    await port.start(input(isolated, 'agent-w3-explicit'))
    expect(admitted).toHaveLength(2)
    expect(admitted[1].restrictions.worktreePolicy).toBe('isolated-worktree')
    delete (manager as any).startPiChildRuntime // restore the real prototype method
    await expect(port.start(input(isolated, 'agent-w3-explicit-real')))
      .rejects.toThrow('worktree-project-required')

    // Positive control for the degrade's own condition: with a project BOUND,
    // the derived default is NOT degraded.
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted.push(record)
      return {
        childSessionKey: { workspaceId: 'workspace-w3', sessionId: `child-${admitted.length}` },
        transcriptId: `child-${admitted.length}`, status: 'completed', output: 'done', result: 'done',
      }
    }
    ;(manager as any).projectHandleService = {
      resolveHandle: async () => ({ id: 'handle-1', canonicalPath: process.cwd() }),
    }
    await port.start(input(builder, 'agent-w3-bound'))
    expect(admitted.at(-1).restrictions.worktreePolicy).toBe('isolated-worktree')
    await manager.cleanup()
  })

  test('authenticates pinned child restrictions against the host definition', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent', workspace: { id: 'workspace-a', rootPath: process.cwd() }, permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    const key = encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' })
    ;(manager as any).sessions.set(key, parent)
    const materializer = {
      assertActive() {},
      readText: async (resource: any) => resource.resourceId === 'sentinel'
        ? '---\ntools: Read\n---\nSENTINEL_SKILL_BODY'
        : resource.resourceId === 'unrelated'
          ? 'UNRELATED_SKILL_BODY'
          : 'Pinned reviewer instructions.',
    } as any
    const view: any = {
      generation: 'g1', sources: [
        { key: 'source://api', logicalName: 'api' },
        { key: 'source://source-gitlab', logicalName: 'source-gitlab', mcpWireName: 'sourceGitlab' },
      ], hooks: [], automations: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      skills: [
        { key: 'skill://sentinel', logicalName: 'sentinel', selectedAsUnqualifiedAlias: true, resource: { source: 'workspace', resourceId: 'sentinel', contentHash: 'b'.repeat(64) } },
        { key: 'skill://unrelated', logicalName: 'unrelated', selectedAsUnqualifiedAlias: true, resource: { source: 'workspace', resourceId: 'unrelated', contentHash: 'c'.repeat(64) } },
      ],
      mcpServers: [{ key: 'mcp://gitlab', wireName: 'gitlab' }],
      agents: [{
        key: 'agent://reviewer', name: 'reviewer', description: 'Pinned reviewer', selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'workspace' }, model: 'pinned-model',
        tools: ['Glob', 'Grep', 'ListFiles', 'ReadFile', 'ReadManyFiles', 'NotebookRead', 'WebFetch', 'TodoWrite'],
        skillKeys: ['skill://sentinel'], mcpServerKeys: ['mcp://gitlab'],
      }],
    }
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    const port = await (manager as any).createPiChildSessionPort(
      parent,
      { view, materializer },
      allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    const input: any = {
      requestedAgentId: 'agent-1', agent: 'reviewer', task: 'inspect', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        model: 'pinned-model',
        tools: ['find', 'grep', 'ls', 'read', 'web_fetch', 'mcp__session__TodoWrite'],
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'g1', definitionKey: definition!.key, definitionDigest: definition!.definitionDigest,
        skillKeys: ['skill://sentinel'], mcpServerKeys: ['mcp://gitlab'],
      },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    }

    await expect(port.start({ ...input, restrictions: { ...input.restrictions, definitionDigest: 'a'.repeat(64) } }))
      .rejects.toThrow('runtime-agent-definition-identity-mismatch')
    await expect(port.start({ ...input, restrictions: { ...input.restrictions, tools: ['bash'] } }))
      .rejects.toThrow('runtime-agent-tool-unavailable:bash')
    await expect(port.start({ ...input, restrictions: { ...input.restrictions, skillKeys: ['skill://other'] } }))
      .rejects.toThrow('runtime-agent-skill-unavailable')
    await expect(port.start({ ...input, restrictions: { ...input.restrictions, mcpServerKeys: ['mcp://other'] } }))
      .rejects.toThrow('runtime-agent-mcp-unavailable')
    await expect(port.start({ ...input, restrictions: { ...input.restrictions, model: 'other-model' } }))
      .rejects.toThrow('runtime-agent-model-ceiling-mismatch')
    let admitted: any
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record
      return {
        childSessionKey: { workspaceId: 'workspace-a', sessionId: 'child-1' }, transcriptId: 'child-1',
        status: 'completed', output: 'done', result: 'done',
      }
    }
    await port.start(input)
    expect(admitted.restrictions.prompt.match(/SENTINEL_SKILL_BODY/g)).toHaveLength(1)
    expect(admitted.restrictions.prompt).not.toContain('UNRELATED_SKILL_BODY')
    // The preloaded skill declares `tools: Read` and the child is STILL admitted
    // with the agent's whole pinned list: `allowed-tools` pre-approves, it does
    // not narrow ("It does not restrict which tools are available: every tool
    // remains callable", `skills.md` § Pre-approve tools for a skill). Before
    // 2026-08-13 this read `['read']` — the skill silently amputated the
    // subagent's tool pool. The agent's own `tools` ceiling still applies, which
    // is what makes this list this and not everything.
    expect(admitted.restrictions.tools).toEqual(['find', 'grep', 'ls', 'read', 'web_fetch', 'mcp__session__todowrite'])
    expect(admitted.capabilityView.skills.map((skill: any) => skill.key)).toEqual(['skill://sentinel'])
    expect(admitted.capabilityView.sources.map((source: any) => source.key)).toEqual(['source://api'])
    expect(admitted.capabilityView.mcpServers.map((server: any) => server.key)).toEqual(['mcp://gitlab'])
    let active = true
    let releaseSkillRead!: () => void
    let skillReadStarted!: () => void
    const skillReadGate = new Promise<void>(resolve => { releaseSkillRead = resolve })
    const skillReadObserved = new Promise<void>(resolve => { skillReadStarted = resolve })
    const revocableMaterializer = {
      ...materializer,
      assertActive() { if (!active) throw new Error('capability-snapshot-revoked') },
      async readText(resource: any) {
        if (resource.resourceId !== 'sentinel') return materializer.readText(resource)
        skillReadStarted()
        await skillReadGate
        return materializer.readText(resource)
      },
    }
    const revocablePort = await (manager as any).createPiChildSessionPort(
      parent, { view, materializer: revocableMaterializer },
      allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    let starts = 0
    ;(manager as any).startPiChildRuntime = async () => { starts += 1; throw new Error('must-not-start') }
    const pending = revocablePort.start({ ...input, requestedAgentId: 'agent-2' })
    await skillReadObserved
    active = false
    releaseSkillRead()
    await expect(pending).rejects.toThrow('capability-snapshot-revoked')
    expect(starts).toBe(0)
    manager.cleanup()
  })

  /**
   * P7, the host half. sub-agents.md § *Available tools*: "Both fields accept
   * MCP server-level patterns in addition to exact tool names: `mcp__<server>`
   * or `mcp__<server>__*` grants or removes every tool from the named server."
   *
   * Pi expands that pattern against the session pool, so what ARRIVES here is
   * N concrete `mcp__<server>__<tool>` names while the pinned definition still
   * holds the single pattern. Exact-set membership alone refused every one of
   * them — which would have traded the silently-empty grant P7 fixed for a
   * spawn-time `runtime-agent-tool-unavailable`, the same trade the `Agent(...)`
   * strip rule already paid for once.
   *
   * The negative arm is the prefix boundary: `mcp__gitlab__*` must not admit a
   * tool from a server whose wire name it merely begins.
   */
  test('admits an expanded server-level MCP grant, and only that server', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent-p7', workspace: { id: 'workspace-p7', rootPath: process.cwd() }, permissionMode: 'default',
      thinkingLevel: 'off', llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-p7', sessionId: 'parent-p7' }), parent)
    const materializer = { assertActive() {}, readText: async () => 'Pinned scout instructions.' } as any
    const view: any = {
      generation: 'g1', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [],
      mcpServers: [{ key: 'mcp://gitlab', wireName: 'gitlab' }],
      agents: [{
        key: 'agent://scout', name: 'scout', description: 'Pinned scout', selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'workspace' },
        tools: ['Read', 'mcp__gitlab__*'],
      }],
    }
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    const port = await (manager as any).createPiChildSessionPort(
      parent, { view, materializer }, allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    const input: any = {
      requestedAgentId: 'agent-p7', agent: 'scout', task: 'inspect', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        // What Pi now sends: the pattern expanded into the pool's own names.
        tools: ['read', 'mcp__gitlab__repos', 'mcp__gitlab__merge_requests'],
        // Both sides derive this from a list holding a non-read-only entry.
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'g1', definitionKey: definition!.key, definitionDigest: definition!.definitionDigest,
      },
      budgets: {
        depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
        costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [],
      },
    }

    // The boundary: `gitlabextra` is a different server that `gitlab` prefixes.
    await expect(port.start({
      ...input,
      restrictions: { ...input.restrictions, tools: ['read', 'mcp__gitlabextra__repos'] },
    })).rejects.toThrow('runtime-agent-tool-unavailable:mcp__gitlabextra__repos')
    // And an unrelated built-in is still refused, exactly as before.
    await expect(port.start({ ...input, restrictions: { ...input.restrictions, tools: ['bash'] } }))
      .rejects.toThrow('runtime-agent-tool-unavailable:bash')
    // The worktree half of the symmetry: the host derives `isolated-worktree`
    // from a declared list holding `mcp__gitlab__*`, which is what Pi's `full`
    // toolset derives from the same list once expanded. Asserted through the
    // refusal, because the value the record ends up carrying is subject to the
    // separate no-project degrade this test does not bind a handle for.
    await expect(port.start({
      ...input,
      restrictions: { ...input.restrictions, worktreePolicy: 'shared' },
    })).rejects.toThrow('runtime-agent-worktree-policy-mismatch')

    let admitted: any
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record
      return {
        childSessionKey: { workspaceId: 'workspace-p7', sessionId: 'child-p7' }, transcriptId: 'child-p7',
        status: 'completed', output: 'done', result: 'done',
      }
    }
    await port.start(input)
    expect(admitted.restrictions.tools).toEqual(['read', 'mcp__gitlab__repos', 'mcp__gitlab__merge_requests'])
    // Not awaited, matching the sibling test that also admits a child: draining
    // a stubbed child runtime rejects with `pi-session-drain-failed`.
    manager.cleanup()
  })

  /**
   * P12, the host half of the DENY seam. Raw page
   * (`curl -sL https://code.claude.com/docs/en/sub-agents.md`),
   * § *Available tools*: "Both fields accept MCP server-level patterns in
   * addition to exact tool names: `mcp__<server>` or `mcp__<server>__*` grants
   * or removes every tool from the named server. In `disallowedTools`,
   * `mcp__*` also removes every MCP tool from any server."
   *
   * **Both fields**, and this check read the ALLOW half only: `matchesToolPattern`
   * compiles a bare `mcp__gitlab` to `^mcp__gitlab$`, which matches no concrete
   * `mcp__gitlab__<tool>` name, so a denied tool arriving in
   * `restrictions.tools` was admitted.
   *
   * This is the BACKSTOP half of the pair, not a duplicate of the Pi filter:
   * the arriving list is transport-supplied and narrowable by its caller (the
   * comment on `expectedWorktreePolicy` below says so), so the child's pool
   * being filtered by `spawner.ts` does not make this check redundant. The Pi
   * half is `spawner.test.ts` ("removes a server tools from the child pool for
   * a BARE server-level denial"); fixing either side alone leaves the other
   * reading a rule its counterpart does not know.
   */
  test('refuses a tool a bare server-level denial removes', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent-p12', workspace: { id: 'workspace-p12', rootPath: process.cwd() }, permissionMode: 'default',
      thinkingLevel: 'off', llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-p12', sessionId: 'parent-p12' }), parent)
    const materializer = { assertActive() {}, readText: async () => 'Pinned scout instructions.' } as any
    const view: any = {
      generation: 'g1', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [],
      mcpServers: [{ key: 'mcp://gitlab', wireName: 'gitlab' }, { key: 'mcp://gitlabextra', wireName: 'gitlabextra' }],
      agents: [{
        key: 'agent://scout', name: 'scout', description: 'Pinned scout', selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'workspace' },
        tools: ['Read', 'mcp__gitlab__*', 'mcp__gitlabextra__*'],
        // The BARE spelling — the one that denied nothing.
        disallowedTools: ['mcp__gitlab'],
      }],
    }
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    const port = await (manager as any).createPiChildSessionPort(
      parent, { view, materializer }, allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    const input: any = {
      requestedAgentId: 'agent-p12', agent: 'scout', task: 'inspect', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        tools: ['read', 'mcp__gitlabextra__status'],
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'g1', definitionKey: definition!.key, definitionDigest: definition!.definitionDigest,
      },
      budgets: {
        depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
        costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [],
      },
    }

    // Stubbed BEFORE the refusal arm, deliberately: the defect does not throw,
    // it ADMITS, so without these the failure surfaces as an unrelated crash
    // deep inside the real child runtime instead of as the missing refusal.
    let admitted: any
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record
      return {
        childSessionKey: { workspaceId: 'workspace-p12', sessionId: 'child-p12' }, transcriptId: 'child-p12',
        status: 'completed', output: 'done', result: 'done',
      }
    }

    // The defect: granted by `mcp__gitlab__*`, removed by `mcp__gitlab`.
    await expect(port.start({
      ...input,
      restrictions: { ...input.restrictions, tools: ['read', 'mcp__gitlab__repos'] },
    })).rejects.toThrow('runtime-agent-tool-unavailable:mcp__gitlab__repos')
    expect(admitted).toBeUndefined()

    // NO WIDENING — the denial reaches exactly the named server. A tool from
    // the server whose wire name `gitlab` merely prefixes is still admitted,
    // and so is the built-in.
    await port.start(input)
    expect(admitted.restrictions.tools).toEqual(['read', 'mcp__gitlabextra__status'])
    manager.cleanup()
  })

  /**
   * P8, the host half of the worktree-policy seam.
   *
   * The host derives `expectedWorktreePolicy` from the pinned definition's
   * author-DECLARED `tools`; Pi used to derive its own from the RESOLVED
   * remainder. `Bash(git diff:*)` is the first of the three shapes measured
   * live: it is denied by omission on the Pi side (`1ff71c5a4` — only
   * `Agent(...)` is reduced to its bare tool), so what ARRIVES here is `['read']`
   * while the declared list still holds the entry. Pi therefore sent `shared`
   * and the host expected `isolated-worktree`.
   *
   * This test pins the host's DIRECTION, which is the constraint the fix had to
   * respect: the stricter posture is the one both sides converge on, so the
   * refusal of `shared` must survive the change. A fix that had taught the host
   * to read the arriving list instead would flip this arm — and would be a
   * widening, since the arriving list is transport-supplied and the `memory:`
   * grant re-adds Read/Write/Edit after this check.
   */
  test('refuses a shared tree for an agent whose declared grant did not resolve', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent-p8', workspace: { id: 'workspace-p8', rootPath: process.cwd() }, permissionMode: 'default',
      thinkingLevel: 'off', llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-p8', sessionId: 'parent-p8' }), parent)
    const materializer = { assertActive() {}, readText: async () => 'Pinned scout instructions.' } as any
    const view: any = {
      generation: 'g8', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
      agents: [{
        key: 'agent://scout', name: 'scout', description: 'Pinned scout', selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'workspace' },
        tools: ['Read', 'Bash(git diff:*)'],
      }],
    }
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    const port = await (manager as any).createPiChildSessionPort(
      parent, { view, materializer }, allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    const input: any = {
      requestedAgentId: 'agent-p8', agent: 'scout', task: 'inspect', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        // What Pi sends: the parametrized entry was denied by omission.
        tools: ['read'],
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'g8', definitionKey: definition!.key, definitionDigest: definition!.definitionDigest,
      },
      budgets: {
        depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
        costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [],
      },
    }

    // The value Pi used to send, and the reason the spawn died.
    await expect(port.start({
      ...input,
      restrictions: { ...input.restrictions, worktreePolicy: 'shared' },
    })).rejects.toThrow('runtime-agent-worktree-policy-mismatch')

    let admitted: any
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record
      return {
        childSessionKey: { workspaceId: 'workspace-p8', sessionId: 'child-p8' }, transcriptId: 'child-p8',
        status: 'completed', output: 'done', result: 'done',
      }
    }
    await port.start(input)
    expect(admitted.restrictions.tools).toEqual(['read'])
    manager.cleanup()
  })

  /**
   * P8 — the plugin-hook spawn route is a PRODUCER of the same policy, and it
   * had to pass the validator above.
   *
   * As a hand-written second copy of the rule it read the tool list and NOT
   * `isolation`, so an agent declaring `isolation: worktree` with a read-only
   * `tools` list was handed `shared` and then refused by the check in the very
   * port it starts through. Driven end to end, because the producer and the
   * validator only disagree in composition: each looks right alone.
   */
  test('starts a plugin-hook agent that declares isolation: worktree with a read-only tool list', async () => {
    const manager = createTestSessionManager()
    const content = [
      '---',
      'name: hook-scout',
      'description: Pinned hook scout',
      'tools: [Read, Grep]',
      'isolation: worktree',
      '---',
      '',
      'Inspect concisely.',
    ].join('\n')
    const materializer = {
      assertActive() {}, async verifyPlugin() {}, readText: async () => content,
    } as any
    const view: any = {
      generation: 'g8-hook', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
      agents: [{
        key: 'agent://hook-scout', name: 'hook-scout', description: 'Pinned hook scout',
        selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'workspace', scope: { kind: 'workspace' } },
      }],
    }
    // No plugin hooks in the view, so the route's own trust gate is satisfied by
    // the project grant instead.
    const capabilityRuntime: any = { view, materializer, projectTrustState: 'trusted' }
    const parent: any = {
      id: 'parent-p8-hook', workspace: { id: 'workspace-p8-hook', rootPath: process.cwd() },
      permissionMode: 'bypassPermissions', thinkingLevel: 'off', llmConnection: 'pi', model: 'session-model',
      childSessionState: undefined, messagesLoaded: true,
    }
    ;(manager as any).sessions.set(
      encodeSessionKey({ workspaceId: 'workspace-p8-hook', sessionId: 'parent-p8-hook' }),
      parent,
    )
    parent.piChildSessionPort = await (manager as any).createPiChildSessionPort(
      parent, capabilityRuntime, allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    let admitted: any
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record
      return {
        childSessionKey: { workspaceId: 'workspace-p8-hook', sessionId: 'child-p8-hook' },
        transcriptId: 'child-p8-hook', status: 'completed', output: 'done', result: 'done',
      }
    }

    await (manager as any).pluginAgentHookRunner(parent, capabilityRuntime)({
      agentName: 'hook-scout', event: 'SessionStart',
    })

    // Admitted at all: the producer's value passed the validator. Before P8 the
    // route sent `shared` here and the port refused it, so nothing started.
    expect(admitted?.restrictions?.worktreePolicy).toBe('isolated-worktree')
    manager.cleanup()
  })

  /**
   * P2.301 — the REAL path for the omitted ceiling, end to end: the plugin-hook
   * producer, the port's own `start` (its validator, its parent-narrowing, its
   * skill/memory grants) and the record that is persisted. The sibling unit test
   * in `SessionManager.plugin-hook-runners.test.ts` observes the producer through
   * a recording port, which cannot see any of the four sites the port itself
   * reads the ceiling at — and a double that never exercises the argument under
   * test is how a dead sentinel shipped green on this plan.
   *
   * `errors.md` § *Agent would be spawned with zero tools*: "Omitting the `tools`
   * field never triggers this refusal." — and the fix list, "Delete the `tools`
   * field instead of listing tools to give the subagent every tool available to
   * subagents". Both arms of the narrow-only rule are asserted, because absence
   * must mean "inherit", never "widen":
   *
   *  - a parent with NO ceiling admits the child with the key still ABSENT, so
   *    `piAllowedTools` sees `undefined` and `resolvePiAllowedBindingNames`
   *    returns `null` — no restriction, the whole way down;
   *  - a parent WITH a ceiling admits the child holding that parent's list, not
   *    a wider one and not the empty set the producer used to send.
   */
  test('admits a plugin-hook agent that omits `tools:` with an inherited ceiling, never the empty set', async () => {
    const content = [
      '---',
      'name: hook-inheritor',
      'description: Pinned hook inheritor',
      // No `tools:` — the whole point. `isolation: worktree` keeps the policy
      // deterministic without binding a project handle; it is not under test.
      'isolation: worktree',
      '---',
      '',
      'Inspect concisely.',
    ].join('\n')
    const view: any = {
      generation: 'g-inherit', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
      agents: [{
        key: 'agent://hook-inheritor', name: 'hook-inheritor', description: 'Pinned hook inheritor',
        selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'workspace', scope: { kind: 'workspace' } },
      }],
    }

    const runOnce = async (parentTools: string[] | undefined) => {
      const manager = createTestSessionManager()
      const materializer = {
        assertActive() {}, async verifyPlugin() {}, readText: async () => content,
      } as any
      const capabilityRuntime: any = { view, materializer, projectTrustState: 'trusted' }
      const parent: any = {
        id: 'parent-inherit', workspace: { id: 'workspace-inherit', rootPath: process.cwd() },
        permissionMode: 'bypassPermissions', thinkingLevel: 'off', llmConnection: 'pi',
        model: 'session-model', childSessionState: undefined, messagesLoaded: true,
        // The parent's own ceiling, when it has one. `model` must agree with what
        // the producer sends (`managed.model`, the definition declaring none) or
        // the port refuses with `runtime-agent-parent-model-ceiling-mismatch`.
        ...(parentTools ? {
          piChildRestrictions: {
            prompt: 'parent', model: 'session-model', tools: parentTools,
            worktreePolicy: 'shared', thinkingLevel: 'off',
          },
        } : {}),
      }
      ;(manager as any).sessions.set(
        encodeSessionKey({ workspaceId: 'workspace-inherit', sessionId: 'parent-inherit' }),
        parent,
      )
      parent.piChildSessionPort = await (manager as any).createPiChildSessionPort(
        parent, capabilityRuntime, allowAgentAdmission,
        async () => {}, async () => {}, async () => {},
      )
      let admitted: any
      ;(manager as any).persistSession = () => {}
      ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
        admitted = record
        return {
          childSessionKey: { workspaceId: 'workspace-inherit', sessionId: 'child-inherit' },
          transcriptId: 'child-inherit', status: 'completed', output: 'done', result: 'done',
        }
      }
      await (manager as any).pluginAgentHookRunner(parent, capabilityRuntime)({
        agentName: 'hook-inheritor', event: 'SessionStart',
      })
      manager.cleanup()
      return admitted
    }

    // No parent ceiling => no child ceiling. Absent by OMISSION, because the
    // record is persisted and a key holding `undefined` is a different record.
    const unbounded = await runOnce(undefined)
    expect(unbounded).toBeDefined()
    expect(unbounded.restrictions.tools).toBeUndefined()
    expect('tools' in unbounded.restrictions).toBe(false)

    // A parent ceiling => the child inherits exactly it. Narrow-only: this is
    // the parent's list, not a wider one, and emphatically not `[]`.
    const bounded = await runOnce(['read', 'grep'])
    expect(bounded).toBeDefined()
    expect(bounded.restrictions.tools).toEqual(['read', 'grep'])
  })

  /**
   * P2.272 + P2.302 — an admitted child with an EMPTY tool pool is observable on
   * EVERY route that can produce one, and it is a NOTICE, never a refusal.
   *
   * `errors.md` § *Agent would be spawned with zero tools* is what forbids the
   * refusal, in one sentence covering two of these routes by name: "Omitting the
   * `tools` field never triggers this refusal. If you leave the `tools` list
   * empty, or `disallowedTools` removes every entry in it, Claude Code also
   * skips the refusal and launches the subagent without tools." P2.202 removed
   * our divergent throw for exactly that reason. The surfacing is the half that
   * row could not land: upstream is silent here and so are we, so a subagent
   * launches that can call nothing, burns a model turn and (on an isolating
   * policy) a worktree lease, and NOTHING says so.
   *
   * The first four arms are the four producers of an empty pool, asserted
   * together because the point of the row is that NO route stays quiet: the one
   * route that had a distinguishable symptom (the plugin-hook producer's false
   * `outcome: 'success'`, P2.273) is the only one anybody could see, and it was
   * fixed at its producer in `e5c85f138`. The other three were never louder than
   * an ordinary allowed admission.
   *
   * The last two arms are controls, and they discriminate different things: a
   * child WITH tools keeps `permission_allowed` and adds no row (the CONDITION
   * is not vacuous), and a DENIED admission adds no row either (the ORDERING is
   * real — the notice sits below the deny throw, and nothing that never ran gets
   * warned about).
   */
  test('records a notice, not a refusal, on every route that admits a child with an empty tool pool', async () => {
    const runAdmission = async (options: {
      requestTools?: string[]
      parentTools?: string[]
      skillDisallowedTools?: string
      deny?: boolean
    }) => {
      const manager = createTestSessionManager()
      const parent: any = {
        id: 'parent-empty-pool',
        workspace: { id: 'workspace-empty-pool', rootPath: process.cwd() },
        permissionMode: 'bypassPermissions',
        thinkingLevel: 'off',
        llmConnection: 'pi',
        model: 'm',
        messages: [],
        childSessionState: undefined,
        messagesLoaded: true,
        // A parent that is itself a child. `model` must agree with the request's
        // or the port refuses earlier, at the parent model ceiling.
        ...(options.parentTools ? {
          piChildRestrictions: {
            prompt: 'parent', model: 'm', tools: options.parentTools,
            worktreePolicy: 'shared', thinkingLevel: 'off',
          },
        } : {}),
      }
      ;(manager as any).sessions.set(
        encodeSessionKey({ workspaceId: parent.workspace.id, sessionId: parent.id }),
        parent,
      )
      ;(manager as any).persistSession = () => {}
      const events: any[] = []
      ;(manager as any).sendEvent = (event: any) => { events.push(event) }
      ;(manager as any).startPiChildRuntime = async () => ({
        childSessionKey: { workspaceId: parent.workspace.id, sessionId: 'child-empty-pool' },
        transcriptId: 'child-empty-pool', status: 'completed', output: 'done', result: 'done',
      })
      const view: any = {
        generation: 'g-empty-pool',
        sources: [], mcpServers: [], hooks: [], automations: [], agents: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
        skills: options.skillDisallowedTools
          ? [{
              key: 'skill://blocker', logicalName: 'blocker', selectedAsUnqualifiedAlias: true,
              resource: { source: 'workspace', resourceId: 'blocker', contentHash: 'e'.repeat(64) },
            }]
          : [],
      }
      const port = await (manager as any).createPiChildSessionPort(
        parent,
        {
          view,
          projectTrustState: 'trusted',
          materializer: {
            assertActive() {},
            async readText() {
              return `---\ndisallowed-tools: ${options.skillDisallowedTools ?? ''}\n---\nBlock.`
            },
          },
        },
        options.deny
          ? { authorize: async () => ({ outcome: 'deny', decisionId: 'decision-deny', reason: 'nope' }) }
          : allowAgentAdmission,
        async () => {}, async () => {}, async () => {},
      )
      const start = port.start({
        requestedAgentId: 'agent-empty-pool', agent: 'scout', task: 'inspect', background: false,
        restrictions: {
          prompt: 'p', model: 'm', worktreePolicy: 'shared', thinkingLevel: 'off',
          ...(options.requestTools ? { tools: options.requestTools } : {}),
          ...(options.skillDisallowedTools ? { skillKeys: ['skill://blocker'] } : {}),
        },
        budgets: {
          depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
          costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [],
        },
      })
      if (options.deny) await expect(start).rejects.toThrow('nope')
      else await start
      const receipts = parent.piExecutionReceipts.snapshot()
      manager.cleanup()
      return { receipt: receipts.at(-1), notices: parent.messages, events }
    }

    // Route 1 — the pool arrives empty from the CALLER. This is the spawner's
    // `disallowedTools` filter (`spawner.ts` `allowedTools`) removing every
    // entry, and equally an author who wrote `tools: []`. It is the second
    // clause of the sentence quoted above, and it was live before P2.202 ever
    // touched anything.
    const fromRequest = await runAdmission({ requestTools: [] })
    expect(fromRequest.receipt).toMatchObject({
      semanticId: 'agent-admission', outcome: 'success', code: 'agent_admitted_without_tools',
    })
    expect(fromRequest.notices).toHaveLength(1)
    expect(fromRequest.notices[0]).toMatchObject({ role: 'info', infoLevel: 'warning', errorCode: 'agent_empty_tool_pool' })
    expect(fromRequest.notices[0].content).toContain('its own tool list is empty')
    // The notice reaches the live client too, not only the persisted transcript.
    expect(fromRequest.events.some((event: any) => event.type === 'info'
      && String(event.message).includes('empty tool pool'))).toBe(true)

    // Route 2 — the PARENT's ceiling is itself empty, so the narrow-only
    // inheritance has nothing to hand down.
    const fromParentCeiling = await runAdmission({ parentTools: [] })
    expect(fromParentCeiling.receipt).toMatchObject({ code: 'agent_admitted_without_tools' })
    expect(fromParentCeiling.notices[0].content).toContain('the parent session has an empty tool ceiling')

    // Route 3 — request and parent ceiling are each non-empty and DISJOINT, so
    // the intersection empties. Nothing upstream refuses this either.
    const fromIntersection = await runAdmission({ requestTools: ['read'], parentTools: ['write'] })
    expect(fromIntersection.receipt).toMatchObject({ code: 'agent_admitted_without_tools' })
    expect(fromIntersection.notices[0].content).toContain('nothing in common')

    // Route 4 — an invoked skill's `disallowed-tools` removes the last entry at
    // the host-side chokepoint (`skills.md` § `disallowed-tools`). P2.302 called
    // this one "writes no receipt at all"; measured, it writes the SAME
    // `agent-admission` receipt every route writes — what it wrote nothing about
    // was the empty pool. The row's point is unaffected; its wording is.
    // Both sides of the match are canonicalised by `parseSkillToolEntry`, which
    // is why frontmatter `Read` removes a ceiling entry spelled `read`.
    const fromSkillDenial = await runAdmission({ requestTools: ['read'], skillDisallowedTools: 'Read' })
    expect(fromSkillDenial.receipt).toMatchObject({ code: 'agent_admitted_without_tools' })
    expect(fromSkillDenial.notices[0].content).toContain('disallowed-tools')

    // The control. A child that CAN act keeps the admission code it always had
    // and adds no row — so the four assertions above discriminate rather than
    // firing on every admission.
    const withTools = await runAdmission({ requestTools: ['read'] })
    expect(withTools.receipt).toMatchObject({
      semanticId: 'agent-admission', outcome: 'success', code: 'permission_allowed',
    })
    expect(withTools.notices).toHaveLength(0)

    // The second control, for the ORDERING claim rather than the condition: a
    // child that was DENIED spends no turn and takes no lease, so there is
    // nothing to warn about and the denial is its own louder surface. The
    // notice sits below the deny throw for exactly this reason, and an
    // assertion is cheaper than trusting statement order.
    const denied = await runAdmission({ requestTools: [], deny: true })
    expect(denied.receipt).toMatchObject({
      semanticId: 'agent-admission', outcome: 'denied', code: 'permission_denied',
    })
    expect(denied.notices).toHaveLength(0)
  })

  /**
   * skills.md, "Inject dynamic context" — "The `` !`<command>` `` syntax runs
   * shell commands before the skill content is sent to Claude … This is
   * preprocessing, not something Claude executes."
   *
   * THE forked route. A skill body that drives a child session goes around the
   * invoking turn's pinned-instruction formatter entirely, so a substitution
   * implemented inside that formatter leaves this path shipping the literal
   * `` !`gh pr diff` `` — and the page's own `pr-summary`, which is BOTH forked
   * (`context: fork`) and placeholder-bearing, is exactly that case. The
   * substitution therefore lives below the branch, in
   * `formatRuntimeSkillInvocation`'s rendered-body parameter, and both routes
   * fill it from the one renderer.
   *
   * The plugin-runtime gate rides along unchanged: the second skill here has no
   * bundle and keeps its placeholder literal, which is also the positive control
   * for the substituted one.
   */
  test('substitutes skill placeholders in a child session prompt, and only for a plugin skill', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent-fork', workspace: { id: 'workspace-fork', rootPath: process.cwd() }, permissionMode: 'default',
      thinkingLevel: 'off', llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
      isProcessing: true,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-fork', sessionId: 'parent-fork' }), parent)
    const materializer = {
      assertActive() {},
      readText: async (resource: any) => resource.resourceId === 'forked'
        ? '---\ncontext: fork\nagent: reviewer\n---\n- PR diff: !`gh pr diff`\n- Files: !`gh pr diff --name-only`'
        : resource.resourceId === 'native'
          ? 'NATIVE body !`gh pr diff`'
          : 'Pinned reviewer instructions.',
    } as any
    const view: any = {
      generation: 'g1', sources: [], mcpServers: [], hooks: [], automations: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [],
      skills: [
        {
          key: 'skill://forked', logicalName: 'forked', selectedAsUnqualifiedAlias: true,
          resource: { pluginInstanceId: 'plugin://market/pr@1#hash', resourceId: 'forked', relativePath: 'skills/pr/SKILL.md', contentHash: 'b'.repeat(64) },
          pluginRuntime: { rootPath: '/plugin', dataPath: '/plugin-data', bundleHash: 'c'.repeat(64), profile: 'generic-plugin-env-v1' },
        },
        {
          key: 'skill://native', logicalName: 'native', selectedAsUnqualifiedAlias: true,
          resource: { source: 'workspace', resourceId: 'native', contentHash: 'd'.repeat(64) },
        },
      ],
      agents: [{
        key: 'agent://reviewer', name: 'reviewer', description: 'Pinned reviewer', selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'workspace' }, model: 'pinned-model',
        tools: ['Glob', 'Grep', 'ListFiles', 'ReadFile'],
        skillKeys: ['skill://forked', 'skill://native'], mcpServerKeys: [],
      }],
    }
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    const commands: string[] = []
    ;(manager as any).runtimeSkillContextExecutor = () => async (request: any) => {
      commands.push(request.command)
      return `<${request.command}>`
    }
    const port = await (manager as any).createPiChildSessionPort(
      parent, { view, materializer }, allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    let admitted: any
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record
      return {
        childSessionKey: { workspaceId: 'workspace-fork', sessionId: 'child-1' }, transcriptId: 'child-1',
        status: 'completed', output: 'done', result: 'done',
      }
    }

    await port.start({
      requestedAgentId: 'agent-1', agent: 'reviewer', task: 'summarize', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        model: 'pinned-model', tools: ['find', 'grep', 'ls', 'read'],
        worktreePolicy: 'shared', thinkingLevel: 'off',
        capabilityGeneration: 'g1', definitionKey: definition!.key, definitionDigest: definition!.definitionDigest,
        skillKeys: ['skill://forked', 'skill://native'], mcpServerKeys: [],
      },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })

    // Every placeholder in the plugin skill ran, with the backticks stripped —
    // the string an `allowed-tools: Bash(gh *)` rule has to match.
    expect(commands).toEqual(['gh pr diff', 'gh pr diff --name-only'])
    expect(admitted.restrictions.prompt).toContain('- PR diff: <gh pr diff>')
    expect(admitted.restrictions.prompt).toContain('- Files: <gh pr diff --name-only>')
    // The skill without a plugin bundle is untouched: nothing ran for it, and
    // its literal placeholder is still there.
    expect(admitted.restrictions.prompt).toContain('NATIVE body !`gh pr diff`')
    manager.cleanup()
  })

  /**
   * sub-agents.md:523-527 — a `memory:` agent gets the directory, the
   * `MEMORY.md` excerpt and Read/Write/Edit at spawn.
   *
   * Deliberately a NON-BUILTIN agent with `toolset: read-only`. A builtin
   * carries no `definitionKey`, so the pinned-tools re-validation is SKIPPED for
   * it — a test written against `scout` passes whether or not the grant survives
   * that check, which is exactly how the obvious spawner-side implementation
   * (union read/write/edit into `allowedTools`) would look green while failing
   * closed with `runtime-agent-tool-unavailable:write` on every real imported
   * subagent bundle.
   */
  test('provisions per-agent memory for a pinned read-only agent and refuses a forged scope', async () => {
    const manager = createTestSessionManager()
    const projectRoot = mkdtempSync(join(tmpdir(), 'nessy-agent-memory-host-'))
    try {
      const parent: any = {
        id: 'parent-memory', workspace: { id: 'workspace-memory', rootPath: process.cwd() },
        workingDirectory: projectRoot,
        permissionMode: 'default', thinkingLevel: 'off',
        llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
      }
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-memory', sessionId: 'parent-memory' }), parent)
      const materializer = {
        assertActive() {},
        readText: async () => '---\nmemory: project\ntools: ReadFile, Grep, ListFiles, Glob\n---\nPinned reviewer instructions.',
      } as any
      const view: any = {
        generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [],
        promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
        agents: [{
          key: 'agent://reviewer', name: 'reviewer', description: 'Pinned reviewer',
          selectedAsUnqualifiedAlias: true, instructionsResource: { source: 'workspace' },
        }],
      }
      const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
      expect(definition!.memory).toBe('project')
      // The precondition the whole case rests on: the AUTHOR declared a
      // read-only tool list, so `write`/`edit` are not in the pinned set the
      // host re-validates against.
      expect(definition!.tools).toEqual(['ReadFile', 'Grep', 'ListFiles', 'Glob'])

      const memoryDir = join(projectRoot, '.nessy-agent', 'agent-memory', 'reviewer')
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory\n\n- SENTINEL_AGENT_MEMORY_ENTRY\n')

      const port = await (manager as any).createPiChildSessionPort(
        parent, { view, materializer }, allowAgentAdmission,
        async () => {}, async () => {}, async () => {},
      )
      const input: any = {
        requestedAgentId: 'agent-memory-1', agent: 'reviewer', task: 'inspect', background: false,
        restrictions: {
          prompt: `Safety core.\n\n${definition!.systemPrompt}`,
          model: 'session-model', tools: ['read', 'grep', 'find', 'ls'],
          worktreePolicy: 'shared', thinkingLevel: 'off',
          capabilityGeneration: 'g1', definitionKey: definition!.key, definitionDigest: definition!.definitionDigest,
          memory: 'project',
        },
        budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
      }

      // A scope the author did not declare cannot be picked at the call site —
      // it would otherwise be a free `write`/`edit` grant for any caller.
      await expect(port.start({ ...input, restrictions: { ...input.restrictions, memory: 'local' } }))
        .rejects.toThrow('runtime-agent-memory-unavailable:local')

      let admitted: any
      ;(manager as any).persistSession = () => {}
      ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
        admitted = record
        return {
          childSessionKey: { workspaceId: 'workspace-memory', sessionId: 'child-memory' },
          transcriptId: 'child-memory', status: 'completed', output: 'done', result: 'done',
        }
      }
      await port.start(input)
      // :527 — the read-only agent CAN now manage its memory files.
      expect(admitted.restrictions.tools).toEqual(['read', 'grep', 'find', 'ls', 'write', 'edit'])
      // :525/:526 — the directory is named and the index is inlined.
      expect(admitted.restrictions.prompt).toContain(memoryDir)
      expect(admitted.restrictions.prompt).toContain('SENTINEL_AGENT_MEMORY_ENTRY')
      // The pinned prompt is still the prefix the admission check validated.
      expect(admitted.restrictions.prompt.startsWith(input.restrictions.prompt)).toBe(true)
      expect(admitted.restrictions.memory).toBe('project')
      // The grant must not relocate the child out of the parent's checkout: a
      // worktree would take the project-scope memory directory with it.
      expect(admitted.restrictions.worktreePolicy).toBe('shared')

      // The builtin route carries no `definitionKey`, so the pinned checks are
      // skipped there — without the builtin arm of the scope check a caller
      // could hand a read-only builtin a scope and collect write/edit with it.
      await expect(port.start({
        requestedAgentId: 'agent-memory-2', agent: 'scout', task: 'inspect', background: false,
        restrictions: {
          prompt: 'Safety core.', model: 'session-model', tools: ['read'],
          worktreePolicy: 'shared', thinkingLevel: 'off', memory: 'user',
        },
        budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
      })).rejects.toThrow('runtime-agent-memory-unavailable:user')

      // Control: an agent that declares no memory is untouched — no directory,
      // no block, no grant, no new restriction key.
      const plainView: any = {
        ...view,
        agents: [{
          key: 'agent://plain', name: 'plain', description: 'Plain reviewer',
          selectedAsUnqualifiedAlias: true, instructionsResource: { source: 'workspace' },
        }],
      }
      const plainMaterializer = {
        assertActive() {},
        readText: async () => '---\ntools: ReadFile, Grep, ListFiles, Glob\n---\nPlain reviewer instructions.',
      } as any
      const [plain] = await materializePiRuntimeAgentDefinitions({ view: plainView, materializer: plainMaterializer })
      const plainPort = await (manager as any).createPiChildSessionPort(
        parent, { view: plainView, materializer: plainMaterializer }, allowAgentAdmission,
        async () => {}, async () => {}, async () => {},
      )
      await plainPort.start({
        requestedAgentId: 'agent-memory-3', agent: 'plain', task: 'inspect', background: false,
        restrictions: {
          prompt: `Safety core.\n\n${plain!.systemPrompt}`,
          model: 'session-model', tools: ['read', 'grep', 'find', 'ls'],
          worktreePolicy: 'shared', thinkingLevel: 'off',
          capabilityGeneration: 'g1', definitionKey: plain!.key, definitionDigest: plain!.definitionDigest,
        },
        budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
      })
      expect(admitted.restrictions.tools).toEqual(['read', 'grep', 'find', 'ls'])
      expect(admitted.restrictions).not.toHaveProperty('memory')
      expect(admitted.restrictions.prompt).toBe(`Safety core.\n\n${plain!.systemPrompt}`)
      expect(existsSync(join(projectRoot, '.nessy-agent', 'agent-memory', 'plain'))).toBe(false)
      manager.cleanup()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  /**
   * R87b — `sub-agents.md` § *Hooks in subagent frontmatter*. Host-side half:
   * the definition's hooks are copied onto the child from the PINNED
   * definition, a call site cannot supply its own, and the `Stop`-converted
   * tier is registered parent-side for exactly the child's lifetime.
   */
  test('carries a subagent\'s frontmatter hooks from the pinned definition and refuses a forged block', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent-hooks', workspace: { id: 'workspace-hooks', rootPath: process.cwd() },
      permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-hooks', sessionId: 'parent-hooks' }), parent)
    const materializer = {
      assertActive() {},
      readText: async () => [
        '---',
        'tools: ReadFile, Grep, ListFiles, Glob',
        'hooks:',
        '  PreToolUse:',
        '    - matcher: Bash',
        '      hooks:',
        '        - type: command',
        '          command: ./check.sh',
        '  Stop:',
        '    - hooks:',
        '        - type: command',
        '          command: ./done.sh',
        '---',
        'Pinned reviewer instructions.',
      ].join('\n'),
    } as any
    const view: any = {
      generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
      agents: [{
        key: 'agent://reviewer', name: 'reviewer', description: 'Pinned reviewer',
        selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'shared-personal', scope: { kind: 'global' } },
      }],
    }
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view, materializer, projectTrusted: false,
    })
    // A user-level definition needs no trust step, so both tiers are pinned.
    expect(definition!.componentHooks?.child?.automations.PreToolUse?.length).toBe(1)
    expect(definition!.componentHooks?.parent?.automations.SubagentStop?.length).toBe(1)

    const port = await (manager as any).createPiChildSessionPort(
      parent, { view, materializer, projectTrustState: 'none' }, allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    const input: any = {
      requestedAgentId: 'agent-hooks-1', agent: 'reviewer', task: 'inspect', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        model: 'session-model', tools: ['read', 'grep', 'find', 'ls'],
        worktreePolicy: 'shared', thinkingLevel: 'off',
        capabilityGeneration: 'g1', definitionKey: definition!.key, definitionDigest: definition!.definitionDigest,
      },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
    }

    // The field decides which COMMANDS run, so unlike `memory` there is no
    // legitimate call-site value at all — a supplied one is refused, not
    // compared.
    await expect(port.start({
      ...input,
      restrictions: {
        ...input.restrictions,
        componentHooks: { child: { automations: { PreToolUse: [{ actions: [{ type: 'command', command: 'curl evil.example' }] }] } } },
      },
    })).rejects.toThrow('runtime-agent-hooks-not-a-call-site-input')

    let admitted: any
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: unknown) => {
      admitted = record
      return {
        childSessionKey: { workspaceId: 'workspace-hooks', sessionId: 'child-hooks' },
        transcriptId: 'child-hooks', status: 'completed', output: 'done', result: 'done',
      }
    }
    await port.start(input)
    // The host's own copy, taken from the pinned definition.
    expect(admitted.restrictions.componentHooks).toEqual(definition!.componentHooks)

    // Parent-side lifetime: registered at SubagentStart, gone once the terminal
    // event has been dispatched.
    await (manager as any).executePiChildStartAutomation(parent, admitted)
    expect(parent.piChildComponentHooks?.get('agent-hooks-1')).toEqual(definition!.componentHooks!.parent)
    await (manager as any).executePiChildTerminalAutomation(parent, 'SubagentStop', admitted)
    expect(parent.piChildComponentHooks?.has('agent-hooks-1')).toBe(false)

    // Control: an agent that declares no hooks gets no key at all, so a record
    // written before the field existed keeps exactly the shape it had.
    const plainView: any = {
      ...view,
      agents: [{
        key: 'agent://plain', name: 'plain', description: 'Plain reviewer',
        selectedAsUnqualifiedAlias: true,
        instructionsResource: { source: 'shared-personal', scope: { kind: 'global' } },
      }],
    }
    const plainMaterializer = {
      assertActive() {},
      readText: async () => '---\ntools: ReadFile, Grep, ListFiles, Glob\n---\nPlain reviewer instructions.',
    } as any
    const [plain] = await materializePiRuntimeAgentDefinitions({ view: plainView, materializer: plainMaterializer })
    const plainPort = await (manager as any).createPiChildSessionPort(
      parent, { view: plainView, materializer: plainMaterializer, projectTrustState: 'none' }, allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    await plainPort.start({
      requestedAgentId: 'agent-hooks-2', agent: 'plain', task: 'inspect', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${plain!.systemPrompt}`,
        model: 'session-model', tools: ['read', 'grep', 'find', 'ls'],
        worktreePolicy: 'shared', thinkingLevel: 'off',
        capabilityGeneration: 'g1', definitionKey: plain!.key, definitionDigest: plain!.definitionDigest,
      },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] },
    })
    expect(admitted.restrictions).not.toHaveProperty('componentHooks')
    await (manager as any).executePiChildStartAutomation(parent, admitted)
    // `toBe(false)`, not `toBeFalsy()`: an ABSENT map is falsy too, and the map
    // provably exists by here (asserted above for `agent-hooks-1`). The claim is
    // that the plain agent got no key, not that the registry vanished.
    expect(parent.piChildComponentHooks?.has('agent-hooks-2')).toBe(false)
    manager.cleanup()
  })

  test('rejects a nested child model that widens its parent child-session ceiling', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'child-parent', workspace: { id: 'workspace-a', rootPath: process.cwd() }, permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
      piChildRestrictions: {
        prompt: 'parent', model: 'parent-model', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off',
      },
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'child-parent' }), parent)
    const port = await (manager as any).createPiChildSessionPort(
      parent,
      {
        view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [] },
        materializer: { assertActive() {} },
      },
      allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    await expect(port.start({
      requestedAgentId: 'grandchild-1', agent: 'worker', task: 'inspect', background: false,
      restrictions: { prompt: 'p', model: 'other-model', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 2, maxDepth: 3, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })).rejects.toThrow('runtime-agent-parent-model-ceiling-mismatch')
    manager.cleanup()
  })

  test('authorizes direct, workflow, and review children once at the shared host admission boundary', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent-admission',
      workspace: { id: 'workspace-admission', rootPath: process.cwd() },
      permissionMode: 'bypassPermissions',
      thinkingLevel: 'off',
      llmConnection: 'pi',
      childSessionState: undefined,
      messagesLoaded: true,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: parent.workspace.id, sessionId: parent.id }), parent)
    ;(manager as any).persistSession = () => {}
    const starts: string[] = []
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: any) => {
      starts.push(record.agent)
      return {
        childSessionKey: { workspaceId: parent.workspace.id, sessionId: `child-${record.agentId}` },
        transcriptId: `child-${record.agentId}`,
        status: 'completed', output: 'done', result: 'done',
      }
    }
    const permissionContent = JSON.stringify({
      toolRules: [{ pattern: 'subagent', action: 'ask' }],
      permissionDsl: {
        version: 1,
        generation: 'generation-admission',
        rules: [
          { id: 'allow-scout', action: 'allow', match: { kind: 'agent', agent: 'scout' } },
          { id: 'deny-worker', action: 'deny', match: { kind: 'agent', agent: 'worker' } },
          { id: 'ask-reviewer-key', action: 'ask', match: { kind: 'agent', agent: 'builtin:reviewer' } },
        ],
      },
    })
    const view: any = {
      generation: 'generation-admission',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], commands: [], promptCommands: [], apps: [],
      permissionLayers: [{
        key: 'permission::builtin::managed', scope: 'builtin',
        resource: { contentHash: 'd'.repeat(64) },
      }],
    }
    const authorizations: any[] = []
    const approvals: string[] = []
    const authority = createPiPermissionService({
      requestApproval: async request => { approvals.push(request.subject.bindingName); return { allowed: true } },
    })
    const permissionService = {
      authorize: async (request: any) => { authorizations.push(request); return authority.authorize(request) },
    }
    const port = await (manager as any).createPiChildSessionPort(
      parent,
      {
        view,
        projectTrustState: 'trusted',
        materializer: { assertActive() {}, async readText() { return permissionContent } },
      },
      permissionService,
      async () => {}, async () => {}, async () => {},
    )
    const child = (agent: string, requestedAgentId: string) => ({
      requestedAgentId, agent, task: 'inspect', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })

    await port.start(child('scout', 'direct-agent'))
    await expect(port.start(child('worker', 'workflow-agent'))).rejects.toThrow('Agent denied by readable permission policy rule `deny-worker` (managed scope).')
    await port.start(child('reviewer', 'review-agent'))

    expect(authorizations).toHaveLength(3)
    expect(authorizations.map(request => request.canonicalInput)).toEqual([
      { agent: 'scout', agent_key: 'builtin:scout' },
      { agent: 'worker', agent_key: 'builtin:worker' },
      { agent: 'reviewer', agent_key: 'builtin:reviewer' },
    ])
    expect(approvals).toEqual(['builtin:scout', 'builtin:reviewer'])
    expect(starts).toEqual(['scout', 'reviewer'])
    expect(parent.piExecutionReceipts.snapshot().map((receipt: any) => ({ semanticId: receipt.semanticId, outcome: receipt.outcome }))).toEqual([
      { semanticId: 'agent-admission', outcome: 'success' },
      { semanticId: 'agent-admission', outcome: 'denied' },
      { semanticId: 'agent-admission', outcome: 'success' },
    ])
    manager.cleanup()
  })

  test('keeps one PiAgent child port while rebinding every operation to the active turn', async () => {
    const manager = createTestSessionManager()
    const managed: any = {
      id: 'parent-turn-rebind',
      workspace: { id: 'workspace-turn-rebind', rootPath: process.cwd() },
      permissionMode: 'bypassPermissions',
      thinkingLevel: 'off',
      llmConnection: 'pi',
      childSessionState: undefined,
      messagesLoaded: true,
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }), managed)
    ;(manager as any).persistSession = () => {}
    const starts: string[] = []
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: any) => {
      starts.push(record.agent)
      return {
        childSessionKey: { workspaceId: managed.workspace.id, sessionId: `child-${record.agentId}` },
        transcriptId: `child-${record.agentId}`,
        status: 'completed', output: 'done', result: 'done',
      }
    }
    const reads: string[] = []
    const runtime = (generation: string, action: 'ask' | 'deny') => ({
      view: {
        generation,
        sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], commands: [], promptCommands: [], apps: [],
        permissionLayers: [{ key: `permission::${generation}`, scope: 'builtin', resource: { contentHash: generation.padEnd(64, 'a') } }],
      },
      projectTrustState: 'trusted',
      materializer: {
        assertActive() {},
        async readText() {
          reads.push(generation)
          return JSON.stringify({
            permissionDsl: {
              version: 1,
              generation,
              rules: [{ id: `${action}-worker`, action, match: { kind: 'agent', agent: 'worker' } }],
            },
          })
        },
      },
    })
    const requests: string[] = []
    const approvals: string[] = []
    const authority = createPiPermissionService({
      requestApproval: async request => { approvals.push(request.subject.bindingName); return { allowed: true } },
    })
    const permissionService = {
      authorize: async (request: any) => { requests.push(request.subject.manifestGeneration); return authority.authorize(request) },
    }
    const piAgentPort = (manager as any).createPiDelegatingChildSessionPort(managed, permissionService)
    managed.piChildSessionPort = piAgentPort
    const child = (requestedAgentId: string) => ({
      requestedAgentId, agent: 'worker', task: 'inspect', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })

    managed.capabilityRuntime = runtime('turn-1', 'deny')
    await expect(piAgentPort.start(child('turn-1-child'))).rejects.toThrow('Agent denied by readable permission policy rule `deny-worker` (managed scope).')
    managed.capabilityRuntime = undefined
    await expect(piAgentPort.start(child('outside-turn-child'))).rejects.toThrow('pi-child-operation-outside-active-capability-turn')
    managed.capabilityRuntime = runtime('turn-2', 'ask')
    await expect(piAgentPort.start(child('turn-2-child'))).resolves.toMatchObject({ status: 'completed', result: 'done' })

    expect(managed.piChildSessionPort).toBe(piAgentPort)
    expect(reads).toEqual(['turn-1', 'turn-2'])
    expect(requests).toEqual(['turn-1', 'turn-2'])
    expect(approvals).toEqual(['builtin:worker'])
    expect(starts).toEqual(['worker'])
    manager.cleanup()
  })

  test('retains the originating capability authority for a background workflow across turn cleanup', async () => {
    const resolver = createTestCapabilityResolver()
    const manager = createTestSessionManager({ resolver })
    const managed: any = {
      id: 'parent-background-authority',
      workspace: { id: 'workspace-background-authority', rootPath: process.cwd() },
      permissionMode: 'bypassPermissions',
      thinkingLevel: 'off',
      llmConnection: 'pi',
      childSessionState: undefined,
      messagesLoaded: true,
      // R86: a settled BACKGROUND task now routes through `deliverMonitorEvent`,
      // which reads the transcript to apply the before-the-first-user-prompt
      // rule. `ManagedSession.messages` is non-optional and `createManagedSession`
      // always builds it — same reasoning as the two maps below. Empty here, so
      // the completion is HELD rather than starting a turn, which is what this
      // test's authority assertions expect.
      messages: [],
      backgroundTaskOutputs: new Map(),
      // SubagentStop carries the parent's background_tasks[] since 5287fd49, and
      // that projection iterates this map. `createManagedSession` always builds
      // it, so a stub without it is an incomplete parent, not a supported shape.
      backgroundShellCommands: new Map(),
    }
    const sessionKey = encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id })
    ;(manager as any).sessions.set(sessionKey, managed)
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: any) => ({
      childSessionKey: { workspaceId: managed.workspace.id, sessionId: `child-${record.agentId}` },
      transcriptId: `child-${record.agentId}`,
      status: 'completed', output: 'done', result: 'done',
    })

    const hookEvents: Array<{ authority: string; event: string }> = []
    const automation = (authority: string) => (manager as any).trackAgentAutomationSystem(managed, {
      async executeAgentEvent(event: string) {
        hookEvents.push({ authority, event })
        return { matchedCount: 1 }
      },
    })
    const permissionService = createPiPermissionService({})
    managed.piPermissionService = permissionService
    const piAgentPort = (manager as any).createPiDelegatingChildSessionPort(managed, permissionService)
    managed.piChildSessionPort = piAgentPort
    const taskService = new TaskService(
      { workspaceId: managed.workspace.id, sessionId: managed.id },
      undefined,
      (event, taskId) => (manager as any).executePiTaskAutomationEvent(managed, event, taskId),
    )
    ;(manager as any).piTaskServices.set(sessionKey, taskService)

    const turn = async (generation: string, action: 'allow' | 'deny', authority: string) => {
      const snapshot = await resolver.resolve({
        workspaceId: managed.workspace.id,
        sessionId: managed.id,
        enabledSourceNames: [],
        projectTrustState: 'none',
        projectTrustRevision: '',
      })
      const runtime: any = {
        view: {
          generation,
          sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], commands: [], promptCommands: [], apps: [],
          permissionLayers: [{ key: `permission::${generation}`, scope: 'builtin', resource: { contentHash: generation.padEnd(64, 'a') } }],
        },
        projectTrustState: 'trusted',
        materializer: {
          assertActive() {
            if (!resolver.isLeaseActive(snapshot.leaseId)) throw new Error('capability-snapshot-revoked')
          },
          async readText() {
            return JSON.stringify({
              permissionDsl: {
                version: 1,
                generation,
                rules: [{ id: `${action}-worker`, action, match: { kind: 'agent', agent: 'worker' } }],
              },
            })
          },
        },
      }
      const lease = (manager as any).createRetainedCapabilityLease(snapshot.leaseId)
      managed.capabilityRuntime = runtime
      managed.capabilityLeaseId = snapshot.leaseId
      managed.agentAutomationSystem = automation(authority)
      managed.agentAutomationCapabilityLease = lease
      return { runtime, lease }
    }
    const child = (requestedAgentId: string, background: boolean) => ({
      requestedAgentId,
      agent: 'worker',
      task: 'inspect',
      ...(background ? { ownerTaskId: 'owner-workflow-1', backgroundTaskId: 'task-workflow-1' } : {}),
      background,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 3, concurrency: 2, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })

    const turnOne = await turn('turn-1-background', 'allow', 'turn-1')
    await (manager as any).processEvent(managed, {
      type: 'task_backgrounded',
      toolUseId: 'workflow-tool-1',
      taskId: 'task-workflow-1',
      kind: 'workflow',
    })
    await expect(piAgentPort.start(child('background-phase-1', true))).resolves.toMatchObject({
      agentId: 'background-phase-1',
      status: 'completed',
    })
    managed.capabilityRuntime = undefined
    managed.capabilityLeaseId = undefined
    managed.agentAutomationSystem = undefined
    managed.agentAutomationCapabilityLease = undefined
    turnOne.lease.release()

    const turnTwo = await turn('turn-2-foreground', 'deny', 'turn-2')
    await expect(piAgentPort.start(child('foreground-turn-2', false))).rejects.toThrow('Agent denied by readable permission policy rule `deny-worker` (managed scope).')
    await expect(piAgentPort.start(child('background-phase-2', true))).resolves.toMatchObject({
      agentId: 'background-phase-2',
      status: 'completed',
    })
    expect(hookEvents.filter(entry => entry.event === 'SubagentStart')).toEqual([
      { authority: 'turn-1', event: 'SubagentStart' },
      { authority: 'turn-1', event: 'SubagentStart' },
    ])

    managed.capabilityRuntime = undefined
    managed.capabilityLeaseId = undefined
    managed.agentAutomationSystem = undefined
    managed.agentAutomationCapabilityLease = undefined
    turnTwo.lease.release()
    await piAgentPort.sealOwnerTask('owner-workflow-1')
    await (manager as any).processEvent(managed, {
      type: 'task_completed', taskId: 'task-workflow-1', status: 'completed', summary: 'done',
    })
    expect(hookEvents.filter(entry => ['TaskCreated', 'SubagentStart', 'SubagentStop', 'TaskCompleted'].includes(entry.event)))
      .toEqual([
        { authority: 'turn-1', event: 'TaskCreated' },
        { authority: 'turn-1', event: 'SubagentStart' },
        { authority: 'turn-1', event: 'SubagentStop' },
        { authority: 'turn-1', event: 'SubagentStart' },
        { authority: 'turn-1', event: 'SubagentStop' },
        { authority: 'turn-1', event: 'TaskCompleted' },
      ])
    expect(resolver.leaseCount()).toBe(0)
    manager.cleanup()
  })

  test('retains the spawning turn hook authority through background SubagentStop and TaskCompleted', async () => {
    const resolver = createTestCapabilityResolver()
    const manager = createTestSessionManager({ resolver })
    const parent: any = {
      id: 'parent', workspace: { id: 'workspace-a', rootPath: process.cwd() }, permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
      // See the background-workflow case above: the SubagentStop payload reads
      // this map, and a parent stub without it drops the event silently.
      backgroundShellCommands: new Map(),
    }
    const child: any = {
      id: 'child-session', workspace: { id: 'workspace-a' }, messagesLoaded: true,
      messages: [{ role: 'assistant', content: 'child result' }],
      agent: { isProcessing: () => false },
    }
    const key = encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' })
    ;(manager as any).sessions.set(key, parent)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'child-session' }), child)
    ;(manager as any).persistSession = () => {}
    ;(manager as any).startPiChildRuntime = async () => ({
      childSessionKey: { workspaceId: 'workspace-a', sessionId: 'child-session' },
      transcriptId: 'child-session',
      status: 'running',
    })

    const events: string[] = []
    const terminalLeaseStates: boolean[] = []
    let snapshotLeaseId = ''
    const system = (manager as any).trackAgentAutomationSystem(parent, {
      async executeAgentEvent(event: string) {
        events.push(event)
        if (event === 'SubagentStop' || event === 'TaskCompleted') {
          terminalLeaseStates.push(resolver.isLeaseActive(snapshotLeaseId))
        }
        return { matchedCount: 1 }
      },
    })
    const snapshot = await resolver.resolve({
      workspaceId: 'workspace-a', sessionId: 'parent', enabledSourceNames: [],
      projectTrustState: 'none', projectTrustRevision: '',
    })
    snapshotLeaseId = snapshot.leaseId
    const lease = (manager as any).createRetainedCapabilityLease(snapshot.leaseId)
    parent.agentAutomationSystem = system
    parent.agentAutomationCapabilityLease = lease
    const taskService = new TaskService(
      { workspaceId: 'workspace-a', sessionId: 'parent' },
      undefined,
      (event, taskId) => (manager as any).executePiTaskAutomationEvent(parent, event, taskId),
    )
    ;(manager as any).piTaskServices.set(key, taskService)

    const port = await (manager as any).createPiChildSessionPort(
      parent,
      { view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [] }, materializer: inertMaterializer },
      allowAgentAdmission,
      (record: unknown) => (manager as any).executePiChildStartAutomation(parent, record),
      (event: string, record: unknown) => (manager as any).executePiChildTerminalAutomation(parent, event, record),
      async () => {},
    )
    await port.start({
      requestedAgentId: 'agent-1', agent: 'worker', task: 'inspect', ownerTaskId: 'task-1', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })

    parent.agentAutomationSystem = undefined
    parent.agentAutomationCapabilityLease = undefined
    lease.release()
    expect(resolver.leaseCount()).toBe(1)

    await port.sealOwnerTask('task-1')
    await port.monitor('agent-1')
    expect(events).toEqual(['TaskCreated', 'SubagentStart', 'SubagentStop', 'TaskCompleted'])
    expect(terminalLeaseStates).toEqual([true, true])
    expect(resolver.leaseCount()).toBe(0)

    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })

  test('does not let generated preflight cleanup mask the original child admission error', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent-preflight', workspace: { id: 'workspace-a', rootPath: process.cwd() },
      permissionMode: 'default', thinkingLevel: 'off', llmConnection: 'pi', messagesLoaded: true,
    }
    const sessionKey = encodeSessionKey({ workspaceId: 'workspace-a', sessionId: parent.id })
    ;(manager as any).piTaskServices.set(
      sessionKey,
      new TaskService({ workspaceId: 'workspace-a', sessionId: parent.id }),
    )

    const delegating = (manager as any).createPiDelegatingChildSessionPort(parent, allowAgentAdmission)
    await expect(delegating.sealOwnerTask('owner-subagent-preflight-failure')).resolves.toBeUndefined()
    await expect(delegating.sealOwnerTask('owner-workflow-preflight-failure')).resolves.toBeUndefined()

    const direct = await (manager as any).createPiChildSessionPort(
      parent,
      {
        view: {
          generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [],
          agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
        },
        materializer: inertMaterializer,
      },
      allowAgentAdmission,
      async () => {}, async () => {}, async () => {},
    )
    await expect(direct.sealOwnerTask('owner-subagent-preflight-failure'))
      .rejects.toThrow('unknown-owner-task-id:owner-subagent-preflight-failure')
    await manager.cleanup()
  })

  test('publishes a durable restricted child session through the existing session owner', async () => {
    const manager = createTestSessionManager()
    const parent = {
      id: 'parent', workspace: { id: 'workspace-a', rootPath: process.cwd() }, permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    const child = {
      id: 'child-session', workspace: { id: 'workspace-a' }, messagesLoaded: true,
      messages: [{ role: 'assistant', content: 'child result' }],
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), parent)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'child-session' }), child)
    const taskService = new TaskService({ workspaceId: 'workspace-a', sessionId: 'parent' })
    ;(manager as any).piTaskServices.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), taskService)
    ;(manager as any).projectHandleService.resolveHandle = async () => null
    ;(manager as any).createSession = async () => ({ id: 'child-session' })
    ;(manager as any).persistSession = () => {}
    ;(manager as any).sendMessage = async () => {}
    const staleEvents: string[] = []
    await (manager as any).createPiChildSessionPort(parent, {
      view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [] },
      materializer: inertMaterializer,
    }, allowAgentAdmission, async () => {}, async (event: string) => { staleEvents.push(event) }, async () => {})
    const events: string[] = []
    const port = await (manager as any).createPiChildSessionPort(parent, {
      view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [] },
      materializer: inertMaterializer,
    }, allowAgentAdmission, async () => {}, async (event: string) => { events.push(event) }, async () => {})

    const result = await port.start({
      requestedAgentId: 'agent-1', agent: 'worker', task: 'inspect', ownerTaskId: 'task-1', background: false,
      restrictions: { prompt: 'bounded prompt', model: 'model-1', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'high' },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })
    await port.sealOwnerTask('task-1')
    expect(result).toMatchObject({ agentId: 'agent-1', ownerTaskId: 'task-1', status: 'completed', result: 'child result' })
    expect((parent as any).childSessionState.children[0]).toMatchObject({
      agentId: 'agent-1', childSessionKey: { workspaceId: 'workspace-a', sessionId: 'child-session' },
      capabilityView: { generation: 'g1' },
    })
    expect((child as any).piChildRestrictions).toEqual({ prompt: 'bounded prompt', model: 'model-1', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'high' })
    expect(events).toEqual(['SubagentStart', 'SubagentStop'])
    expect(staleEvents).toEqual([])
    expect(taskService.snapshot().tasks).toEqual([expect.objectContaining({ id: 'task-1', status: 'completed' })])
    manager.cleanup()
  })

  test('clamps a child permissionMode request to be no broader than the parent (never broadens)', async () => {
    const runOnce = async (requested: string | undefined) => {
      const manager = createTestSessionManager()
      const parent: any = {
        id: 'parent', workspace: { id: 'workspace-a', rootPath: process.cwd() }, permissionMode: 'default', thinkingLevel: 'off',
        llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
      }
      const child: any = {
        id: 'child-session', workspace: { id: 'workspace-a' }, messagesLoaded: true,
        messages: [{ role: 'assistant', content: 'child result' }],
      }
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), parent)
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'child-session' }), child)
      const taskService = new TaskService({ workspaceId: 'workspace-a', sessionId: 'parent' })
      ;(manager as any).piTaskServices.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), taskService)
      ;(manager as any).projectHandleService.resolveHandle = async () => null
      let capturedMode: string | undefined
      ;(manager as any).createSession = async (_workspaceId: string, options: any) => {
        capturedMode = options.permissionMode
        return { id: 'child-session' }
      }
      ;(manager as any).persistSession = () => {}
      ;(manager as any).sendMessage = async () => {}
      const port = await (manager as any).createPiChildSessionPort(parent, {
        view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [] },
        materializer: inertMaterializer,
      }, allowAgentAdmission, async () => {}, async () => {})
      await port.start({
        requestedAgentId: 'agent-1', agent: 'worker', task: 'inspect', background: false,
        restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off', ...(requested ? { permissionMode: requested } : {}) },
        budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
      })
      manager.cleanup()
      return capturedMode
    }

    // Parent is `default`. A broader request (`bypassPermissions`) clamps DOWN.
    expect(await runOnce('bypassPermissions')).toBe('default')
    // A stricter request (`plan`) is honored as-is (narrowing is allowed; F1.1050: this arm asked for the retired explore).
    expect(await runOnce('plan')).toBe('plan')
    // No request => inherit the parent's mode verbatim.
    expect(await runOnce(undefined)).toBe('default')
  })

  test('normalizes disabled Pi modes on top-level creation, child admission, mutation, and restore', async () => {
    const managedPiPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: ['allow-all', 'auto'],
    })
    const manager = createTestSessionManager({ managedPiPolicy })
    const topLevel = await manager.createSession('workspace-managed-policy', { permissionMode: 'bypassPermissions' })
    expect(topLevel.permissionMode).toBe('acceptEdits')

    const workspaceId = 'workspace-managed-policy'
    const parent: any = {
      id: 'parent', workspace: { id: workspaceId, rootPath: process.cwd() }, permissionMode: 'bypassPermissions',
      thinkingLevel: 'off', llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    const child: any = {
      id: 'child-session', workspace: { id: workspaceId, rootPath: process.cwd() }, permissionMode: 'bypassPermissions',
      piParentSessionKey: { workspaceId, sessionId: parent.id },
      piChildRestrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off', permissionMode: 'bypassPermissions' },
      messagesLoaded: true, messages: [{ role: 'assistant', content: 'child result' }],
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: parent.id }), parent)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: child.id }), child)
    ;(manager as any).projectHandleService.resolveHandle = async () => null
    ;(manager as any).persistSession = () => {}
    ;(manager as any).sendMessage = async () => {}
    let childCreationMode: string | undefined
    ;(manager as any).createSession = async (_workspaceId: string, options: any) => {
      childCreationMode = options.permissionMode
      return { id: child.id }
    }
    const taskService = new TaskService({ workspaceId, sessionId: parent.id })
    ;(manager as any).piTaskServices.set(encodeSessionKey({ workspaceId, sessionId: parent.id }), taskService)
    const port = await (manager as any).createPiChildSessionPort(parent, {
      view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [] },
      materializer: inertMaterializer,
    }, allowAgentAdmission, async () => {}, async () => {}, async () => {})
    await port.start({
      requestedAgentId: 'agent-1', agent: 'worker', task: 'inspect', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off', permissionMode: 'auto' },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })
    expect(childCreationMode).toBe('acceptEdits')

    manager.setSessionPermissionMode(child.id, 'bypassPermissions', workspaceId)
    expect(child.permissionMode).toBe('acceptEdits')

    const restored: any = {
      id: 'restored', workspace: { id: workspaceId, rootPath: process.cwd() }, llmConnection: 'pi',
      permissionMode: 'bypassPermissions', previousPermissionMode: 'auto',
    }
    expect((manager as any).normalizePersistedSessionPermissionMode(restored)).toBe(true)
    expect(restored).toMatchObject({ permissionMode: 'acceptEdits', previousPermissionMode: 'acceptEdits' })
    manager.cleanup()
  })

  test('pins managed policy to a live Pi runtime without changing non-Pi provider resolution', () => {
    const manager = createTestSessionManager({
      managedPiPolicy: parseManagedPiPolicyV1({
        schemaVersion: 1,
        disabledPermissionModes: ['allow-all'],
      }),
    })
    let mutableDefault: 'pi' | 'anthropic' = 'pi'
    ;(manager as any).resolveConfiguredProvider = () => mutableDefault
    const piLive: any = {
      id: 'pi-live', workspace: { id: 'workspace-managed-policy', rootPath: process.cwd() },
      agent: {}, activeProvider: 'pi', permissionMode: 'bypassPermissions',
    }
    mutableDefault = 'anthropic'
    expect((manager as any).resolveManagedProvider(piLive)).toBe('pi')
    expect((manager as any).normalizeSessionPermissionMode(piLive, 'bypassPermissions')).toBe('auto')

    const nonPiLive: any = {
      id: 'non-pi-live', workspace: { id: 'workspace-managed-policy', rootPath: process.cwd() },
      agent: {}, activeProvider: 'anthropic', permissionMode: 'bypassPermissions',
    }
    mutableDefault = 'pi'
    expect((manager as any).resolveManagedProvider(nonPiLive)).toBe('pi')
    expect((manager as any).normalizeSessionPermissionMode(nonPiLive, 'bypassPermissions')).toBe('auto')
    manager.cleanup()
  })

  test('rebuilds cold provider flips before the real factory in managed and send paths', async () => {
    setSessionPlatform(createHeadlessPlatform())
    const managedPiPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: ['allow-all'],
      permissionDsl: {
        version: 1,
        rules: [{
          id: 'deny-rm',
          action: 'deny',
          match: { kind: 'bash', executable: 'rm' },
        }],
      },
    })
    const cases = [
      { snapshotProvider: 'anthropic', finalProvider: 'pi', deniedCapabilityVisible: false, hasManagedDsl: true },
      { snapshotProvider: 'pi', finalProvider: 'anthropic', deniedCapabilityVisible: true, hasManagedDsl: false },
    ] as const

    for (const testCase of cases) {
      for (const flow of ['managed-turn', 'send-message'] as const) {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-provider-flip-'))
        const activeLeases = new Set<string>()
        const releasedLeases: string[] = []
        const resolvedProviders: string[] = []
        let leaseCounter = 0
        const resolver = {
          async resolve(context: any) {
            resolvedProviders.push(context.provider)
            leaseCounter += 1
            const leaseId = `provider-lease-${leaseCounter}`
            activeLeases.add(leaseId)
            return {
              context,
              generation: `provider-${context.provider}-${leaseCounter}`,
              leaseId,
              entries: context.provider === 'pi' ? [] : [{
                summary: {
                  key: 'skill://managed-denied',
                  kind: 'skill',
                  logicalName: 'managed-denied',
                  origin: 'plugin',
                  enabled: true,
                  selectedAsUnqualifiedAlias: true,
                  readOnly: true,
                  trustState: 'trusted',
                  credentialState: 'ready',
                  diagnostics: [],
                  scope: { kind: 'workspace', workspaceId: context.workspaceId },
                },
                runtimeBinding: {
                  kind: 'skill',
                  resource: { source: 'workspace', resourceId: 'managed-denied', contentHash: 'a'.repeat(64) },
                },
              }],
              installedPlugins: [],
              diagnostics: [],
            }
          },
          releaseSnapshot(leaseId: string) {
            if (activeLeases.delete(leaseId)) releasedLeases.push(leaseId)
          },
          invalidate() {},
          isLeaseActive(leaseId: string) { return activeLeases.has(leaseId) },
          referencedInstances() { return new Set() },
          leaseCount() { return activeLeases.size },
        }
        const manager = createTestSessionManager({ resolver: resolver as any, managedPiPolicy })
        const workspace = {
          id: `workspace-${flow}-${testCase.finalProvider}`,
          name: 'Provider flip test',
          rootPath: workspaceRoot,
          createdAt: 1,
        }
        const managed: any = createManagedSession(
          { id: `cold-${flow}-${testCase.finalProvider}`, name: 'Provider flip test', ephemeral: true },
          workspace as never,
          { messagesLoaded: true },
        )
        ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), managed)
        const observedRuntimes: Array<{
          snapshotProvider: string
          factoryProvider: string
          deniedCapabilityVisible: boolean
          hasManagedDsl: boolean
        }> = []
        const factoryProviders: string[] = []
        ;(manager as any).resolveBackendContextForManaged = () => {
          const provider = resolvedProviders.length === 0
            ? testCase.snapshotProvider
            : testCase.finalProvider
          return {
            connection: null,
            provider,
            resolvedModel: `${provider}-model`,
            capabilities: { needsHttpPoolServer: false },
          }
        }
        ;(manager as any).buildAgentAutomationSystem = async (_managed: unknown, runtime: any, provider: string) => {
          observedRuntimes.push({
            snapshotProvider: runtime.provider,
            factoryProvider: provider,
            deniedCapabilityVisible: runtime.view.skills.some((skill: any) => skill.logicalName === 'managed-denied'),
            hasManagedDsl: runtime.managedPermissionDsl?.rules[0]?.id === 'deny-rm',
          })
          // Without the production guard, a factory would receive a mixed
          // snapshot/backend pair and this deterministic test must fail.
          if (runtime.provider !== provider) throw new Error('mixed-provider-capability-runtime')
          return { executeAgentEvent: async () => ({ matchedCount: 0 }) }
        }
        const agent = {
          isProcessing: () => false,
          setAutomationSystem() {},
          setCapabilityTurnRuntime() {},
          drainAutomationEvents: async () => {},
          postInit: async () => ({}),
          setAllSources() {},
          setSourceServers: async () => {},
          getModel: () => 'test-model',
          chat: () => (async function* () {})(),
          getSessionId: () => undefined,
          endLifecycle: async () => {},
          forceAbort() {},
          dispose() {},
        }
        ;(manager as any).createBackendFromManagedContext = (input: any) => {
          // The stale lease must be gone before the final real-factory seam is
          // reached. Removing either retry cleanup path makes this throw.
          if (!releasedLeases.includes('provider-lease-1')) {
            throw new Error('stale-capability-lease-not-released-before-factory')
          }
          factoryProviders.push(input.context.provider)
          return agent
        }
        ;(manager as any).piWorkspaceDrainParticipant = {
          processSupervisorPort: undefined,
          async admitRuntime(input: any) {
            const created = await input.create()
            input.publish(created, { dispose() {} })
          },
          dispose() {},
        }
        ;(manager as any).persistSession = () => {}
        ;(manager as any).flushSession = async () => {}
        ;(manager as any).sendEvent = () => {}
        ;(manager as any).onProcessingStopped = () => { managed.isProcessing = false }

        try {
          if (flow === 'managed-turn') {
            await (manager as any).withCapabilityRuntime(managed, (runtime: any) => (
              (manager as any).getOrCreateAgent(managed, runtime)
            ))
          } else {
            await manager.sendMessage(managed.id, 'exercise cold provider flip', undefined, undefined, undefined, undefined, undefined, undefined, {
              workspaceId: workspace.id,
            })
          }

          expect(resolvedProviders).toEqual([testCase.snapshotProvider, testCase.finalProvider])
          expect(factoryProviders).toEqual([testCase.finalProvider])
          expect(observedRuntimes).toEqual([{
            snapshotProvider: testCase.finalProvider,
            factoryProvider: testCase.finalProvider,
            deniedCapabilityVisible: testCase.deniedCapabilityVisible,
            hasManagedDsl: testCase.hasManagedDsl,
          }])
          expect(releasedLeases).toContain('provider-lease-1')
          expect(resolver.leaseCount()).toBe(0)
        } finally {
          managed.agent = null
          managed.piDrainRegistration = undefined
          try {
            await manager.cleanup()
          } finally {
            rmSync(workspaceRoot, { recursive: true, force: true })
          }
        }
      }
    }
  })

  test('normalizes an imported Pi permission mode before writing its JSONL header', async () => {
    const manager = createTestSessionManager({
      managedPiPolicy: parseManagedPiPolicyV1({
        schemaVersion: 1,
        disabledPermissionModes: ['allow-all', 'auto'],
      }),
    })
    const workspaceId = 'workspace-imported-managed-policy'
    const bundle: SessionBundle = {
      version: 1,
      session: {
        header: {
          id: 'source-session',
          createdAt: 1,
          lastUsedAt: 1,
          messageCount: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
          permissionMode: 'bypassPermissions',
          previousPermissionMode: 'auto',
        },
        messages: [],
      },
      files: [],
    }
    try {
      const imported = await manager.importSession(workspaceId, bundle, 'move')
      const sessionFile = (manager as any).sessionStore.getSessionFilePath({
        workspaceId,
        sessionId: imported.sessionId,
      })
      const persistedHeader = JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]!)
      expect(persistedHeader).toMatchObject({
        permissionMode: 'acceptEdits',
        previousPermissionMode: 'acceptEdits',
      })
    } finally {
      manager.cleanup()
    }
  })

  describe('post-creation child permission-mode clamp (lifetime ceiling)', () => {
    const workspaceId = 'workspace-a'
    const parentKey = { workspaceId, sessionId: 'parent' }

    const setup = (parentMode: string, childMode: string) => {
      const manager = createTestSessionManager()
      const parent: any = {
        id: 'parent', workspace: { id: workspaceId }, permissionMode: parentMode,
        llmConnection: 'pi', messagesLoaded: true, messages: [],
      }
      const child: any = {
        id: 'child-session', workspace: { id: workspaceId }, permissionMode: childMode,
        // Back-reference to the parent + the ceiling the child was created under.
        piParentSessionKey: parentKey,
        piChildRestrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off', permissionMode: childMode },
        messagesLoaded: true, messages: [],
      }
      ;(manager as any).sessions.set(encodeSessionKey(parentKey), parent)
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: 'child-session' }), child)
      ;(manager as any).persistSession = () => {}
      return { manager, parent, child }
    }

    test('RPC setPermissionMode on a child can never broaden past the parent', () => {
      const { manager, child } = setup('default', 'default')
      // A broadening request routed through the RPC funnel clamps DOWN to `default`.
      manager.setSessionPermissionMode('child-session', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('default')
      // A stricter request is still honored (narrowing is allowed).
      manager.setSessionPermissionMode('child-session', 'plan', workspaceId)
      expect(child.permissionMode).toBe('plan')
      manager.cleanup()
    })

    test('re-clamps against the parent CURRENT mode, not a stale creation-time ceiling', () => {
      const { manager, parent, child } = setup('default', 'default')
      // Parent narrows AFTER the child was created.
      parent.permissionMode = 'plan'
      // A child mode change now clamps against the parent's CURRENT `plan`, not
      // the stale `default` — a broader `auto` request resolves to `plan`.
      manager.setSessionPermissionMode('child-session', 'auto', workspaceId)
      expect(child.permissionMode).toBe('plan')
      manager.cleanup()
    })

    // F1.259 — the `acceptPlan force-set on a safe child` arm left with `acceptPlan` (deleted: no production caller,
    // and its non-Pi branch switched explore to bypass). The force-set it drove is gone; the clamp it measured is the
    // funnel's own, pinned above by 'RPC setPermissionMode on a child can never broaden past the parent'.

    test('leaves a non-child (parentless) session mode change unclamped', () => {
      const manager = createTestSessionManager()
      const solo: any = {
        id: 'solo', workspace: { id: workspaceId }, permissionMode: 'plan',
        llmConnection: 'pi', messagesLoaded: true, messages: [],
      }
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: 'solo' }), solo)
      ;(manager as any).persistSession = () => {}
      manager.setSessionPermissionMode('solo', 'bypassPermissions', workspaceId)
      expect(solo.permissionMode).toBe('bypassPermissions')
      manager.cleanup()
    })

    test('falls back to the created-under ceiling when the parent record is gone', () => {
      const manager = createTestSessionManager()
      const child: any = {
        id: 'orphan-child', workspace: { id: workspaceId }, permissionMode: 'default',
        // Parent no longer resolvable; the stored restriction ceiling still bounds it.
        piParentSessionKey: parentKey,
        piChildRestrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off', permissionMode: 'default' },
        llmConnection: 'pi', messagesLoaded: true, messages: [],
      }
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: 'orphan-child' }), child)
      ;(manager as any).persistSession = () => {}
      manager.setSessionPermissionMode('orphan-child', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('default')
      manager.cleanup()
    })

    // UA12.165 (RS-113 R2 on RC2) — the rehydrate dispatch spawns the resumed child under the run's
    // recorded bypass (UA12.152's broader-of), and 121 ms later the child's applied mode is routed
    // through this funnel again: the parent clamp read only the orchestrator's LIVE mode — demoted to
    // the start mode by the resume table at load (`auto`, changedBy=restore) — and rewrote the child
    // to `auto` (changedBy=user); its Bash card was never answered and the resumed run wedged. The
    // ceiling for a LIVE run node is floored at the run-log's recorded orchestrator mode — the same
    // broader-of rule the dispatch uses, never a cap (a post-restart raise still propagates).
    const runNodeSetup = (writeRunLog: (root: string) => void) => {
      const root = mkdtempSync(join(tmpdir(), 'nessy-ua12165-'))
      const manager = createTestSessionManager()
      // The orchestrator as the restart left it: the resume table already demoted its persisted
      // bypass to the new-session start mode (`auto`), the documented load-time behaviour — kept.
      const parent: any = {
        id: 'orch', workspace: { id: workspaceId, rootPath: root }, permissionMode: 'auto',
        llmConnection: 'pi', messagesLoaded: true, messages: [],
      }
      // The re-dispatched child: created with the run's recorded mode and the run keys the dispatch
      // sets (CreateSessionOptions taskSlug/taskRunId/taskNodeId + parentSessionId).
      const child: any = {
        id: 'node-child', workspace: { id: workspaceId, rootPath: root }, permissionMode: 'bypassPermissions',
        parentSessionId: 'orch', taskSlug: 'rec-task', taskRunId: 'r1', taskNodeId: 'b',
        messagesLoaded: true, messages: [],
      }
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: 'orch' }), parent)
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: 'node-child' }), child)
      ;(manager as any).persistSession = () => {}
      writeRunLog(root)
      return { manager, child }
    }
    const T12165 = '2026-10-04T10:57:00.000Z'

    test('a live run node keeps the run-log\'s recorded grant against the parent\'s restart-demoted live mode', () => {
      const { manager, child } = runNodeSetup(root => {
        // The run-log UA12.152's recording writes: run-started + node-spawned both carry the
        // orchestrator's mode; the LAST carrier is the grant this dispatch ran under.
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'run-started', taskId: 'rec-task', runId: 'r1', orchestratorSessionId: 'orch', permissionMode: 'bypassPermissions' })
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'node-scheduled', nodeId: 'b' })
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'node-spawned', nodeId: 'b', sessionId: 'node-child', permissionMode: 'bypassPermissions' })
      })
      // The sitting's second write (121 ms after the dispatch set the child to bypassPermissions):
      // the applied mode must NOT fall below the run's recorded mode while the run is live.
      manager.setSessionPermissionMode('node-child', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('bypassPermissions')
      manager.cleanup()
    })

    test('UA12.165 control: once the run log ends terminally the ordinary parent ceiling returns', () => {
      const { manager, child } = runNodeSetup(root => {
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'run-started', taskId: 'rec-task', runId: 'r1', orchestratorSessionId: 'orch', permissionMode: 'bypassPermissions' })
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'node-spawned', nodeId: 'b', sessionId: 'node-child', permissionMode: 'bypassPermissions' })
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'node-finished', nodeId: 'b', sessionId: 'node-child', state: 'done' })
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'run-completed' })
      })
      // The run is over: the recorded grant is stale, and the clamp is the documented lifetime
      // ceiling again — the child cannot sit above its orchestrator's live mode.
      manager.setSessionPermissionMode('node-child', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('auto')
      manager.cleanup()
    })

    test('UA12.165 boundary: a run log with no recorded mode (pre-UA12.152) clamps to the live parent as before', () => {
      const { manager, child } = runNodeSetup(root => {
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'run-started', taskId: 'rec-task', runId: 'r1', orchestratorSessionId: 'orch' })
        appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'node-spawned', nodeId: 'b', sessionId: 'node-child' })
      })
      manager.setSessionPermissionMode('node-child', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('auto')
      manager.cleanup()
    })

    // UA12.171 (CRITICAL, 2026-10-08 verification) — UA12.165's floor cannot tell the restart demotion from a
    // user's DELIBERATE lower: while the run is live the recorded carrier kept flooring the child at the run's
    // grant, so lowering the orchestrator no longer capped what a running subtask could switch to (KNOWN item 2,
    // permissions.md, board/tasks.md, resources/docs/board.md). A deliberate change of an orchestrator with a
    // live run is now RECORDED in the run log (`mode-changed`), so the recorded ceiling follows the user; the
    // restart demotion records nothing, so UA12.165's arm keeps its grant.
    const liveOrchestratorSetup = (orchestratorMode: string) => {
      const root = mkdtempSync(join(tmpdir(), 'nessy-ua12171-'))
      const manager = createTestSessionManager()
      // The orchestrator of a LIVE run (bound to the task: taskSlug, no taskNodeId) in its granted mode.
      const parent: any = {
        id: 'orch', workspace: { id: workspaceId, rootPath: root }, permissionMode: orchestratorMode,
        taskSlug: 'rec-task', llmConnection: 'pi', messagesLoaded: true, messages: [],
      }
      const child: any = {
        id: 'node-child', workspace: { id: workspaceId, rootPath: root }, permissionMode: 'bypassPermissions',
        parentSessionId: 'orch', taskSlug: 'rec-task', taskRunId: 'r1', taskNodeId: 'b',
        messagesLoaded: true, messages: [],
      }
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: 'orch' }), parent)
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: 'node-child' }), child)
      ;(manager as any).persistSession = () => {}
      appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'run-started', taskId: 'rec-task', runId: 'r1', orchestratorSessionId: 'orch', permissionMode: 'bypassPermissions' })
      appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'node-scheduled', nodeId: 'b' })
      appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'node-spawned', nodeId: 'b', sessionId: 'node-child', permissionMode: 'bypassPermissions' })
      const runLog = () => readFileSync(join(root, 'tasks', 'rec-task', 'runs', 'r1', 'run-log.jsonl'), 'utf-8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line))
      return { manager, parent, child, root, runLog }
    }

    test('UA12.171: a deliberate mid-run lower of the orchestrator caps a running node\'s next mode change', () => {
      const { manager, parent, child, runLog } = liveOrchestratorSetup('bypassPermissions')
      // The user lowers the orchestrator bypass → default while the run is live (the RPC funnel).
      manager.setSessionPermissionMode('orch', 'default', workspaceId)
      expect(parent.permissionMode).toBe('default')
      // Probe: the running node's next change asks for bypass again — capped at the lowered orchestrator.
      manager.setSessionPermissionMode('node-child', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('default')
      // The lower is recorded in the live run's log as the newest carrier.
      expect(runLog().filter(e => e.kind === 'mode-changed')).toEqual([expect.objectContaining({ permissionMode: 'default' })])
      manager.cleanup()
    })

    test('UA12.171: a raise after the lower is honoured up to the new mode, never above it', () => {
      const { manager, child, runLog } = liveOrchestratorSetup('bypassPermissions')
      manager.setSessionPermissionMode('orch', 'default', workspaceId)
      manager.setSessionPermissionMode('orch', 'acceptEdits', workspaceId)
      manager.setSessionPermissionMode('node-child', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('acceptEdits')
      expect(runLog().filter(e => e.kind === 'mode-changed').map(e => e.permissionMode)).toEqual(['default', 'acceptEdits'])
      // Below the new ceiling a node's own narrower request is still honoured.
      manager.setSessionPermissionMode('node-child', 'plan', workspaceId)
      expect(child.permissionMode).toBe('plan')
      manager.cleanup()
    })

    test('UA12.171 boundary: the restart demotion records nothing, so the run keeps its recorded grant', () => {
      const { manager, parent, child, runLog } = liveOrchestratorSetup('bypassPermissions')
      const before = runLog().length
      // The load-time resume table (P6.492) demotes the persisted bypass to the new-session start mode — the
      // UA12.165 restart case. It is a restore, not a deliberate change, and must not write a carrier.
      ;(manager as any).normalizePersistedSessionPermissionMode(parent)
      expect(parent.permissionMode).not.toBe('bypassPermissions')
      expect(runLog()).toHaveLength(before)
      expect(runLog().some(e => e.kind === 'mode-changed')).toBe(false)
      manager.setSessionPermissionMode('node-child', 'bypassPermissions', workspaceId)
      expect(child.permissionMode).toBe('bypassPermissions')
      manager.cleanup()
    })

    test('UA12.171 control: a mode change of an orchestrator whose run has ended writes nothing to that log', () => {
      const { manager, root, runLog } = liveOrchestratorSetup('bypassPermissions')
      appendRunLog(root, 'rec-task', 'r1', { t: T12165, kind: 'run-completed' })
      const before = runLog().length
      manager.setSessionPermissionMode('orch', 'default', workspaceId)
      expect(runLog()).toHaveLength(before)
      manager.cleanup()
    })
  })

  test('persists the parent back-reference on the child managed record at creation', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent', workspace: { id: 'workspace-a', rootPath: process.cwd() }, permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    const child: any = {
      id: 'child-session', workspace: { id: 'workspace-a' }, messagesLoaded: true,
      messages: [{ role: 'assistant', content: 'child result' }],
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), parent)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'child-session' }), child)
    const taskService = new TaskService({ workspaceId: 'workspace-a', sessionId: 'parent' })
    ;(manager as any).piTaskServices.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), taskService)
    ;(manager as any).projectHandleService.resolveHandle = async () => null
    ;(manager as any).createSession = async () => ({ id: 'child-session' })
    ;(manager as any).persistSession = () => {}
    ;(manager as any).sendMessage = async () => {}
    const port = await (manager as any).createPiChildSessionPort(parent, {
      view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [] },
      materializer: inertMaterializer,
    }, allowAgentAdmission, async () => {}, async () => {})
    await port.start({
      requestedAgentId: 'agent-1', agent: 'worker', task: 'inspect', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1000, ancestry: [] },
    })
    // The child records its spawning parent so post-creation mode changes have a
    // live back-reference to re-clamp against.
    expect((child as any).piParentSessionKey).toEqual({ workspaceId: 'workspace-a', sessionId: 'parent' })
    manager.cleanup()
  })

  test('keeps child construction on SessionManager and the canonical X4B Pi admission path', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const childStart = source.slice(source.indexOf('private async startPiChildRuntime('), source.indexOf('private createPiChildSessionPort('))
    expect(childStart).toContain('this.createSession(')
    expect(childStart).toContain('this.runPiChildTurn(')
    expect(childStart).not.toContain('createPiRuntimeSession')
    const managedFactory = source.slice(source.indexOf('private async getOrCreateAgent('), source.indexOf('private async generateRemoteTransferSummary('))
    expect(managedFactory).toContain('this.piWorkspaceDrainParticipant.admitRuntime')
    expect(managedFactory).toContain('childSessionPort: piChildSessionPort')
  })

  test('every temporary-agent construction site post-inits before it queries the model', () => {
    // postInit is what injects a connection's auth — and, for `claude-runtime`,
    // what starts the local adapter the SDK must talk to instead of
    // api.anthropic.com. A construction site that skips it silently resolves
    // ANTHROPIC_BASE_URL from the ambient process environment. The transfer
    // summary was that site: it built an agent and called runMiniCompletion with
    // no postInit at all.
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const summaryFactory = source.slice(
      source.indexOf('private async generateRemoteTransferSummary('),
      source.indexOf('async exportRemoteSessionTransfer('),
    )
    const postInit = summaryFactory.indexOf('await agent.postInit()')
    const query = summaryFactory.indexOf('agent.runMiniCompletion.bind(agent)')
    expect(postInit).toBeGreaterThan(-1)
    expect(query).toBeGreaterThan(-1)
    expect(postInit).toBeLessThan(query)
    // Inside the try, so the existing `finally` still disposes on failure.
    expect(summaryFactory.indexOf('try {', summaryFactory.indexOf('summary-agent-construction-did-not-publish')))
      .toBeLessThan(postInit)
  })

  test('publishes an isolated worktree lease through X4B before child construction and drains it by opaque lease id', async () => {
    const manager = createTestSessionManager()
    const parent: any = {
      id: 'parent', workspace: { id: 'workspace-a', rootPath: '/workspace' }, permissionMode: 'default', thinkingLevel: 'off',
      llmConnection: 'pi', childSessionState: undefined, messagesLoaded: true,
    }
    const child: any = {
      id: 'child-session', workspace: { id: 'workspace-a' }, messagesLoaded: true,
      messages: [{ role: 'assistant', content: 'done' }],
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), parent)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'child-session' }), child)
    let released = 0
    const lease = {
      schemaVersion: 1, worktreeLeaseId: 'worktree-agent-1', workspaceId: 'workspace-a', ownerAgentId: 'agent-1',
      path: '/worktrees/agent-1', branch: 'nessy/agent-1/worktree-agent-1', baseSha: 'abc', status: 'active',
    }
    const worktreeService = {
      recover: async () => [],
      acquire: async () => lease,
      release: async (id: string) => { expect(id).toBe('worktree-agent-1'); released += 1 },
      notifyCreated: async () => {},
    }
    ;(manager as any).createPiWorktreeLeaseService = () => {
      ;(manager as any).piWorktreeLeaseServices.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'parent' }), worktreeService)
      return worktreeService
    }
    ;(manager as any).projectHandleService.validateProjectDirectory = async (_workspaceId: string, path: string) => {
      expect(path).toBe('/worktrees/agent-1')
      return { id: 'worktree-project' }
    }
    // A bound parent project: the real lease authority (`worktreeAuthority`)
    // refuses a project-less session, and since W3 the derived
    // isolated-worktree default DEGRADES to `shared` there before a lease is
    // ever requested — so a fixture that acquires a lease must model the
    // project-bound shape. The child's own handle still comes from
    // `validateProjectDirectory` over the lease path, asserted below.
    ;(manager as any).projectHandleService.resolveHandle = async () => (
      { id: 'parent-project', canonicalPath: '/workspace' }
    )
    let projectHandleId: string | undefined
    ;(manager as any).createSession = async (_workspaceId: string, options: any) => {
      projectHandleId = options.projectHandleId
      return { id: 'child-session' }
    }
    ;(manager as any).persistSession = () => {}
    ;(manager as any).sendMessage = async () => {}
    const port = await (manager as any).createPiChildSessionPort(parent, {
      view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [] },
      materializer: inertMaterializer,
    }, allowAgentAdmission, async () => {}, async () => {})

    const result = await port.start({
      requestedAgentId: 'agent-1', agent: 'worker', task: 'edit', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: ['read', 'write'], worktreePolicy: 'isolated-worktree', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1_000, ancestry: [] },
    })
    expect(result).toMatchObject({ agentId: 'agent-1', worktreeLeaseId: 'worktree-agent-1' })
    expect(projectHandleId).toBe('worktree-project')
    const drainLease = await (manager as any).workspaceQuiescence.acquire('workspace-a')
    expect(released).toBe(1)
    await drainLease.release()
    manager.cleanup()
  })

  test('enforces the durable child deadline and token/cost ceilings at the existing session owner', async () => {
    const manager = createTestSessionManager()
    const child: any = {
      id: 'child', workspace: { id: 'workspace-a' }, messagesLoaded: true,
      messages: [{ role: 'assistant', content: 'result' }], tokenUsage: { inputTokens: 60, outputTokens: 41, totalTokens: 101, costUsd: 0 },
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-a', sessionId: 'child' }), child)
    ;(manager as any).sendMessage = async () => {}
    let cancellations = 0
    ;(manager as any).cancelProcessing = async () => { cancellations += 1 }
    const base = { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 1_000, ancestry: [] }
    const run = (budgets: typeof base) => (manager as any).runPiChildTurn(
      { workspaceId: 'workspace-a', sessionId: 'parent' }, 'agent-1',
      { workspaceId: 'workspace-a', sessionId: 'child' }, 'work', budgets,
    )
    expect(await run(base)).toMatchObject({ status: 'failed', error: 'child-session-token-budget-exceeded' })
    child.tokenUsage = { inputTokens: 1, outputTokens: 0, totalTokens: 1, costUsd: 2 }
    expect(await run(base)).toMatchObject({ status: 'failed', error: 'child-session-cost-budget-exceeded' })
    expect(await run({ ...base, deadlineAt: Date.now() - 1 })).toMatchObject({ status: 'interrupted', error: 'child-session-deadline-exceeded' })
    expect(cancellations).toBe(1)
    manager.cleanup()
  })

  test('resolves a fresh child generation and intersects it with the durable parent capability ceiling', async () => {
    const manager = createTestSessionManager()
    const app = (key: string) => ({
      summary: { key, enabled: true, trustState: 'trusted', unavailableReason: undefined },
      runtimeBinding: { kind: 'app', app: { key, mcpServerKeys: [] } },
    })
    ;(manager as any).capabilityResolver = {
      resolve: async (context: any) => ({ context, generation: `child:${context.sessionId}`, leaseId: 'lease-child', entries: [app('shared'), app('child-only')], installedPlugins: [], diagnostics: [] }),
      releaseSnapshot: () => {}, invalidate: () => {}, isLeaseActive: () => true,
    }
    const child: any = {
      id: 'child-session', workspace: { id: 'workspace-a' }, messagesLoaded: true,
      piChildCapabilityGeneration: 'parent:parent-session',
      piChildCapabilityView: { generation: 'parent:parent-session', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [{ key: 'shared', mcpServerKeys: [] }] },
    }
    const turn = await (manager as any).createCapabilityTurn(child)
    expect(turn.runtime.view.generation).toBe('child:child-session')
    expect(turn.runtime.view.apps.map((value: any) => value.key)).toEqual(['shared'])
    expect(turn.runtime.piExecutionManifestSeed.provenance.map((value: any) => value.capabilityKey)).toEqual(['shared'])
    // T1: no gateway `fast`-aliased connection resolves here, so the small-tier
    // default is omitted (today's behavior) — the seed carries no tierModelMap.
    expect(turn.runtime.piExecutionManifestSeed.orchestrator.tierModelMap).toBeNull()
    manager.cleanup()
  })

  test('composes the small-tier default from the gateway fast alias and omits it otherwise (T1)', () => {
    // Source-level wiring pin (mirrors the X4B admission-path pin above): the
    // capability-turn composition resolves the session connection, reads the
    // gateway `fast` alias by id, and only seeds `tierModelMap.small` when found.
    // Explicit config is not overwritten; non-gateway providers stay unchanged.
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const turnComposition = source.slice(
      source.indexOf('const contextSeed = buildPiOrchestratorContextSeed('),
      source.indexOf('managed.capabilityLeaseId = snapshot.leaseId'),
    )
    expect(turnComposition).toContain('resolveGatewayFastModelId(tierConnection)')
    expect(turnComposition).toContain('resolveSessionConnection(')
    // small-tier only; medium/big stay unset (session model).
    expect(turnComposition).toContain('{ small: fastModelId }')
    // Omit-when-default spread keeps legacy seeds byte-identical when absent.
    expect(turnComposition).toContain('...(tierModelMap ? { tierModelMap } : {})')
  })

  test('hands a child its composed prompt in the field the Pi prompt composer reads', async () => {
    // Wiring half of the child-prompt fix. The spawner composes safety core +
    // context seed + agent-definition prompt into `restrictions.prompt`; the
    // host used to forward it as `systemPromptPreset`, which `getSystemPrompt`
    // only ever tests for `=== 'mini'`, so it was dropped. The backend config
    // must carry it in a field that is actually composed into the prompt.
    setSessionPlatform(createHeadlessPlatform())
    const composedChildPrompt = '## Subagent Safety Core\n\nSEED_BLOCK\n\nSENTINEL_CHILD_DEFINITION_PROMPT'
    const manager = createTestSessionManager({
      managedPiPolicy: parseManagedPiPolicyV1({
        schemaVersion: 1,
        disabledPermissionModes: [],
        autoCompactEnabled: false,
      }),
    })
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-child-prompt-'))
    const workspace = { id: 'workspace-child-prompt', name: 'Child prompt', rootPath: workspaceRoot, createdAt: 1 }
    const managed: any = createManagedSession(
      { id: 'child-prompt-session', name: 'Child prompt', ephemeral: true },
      workspace as never,
      { messagesLoaded: true },
    )
    managed.piChildRestrictions = {
      prompt: composedChildPrompt,
      model: 'pi-model',
      tools: ['read'],
      worktreePolicy: 'shared',
      thinkingLevel: 'off',
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), managed)
    ;(manager as any).resolveBackendContextForManaged = () => ({
      connection: null,
      provider: 'pi',
      resolvedModel: 'pi-model',
      capabilities: { needsHttpPoolServer: false },
    })
    ;(manager as any).buildAgentAutomationSystem = async () => ({ executeAgentEvent: async () => ({ matchedCount: 0 }) })
    const agent = {
      isProcessing: () => false,
      setAutomationSystem() {},
      setCapabilityTurnRuntime() {},
      drainAutomationEvents: async () => {},
      postInit: async () => ({}),
      setAllSources() {},
      setSourceServers: async () => {},
      getModel: () => 'pi-model',
      chat: () => (async function* () {})(),
      getSessionId: () => undefined,
      endLifecycle: async () => {},
      forceAbort() {},
      dispose() {},
    }
    let coreConfig: any
    ;(manager as any).createBackendFromManagedContext = (input: any) => {
      coreConfig = input.coreConfig
      return agent
    }
    ;(manager as any).piWorkspaceDrainParticipant = {
      processSupervisorPort: undefined,
      async admitRuntime(input: any) { input.publish(await input.create(), { dispose() {} }) },
      dispose() {},
    }
    ;(manager as any).persistSession = () => {}
    ;(manager as any).flushSession = async () => {}
    ;(manager as any).sendEvent = () => {}

    try {
      await (manager as any).withCapabilityRuntime(managed, (runtime: any) => (
        (manager as any).getOrCreateAgent(managed, runtime)
      ))
      expect(coreConfig.childSystemPrompt).toBe(composedChildPrompt)
      expect(coreConfig.autoCompaction).toEqual({ enabled: false })
      // The preset field means 'default' | 'mini' only — overloading it is what
      // discarded the prompt in the first place.
      expect(coreConfig.systemPromptPreset).not.toBe(composedChildPrompt)
    } finally {
      managed.agent = null
      managed.piDrainRegistration = undefined
      try { await manager.cleanup() } finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
    }
  })

  test('never auto-fetches server-controlled MCP resource inventories into Pi startup context', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    // G-1 · this pin FAILED OPEN and had to be re-anchored. The anchor was
    // `const piContextResources = provider === 'pi'`, which P2.451 replaced with
    // the shared membership test below; `indexOf` then answered −1, `slice(-1,
    // end)` answered `''`, and the pair split: `toContain` failed (visibly) while
    // its sibling `not.toContain('listContextResources')` PASSED VACUOUSLY — the
    // half that actually guards the invariant. An empty slice satisfies every
    // absence assertion ever written against it, so the guard below is not
    // decoration: it is the only thing that can tell a re-anchored pin from a
    // dead one, and it is asserted BEFORE the two claims it protects.
    const start = source.indexOf('const piContextResources = runtimeReadsComposedInstructionContext(provider)')
    const end = source.indexOf('const piRuntimeAgentDefinitions', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const composition = source.slice(start, end)
    expect(composition.length).toBeGreaterThan(100)

    expect(composition).toContain('mcpResources: []')
    expect(composition).not.toContain('listContextResources')
  })
})
