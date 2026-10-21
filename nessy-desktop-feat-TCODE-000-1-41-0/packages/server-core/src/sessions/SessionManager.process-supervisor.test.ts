import { describe, expect, mock, test } from 'bun:test'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { parsePermissionDslV1 } from '@nessy-agent/shared/agent/pi-harness/permission-dsl'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins/bundle-hash'
import { resolvePluginLspLaunch } from '@nessy-agent/shared/capabilities/resolver'
import { createManagedSession, createPiLspAuthoritySignature, createPiLspPort, isPiLspProvisioningAllowed, resolvePiLspDocumentUri, rethrowAfterPiAdmissionCleanup, shouldRetainPiLspService } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

async function createRuntimeSkillFixture() {
  const root = await mkdtemp(join(tmpdir(), 'nessy-runtime-skill-context-'))
  await writeFile(join(root, 'SKILL.md'), '!printf context\n')
  const bundleHash = await computeNormalizedBundleHash(root)
  const skill = {
    key: 'plugin://market/context@1.0.0#hash#skill@workspace:ws',
    logicalName: 'context',
    description: 'Context',
    selectedAsUnqualifiedAlias: true,
    resource: {
      pluginInstanceId: 'plugin://market/context@1.0.0#hash',
      relativePath: 'skills/context/SKILL.md',
      contentHash: 'a'.repeat(64),
    },
    pluginRuntime: {
      rootPath: root,
      dataPath: root,
      bundleHash,
      profile: 'generic-plugin-env-v1' as const,
    },
  }
  const runtime = {
    provider: 'pi' as const,
    projectTrustState: 'trusted' as const,
    view: { generation: 'generation-skill-context', skills: [skill], permissionLayers: [] },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async readText() { throw new Error('unused') },
    },
  }
  return { root, skill, runtime }
}

function runtimeSkillRequest(fixture: Awaited<ReturnType<typeof createRuntimeSkillFixture>>) {
  return {
    skillKey: fixture.skill.key,
    command: 'printf context',
    cwd: process.cwd(),
    generation: fixture.runtime.view.generation,
    resourceHash: fixture.skill.resource.contentHash,
    timeoutMs: 5_000,
  }
}

function runtimeSkillManager(start: (request: any) => Promise<any>) {
  const manager = createTestSessionManager() as any
  manager.piWorkspaceDrainParticipant = { processSupervisorPort: { start } }
  manager.directPermissionResolvers = new Map()
  manager.piGoalServices = new Map()
  manager.persistSession = mock(() => {})
  manager.emitPiHarnessInvalidation = mock(() => {})
  manager.sendEvent = mock(() => {})
  return manager
}

