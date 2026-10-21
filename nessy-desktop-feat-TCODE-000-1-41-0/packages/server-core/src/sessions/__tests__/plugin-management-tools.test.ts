import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PluginActivationTarget,
  PluginKey,
  PluginManagementApi,
  PluginManagementInstalledSummary,
  PluginManagementInstallResult,
} from '@nessy-agent/shared/plugins'
import { MarketplaceProposalRegistry, proposeRepositoryInstall } from '@nessy-agent/shared/marketplace'
import { createPluginManagementTools } from '@nessy-agent/shared/agent'
import {
  onCapabilityCatalogInvalidation,
  type CapabilityCatalogInvalidation,
} from '@nessy-agent/shared/capabilities/invalidation'
import {
  createNodeFileSystem,
  SESSION_TOOL_REGISTRY,
  type SessionToolContext,
} from '@nessy-agent/session-tools-core'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import { createManagedSession, SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** Minimal fake RpcServer that only records `push` calls (mirrors the fake in `handlers/rpc/__tests__/plugins.test.ts`). */
function createFakeRpcServer(): { server: RpcServer; pushCalls: Array<{ channel: string; target: unknown; args: unknown[] }> } {
  const pushCalls: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const server: RpcServer = {
    handle() {},
    push(channel, target, ...args) { pushCalls.push({ channel, target, args }) },
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  return { server, pushCalls }
}

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

/**
 * In-memory `PluginManagementApi` fake with the same install/activation
 * semantics `PluginManagementServiceV2` guarantees (A7): a partial-compatibility
 * package installs but auto-activation is suppressed with
 * `requiresConfirmation: true`; enable/disable only flip an activation flag —
 * neither ever touches executable trust. Matches the fake used by
 * `handlers/rpc/__tests__/plugins.test.ts` for the same reason:
 * PluginManagementServiceV2 is package-internal to `@nessy-agent/shared` and
 * not part of its public export surface.
 */
function createFakePluginManagement(options: { forcePartial?: boolean; pruneOrphans?: string[] } = {}): {
  api: PluginManagementApi
  activation: Map<PluginKey, boolean>
  calls: string[]
} {
  let counter = 0
  const installed = new Map<PluginKey, PluginManagementInstalledSummary>()
  const activation = new Map<PluginKey, boolean>()
  const calls: string[] = []

  const api: PluginManagementApi = {
    async status() {
      return { installed: [...installed.values()], diagnostics: [] }
    },
    async install(source, opts) {
      calls.push('install')
      counter += 1
      const pluginKey = `local.toolkit-${counter}`
      const summary: PluginManagementInstalledSummary = {
        pluginKey,
        activeInstanceId: `instance-${counter}`,
        marketplaceId: 'local',
        pluginId: 'toolkit',
        version: '1.0.0',
        name: 'toolkit',
        installedAt: Date.now(),
        capabilityKinds: ['skill'],
        diagnostics: [],
        ...(options.forcePartial ? { compatibility: { format: 'nessy', state: 'partial', supportedKinds: ['skill'], deferred: [], blocked: [] } } : {}),
      }
      installed.set(pluginKey, summary);
      void source
      // Installation is the consent boundary, so a PARTIAL package activates its
      // supported subset in the requested scope exactly like a fully supported
      // one; only its unsupported declarations stay unavailable. The fake used to
      // withhold activation for a partial package, which modelled the removed
      // `allowPartial` gate rather than the shipped service.
      if (opts?.activateIn) activation.set(pluginKey, true)
      const result: PluginManagementInstallResult = {
        ok: true,
        installed: summary,
        diagnostics: [],
        ...(summary.compatibility ? { compatibility: summary.compatibility } : {}),
        // No `requiresConfirmation` on install: the supported subset is already
        // active, so there is nothing for the caller to confirm. The install
        // handler does not forward the field at all — it survives only on the
        // update/repair path, which stays fail-closed.
      }
      return result
    },
    async enable(pluginKey: PluginKey, _target: PluginActivationTarget) {
      calls.push('enable')
      activation.set(pluginKey, true)
      return installed.get(pluginKey)!
    },
    async disable(pluginKey: PluginKey, _target: PluginActivationTarget) {
      calls.push('disable')
      activation.set(pluginKey, false)
      return installed.get(pluginKey)!
    },
    async setCapabilityEnabled(pluginKey: PluginKey) {
      calls.push('set-capability-enabled')
      return installed.get(pluginKey)!
    },
    async configurationStatus() {
      return { state: 'not-required', fields: [] }
    },
    async configure() {
      return { state: 'not-required', fields: [] }
    },
    async clearConfiguration() {
      return { state: 'not-required', fields: [] }
    },
    async repair(pluginKey: PluginKey) {
      calls.push('repair')
      return {
        ok: true,
        installed: installed.get(pluginKey),
        diagnostics: [],
        ...(options.forcePartial ? {
          compatibility: { format: 'nessy' as const, state: 'partial' as const, supportedKinds: ['skill' as const], deferred: [], blocked: [] },
          requiresConfirmation: true,
        } : {}),
      }
    },
    async update(pluginKey: PluginKey) {
      calls.push('update')
      return {
        ok: true,
        installed: installed.get(pluginKey),
        diagnostics: [],
        ...(options.forcePartial ? {
          compatibility: { format: 'nessy' as const, state: 'partial' as const, supportedKinds: ['skill' as const], deferred: [], blocked: [] },
          requiresConfirmation: true,
        } : {}),
      }
    },
    // P6.437 — the fake records the DECISION as well as the call, so a
    // `keepData` that never reached the service would show up here as
    // `uninstall` rather than `uninstall:keep-data`.
    async uninstall(pluginKey: PluginKey, options?: { keepData?: boolean }) {
      calls.push(options?.keepData ? 'uninstall:keep-data' : 'uninstall')
      installed.delete(pluginKey)
      activation.delete(pluginKey)
      return options?.keepData ? { keptDataPath: `/fake/plugin-data/${pluginKey}` } : {}
    },
    // P6.557 — the fake records the verb and its dry-run flag, so a `prune`
    // that never reached the service, or reached it without `dryRun`, is
    // visible in `calls` rather than hidden behind a plausible payload.
    async pruneDependencies(pruneOptions) {
      calls.push(pruneOptions?.dryRun ? 'prune:dry-run' : 'prune')
      const orphans = options.pruneOrphans ?? []
      if (!pruneOptions?.dryRun) for (const key of orphans) installed.delete(key as PluginKey)
      return {
        removed: orphans.map(key => ({ pluginKey: key as PluginKey, name: key, marketplaceId: 'local' })),
        kept: [],
        userInstalledCount: installed.size,
        dryRun: pruneOptions?.dryRun === true,
      }
    },
    async refresh() {
      return { installed: [...installed.values()], diagnostics: [] }
    },
  }
  return { api, activation, calls }
}

/**
 * Builds a SessionToolContext with `pluginManagement` wired EXACTLY the way
 * SessionManager wires it per-session (see `mergeSessionScopedToolCallbacks`
 * in `getOrCreateAgent`): `createPluginManagementTools()` bound to the
 * server-owned deps, with `afterMutation` calling the SAME
 * `SessionManager.refreshPluginRuntime` used in production — proving the
 * SessionManager integration boundary without needing a live LLM subprocess
 * (ClaudeAgent/PiAgent always spawn a real process, out of scope for this
 * focused unit; the lazy callback-registry indirection itself is covered by
 * `agent/__tests__/session-self-management-bindings.test.ts`).
 */
function toolContextWithPluginManagement(options: {
  sm: SessionManager
  workspaceId: string
  sessionId: string
  pluginManagement: PluginManagementApi
  proposalRegistry: MarketplaceProposalRegistry
}): SessionToolContext {
  const workspacePath = `/tmp/plugin-mgmt-${options.workspaceId}`
  const ctx: SessionToolContext = {
    configRoot: workspacePath,
    sessionId: options.sessionId,
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources') },
    get skillsPath() { return join(workspacePath, 'skills') },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
    fs: createNodeFileSystem(),
    loadSourceConfig: () => null,
    pluginManagement: createPluginManagementTools({
      pluginManagement: options.pluginManagement,
      marketplaceService: {
        proposeInstall: request => proposeRepositoryInstall(request),
        inspect: async () => { throw new Error('inspect not used in this fixture') },
        // D1: the agent install enters at the marketplace door. This fixture
        // exercises the SessionManager wiring, not dependency acquisition, so
        // it forwards to the same mutation boundary the door would reach.
        install: async request => options.pluginManagement.install(
          request.source!,
          { activateIn: request.activateIn ?? { kind: 'global' } },
        ),
      },
      proposalRegistry: options.proposalRegistry,
      clientId: `session:${options.workspaceId}:${options.sessionId}`,
      resolveScope: () => ({ workspaceId: options.workspaceId }),
      // The EXACT SessionManager-owned hook production wires in `getOrCreateAgent`
      // (`afterAgentPluginMutation`): refreshes live sessions AND reuses the
      // shared invalidation-emit + capabilities.CHANGED push production uses for
      // the RPC path — proving the wiring reaches the real "refreshed
      // capabilities" seam, not just the in-process session runtime refresh.
      afterMutation: (reason, target, effect) => (options.sm as unknown as {
        afterAgentPluginMutation(
          workspaceId: string,
          projectKey: undefined,
          reason: string,
          target?: PluginActivationTarget,
          effect?: 'add-or-refresh' | 'remove',
        ): Promise<void>
      }).afterAgentPluginMutation(options.workspaceId, undefined, reason, target, effect),
    }),
  }
  return ctx
}

function parseJson(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text)
}

function registerManagedSession(sm: SessionManager, workspaceId: string, sessionId: string, workspaceRoot: string): void {
  const workspace = {
    id: workspaceId,
    name: workspaceId,
    slug: workspaceId,
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  ;(sm as unknown as { workspaceService: { resolve(id: string): unknown } }).workspaceService.resolve(workspaceId)
  const managed = createManagedSession({ id: sessionId }, workspace, { messagesLoaded: true, ephemeral: true })
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
}

describe('plugin management tools — SessionManager integration', () => {
  it('plans a repository install, installs it, refreshes runtime, and reports status — without granting trust', async () => {
    const dir = root('plugin-mgmt-tools-sm-')
    const { api, activation, calls } = createFakePluginManagement()
    const proposalRegistry = new MarketplaceProposalRegistry()
    const sm = createTestSessionManager()
    const workspaceId = 'ws-plugin-mgmt'
    const sessionId = 'session-plugin-mgmt'
    registerManagedSession(sm, workspaceId, sessionId, join(dir, 'workspace'))

    const ctx = toolContextWithPluginManagement({ sm, workspaceId, sessionId, pluginManagement: api, proposalRegistry })

    // 1. Plan an internal/repository install (offline detection, no network —
    // MarketplaceService.proposeInstall delegates to the pure proposeRepositoryInstall).
    const planHandler = SESSION_TOOL_REGISTRY.get('plugin_plan_install')!.handler!
    const planResult = await planHandler(ctx, { repositoryUrl: 'https://github.com/acme/widgets' })
    expect(planResult.isError).not.toBe(true)
    const plan = parseJson(planResult)
    expect(plan.status).toBe('installable')
    expect(typeof plan.proposalId).toBe('string')
    // Proposal DTO never carries the raw structured install source.
    expect(plan).not.toHaveProperty('source')

    // 2. Install using the SAME proposalId returned by plugin_plan_install — the
    // ONLY channel from plan to install; no raw path/URL/command is ever passed.
    const installHandler = SESSION_TOOL_REGISTRY.get('plugin_install')!.handler!
    const installResult = await installHandler(ctx, { proposalId: plan.proposalId })
    expect(installResult.isError).not.toBe(true)
    const installed = parseJson(installResult)
    expect(installed.ok).toBe(true)
    expect(typeof installed.pluginKey).toBe('string')
    expect(activation.get(installed.pluginKey)).toBe(true)
    expect(calls).toEqual(['install'])

    // afterMutation reached SessionManager.refreshPluginRuntime without throwing
    // even though this fixture session has no live agent (managed.agent === null) —
    // refreshPluginRuntime no-ops per-session in that case but must not reject.

    // 3. Report status.
    const statusHandler = SESSION_TOOL_REGISTRY.get('plugin_status')!.handler!
    const statusResult = await statusHandler(ctx, {})
    const status = parseJson(statusResult)
    expect(status.installed).toHaveLength(1)
    expect(status.installed[0]!.pluginKey).toBe(installed.pluginKey)

    // 4. Trust is never mentioned anywhere in the install/status payloads —
    // this module never touches CapabilityTrustStore; only the user's
    // explicit A7 trust-grant RPC does.
    expect(JSON.stringify(installed)).not.toMatch(/trust/i)
    expect(JSON.stringify(status)).not.toMatch(/trust/i)
  })

  it('plugin_install activates a partial package\'s supported subset, and plugin_manage reaches enable/disable/uninstall', async () => {
    const dir = root('plugin-mgmt-tools-manage-')
    const { api, activation, calls } = createFakePluginManagement({ forcePartial: true })
    const proposalRegistry = new MarketplaceProposalRegistry()
    const sm = createTestSessionManager()
    const workspaceId = 'ws-plugin-manage'
    const sessionId = 'session-plugin-manage'
    registerManagedSession(sm, workspaceId, sessionId, join(dir, 'workspace'))

    const ctx = toolContextWithPluginManagement({ sm, workspaceId, sessionId, pluginManagement: api, proposalRegistry })

    const proposalId = proposalRegistry.issue({
      clientId: `session:${workspaceId}:${sessionId}`,
      source: { kind: 'local-path', path: '/tmp/does-not-matter-for-fake' },
      displaySource: 'local',
      detectedFormat: 'nessy-plugin',
    }).proposalId

    const installHandler = SESSION_TOOL_REGISTRY.get('plugin_install')!.handler!
    const installed = parseJson(await installHandler(ctx, { proposalId }))
    expect(installed.ok).toBe(true)
    // Installation is the consent boundary: a partial package activates its
    // SUPPORTED subset immediately and asks for no second confirmation.
    // `allowPartial` is a deprecated compatibility no-op, so there is nothing
    // left for the caller to confirm — unsupported declarations simply stay
    // unavailable.
    expect(installed.requiresConfirmation).toBeUndefined()
    expect(activation.get(installed.pluginKey)).toBe(true)

    const pluginKey = installed.pluginKey as string
    const manageHandler = SESSION_TOOL_REGISTRY.get('plugin_manage')!.handler!

    // enable/disable reach the same PluginManagementApi instance by pluginKey.
    const enableResult = await manageHandler(ctx, { pluginKey, action: 'enable' })
    expect(enableResult.isError).not.toBe(true)
    expect(activation.get(pluginKey)).toBe(true)
    expect(JSON.stringify(parseJson(enableResult))).not.toMatch(/trust/i)

    const disableResult = await manageHandler(ctx, { pluginKey, action: 'disable' })
    expect(disableResult.isError).not.toBe(true)
    expect(activation.get(pluginKey)).toBe(false)

    const uninstallResult = await manageHandler(ctx, { pluginKey, action: 'uninstall' })
    expect(uninstallResult.isError).not.toBe(true)
    expect(calls).toEqual(['install', 'enable', 'disable', 'uninstall'])
    // P6.437 — delete-by-default is the page's posture, so the default call
    // carries no retention and the result reports no path.
    expect(JSON.parse(uninstallResult.content[0]!.text!).keptDataPath).toBeUndefined()
  })

  it('P6.437 — plugin_manage(uninstall, keepData) reaches the service and reports the retained path', async () => {
    // `plugins/cli-reference.md#plugin-uninstall`: `--keep-data` "Preserve the
    // plugin's persistent data directory". The tool is the surface all three
    // runtimes reach, so the flag is host-supplied once rather than per runtime.
    const dir = root('plugin-mgmt-tools-keep-data-')
    const { api, calls } = createFakePluginManagement()
    const proposalRegistry = new MarketplaceProposalRegistry()
    const sm = createTestSessionManager()
    const workspaceId = 'ws-plugin-keep-data'
    const sessionId = 'session-plugin-keep-data'
    registerManagedSession(sm, workspaceId, sessionId, join(dir, 'workspace'))
    const ctx = toolContextWithPluginManagement({ sm, workspaceId, sessionId, pluginManagement: api, proposalRegistry })

    const proposalId = proposalRegistry.issue({
      clientId: `session:${workspaceId}:${sessionId}`,
      source: { kind: 'local-path', path: '/tmp/does-not-matter-for-fake' },
      displaySource: 'local',
      detectedFormat: 'nessy-plugin',
    }).proposalId
    const installed = parseJson(await SESSION_TOOL_REGISTRY.get('plugin_install')!.handler!(ctx, { proposalId }))
    const pluginKey = installed.pluginKey as string

    const result = await SESSION_TOOL_REGISTRY.get('plugin_manage')!.handler!(
      ctx,
      { pluginKey, action: 'uninstall', keepData: true },
    )

    expect(result.isError).not.toBe(true)
    expect(calls).toEqual(['install', 'uninstall:keep-data'])
    expect(parseJson(result).keptDataPath).toBe(`/fake/plugin-data/${pluginKey}`)
  })

  it('P6.557 — plugin_manage(prune) needs no pluginKey, and dryRun removes nothing', async () => {
    // `plugins/cli-reference.md#plugin-prune` takes only `--scope`, `--dry-run` and
    // `--yes`: there is no plugin argument, so the tool's pluginKey check has to
    // stop applying to exactly this one action and to no other.
    const dir = root('plugin-mgmt-tools-prune-')
    const { api, calls } = createFakePluginManagement({ pruneOrphans: ['local.vault'] })
    const sm = createTestSessionManager()
    const workspaceId = 'ws-plugin-prune'
    const sessionId = 'session-plugin-prune'
    registerManagedSession(sm, workspaceId, sessionId, join(dir, 'workspace'))
    const ctx = toolContextWithPluginManagement({
      sm,
      workspaceId,
      sessionId,
      pluginManagement: api,
      proposalRegistry: new MarketplaceProposalRegistry(),
    })
    const manageHandler = SESSION_TOOL_REGISTRY.get('plugin_manage')!.handler!

    const preview = await manageHandler(ctx, { action: 'prune', dryRun: true })
    expect(preview.isError).not.toBe(true)
    expect(parseJson(preview).dryRun).toBe(true)
    expect(parseJson(preview).removed).toHaveLength(1)

    const applied = await manageHandler(ctx, { action: 'prune' })
    expect(applied.isError).not.toBe(true)
    expect(calls).toEqual(['prune:dry-run', 'prune'])

    // Every other action still refuses without a key — the check moved, it did
    // not go away.
    const missingKey = await manageHandler(ctx, { action: 'uninstall' })
    expect(missingKey.isError).toBe(true)
  })

  it('reports "not available in this context" when no plugin management deps are wired for the session', async () => {
    const workspacePath = '/tmp/plugin-mgmt-ws-no-plugins'
    const ctx: SessionToolContext = {
      configRoot: workspacePath,
      sessionId: 'session-no-plugins',
      workspacePath,
      get sourcesPath() { return join(workspacePath, 'sources') },
      get skillsPath() { return join(workspacePath, 'skills') },
      plansFolderPath: join(workspacePath, 'plans'),
      callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
      fs: createNodeFileSystem(),
      loadSourceConfig: () => null,
      // pluginManagement intentionally omitted.
    }
    const planHandler = SESSION_TOOL_REGISTRY.get('plugin_plan_install')!.handler!
    const result = await planHandler(ctx, { repositoryUrl: 'https://github.com/acme/widgets' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('not available in this context')
  })
})

describe('plugin management tools — full afterPluginMutation semantics (refresh + invalidation + push)', () => {
  it('agent-driven removal publishes invalidation before waiting for runtime teardown', async () => {
    const sm = createTestSessionManager()
    const { server, pushCalls } = createFakeRpcServer()
    sm.setRpcServer(server)
    let signalRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => { signalRefreshStarted = resolve })
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
    sm.refreshPluginRuntime = async () => {
      signalRefreshStarted()
      await refreshGate
      // P2.107 — the method now reports per-session outcomes; this stub touches
      // no session, so nothing was applied, deferred or skipped.
      return { applied: 0, deferred: 0, untouched: 0 }
    }
    const catalogEvents: CapabilityCatalogInvalidation[] = []
    const unsubscribe = onCapabilityCatalogInvalidation(event => { catalogEvents.push(event) })
    const pending = (sm as unknown as {
      afterAgentPluginMutation(
        workspaceId: string,
        projectKey: undefined,
        reason: string,
      ): Promise<void>
    }).afterAgentPluginMutation('ws-agent-order', undefined, 'plugin_manage:disable')

    await refreshStarted
    try {
      expect(catalogEvents).toHaveLength(1)
      expect(catalogEvents[0]).toMatchObject({
        scope: { kind: 'workspace', workspaceId: 'ws-agent-order' },
        effect: 'revoke-active-snapshot',
      })
      expect(pushCalls.map(call => call.channel)).toEqual([RPC_CHANNELS.capabilities.CHANGED])
    } finally {
      releaseRefresh()
      await pending
      unsubscribe()
      sm.cleanup()
    }
  })

  it('plugin_install emits a capability catalog invalidation and pushes capabilities.CHANGED, not just refreshPluginRuntime', async () => {
    const dir = root('plugin-mgmt-tools-full-install-')
    const { api } = createFakePluginManagement()
    const proposalRegistry = new MarketplaceProposalRegistry()
    const sm = createTestSessionManager()
    const { server, pushCalls } = createFakeRpcServer()
    sm.setRpcServer(server)
    const workspaceId = 'ws-plugin-full-install'
    const sessionId = 'session-plugin-full-install'
    registerManagedSession(sm, workspaceId, sessionId, join(dir, 'workspace'))

    const ctx = toolContextWithPluginManagement({ sm, workspaceId, sessionId, pluginManagement: api, proposalRegistry })

    const catalogEvents: CapabilityCatalogInvalidation[] = []
    const unsubscribe = onCapabilityCatalogInvalidation(event => { catalogEvents.push(event) })

    try {
      const planHandler = SESSION_TOOL_REGISTRY.get('plugin_plan_install')!.handler!
      const planResult = await planHandler(ctx, { repositoryUrl: 'https://github.com/acme/widgets' })
      const plan = parseJson(planResult)

      const installHandler = SESSION_TOOL_REGISTRY.get('plugin_install')!.handler!
      const installResult = await installHandler(ctx, { proposalId: plan.proposalId })
      expect(installResult.isError).not.toBe(true)
    } finally {
      unsubscribe()
    }

    // (b) installation mutates the global bundle inventory even when its
    // activation target is scoped, so every Workspace runtime is invalidated.
    const globalEvents = catalogEvents.filter(event => event.scope.kind === 'global')
    expect(globalEvents.length).toBeGreaterThan(0)
    expect(globalEvents[0]!.effect).toBe('refresh-before-next-turn')

    // (c) capabilities.CHANGED was pushed to the renderer via the SAME RpcServer
    // the RPC-path afterPluginMutation uses — proving the agent path reaches the
    // live renderer refresh, not just the in-process session runtime refresh.
    const capabilitiesPushes = pushCalls.filter(call => call.channel === RPC_CHANNELS.capabilities.CHANGED)
    expect(capabilitiesPushes.length).toBeGreaterThan(0)
    expect(capabilitiesPushes[0]!.args[0]).toMatchObject({ workspaceId, reasonCode: 'plugin-runtime-changed' })
  })

  it('plugin_manage(uninstall) emits a "remove" capability catalog invalidation and pushes capabilities.CHANGED', async () => {
    const dir = root('plugin-mgmt-tools-full-uninstall-')
    const { api } = createFakePluginManagement()
    const proposalRegistry = new MarketplaceProposalRegistry()
    const sm = createTestSessionManager()
    const { server, pushCalls } = createFakeRpcServer()
    sm.setRpcServer(server)
    const workspaceId = 'ws-plugin-full-uninstall'
    const sessionId = 'session-plugin-full-uninstall'
    registerManagedSession(sm, workspaceId, sessionId, join(dir, 'workspace'))

    const ctx = toolContextWithPluginManagement({ sm, workspaceId, sessionId, pluginManagement: api, proposalRegistry })

    const proposalId = proposalRegistry.issue({
      clientId: `session:${workspaceId}:${sessionId}`,
      source: { kind: 'local-path', path: '/tmp/does-not-matter-for-fake' },
      displaySource: 'local',
      detectedFormat: 'nessy-plugin',
    }).proposalId

    const installHandler = SESSION_TOOL_REGISTRY.get('plugin_install')!.handler!
    const installed = parseJson(await installHandler(ctx, { proposalId }))
    const pluginKey = installed.pluginKey as string

    const catalogEvents: CapabilityCatalogInvalidation[] = []
    const unsubscribe = onCapabilityCatalogInvalidation(event => { catalogEvents.push(event) })
    pushCalls.length = 0

    try {
      const manageHandler = SESSION_TOOL_REGISTRY.get('plugin_manage')!.handler!
      const uninstallResult = await manageHandler(ctx, { pluginKey, action: 'uninstall' })
      expect(uninstallResult.isError).not.toBe(true)
    } finally {
      unsubscribe()
    }

    const globalEvents = catalogEvents.filter(event => event.scope.kind === 'global')
    expect(globalEvents.length).toBeGreaterThan(0)
    // uninstall is a removal — the resolver must revoke the active snapshot
    // immediately rather than waiting for the next turn.
    expect(globalEvents[0]!.effect).toBe('revoke-active-snapshot')

    const capabilitiesPushes = pushCalls.filter(call => call.channel === RPC_CHANNELS.capabilities.CHANGED)
    expect(capabilitiesPushes.length).toBeGreaterThan(0)
    expect(capabilitiesPushes[0]!.args[0]).toMatchObject({ workspaceId, reasonCode: 'plugin-runtime-changed', effect: 'revoke-active-snapshot' })
  })

  it('plugin_manage(partial repair) immediately revokes the active capability snapshot', async () => {
    const { api } = createFakePluginManagement({ forcePartial: true })
    const proposalRegistry = new MarketplaceProposalRegistry()
    const sm = createTestSessionManager()
    const { server, pushCalls } = createFakeRpcServer()
    sm.setRpcServer(server)
    const workspaceId = 'ws-plugin-partial-repair'
    const sessionId = 'session-plugin-partial-repair'
    registerManagedSession(sm, workspaceId, sessionId, root('plugin-mgmt-tools-partial-repair-'))

    const installed = await api.install({ kind: 'local-path', path: '/tmp/fake' })
    const pluginKey = installed.installed!.pluginKey
    const ctx = toolContextWithPluginManagement({ sm, workspaceId, sessionId, pluginManagement: api, proposalRegistry })
    const catalogEvents: CapabilityCatalogInvalidation[] = []
    const unsubscribe = onCapabilityCatalogInvalidation(event => { catalogEvents.push(event) })
    try {
      const manageHandler = SESSION_TOOL_REGISTRY.get('plugin_manage')!.handler!
      const result = await manageHandler(ctx, { pluginKey, action: 'repair' })
      expect(result.isError).not.toBe(true)
    } finally {
      unsubscribe()
      sm.cleanup()
    }

    expect(catalogEvents).toContainEqual(expect.objectContaining({
      scope: { kind: 'global' },
      effect: 'revoke-active-snapshot',
    }))
    expect(pushCalls.at(-1)?.args[0]).toMatchObject({ effect: 'revoke-active-snapshot' })
  })
})