describe('SessionManager Pi process owner', () => {
  test('injects one admitted supervisor proxy and covers both Pi factory paths', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    expect(source).toContain('new PiWorkspaceDrainParticipant')
    expect(source).toContain("processSupervisorPort: provider === 'pi' ? this.piWorkspaceDrainParticipant.processSupervisorPort : undefined")
    const managedFactory = source.slice(source.indexOf('private async getOrCreateAgent('), source.indexOf('private async generateRemoteTransferSummary('))
    const summaryFactory = source.slice(source.indexOf('private async generateRemoteTransferSummary('), source.indexOf('async exportRemoteSessionTransfer('))
    expect(managedFactory).toContain("provider === 'pi'")
    expect(summaryFactory).toContain("backendContext.provider === 'pi'")
    for (const factory of [managedFactory, summaryFactory]) expect(factory).toContain('this.piWorkspaceDrainParticipant.admitRuntime')
    expect(managedFactory).toContain('publish: (agent, registration) =>')
    expect(managedFactory).toContain("() => this.disposeManagedAgentRuntime(managed, 'Pi admission failure', true)")
    expect(summaryFactory).toContain('publish: (created, registration) =>')
    expect(summaryFactory.indexOf('created.destroy()')).toBeLessThan(summaryFactory.indexOf('summaryDisposed = true'))
    expect(summaryFactory.indexOf('disposeSummary(agent)')).toBeLessThan(summaryFactory.indexOf('summaryRegistration?.dispose()'))
    expect(source).toContain('await this.piProcessSupervisor.stop({')
    const killStart = source.indexOf('async killShell(')
    const killEnd = source.indexOf('/**\n   * Get output from a background task', killStart)
    const killShell = source.slice(killStart, killEnd)
    expect(killShell).not.toContain('pgrep')
    expect(killShell).not.toContain('pkill')
    expect(killShell).not.toContain('command.replace')
  })

  test('authorizes worktree git only against the selected project or exact lease root', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('private createPiWorktreeLeaseService(')
    const end = source.indexOf('private async registerPiWorktreeLease(', start)
    const worktrees = source.slice(start, end)

    expect(worktrees).not.toContain('managed.workspace.rootPath')
    // P6.136 extracted the three authority paths into `worktreeAuthorityPaths`,
    // which moved the namespace literal OUT of this slice — so the assertion
    // that used to read it here went red on a refactor that changed nothing it
    // was guarding. Read at the extracted helper, with the call kept pinned in
    // this slice so the two cannot be separated again (P6.175, in passing).
    expect(worktrees).toContain('worktreeAuthorityPaths(')
    expect(source.slice(
      source.indexOf('function worktreeAuthorityPaths('),
      source.indexOf('function isFuzzyFileSearchAgent('),
    )).toContain("'.nessy-worktrees'")
    expect(worktrees).toContain('[authority.root, authority.namespaceRoot]')
    expect(worktrees).toContain('authority.containmentRoot')
    const control = source.slice(
      source.indexOf('async controlPiHarnessRuntime('),
      source.indexOf('private buildPiAgentViewSettlement', source.indexOf('async controlPiHarnessRuntime(')),
    )
    expect(control).toContain('await this.releasePiWorktreeLease(managed, request.leaseId)')

    const runnerStart = source.indexOf('private async runWorktreeGit(')
    const runner = source.slice(runnerStart, start)
    expect(runner).toContain("profile: 'read-only'")
    expect(runner).not.toContain("profile: 'none'")
  })

  test('pins hook automation and plugin peripherals to each current capability turn before lease release', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const managedFactory = source.slice(source.indexOf('private async getOrCreateAgent('), source.indexOf('private async generateRemoteTransferSummary('))
    const build = managedFactory.indexOf('const agentAutomationSystem = await this.buildAgentAutomationSystem')
    // The BRACE is load-bearing: `if (!managed.agent)` alone also matches any
    // guard elsewhere in this slice, and matching one of those turns a true
    // ordering pin into a false failure about a line that is not the branch.
    const createBranch = managedFactory.indexOf('if (!managed.agent) {')
    expect(createBranch).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(-1)
    expect(build).toBeLessThan(createBranch)
    expect(managedFactory).toContain('managed.agent?.setAutomationSystem(agentAutomationSystem)')
    expect(managedFactory).toContain('managed.agent.restoreLifecycleState(managed.agentLifecycleState)')
    // R15: this slice used to be pinned on `managed.agentAutomationSystem?.executeAgentEvent`,
    // whose only occurrence here was the permission service's hook-event
    // forwarder — so the pin was holding the DEFECT in place. The service must
    // now be built with no automation forwarder at all: `PermissionRequest` and
    // `PermissionDenied` fire once, from pi-agent's band, which is the only site
    // with the documented input. Late-bound turn-scoped automation access is
    // still pinned, by the `setAutomationSystem` assertion above and the
    // turn-helper ordering below.
    // 2026-09-11 (W12-c) · the slice used to START at `const piPermissionService =`,
    // and `e8879beb1` (P6.590) lifted the options object OUT of that expression
    // — `const permissionServiceOptions: PiPermissionServiceOptions` now sits
    // ABOVE it, because a claude or codex session needs the same options to
    // build its own admission-only instance for the child-session port. So the
    // `requestApproval` this row asserts moved two lines up and out of the
    // window while the wiring it guards was intact. The slice now opens at the
    // OPTIONS, which is where both halves of this pair are decided: the forwarder
    // that must be absent would be written there too.
    const piServiceConstruction = managedFactory.slice(
      managedFactory.indexOf('const permissionServiceOptions: PiPermissionServiceOptions'),
      managedFactory.indexOf('const piChildSessionPort ='),
    )
    expect(managedFactory.indexOf('const permissionServiceOptions: PiPermissionServiceOptions')).toBeGreaterThan(-1)
    expect(piServiceConstruction).toContain('const piPermissionService =')
    expect(piServiceConstruction).toContain('requestApproval')
    expect(piServiceConstruction).not.toContain('emitAutomationEvent')
    expect(source).not.toContain('pluginHttpHooksEnabled')

    const turnHelper = source.slice(source.indexOf('private async withCapabilityRuntime<T>('), source.indexOf('/** Encoded composite key', source.indexOf('private async withCapabilityRuntime<T>(')))
    expect(turnHelper.indexOf('setAutomationSystem(undefined)')).toBeLessThan(turnHelper.indexOf('drainAgentAutomationEvents(managed)'))
    expect(turnHelper.indexOf('disarmPluginPeripherals(managed)')).toBeLessThan(turnHelper.indexOf('drainAgentAutomationEvents(managed)'))
    expect(turnHelper.indexOf('drainAgentAutomationEvents(managed)')).toBeLessThan(turnHelper.indexOf('setCapabilityTurnRuntime(null)'))
    expect(turnHelper.indexOf('setAutomationSystem(undefined)')).toBeLessThan(turnHelper.indexOf('releaseSnapshot'))
    expect(turnHelper.indexOf('disarmPluginPeripherals(managed)')).toBeLessThan(turnHelper.indexOf('releaseSnapshot'))

    const sendCleanup = source.slice(source.lastIndexOf('const leaseId = capabilityTurn?.snapshot.leaseId'), source.indexOf('// Covers resolution, cold-agent startup', source.lastIndexOf('const leaseId = capabilityTurn?.snapshot.leaseId')))
    expect(sendCleanup.indexOf('setAutomationSystem(undefined)')).toBeLessThan(sendCleanup.indexOf('drainAgentAutomationEvents(managed)'))
    expect(sendCleanup.indexOf('disarmPluginPeripherals(managed)')).toBeLessThan(sendCleanup.indexOf('drainAgentAutomationEvents(managed)'))
    expect(sendCleanup.indexOf('drainAgentAutomationEvents(managed)')).toBeLessThan(sendCleanup.indexOf('setCapabilityTurnRuntime(null)'))
    expect(sendCleanup.indexOf('setAutomationSystem(undefined)')).toBeLessThan(sendCleanup.indexOf('capabilityAutomationLease?.release()'))
    expect(sendCleanup.indexOf('disarmPluginPeripherals(managed)')).toBeLessThan(sendCleanup.indexOf('capabilityAutomationLease?.release()'))

    const lifecycle = source.slice(source.indexOf('private async endManagedAgentLifecycle('), source.indexOf('/**\n   * Refresh an existing agent', source.indexOf('private async endManagedAgentLifecycle(')))
    expect(lifecycle.indexOf('disarmPluginPeripherals(managed)')).toBeLessThan(lifecycle.indexOf('releaseSnapshot'))
  })

  test('wires optional effectful plugin hook kinds through the Pi-only governed runner path', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('private async buildAgentAutomationSystem(')
    const end = source.indexOf('/**\n   * Get or create agent', start)
    const automationFactory = source.slice(start, end)

    for (const runner of ['pluginAgentHookRunner', 'pluginMcpToolHookRunner', 'pluginHttpHookRunner']) {
      expect(source).toContain(`private ${runner}(`)
      expect(automationFactory).toContain(`${runner}: this.${runner}(`)
    }
    expect(automationFactory).toContain("provider === 'pi'")
  })

  test('contains every command hook in the existing supervised workspace process path', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('private pluginCommandHookRunner(')
    const end = source.indexOf('/**\n   * CI2 edit-feedback runner', start)
    const runner = source.slice(start, end)
    expect(runner).toContain('processSupervisorPort.start({')
    expect(runner).toContain("profile: 'workspace'")
    expect(runner).toContain("environmentProfile: 'explicit'")
    expect(runner).toContain("shouldAllowToolInMode('Bash'")
    expect(runner).toContain("shouldPromptInAskMode('Bash'")
    expect(runner).toContain('this.appendPiExecutionReceipt(managed')
    expect(runner).toContain('permissionManager.setCapabilityPermissionLayers(')
    expect(runner).toContain('evaluatePermissionDslV1(readablePolicy')
    expect(runner).toContain('this.createTelemetryPiPermissionService(managed, {')
    expect(runner).toContain('environmentDigest: result.environmentDigest')
    expect(runner).not.toContain('spawn(')
    expect(source).toContain('pluginCommandHookRunner: this.pluginCommandHookRunner(')
  })

  test('applies hook permission policy and records only redacted supervised receipt metadata', async () => {
    const manager = createTestSessionManager() as any
    const start = mock(async () => ({
      handle: 'process-1', stdout: 'token=super-secret', stderr: '', output: 'token=super-secret',
      nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
      isolationProfile: 'workspace:sandbox-exec:host-read:write-workspace+scratch+managed-data',
      environmentProfile: 'explicit', environmentDigest: 'a'.repeat(64),
    }))
    manager.piWorkspaceDrainParticipant = { processSupervisorPort: { start } }
    manager.directPermissionResolvers = new Map()
    manager.piGoalServices = new Map()
    manager.persistSession = mock(() => {})
    manager.resolveManagedProvider = () => 'pi'
    manager.emitPiHarnessInvalidation = mock(() => {})
    manager.sendEvent = mock(() => {})
    const managed: any = {
      id: 'session-hook', workspace: { id: 'workspace-hook', rootPath: process.cwd() },
      permissionMode: 'bypassPermissions', enabledSourceSlugs: [],
    }
    const runner = manager.pluginCommandHookRunner(managed, {
      projectTrustState: 'trusted',
      view: { generation: 'generation-hook', permissionLayers: [] },
      materializer: { assertActive() {}, async readText() { throw new Error('unused') } },
    })
    const result = await runner({ type: 'command', command: 'echo ok' }, {
      event: 'PreToolUse', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cwd: process.cwd(),
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.stdout).toBe('token=[REDACTED]')
    const receipt = managed.piExecutionReceipts.snapshot()[0]
    expect(receipt).toMatchObject({
      semanticId: 'plugin-hook', outcome: 'success',
      isolationProfile: 'workspace:sandbox-exec:host-read:write-workspace+scratch+managed-data',
      environmentProfile: 'explicit', environmentDigest: 'a'.repeat(64), effect: 'externalMutation',
    })
    expect(JSON.stringify(receipt)).not.toContain('super-secret')
    expect(JSON.stringify(receipt)).not.toContain(process.cwd())

    managed.permissionMode = 'dontAsk' // F1.758: plan mode now judges a hook as `default` (commandHookGateMode); dontAsk still refuses
    const denied = await runner({ type: 'command', command: 'touch denied-file' }, {
      event: 'PreToolUse', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cwd: process.cwd(),
    })
    expect(denied.success).toBe(false)
    expect(start).toHaveBeenCalledTimes(1)
    expect(managed.piExecutionReceipts.snapshot().at(-1)).toMatchObject({ outcome: 'denied', code: 'permission_denied' })
  })

  test('redacts real Pi runtime skill context output before returning it to the model', async () => {
    const fixture = await createRuntimeSkillFixture()
    try {
      const start = mock(async (request: any) => {
        await request.beforeStart?.()
        return {
          handle: 'process-skill-context', stdout: 'token=super-secret', stderr: '', output: 'token=super-secret',
          nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
          isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'a'.repeat(64),
        }
      })
      const manager = runtimeSkillManager(start)
      const managed: any = {
        id: 'session-skill-context', workspace: { id: 'workspace-skill-context', rootPath: process.cwd() },
        isProcessing: true, permissionMode: 'bypassPermissions', enabledSourceSlugs: [], capabilityRuntime: fixture.runtime,
      }
      const runner = manager.runtimeSkillContextExecutor(managed, fixture.runtime)

      const output = await runner(runtimeSkillRequest(fixture), new AbortController().signal)

      expect(start).toHaveBeenCalledTimes(1)
      expect(output).toBe('token=[REDACTED]')
      expect(JSON.stringify(managed.piExecutionReceipts.snapshot())).not.toContain('super-secret')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('stopping Pi runtime skill context during permission prevents process admission', async () => {
    const fixture = await createRuntimeSkillFixture()
    try {
      const start = mock(async () => { throw new Error('must not start') })
      const manager = runtimeSkillManager(start)
      const controller = new AbortController()
      manager.sendEvent = mock(() => controller.abort('user-stop'))
      const managed: any = {
        id: 'session-skill-permission-stop', workspace: { id: 'workspace-skill-permission-stop', rootPath: process.cwd() },
        isProcessing: true, permissionMode: 'default', enabledSourceSlugs: [], capabilityRuntime: fixture.runtime,
      }
      const runner = manager.runtimeSkillContextExecutor(managed, fixture.runtime)

      await expect(runner(runtimeSkillRequest(fixture), controller.signal)).rejects.toThrow()

      expect(controller.signal.aborted).toBe(true)
      expect(start).toHaveBeenCalledTimes(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('stopping Pi runtime skill context at the final execution gate prevents spawn', async () => {
    const fixture = await createRuntimeSkillFixture()
    try {
      const controller = new AbortController()
      let spawned = 0
      const start = mock(async (request: any) => {
        controller.abort('user-stop')
        await request.beforeStart?.()
        spawned += 1
        return {
          handle: 'unexpected-process', stdout: '', stderr: '', output: '', nextCursor: 0, isRunning: false,
          exitCode: 0, signal: null, isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'a'.repeat(64),
        }
      })
      const manager = runtimeSkillManager(start)
      const managed: any = {
        id: 'session-skill-execution-stop', workspace: { id: 'workspace-skill-execution-stop', rootPath: process.cwd() },
        isProcessing: true, permissionMode: 'bypassPermissions', enabledSourceSlugs: [], capabilityRuntime: fixture.runtime,
      }
      const runner = manager.runtimeSkillContextExecutor(managed, fixture.runtime)

      await expect(runner(runtimeSkillRequest(fixture), controller.signal)).rejects.toThrow('runtime-skill-context-aborted')

      expect(start).toHaveBeenCalledTimes(1)
      expect(spawned).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('managed Bash deny blocks an allow-all command hook before ProcessSupervisor start', async () => {
    const manager = createTestSessionManager() as any
    const start = mock(async () => { throw new Error('must not start') })
    manager.piWorkspaceDrainParticipant = { processSupervisorPort: { start } }
    manager.directPermissionResolvers = new Map()
    manager.piGoalServices = new Map()
    manager.persistSession = mock(() => {})
    manager.resolveManagedProvider = () => 'pi'
    manager.emitPiHarnessInvalidation = mock(() => {})
    manager.sendEvent = mock((event: any) => {
      const requestId = event?.request?.requestId
      if (typeof requestId === 'string') manager.directPermissionResolvers.get(requestId)?.resolve(false)
    })
    const managed: any = {
      id: 'session-managed-deny',
      workspace: { id: 'workspace-managed-deny', rootPath: process.cwd() },
      permissionMode: 'bypassPermissions',
      enabledSourceSlugs: [],
    }
    const managedPermissionDsl = parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'managed-bash-deny', action: 'deny', match: { kind: 'bash', executable: '*' } }],
    })
    const capabilityRuntime: any = {
      projectTrustState: 'trusted',
      view: {
        generation: 'generation-managed-deny',
        permissionLayers: [],
      },
      managedPermissionDsl,
      materializer: {
        assertActive() {},
        async readText() { throw new Error('unused') },
      },
    }
    const runner = manager.pluginCommandHookRunner(managed, capabilityRuntime)

    const result = await runner({ type: 'command', command: 'echo denied' }, {
      event: 'PreToolUse', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cwd: process.cwd(),
    })

    expect(result.success).toBe(false)
    expect(start).toHaveBeenCalledTimes(0)
    expect(manager.sendEvent).toHaveBeenCalledTimes(0)
    expect(managed.piExecutionReceipts.snapshot().at(-1)).toMatchObject({
      outcome: 'denied',
      code: 'permission_denied',
      isolationProfile: 'not-started',
      decisionId: expect.stringMatching(/^plugin-hook-permission-/),
    })
  })

  test('a deny rule on the symlink cwd blocks a command hook whose cwd was canonicalized', async () => {
    // R1 follow-up (landed in the R15 pre-phase): this gate canonicalizes the
    // hook cwd before evaluation, so without `rawInputPath` the documented
    // deny/ask "match on EITHER the symlink path or its resolved target"
    // asymmetry (permissions.md) degenerated to the resolved form only.
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'nessy-hook-symlink-')))
    try {
      await mkdir(join(root, 'real', 'sub'), { recursive: true })
      await symlink(join(root, 'real'), join(root, 'link'))
      const linkCwd = join(root, 'link', 'sub')
      const manager = createTestSessionManager() as any
      const start = mock(async () => { throw new Error('must not start') })
      manager.piWorkspaceDrainParticipant = { processSupervisorPort: { start } }
      manager.directPermissionResolvers = new Map()
      manager.piGoalServices = new Map()
      manager.persistSession = mock(() => {})
      manager.resolveManagedProvider = () => 'pi'
      manager.emitPiHarnessInvalidation = mock(() => {})
      manager.sendEvent = mock(() => {})
      const managed: any = {
        id: 'session-symlink-deny',
        workspace: { id: 'workspace-symlink-deny', rootPath: root },
        permissionMode: 'bypassPermissions',
        enabledSourceSlugs: [],
      }
      const managedPermissionDsl = parsePermissionDslV1({
        version: 1,
        rules: [{
          id: 'deny-symlink-cwd',
          action: 'deny',
          // Matches the RAW (through-symlink) cwd only; the canonicalized cwd
          // resolves to <root>/real/sub, which this pattern never matches.
          match: { kind: 'pathGlob', pattern: `${join(root, 'link').slice(1)}/**`, anchor: 'absolute', parameter: 'cwd' },
        }],
      })
      const capabilityRuntime: any = {
        projectTrustState: 'trusted',
        view: { generation: 'generation-symlink-deny', permissionLayers: [] },
        managedPermissionDsl,
        materializer: { assertActive() {}, async readText() { throw new Error('unused') } },
      }
      const runner = manager.pluginCommandHookRunner(managed, capabilityRuntime)
      const result = await runner({ type: 'command', command: 'echo through-symlink' }, {
        event: 'PreToolUse', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, cwd: linkCwd,
      })

      expect(result.success).toBe(false)
      expect(start).toHaveBeenCalledTimes(0)
      expect(managed.piExecutionReceipts.snapshot().at(-1)).toMatchObject({
        outcome: 'denied',
        code: 'permission_denied',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('gives the process supervisor the managed egress deny, and leaves it unset by default', async () => {
    // The last link of the S12 chain: managed policy -> resolved sandbox
    // settings -> enforcement -> supervisor. Without it `sandbox.network` still
    // parses, still composes, and still binds no command.
    const supervisorOptions = (manager: unknown): { denyNetworkEgress?: boolean } =>
      (manager as { piProcessSupervisor: { options: { denyNetworkEgress?: boolean } } }).piProcessSupervisor.options

    const open = createTestSessionManager()
    expect(supervisorOptions(open).denyNetworkEgress).toBeUndefined()
    await open.cleanup()

    const locked = createTestSessionManager({
      managedPiPolicy: { sandbox: { network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] } } } as never,
    })
    expect(supervisorOptions(locked).denyNetworkEgress).toBe(true)
    await locked.cleanup()
  })

  test('serializes the single agent capability binding per session', async () => {
    const manager = createTestSessionManager()
    const managed = { id: 'session-lock', workspace: { id: 'workspace-lock' } }
    const acquire = (manager as unknown as {
      acquireCapabilityTurn(value: unknown): Promise<() => void>
    }).acquireCapabilityTurn.bind(manager)

    const releaseFirst = await acquire(managed)
    let secondEntered = false
    const second = acquire(managed).then(release => {
      secondEntered = true
      return release
    })
    await Bun.sleep(0)
    expect(secondEntered).toBe(false)

    releaseFirst()
    const releaseSecond = await second
    expect(secondEntered).toBe(true)
    releaseSecond()
    await manager.cleanup()
  })

  test('awaits the async agent termination barrier during manager cleanup', async () => {
    const manager = createTestSessionManager()
    ;(manager as any).resolveManagedProvider = () => 'anthropic'
    const managed = {
      id: 'session-cleanup', workspace: { id: 'workspace-cleanup' },
      forceAbortCalls: 0,
      isProcessing: true,
      messages: [],
      backgroundShellCommands: new Map(),
    } as Record<string, any>
    let releaseTermination!: () => void
    const termination = new Promise<void>(resolve => { releaseTermination = resolve })
    let asyncDisposalStarted = false
    let syncDisposals = 0
    managed.agent = {
      forceAbort: () => { managed.forceAbortCalls += 1 },
      drainAutomationEvents: async () => {},
      captureLifecycleState: () => ({
        sessionStartEmitted: true,
        sessionEndEmitted: true,
        sessionStartHooksApplied: true,
      }),
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      dispose: () => { syncDisposals += 1 },
      disposeForRestart: async () => {
        asyncDisposalStarted = true
        await termination
      },
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: 'workspace-cleanup', sessionId: 'session-cleanup' }), managed)
    ;(manager as any).endManagedAgentLifecycle = async () => {}

    let cleanupSettled = false
    const cleanup = manager.cleanup().then(() => { cleanupSettled = true })
    try {
      await Bun.sleep(0)
      expect(asyncDisposalStarted).toBe(true)
      expect(cleanupSettled).toBe(false)
      expect(syncDisposals).toBe(0)
    } finally {
      releaseTermination()
    }
    await cleanup
    expect(managed.forceAbortCalls).toBe(1)
    expect(cleanupSettled).toBe(true)
  })

  test('rejects cleanup and retains agent authority when termination fails, then retries', async () => {
    const manager = createTestSessionManager()
    ;(manager as any).resolveManagedProvider = () => 'anthropic'
    const terminationError = new Error('pi-subprocess-termination-unconfirmed:9001')
    let disposalAttempts = 0
    const agent = {
      forceAbort: () => {},
      drainAutomationEvents: async () => {},
      captureLifecycleState: () => ({
        sessionStartEmitted: true,
        sessionEndEmitted: true,
        sessionStartHooksApplied: true,
      }),
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      dispose: () => {},
      disposeForRestart: async () => {
        disposalAttempts += 1
        if (disposalAttempts === 1) throw terminationError
      },
    }
    const managed: Record<string, any> = {
      id: 'session-cleanup-retry', workspace: { id: 'workspace-cleanup-retry' }, agent,
      isProcessing: true,
      messages: [],
      backgroundShellCommands: new Map(),
    }
    ;(manager as any).sessions.set(
      encodeSessionKey({ workspaceId: 'workspace-cleanup-retry', sessionId: 'session-cleanup-retry' }),
      managed,
    )
    ;(manager as any).endManagedAgentLifecycle = async () => {}

    await expect(manager.cleanup()).rejects.toThrow('session-manager-cleanup-failed')
    expect(managed.agent).toBe(agent)
    expect(disposalAttempts).toBe(1)

    await manager.cleanup()
    expect(disposalAttempts).toBe(2)
    expect(managed.agent).toBeNull()
  })

  test('runs SessionEnd before the strict Pi cleanup drain', async () => {
    const manager = createTestSessionManager()
    const workspace = {
      id: 'workspace-cleanup-order',
      name: 'workspace-cleanup-order',
      slug: 'workspace-cleanup-order',
      rootPath: '/tmp/workspace-cleanup-order',
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: 'session-cleanup-order' },
      workspace,
      { messagesLoaded: true, ephemeral: true },
    )
    const sequence: string[] = []
    managed.agent = {
      captureLifecycleState: () => undefined,
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      disposeForRestart: async () => { sequence.push('drain') },
      dispose: () => {},
      isProcessing: () => false,
    } as never
    ;(manager as any).sessions.set(
      encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }),
      managed,
    )
    ;(manager as any).resolveManagedProvider = () => 'pi'
    ;(manager as any).endManagedAgentLifecycle = async () => { sequence.push('SessionEnd') }

    await manager.cleanup()
    expect(sequence).toEqual(['SessionEnd', 'drain'])
  })

  test('cleans common resources exactly once and preserves admission failure identity', async () => {
    const admissionError = new Error('workspace-draining')
    let cleanups = 0
    let caught: unknown
    try {
      await rethrowAfterPiAdmissionCleanup(admissionError, async () => { cleanups += 1 })
    } catch (error) { caught = error }
    expect(caught).toBe(admissionError)
    expect(cleanups).toBe(1)

    const cleanupError = new Error('pool-stop-failed')
    try {
      await rethrowAfterPiAdmissionCleanup(admissionError, async () => {
        cleanups += 1
        throw cleanupError
      })
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([admissionError, cleanupError])
    expect(cleanups).toBe(2)
  })

  test('keeps a cold MCP lease unpublished until construction succeeds and rolls it back on failure', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const factory = source.slice(source.indexOf('private async getOrCreateAgent('), source.indexOf('async flagSession('))
    const lease = factory.indexOf('setupMcpPoolLease = this.workspaceMcpPools.lease')
    const postInit = factory.indexOf('await managed.agent.postInit()')
    const publish = factory.indexOf('managed.mcpPoolLease = setupMcpPoolLease')
    const rollback = factory.indexOf('await pendingMcpSetup.mcpPoolLease.release()')

    expect(lease).toBeGreaterThan(-1)
    expect(postInit).toBeGreaterThan(lease)
    expect(publish).toBeGreaterThan(postInit)
    expect(rollback).toBeGreaterThan(-1)
    expect(factory.slice(lease, publish)).not.toContain('managed.mcpPoolLease =')
  })

  test('retains pending MCP ownership when failed cold-agent disposal must be retried', async () => {
    const manager = createTestSessionManager()
    let agentDisposals = 0
    let failAgentDisposal = true
    const agent = {
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      disposeForRestart: async () => {
        agentDisposals += 1
        if (failAgentDisposal) throw new Error('agent-dispose-failed')
      },
    }
    let serverStops = 0
    let leaseReleases = 0
    const poolServer = { stop: async () => { serverStops += 1 } }
    const mcpPool = {}
    const mcpPoolLease = { release: async () => { leaseReleases += 1 } }
    const managed: Record<string, unknown> = {
      id: 'session-cold-failure',
      workspace: { id: 'workspace-cold-failure' },
      agent,
      // TFP1 (2026-10-10): the real ManagedSession always carries this map
      // (constructed beside the session, typed non-optional), and
      // `retireRuntimeMintedShells` (UA12.192, d992f04b2) reads it on every
      // disposal path. The stub predates the field.
      backgroundShellCommands: new Map(),
    }
    const pending: Record<string, unknown> = {
      mcpPool,
      mcpPoolLease,
      poolServer,
      leaserId: 'session:session-cold-failure:runtime:nonce',
    }
    const constructionError = new Error('post-init-failed')
    const cleanupFailedConstruction = () => (manager as unknown as {
      rethrowAfterFailedAgentConstruction(value: unknown, setup: unknown, error: unknown): Promise<never>
    }).rethrowAfterFailedAgentConstruction(managed, pending, constructionError)

    let caught: unknown
    try { await cleanupFailedConstruction() } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors[0]).toBe(constructionError)
    expect(managed.agent).toBe(agent)
    expect(managed.mcpPool).toBe(mcpPool)
    expect(managed.mcpPoolLease).toBe(mcpPoolLease)
    expect(managed.poolServer).toBe(poolServer)
    expect(managed.mcpLeaserId).toBe('session:session-cold-failure:runtime:nonce')
    expect(managed.failedConstructionAgent).toBe(agent)
    expect(pending.committed).toBe(true)
    expect({ agentDisposals, serverStops, leaseReleases }).toEqual({
      agentDisposals: 1,
      serverStops: 0,
      leaseReleases: 0,
    })

    failAgentDisposal = false
    await (manager as unknown as {
      disposeFailedConstructionAgentBeforeReuse(value: unknown): Promise<void>
    }).disposeFailedConstructionAgentBeforeReuse(managed)
    expect({ agentDisposals, serverStops, leaseReleases }).toEqual({
      agentDisposals: 2,
      serverStops: 1,
      leaseReleases: 1,
    })
    expect(managed.agent).toBeNull()
    expect(managed.mcpPoolLease).toBeUndefined()
    expect(managed.failedConstructionAgent).toBeUndefined()
    await manager.cleanup()
  })

  test('fails closed instead of reusing a retained failed-construction agent', async () => {
    const manager = createTestSessionManager()
    let disposals = 0
    const agent = {
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      disposeForRestart: async () => {
        disposals += 1
        throw new Error('still-cannot-dispose')
      },
    }
    const managed = {
      id: 'session-poisoned-agent',
      workspace: { id: 'workspace-poisoned-agent' },
      agent,
      failedConstructionAgent: agent,
    }
    const retryBeforeReuse = () => (manager as unknown as {
      disposeFailedConstructionAgentBeforeReuse(value: unknown): Promise<void>
    }).disposeFailedConstructionAgentBeforeReuse(managed)

    await expect(retryBeforeReuse()).rejects.toThrow('pi-session-disposal-failed')
    await expect(retryBeforeReuse()).rejects.toThrow('pi-session-disposal-failed')
    expect(disposals).toBe(2)
    expect(managed.agent).toBe(agent)
    expect(managed.failedConstructionAgent).toBe(agent)

    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const factory = source.slice(source.indexOf('private async getOrCreateAgent('), source.indexOf('private async getOrCreateAgentUnchecked('))
    expect(factory.indexOf('await this.disposeFailedConstructionAgentBeforeReuse(managed)'))
      .toBeLessThan(factory.indexOf('this.getOrCreateAgentUnchecked'))
    await manager.cleanup()
  })

  test('resolves only real paths contained by the canonical LSP workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-lsp-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'nessy-lsp-outside-'))
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1')
      await writeFile(join(outside, 'secret.ts'), 'secret')
      await symlink(outside, join(root, 'escape'))
      expect(await resolvePiLspDocumentUri(root, 'src/a.ts')).toStartWith('file:')
      await expect(resolvePiLspDocumentUri(root, 'escape/secret.ts')).rejects.toThrow('lsp-path-outside-workspace')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('retains and provisions Pi LSP only from current trusted readiness', () => {
    const cases = [
      { trust: 'trusted', health: 'ready', retain: true, provision: true },
      { trust: 'blocked', health: 'ready', retain: false, provision: false },
      { trust: 'none', health: 'ready', retain: false, provision: false },
      { trust: 'trusted', health: 'failed', retain: false, provision: true },
    ] as const
    expect(cases.map(({ trust, health }) => ({
      retain: shouldRetainPiLspService(trust, { status: health }),
      provision: isPiLspProvisioningAllowed(trust),
    }))).toEqual(cases.map(({ retain, provision }) => ({ retain, provision })))

    const registration = {
      key: 'typescript',
      lspId: 'typescript',
      command: 'node',
      args: ['server.js'],
      languages: ['typescript'],
      executableHash: 'a'.repeat(64),
      pluginInstanceId: 'plugin://market/toolkit@1.0.0#hash',
      pluginRuntime: {
        rootPath: '/bundle',
        dataPath: '/data',
        bundleHash: 'b'.repeat(64),
        profile: 'generic-plugin-env-v1' as const,
      },
    }
    const current = createPiLspAuthoritySignature('generation-a', [registration])
    expect(shouldRetainPiLspService('trusted', { status: 'ready' }, current, current)).toBe(true)
    expect(shouldRetainPiLspService(
      'trusted',
      { status: 'ready' },
      current,
      createPiLspAuthoritySignature('generation-b', [registration]),
    )).toBe(false)
    expect(shouldRetainPiLspService(
      'trusted',
      { status: 'ready' },
      current,
      createPiLspAuthoritySignature('generation-a', []),
    )).toBe(false)
  })

  test('routes plugin LSP requests only to the declared language server', async () => {
    const calls: string[] = []
    const service = (name: string) => ({
      health: () => ({ status: 'ready' as const }),
      request: async () => { calls.push(name); return name },
    })
    const port = createPiLspPort(new Map([
      ['typescript', service('typescript')],
      ['python', service('python')],
    ]) as never, [
      { key: 'typescript', lspId: 'ts', command: 'tsserver', languages: ['typescript'], executableHash: 'a'.repeat(64) },
      { key: 'python', lspId: 'py', command: 'pylsp', languages: ['python'], executableHash: 'b'.repeat(64) },
    ])
    const signal = new AbortController().signal

    await expect(port.request({ operation: 'hover', path: 'src/a.ts', line: 0, character: 0, language: 'typescript' }, signal)).resolves.toBe('typescript')
    await expect(port.request({ operation: 'hover', path: 'src/a.py', line: 0, character: 0, language: 'python' }, signal)).resolves.toBe('python')
    await expect(port.request({ operation: 'hover', path: 'src/a.ts', line: 0, character: 0 }, signal)).rejects.toThrow('lsp-language-required')
    await expect(port.request({ operation: 'hover', path: 'src/a.go', line: 0, character: 0, language: 'go' }, signal)).rejects.toThrow('lsp-language-unavailable')
    expect(calls).toEqual(['typescript', 'python'])
  })

  test('resolves plugin LSP commands only through bundle or approved host runtime authority', () => {
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const setup = source.slice(source.indexOf('for (const registration of capabilityRuntime.view.lspServers ?? [])'), source.indexOf('if (services.size === 0)', source.indexOf('for (const registration of capabilityRuntime.view.lspServers ?? [])')))
    expect(setup).toContain('resolvePluginStdioExecutable(')
    expect(setup).toContain('this.pluginNodeRuntime')
    expect(setup).toContain('runtime.dataPath')
    expect(setup).not.toContain('qualifyPluginStdioCommand(')
  })

  // C5. `plugins-reference.md` § Environment variables — "| LSP servers |
  // `command`, `args`, `env`, `workspaceFolder` |". Before this the declared
  // env and workspace folder stopped at the manifest reader: the spawn hardcoded
  // `{ ...pluginEnvironment, ...executable.environment }` and
  // `managed.workingDirectory ?? managed.workspace.rootPath`, so a server
  // declaring either started without it and said nothing.
  test('starts a plugin language server with its declared env and workspace folder', () => {
    const bundle = '/bundle'
    const project = '/project'
    const pluginEnvironment = {
      NESSY_PLUGIN_ROOT: bundle,
      NESSY_PLUGIN_DATA: '/data',
      NESSY_PROJECT_DIR: project,
    }
    const registration = {
      key: 'go',
      lspId: 'go',
      command: 'gopls',
      languages: ['go'],
      executableHash: 'a'.repeat(64),
      env: { GOPATH: '${NESSY_PLUGIN_ROOT}/go', GOFLAGS: '-mod=mod' },
      workspaceFolder: '${NESSY_PROJECT_DIR}/svc',
      pluginRuntime: {
        rootPath: bundle,
        dataPath: '/data',
        bundleHash: 'b'.repeat(64),
        projectPath: project,
        profile: 'generic-plugin-env-v1' as const,
      },
    }

    // The declared value reaches the process, with the documented placeholder
    // resolved — a literal `${NESSY_PLUGIN_ROOT}/go` in GOPATH is not a GOPATH.
    expect(resolvePluginLspLaunch(registration, pluginEnvironment, {}, project)).toEqual({
      env: { ...pluginEnvironment, GOPATH: `${bundle}/go`, GOFLAGS: '-mod=mod' },
      workingDirectory: `${project}/svc`,
    })

    // The host's own runtime binding stays above the plugin's declaration, the
    // way `runtime-pool-servers` layers `commandEnvironment` last for stdio MCP.
    expect(resolvePluginLspLaunch(
      { ...registration, env: { NODE: '/plugin/node' } },
      pluginEnvironment,
      { NODE: '/host/node' },
      project,
    ).env.NODE).toBe('/host/node')

    // No declaration is today's behaviour, unchanged.
    expect(resolvePluginLspLaunch(
      { ...registration, env: undefined, workspaceFolder: undefined },
      pluginEnvironment,
      {},
      project,
    )).toEqual({ env: pluginEnvironment, workingDirectory: project })

    // Our earlier `workingDirectory` spelling is bundle-relative by its own
    // validator, and it reached the spawn no more than `workspaceFolder` did.
    expect(resolvePluginLspLaunch(
      { ...registration, workspaceFolder: undefined, workingDirectory: 'tools/gopls' },
      pluginEnvironment,
      {},
      project,
    ).workingDirectory).toBe(`${bundle}/tools/gopls`)

    // A folder no root covers never becomes a supervised process's cwd.
    expect(resolvePluginLspLaunch(
      { ...registration, workspaceFolder: '/etc' },
      pluginEnvironment,
      {},
      project,
    ).workingDirectory).toBe(project)
  })

  test('feeds the plugin LSP spawn from the resolved launch, not from hardcoded defaults', () => {
    // The wiring, not the helper: the mutation this catches is the spawn going
    // back to its own env/cwd literals while the helper above stays green.
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('for (const registration of capabilityRuntime.view.lspServers ?? [])')
    const setup = source.slice(start, source.indexOf('if (services.size === 0)', start))
    expect(setup).toContain('resolvePluginLspLaunch(')
    expect(setup).toContain('workingDirectory: launch.workingDirectory')
    expect(setup).toContain('env: launch.env')
    expect(setup).not.toContain('env: { ...pluginEnvironment, ...executable.environment }')
    // The ARGUMENT ORDER is the security-relevant half and the destination
    // fields above cannot see it. `resolvePluginLspLaunch` layers
    // `{...pluginEnvironment, ...declared, ...hostEnvironment}`, so the host's
    // resolved executable environment wins last precisely so a plugin's `env`
    // declaration can never redirect the managed Node or `dp` binary. Swapping
    // arguments 2 and 3 inverts that and leaves every other assertion green.
    expect(setup).toMatch(
      /resolvePluginLspLaunch\(\s*registration,\s*pluginEnvironment,\s*executable\.environment,/,
    )
  })

  test('passes an onDiagnostics sink into every LspService construction', () => {
    // ONE construction, the plugin loop. P3.366 deleted the second — the
    // host-supplied "native" fallback that had no producer in production or in
    // any test — so the count moved 2 -> 1 with it. This assertion is what
    // pinned that branch: the row's own note said no test did, and this is the
    // correction. The sink assertion below is unchanged and is the point of
    // the test: a construction that is not fed pushes diagnostics into nothing.
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    const constructions = source.split('new LspService({').slice(1)
    expect(constructions).toHaveLength(1)
    for (const construction of constructions) {
      const options = construction.slice(0, construction.indexOf('\n          })'))
      expect(options).toContain('onDiagnostics:')
    }
  })

  test('folds buffered LSP diagnostics for the touched file into one post-edit payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-lsp-edit-feedback-'))
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1')
      await writeFile(join(root, 'src', 'clean.ts'), 'export const b = 2')
      const sessionKey = { workspaceId: 'ws-lsp', sessionId: 'session-lsp' }
      const manager = createTestSessionManager() as any
      // No config markers in the fixture root, so `detectChecks` finds nothing
      // and the supervisor is never reached: this pins that an LSP-only verdict
      // still reaches the model.
      manager.piWorkspaceDrainParticipant = {
        processSupervisorPort: { start: async () => { throw new Error('unexpected-spawn') } },
      }
      manager.piLspDiagnostics = new Map()
      manager.recordPiLspDiagnostics(encodeSessionKey(sessionKey), {
        uri: await resolvePiLspDocumentUri(root, 'src/a.ts'),
        diagnostics: [{
          message: 'Type error',
          severity: 1,
          range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
        }],
      })

      const runner = manager.buildEditFeedbackRunner(sessionKey, root)
      const payload = await runner({ toolName: 'Edit', toolInput: { file_path: 'src/a.ts' } })
      expect(payload).toContain('Type error')

      // For the touched URI ONLY — an untouched file's diagnostics stay out.
      expect(await runner({ toolName: 'Edit', toolInput: { file_path: 'src/clean.ts' } })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the channel subscription survives a capability generation change', async () => {
    // Its premise used to be the opposite: the subscription was re-armed per
    // capability generation, so `unsubscribed` was 1 after a second arm and the
    // events went out through `agent.redirect`. Both changed with the lifetime
    // — a channel push is not turn-pinned work (`channels.md:13`), and it now
    // rides the background-notification queue rather than steering a live turn.
    const manager = createTestSessionManager()
    const redirects: string[] = []
    const delivered: string[] = []
    const subscriptions: Array<(event: { server: string; text: string }) => void> = []
    let unsubscribed = 0
    const managed: Record<string, any> = {
      id: 'session-peripheral-generation',
      workspace: { id: 'workspace-peripheral-generation' },
      isProcessing: true,
      mcpLeaserId: 'peripheral-leaser',
      mcpPool: {
        // Arming re-applies the channel gate every generation; this suite is
        // about the SUBSCRIPTION's lifetime, so the policy call is a no-op here.
        setChannelPolicy: () => undefined,
        // The source announcement reads these two off the pool. Nothing is
        // connected in this suite, so the honest answers are empty and the
        // notice stays silent — the assertions below are about the
        // SUBSCRIPTION, not the notice.
        getConnectedSlugs: () => [] as string[],
        hasChannelHandler: () => false,
        subscribeChannel: (_leaserId: string, listener: (event: { server: string; text: string }) => void) => {
          subscriptions.push(listener)
          return () => { unsubscribed += 1 }
        },
      },
      agent: { isProcessing: () => true, redirect: (text: string) => { redirects.push(text); return true } },
    }
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }), managed)
    ;(manager as any).deliverMonitorEvent = async (delivery: { text: string }) => { delivered.push(delivery.text) }
    const runtime = (generation: string) => ({
      view: { generation, monitors: [] },
      materializer: {},
    })
    managed.capabilityRuntime = runtime('generation-1')

    ;(manager as any).armPluginPeripherals(managed, managed.capabilityRuntime)
    managed.capabilityRuntime = runtime('generation-2')
    ;(manager as any).armPluginPeripherals(managed, managed.capabilityRuntime)

    // ONE subscription across both generations, and nothing torn down.
    expect(subscriptions).toHaveLength(1)
    expect(unsubscribed).toBe(0)

    subscriptions[0]!({ server: 'server', text: 'after generation change' })
    await Promise.resolve()
    // Delivered through the notification queue, never steered into the turn.
    expect(delivered).toEqual(['<channel source="server">\nafter generation change\n</channel>'])
    expect(redirects).toEqual([])
    ;(manager as any).sessions.delete(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }))
    await manager.cleanup()
  })

  test('disarms monitor delivery before a generic capability snapshot releases', async () => {
    const manager = createTestSessionManager()
    const sequence: string[] = []
    let monitorArmed = true
    let staleDeliveries = 0
    const staleMonitorTick = () => {
      if (monitorArmed) staleDeliveries += 1
    }
    const runtime = { view: { generation: 'generation-cleanup', monitors: [] }, materializer: {} }
    const managed: Record<string, any> = {
      id: 'session-generic-peripheral-cleanup',
      workspace: { id: 'workspace-generic-peripheral-cleanup' },
      capabilityLeaseId: 'lease-generic-peripheral-cleanup',
      capabilityRuntime: runtime,
      // The channel subscription is deliberately NOT in this sequence any more:
      // it is session-scoped and released with the MCP lease, not with the turn.
      // The test below ('...before agent, pool server, and MCP lease disposal')
      // is where its teardown ordering is pinned.
      mcpChannelSubscription: { leaserId: 'unused-leaser', dispose: () => { sequence.push('channel:unsubscribe') } },
      pluginMonitorServices: [{ dispose: () => { monitorArmed = false; sequence.push('monitor:dispose') } }],
    }
    ;(manager as any).acquireCapabilityTurn = async () => () => { sequence.push('turn:release') }
    ;(manager as any).createCapabilityTurn = async () => ({
      snapshot: { leaseId: 'lease-generic-peripheral-cleanup' },
      runtime,
    })
    ;(manager as any).drainAgentAutomationEvents = async () => { sequence.push('automation:drain') }
    ;(manager as any).capabilityResolver = {
      releaseSnapshot: () => {
        sequence.push('snapshot:release')
        staleMonitorTick()
      },
    }

    await (manager as any).withCapabilityRuntime(managed, async () => undefined)

    expect(staleDeliveries).toBe(0)
    const before = (left: string, right: string) => expect(sequence.indexOf(left)).toBeLessThan(sequence.indexOf(right))
    expect(sequence).not.toContain('channel:unsubscribe')
    before('monitor:dispose', 'snapshot:release')
    before('snapshot:release', 'turn:release')
    await manager.cleanup()
  })

  test('disarms plugin deliveries and LSP before agent, pool server, and MCP lease disposal', async () => {
    const manager = createTestSessionManager()
    const sequence: string[] = []
    const managed: Record<string, any> = {
      id: 'session-peripheral-disposal',
      workspace: { id: 'workspace-peripheral-disposal' },
      activeProvider: 'pi',
      // TFP1 (2026-10-10): `retireRuntimeMintedShells` (UA12.192, d992f04b2)
      // reads this map on every disposal path; the real ManagedSession always
      // carries it (non-optional in the type, constructed as `new Map()`).
      backgroundShellCommands: new Map(),
      // Session-scoped since the channel subscription left the turn lifetime;
      // this teardown is still the one that releases it, beside the MCP lease.
      mcpChannelSubscription: { leaserId: 'peripheral-leaser', dispose: () => { sequence.push('mcp:unsubscribe') } },
      pluginMonitorServices: [{ dispose: () => { sequence.push('monitor:dispose') } }],
      agent: {
        setCapabilityTurnRuntime: () => { sequence.push('agent:clear-turn') },
        drainAutomationEvents: async () => { sequence.push('agent:drain') },
        captureLifecycleState: () => ({ sessionStartEmitted: true, sessionEndEmitted: false, sessionStartHooksApplied: true }),
        setAutomationSystem: () => { sequence.push('agent:clear-automation') },
        disposeForRestart: async () => { sequence.push('agent:dispose') },
      },
      poolServer: { stop: async () => { sequence.push('pool:stop') } },
      mcpPool: {},
      mcpPoolLease: { release: async () => { sequence.push('mcp:release') } },
      mcpLeaserId: 'peripheral-leaser',
    }
    ;(manager as any).piLspServices.set(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }), new Map([
      ['plugin-lsp', { dispose: async () => { sequence.push('lsp:dispose') } }],
    ]))
    ;(manager as any).piProcessSupervisor = {
      drainSession: async () => { sequence.push('process:drain') },
    }

    await (manager as any).disposeManagedAgentRuntime(managed, 'peripheral disposal')

    const before = (left: string, right: string) => expect(sequence.indexOf(left)).toBeLessThan(sequence.indexOf(right))
    before('mcp:unsubscribe', 'lsp:dispose')
    before('monitor:dispose', 'lsp:dispose')
    before('lsp:dispose', 'agent:dispose')
    before('agent:dispose', 'process:drain')
    before('process:drain', 'pool:stop')
    before('agent:dispose', 'pool:stop')
    before('pool:stop', 'mcp:release')
    await manager.cleanup()
  })

  test('preserves Pi drain authority and owned references after strict disposal failure', async () => {
    const manager = createTestSessionManager()
    const agent = {
      drainAutomationEvents: async () => {},
      captureLifecycleState: () => ({ sessionStartEmitted: true, sessionEndEmitted: false, sessionStartHooksApplied: true }),
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      disposeForRestart: async () => { throw new Error('agent-dispose-failed') },
    }
    const poolServer = { stop: async () => {} }
    const mcpPool = { disconnectAll: async () => {} }
    let registrationDisposals = 0
    const managed = {
      id: 'session-a', workspace: { id: 'workspace-a' }, agent, poolServer, mcpPool,
      activeProvider: 'pi' as const,
      piDrainRegistration: { dispose: () => { registrationDisposals += 1 } },
    }
    const disposeStrict = () => (manager as unknown as {
      disposeManagedAgentRuntime(value: unknown, reason: string, strict: boolean): Promise<void>
    }).disposeManagedAgentRuntime(managed, 'workspace drain', true)

    await expect(disposeStrict()).rejects.toThrow('pi-session-disposal-failed')
    await expect(disposeStrict()).rejects.toThrow('pi-session-disposal-failed')
    expect(managed.agent).toBe(agent)
    expect(managed.activeProvider).toBe('pi')
    expect(managed.poolServer).toBe(poolServer)
    expect(managed.mcpPool).toBe(mcpPool)
    expect(registrationDisposals).toBe(0)
    await manager.cleanup()
  })

  test('blocks runtime replacement until Pi subprocess disposal succeeds on retry', async () => {
    const manager = createTestSessionManager()
    let disposalAttempts = 0
    let confirmExit = false
    const agent = {
      drainAutomationEvents: async () => {},
      captureLifecycleState: () => ({
        sessionStartEmitted: true,
        sessionEndEmitted: false,
        sessionStartHooksApplied: true,
      }),
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      disposeForRestart: async () => {
        disposalAttempts += 1
        if (!confirmExit) throw new Error('pi-subprocess-termination-unconfirmed:9001')
      },
    }
    const managed: Record<string, unknown> = {
      id: 'session-runtime-replacement',
      workspace: { id: 'workspace-runtime-replacement' },
      agent,
      activeProvider: 'pi',
      // TFP1 (2026-10-10): `retireRuntimeMintedShells` (UA12.192, d992f04b2)
      // reads this map on every disposal path, including the retry gate this
      // test drives through runAgentRuntimeRefresh; the real ManagedSession
      // always carries it (non-optional, constructed `new Map()`).
      backgroundShellCommands: new Map(),
    }
    const refresh = () => (manager as unknown as {
      runAgentRuntimeRefresh(
        value: unknown,
        backendContext: unknown,
        runtimeSignature: string,
        restartSignature: string,
        restartRequired: boolean,
        reason: string,
      ): Promise<void>
    }).runAgentRuntimeRefresh(
      managed,
      {},
      'runtime-signature',
      'restart-signature',
      true,
      'test replacement',
    )

    await expect(refresh()).rejects.toThrow('pi-session-disposal-failed')
    expect(disposalAttempts).toBe(1)
    expect(managed.agent).toBe(agent)

    confirmExit = true
    await refresh()
    expect(disposalAttempts).toBe(2)
    expect(managed.agent).toBeNull()
    expect(managed.activeProvider).toBeUndefined()
    await manager.cleanup()
  })

  test('old runtime disposal never clears handles published by a newer runtime', async () => {
    const manager = createTestSessionManager()
    let releaseAgent!: () => void
    const agentGate = new Promise<void>(resolve => { releaseAgent = resolve })
    let agentDisposalStarted!: () => void
    const started = new Promise<void>(resolve => { agentDisposalStarted = resolve })
    const oldAgent = {
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      disposeForRestart: async () => {
        agentDisposalStarted()
        await agentGate
      },
    }
    let oldServerStops = 0
    let oldLeaseReleases = 0
    let oldRegistrationDisposals = 0
    const oldServer = { stop: async () => { oldServerStops += 1 } }
    const oldPool = {}
    const oldLease = { release: async () => { oldLeaseReleases += 1 } }
    const oldRegistration = { dispose: () => { oldRegistrationDisposals += 1 } }
    const managed: Record<string, unknown> = {
      id: 'session-replaced',
      workspace: { id: 'workspace-replaced' },
      agent: oldAgent,
      activeProvider: 'pi',
      poolServer: oldServer,
      mcpPool: oldPool,
      mcpPoolLease: oldLease,
      mcpLeaserId: 'old-leaser',
      piDrainRegistration: oldRegistration,
    }
    const dispose = (manager as unknown as {
      disposeManagedAgentRuntime(value: unknown, reason: string): Promise<void>
    }).disposeManagedAgentRuntime(managed, 'concurrent replacement')
    await started

    const fresh = {
      agent: {}, server: {}, pool: {}, lease: {}, registration: {}, leaserId: 'fresh-leaser', activeProvider: 'anthropic',
    }
    Object.assign(managed, {
      agent: fresh.agent,
      poolServer: fresh.server,
      mcpPool: fresh.pool,
      mcpPoolLease: fresh.lease,
      mcpLeaserId: fresh.leaserId,
      piDrainRegistration: fresh.registration,
      activeProvider: fresh.activeProvider,
    })
    releaseAgent()
    await dispose

    expect(managed.agent).toBe(fresh.agent)
    expect(managed.activeProvider).toBe(fresh.activeProvider)
    expect(managed.poolServer).toBe(fresh.server)
    expect(managed.mcpPool).toBe(fresh.pool)
    expect(managed.mcpPoolLease).toBe(fresh.lease)
    expect(managed.mcpLeaserId).toBe(fresh.leaserId)
    expect(managed.piDrainRegistration).toBe(fresh.registration)
    expect({ oldServerStops, oldLeaseReleases, oldRegistrationDisposals }).toEqual({
      oldServerStops: 1,
      oldLeaseReleases: 1,
      oldRegistrationDisposals: 1,
    })
    await manager.cleanup()
  })

  test('awaits FIFO SessionEnd under pinned authority before delete disposal', async () => {
    const manager = createTestSessionManager()
    const workspace = {
      id: 'workspace-end', name: 'workspace-end', slug: 'workspace-end',
      rootPath: '/tmp/workspace-end', createdAt: Date.now(),
    }
    const managed = createManagedSession({ id: 'session-end' }, workspace, { messagesLoaded: true, ephemeral: true })
    const sequence: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const rawSystem = {
      async executeAgentEvent(event: string) {
        sequence.push(`start:${event}`)
        if (event === 'Notification') await gate
        sequence.push(`end:${event}`)
        return { matchedCount: 1 }
      },
    }
    let bound: typeof rawSystem | undefined
    let endCalls = 0
    managed.agent = {
      setAutomationSystem(system: typeof rawSystem | undefined) {
        bound = system
        if (!system) sequence.push('authority:cleared')
      },
      setCapabilityTurnRuntime() {},
      async endLifecycle() {
        endCalls += 1
        await bound!.executeAgentEvent('SessionEnd')
      },
      async drainAutomationEvents() {},
      dispose() { sequence.push('agent:disposed') },
    } as never
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('workspace-end:session-end', managed)
    ;(manager as any).sessionStore.delete = () => true
    const internals = manager as unknown as {
      trackAgentAutomationSystem(value: unknown, system: unknown): typeof rawSystem
      buildAgentAutomationSystem(value: unknown): Promise<typeof rawSystem>
    }
    internals.buildAgentAutomationSystem = async value => internals.trackAgentAutomationSystem(value, rawSystem)

    const pending = internals.trackAgentAutomationSystem(managed, rawSystem).executeAgentEvent('Notification')
    await Bun.sleep(0)
    const deletion = manager.deleteSession('session-end', 'workspace-end')
    await Bun.sleep(0)
    expect(sequence).toEqual(['start:Notification'])
    release()
    await Promise.all([pending, deletion])

    expect(endCalls).toBe(1)
    expect(sequence).toEqual([
      'start:Notification', 'end:Notification',
      'start:SessionEnd', 'end:SessionEnd',
      'authority:cleared', 'authority:cleared', 'agent:disposed',
    ])
    await manager.cleanup()
  })

  test('retains the clean in-memory owner when durable session deletion fails', async () => {
    const manager = createTestSessionManager()
    const workspace = {
      id: 'workspace-delete-failure',
      name: 'workspace-delete-failure',
      slug: 'workspace-delete-failure',
      rootPath: '/tmp/workspace-delete-failure',
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id: 'session-delete-failure' },
      workspace,
      { messagesLoaded: true, ephemeral: true },
    )
    const key = encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id })
    ;(manager as any).sessions.set(key, managed)
    ;(manager as any).sessionStore.delete = () => false

    await expect(manager.deleteSession(managed.id, workspace.id))
      .rejects.toThrow('session-storage-delete-failed')
    expect((manager as any).sessions.get(key)).toBe(managed)
    expect(managed.agent).toBeNull()
    expect((manager as any).projectMutationSessions.has(key)).toBe(false)
    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })
})

/**
 * P2.139 · a process-backed `Monitor` watch outlives a runtime change, and where
 * a stop still genuinely happens the session is told WHICH watch went and WHY.
 *
 * Owner decision 2026-08-25 is BOTH halves, so both are pinned. The exemption is
 * asserted through `runAgentRuntimeRefresh` rather than by handing
 * `disposeManagedAgentRuntime` the flag directly, because the defect this row
 * closes is a teardown path that forgets to pass it — a test that passes the
 * flag itself could not see that.
 *
 * P2.166 extends the same harness to the third teardown of that shape — a plugin
 * runtime refresh — rather than copying it, because the two rows pin one
 * behaviour on different callers and a second copy of the fake drain would drift
 * from this one.
 */
describe('P2.139/P2.166 · Monitor watches across a teardown', () => {
  const workspace = {
    id: 'workspace-monitor-watch',
    name: 'workspace-monitor-watch',
    slug: 'workspace-monitor-watch',
    rootPath: '/tmp/workspace-monitor-watch',
    createdAt: Date.now(),
  }

  /** One command watch and one ws watch, over a drain that stops only processes. */
  const watchHarness = (options: { drainThrows?: boolean; keptWatchDiesAnyway?: boolean } = {}) => {
    const manager = createTestSessionManager()
    const managed = createManagedSession(
      { id: 'session-monitor-watch' },
      workspace,
      { messagesLoaded: true, ephemeral: true },
    )
    managed.activeProvider = 'pi'
    ;(manager as any).sessions.set(
      encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }),
      managed,
    )
    // The registry the notice reads. A watch leaves it when its process closes,
    // which is what the fake drain below does; a `ws` watch has no process, so a
    // drain can never be the thing that ended one.
    let live = [
      { id: 'process_watch', type: 'monitor', status: 'running', description: 'tail the build log', tool: 'command' },
      { id: 'monitor_ws_1', type: 'monitor', status: 'running', description: 'listen to the deploy socket', tool: 'ws' },
    ]
    const drains: unknown[] = []
    ;(manager as any).sessionMonitors = { list: () => live }
    ;(manager as any).piProcessSupervisor = {
      drainSession: async (_key: unknown, drainOptions?: { keepSemanticIds?: readonly string[] }) => {
        drains.push(drainOptions)
        if (drainOptions?.keepSemanticIds?.includes('monitor')) {
          if (options.keptWatchDiesAnyway !== true) return []
          // P2.166's residue. The exemption spared the RECORD; the watched child
          // crashed inside the same window for its own reasons, and this drain
          // then failed on a residual it could not confirm. The watch is gone
          // either way, so the exemption must not be the thing that leaves the
          // session holding only a causeless SIGTERM line.
          live = live.filter(entry => entry.tool !== 'command')
          throw new Error('process-drain-failed')
        }
        if (options.drainThrows === true) {
          // A partially-failed drain: it took the command watch and then threw on
          // a residual it could not confirm. The ws watch's socket happens to
          // close in the same window — for its own reasons, not this drain's.
          live = []
          throw new Error('process-drain-failed')
        }
        live = live.filter(entry => entry.tool !== 'command')
        return ['process_watch']
      },
    }
    return {
      manager,
      managed,
      drains,
      liveIds: () => ((manager as any).sessionMonitors.list() as { id: string }[]).map(entry => entry.id),
      notices: () => (managed as unknown as { pendingTaskNotifications?: string[] }).pendingTaskNotifications ?? [],
    }
  }

  test.each([
    ['a restart-required runtime change', true],
    ['a runtime config refresh', false],
  ] as const)('spares the watch on %s, and so has nothing to report', async (_label, restartRequired) => {
    const h = watchHarness()

    await (h.manager as any).runAgentRuntimeRefresh(
      h.managed,
      { connection: undefined, provider: 'pi', authType: undefined, resolvedModel: undefined },
      'runtime-signature',
      'restart-signature',
      restartRequired,
      'test',
    )

    expect(h.drains).toEqual([{ keepSemanticIds: ['monitor'] }])
    expect(h.liveIds()).toEqual(['process_watch', 'monitor_ws_1'])
    // Nothing was taken, so there is nothing to be honest about.
    expect(h.notices()).toEqual([])
    ;(h.manager as any).sessions.clear()
    await h.manager.cleanup()
  })

  test('stops the watch on every other teardown and names the watch and the reason', async () => {
    const h = watchHarness()

    await (h.manager as any).disposeManagedAgentRuntime(h.managed, 'workspace drain', true)

    expect(h.drains).toEqual([undefined])
    expect(h.liveIds()).toEqual(['monitor_ws_1'])
    // ONE notice: the ws watch held no process, so the drain did not end it and
    // it is not reported as though it had.
    expect(h.notices()).toHaveLength(1)
    const notice = h.notices()[0]!
    expect(notice).toContain('process_watch')
    expect(notice).toContain('tail the build log')
    expect(notice).toContain('workspace drain')
    ;(h.manager as any).sessions.clear()
    await h.manager.cleanup()
  })

  test('still reports the watches a FAILED drain took, and never a ws watch', async () => {
    // The failure arm has no list of stopped handles to consult, so the notice
    // falls back to the registry's before/after difference — which is also the
    // one place a `ws` watch could be misattributed, since nothing else
    // distinguishes "gone" from "gone because of this drain".
    const h = watchHarness({ drainThrows: true })

    await (h.manager as any).disposeManagedAgentRuntime(h.managed, 'session close', false)

    expect(h.notices()).toHaveLength(1)
    expect(h.notices()[0]!).toContain('process_watch')
    expect(h.notices()[0]!).toContain('session close')
    expect(h.notices().join('\n')).not.toContain('monitor_ws_1')
    ;(h.manager as any).sessions.clear()
    await h.manager.cleanup()
  })

  /**
   * P2.166 · the third teardown of P2.139's shape, and the one with no
   * complication: a plugin runtime refresh replaces the runtime and keeps the
   * session, so a watch a user set up has no more to do with a plugin being
   * installed than it had with a model being changed.
   *
   * Driven at `refreshPluginRuntimeNow` because that is the whole plugin path's
   * one choke point — the idle refresh and the deferred one both land there — so
   * the source check below stands in for the "a caller forgot to pass it"
   * defect that drove P2.139 to test one level up.
   */
  test('spares the watch on a plugin runtime refresh, and so has nothing to report', async () => {
    const h = watchHarness()

    await (h.manager as any).refreshPluginRuntimeNow(h.managed, 'plugin runtime refresh')

    expect(h.drains).toEqual([{ keepSemanticIds: ['monitor'] }])
    expect(h.liveIds()).toEqual(['process_watch', 'monitor_ws_1'])
    // Nothing was taken, so there is nothing to be honest about.
    expect(h.notices()).toEqual([])

    // Neither plugin entry point may dispose on its own: a second dispose site
    // is exactly how this exemption would go quiet for half the plugin paths.
    const source = readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')
    for (const caller of ['invalidatePluginRuntimeForSession', 'flushPendingPluginRuntimeRefresh']) {
      const start = source.indexOf(`private async ${caller}(`)
      expect(start).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf('\n  }\n', start) + 5)
      expect(body).toContain('refreshPluginRuntimeNow(')
      expect(body).not.toContain('disposeManagedAgentRuntime(')
    }
    ;(h.manager as any).sessions.clear()
    await h.manager.cleanup()
  })

  test('reports a spared watch that ended anyway, naming the plugin refresh', async () => {
    // The half the owner warned about. Sparing the record must not buy silence
    // about the residue it cannot cover: if the watched child dies inside the
    // refresh window and the drain then fails, the watch is as gone as one this
    // teardown took, and its own exit line still names no cause.
    const h = watchHarness({ keptWatchDiesAnyway: true })

    await expect((h.manager as any).refreshPluginRuntimeNow(h.managed, 'plugin_manage:install'))
      .rejects.toThrow()

    // The exemption was asked for on this path...
    expect(h.drains).toEqual([{ keepSemanticIds: ['monitor'] }])
    // ...and it did not silence the residue.
    expect(h.notices()).toHaveLength(1)
    expect(h.notices()[0]!).toContain('process_watch')
    expect(h.notices()[0]!).toContain('plugin_manage:install')
    expect(h.notices().join('\n')).not.toContain('monitor_ws_1')
    ;(h.manager as any).sessions.clear()
    await h.manager.cleanup()
  })
})

/**
 * P6.116 — one RPC gated sixteen actions on the provider, and two of them are
 * the SUPERVISOR's, not the Pi harness's.
 *
 * The supervisor is host-side and `SessionKey`-scoped and its payload is a
 * `handle`. The real user route already crosses the boundary — `killShell`
 * sends a non-Pi handle to `backend.stopBackgroundTask` and a Pi one to
 * `piProcessSupervisor.stop` with no provider check — and the runtime
 * snapshot's non-Pi branch already LISTS the same processes. So a claude
 * session could hold a supervised process, see it, and neither read nor stop
 * it, for no reason but this one gate.
 */
describe('P6.116 · supervisor-scoped control actions on a non-Pi session', () => {
  function controlHarness(provider: string) {
    const manager = createTestSessionManager() as any
    const stopped: unknown[] = []
    manager.piProcessSupervisor = {
      stop: async (request: unknown) => { stopped.push(request) },
      read: async () => ({ output: 'supervised output', nextCursor: 12 }),
    }
    manager.piChildSessionServices = new Map()
    manager.resolveManagedProvider = () => provider
    // The tail of every non-`return` action is an invalidation emit, which walks
    // the goal-continuation scheduler; stubbed so the row measures the GATE and
    // the supervisor call rather than the notification path.
    manager.emitPiHarnessInvalidation = () => {}
    const managed = { id: 'session-p6116', workspace: { id: 'workspace-p6116' } }
    manager.getManaged = () => managed
    manager.managedKey = () => 'workspace-p6116:session-p6116'
    return { manager, stopped }
  }

  const session = { workspaceId: 'workspace-p6116', sessionId: 'session-p6116' }

  test('a claude session can stop and read its own supervised process', async () => {
    const { manager, stopped } = controlHarness('anthropic')

    const stop = await manager.controlPiHarnessRuntime({
      schemaVersion: 1, session, action: 'stop_process', handle: 'process-7',
    })
    expect(stop.ok).toBe(true)
    // The handle reached the supervisor unchanged and scoped to this session —
    // the assertion that separates "the gate was relaxed" from "the call was
    // swallowed".
    expect(stopped).toEqual([{ sessionKey: session, handle: 'process-7' }])

    const read = await manager.controlPiHarnessRuntime({
      schemaVersion: 1, session, action: 'read_process', handle: 'process-7',
    })
    expect(read).toMatchObject({ ok: true, output: 'supervised output', nextCursor: 12 })
  })

  test('the Pi harness constructs still refuse on a non-Pi session, by name', async () => {
    // The negative, and the reason the gate is per ACTION rather than removed:
    // `read_child` / `steer_child` / `stop_child` really are Pi constructs, and
    // so is everything hanging off a service built only on the Pi path.
    const { manager } = controlHarness('codex-runtime')
    for (const request of [
      { action: 'read_child', agentId: 'agent-1' },
      { action: 'steer_child', agentId: 'agent-1', message: 'hi' },
      { action: 'stop_child', agentId: 'agent-1' },
      { action: 'answer_ask', requestId: 'r1', answer: 'yes' },
      { action: 'refresh' },
    ]) {
      await expect(manager.controlPiHarnessRuntime({ schemaVersion: 1, session, ...request }))
        .rejects.toThrow('pi-runtime-provider-required')
    }
  })

  test('a Pi session is unchanged — both actions still reach the same supervisor', async () => {
    // The control that proves the widening did not move the Pi path: same two
    // actions, same result, on the provider that always had them.
    const { manager, stopped } = controlHarness('pi')

    await manager.controlPiHarnessRuntime({
      schemaVersion: 1, session, action: 'stop_process', handle: 'process-9',
    })
    expect(stopped).toEqual([{ sessionKey: session, handle: 'process-9' }])
  })
})
