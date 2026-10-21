/**
 * F1.211 (origin WJ-n P-WJ-n-1, MEDIUM) — the agent's `plugin_install` never
 * tells the model that an install which LANDED failed.
 *
 * Measured live by WJ-n on the packaged 1.40.0 (AGENT-INSTALL, 2026-09-23): with a
 * codex session in the workspace, the tool answered
 * `[ERROR] plugin_install failed: codex-runtime-session-disposal-failed` while
 * `installed.json` carried the plugin; the UI channel, same profile, same hour,
 * answered `ok: true` with no `runtimeRefresh` field.
 *
 * Where it comes from, read before the fix: the tool's `afterMutation` is bound
 * to `SessionManager.afterAgentPluginMutation`, which awaits
 * `refreshPluginRuntime` → `invalidatePluginRuntimeForSession` →
 * `refreshPluginRuntimeNow` → `disposeManagedAgentRuntime(…, strict = true)`. A
 * strict dispose that fails throws `AggregateError(…,
 * sessionDisposalFailureMessage(provider))`, `Promise.all` in
 * `refreshPluginRuntime` rejects with it, and `plugin-management-tools.ts`'s
 * `install` caught it in the SAME `catch` as a failed install. The UI channel
 * (`afterPluginMutation`, `handlers/rpc/plugin-runtime-refresh.ts`) wraps the
 * same refresh in a fail-soft catch and answers "cannot say" instead.
 *
 * The rig drives the real session tool handler over the real
 * `afterAgentPluginMutation`, the real refresh and the real strict dispose. The
 * one planted fact is the idle codex session's runtime: an agent whose
 * `disposeForRestart` rejects with the codex cleanup shape (`codex-agent.ts`
 * throws `AggregateError(…, 'codex-runtime-cleanup-failed')`, P3.341), and a
 * provider answer of `codex-runtime` for that one session so the host names it
 * the way the live reading did.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PluginActivationTarget,
  PluginKey,
  PluginManagementApi,
  PluginManagementInstalledSummary,
} from '@nessy-agent/shared/plugins'
import { MarketplaceProposalRegistry, proposeRepositoryInstall } from '@nessy-agent/shared/marketplace'
import { createPluginManagementTools } from '@nessy-agent/shared/agent'
import { createNodeFileSystem, SESSION_TOOL_REGISTRY, type SessionToolContext } from '@nessy-agent/session-tools-core'
import { afterPluginMutation, describeRuntimeRefreshVerdict } from '../../handlers/rpc/plugin-runtime-refresh.ts'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Just the verbs these arms reach; every other member is never called. */
function fakePluginManagement() {
  const installed = new Map<PluginKey, PluginManagementInstalledSummary>()
  const calls: string[] = []
  const api = {
    async status() { return { installed: [...installed.values()], diagnostics: [] } },
    async install() {
      calls.push('install')
      const summary = {
        pluginKey: 'local.toolkit-1', activeInstanceId: 'instance-1', marketplaceId: 'local', pluginId: 'toolkit',
        version: '1.0.0', name: 'toolkit', installedAt: Date.now(), capabilityKinds: ['skill'], diagnostics: [],
      } as unknown as PluginManagementInstalledSummary
      installed.set(summary.pluginKey, summary)
      return { ok: true, installed: summary, diagnostics: [] }
    },
    async disable(pluginKey: PluginKey) {
      calls.push('disable')
      return installed.get(pluginKey)!
    },
  }
  return { api: api as unknown as PluginManagementApi, installed, calls }
}

function rig(options: { codexSession: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'f1211-'))
  roots.push(dir)
  const sm = createTestSessionManager()
  const workspaceId = 'ws-f1211'
  const workspace = { id: workspaceId, name: workspaceId, slug: workspaceId, rootPath: join(dir, 'workspace'), createdAt: Date.now() }
  const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions
  const caller = createManagedSession({ id: 'caller' }, workspace, { messagesLoaded: true, ephemeral: true })
  sessions.set(`${workspaceId}:caller`, caller)

  const disposals: string[] = []
  if (options.codexSession) {
    // An IDLE codex session with a live runtime: the refresh takes the teardown
    // path (codex publishes no in-place reload), and its teardown fails.
    const codex = createManagedSession({ id: 'codex-idle' }, workspace, { messagesLoaded: true, ephemeral: true })
    ;(codex as { agent: unknown }).agent = {
      isProcessing: () => false,
      setCapabilityTurnRuntime: () => {},
      setAutomationSystem: () => {},
      drainAutomationEvents: async () => {},
      disposeForRestart: async () => {
        disposals.push('codex-idle')
        throw new AggregateError([new Error('CODEX_HOME rm EBUSY')], 'codex-runtime-cleanup-failed')
      },
      dispose: () => {},
    }
    sessions.set(`${workspaceId}:codex-idle`, codex)
    const internals = sm as unknown as { resolveManagedProvider(managed: { id: string }): string }
    const realProvider = internals.resolveManagedProvider.bind(sm)
    internals.resolveManagedProvider = managed => managed.id === 'codex-idle' ? 'codex-runtime' : realProvider(managed as never)
  }

  const plugins = fakePluginManagement()
  const proposalRegistry = new MarketplaceProposalRegistry()
  const workspacePath = join(dir, 'workspace')
  const ctx: SessionToolContext = {
    configRoot: workspacePath,
    sessionId: 'caller',
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources') },
    get skillsPath() { return join(workspacePath, 'skills') },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
    fs: createNodeFileSystem(),
    loadSourceConfig: () => null,
    pluginManagement: createPluginManagementTools({
      pluginManagement: plugins.api,
      marketplaceService: {
        proposeInstall: request => proposeRepositoryInstall(request),
        inspect: async () => { throw new Error('inspect not used') },
        install: async request => plugins.api.install(request.source!, { activateIn: request.activateIn ?? { kind: 'global' } }),
      },
      proposalRegistry,
      clientId: `session:${workspaceId}:caller`,
      resolveScope: () => ({ workspaceId }),
      // Production's own binding (`getOrCreateAgent`): the SAME host hook.
      afterMutation: (reason, target, effect) => (sm as unknown as {
        afterAgentPluginMutation(w: string, p: undefined, r: string, t?: PluginActivationTarget, e?: 'add-or-refresh' | 'remove'): Promise<void>
      }).afterAgentPluginMutation(workspaceId, undefined, reason, target, effect),
    }),
  }
  return { sm, ctx, plugins, disposals, workspaceId }
}

async function installThroughTheTool(ctx: SessionToolContext) {
  const plan = await SESSION_TOOL_REGISTRY.get('plugin_plan_install')!.handler!(ctx, { repositoryUrl: 'https://github.com/acme/widgets' })
  const proposalId = JSON.parse(plan.content[0]!.text).proposalId as string
  return SESSION_TOOL_REGISTRY.get('plugin_install')!.handler!(ctx, { proposalId })
}

describe('F1.211 — an install that landed is never reported to the model as failed', () => {
  it('THE DEFECT — a codex session whose strict teardown fails: the tool says the install landed, and what the refresh did', async () => {
    const { sm, ctx, plugins, disposals } = rig({ codexSession: true })
    try {
      const result = await installThroughTheTool(ctx)
      // The refresh really ran and really failed (positive control on the rig).
      expect(disposals).toEqual(['codex-idle'])
      // The install LANDED.
      expect(plugins.calls).toEqual(['install'])
      expect([...plugins.installed.keys()]).toEqual(['local.toolkit-1'])
      // …and the model is told so.
      const text = result.content[0]!.text
      expect(result.isError).not.toBe(true)
      expect(text).not.toContain('plugin_install failed')
      const answer = JSON.parse(text)
      expect(answer.ok).toBe(true)
      expect(answer.pluginKey).toBe('local.toolkit-1')
      expect(answer.runtimeRefresh).toBe('failed')
      expect(answer.runtimeRefreshError).toBe('codex-runtime-session-disposal-failed')
      expect(typeof answer.runtimeRefreshNote).toBe('string')
    } finally {
      sm.cleanup()
    }
  })

  it('THE SAME CLASS on plugin_manage — a disable that landed is not reported as failed either', async () => {
    const { sm, ctx, plugins } = rig({ codexSession: true })
    try {
      await installThroughTheTool(ctx)
      const result = await SESSION_TOOL_REGISTRY.get('plugin_manage')!.handler!(ctx, { action: 'disable', pluginKey: 'local.toolkit-1' })
      expect(plugins.calls).toEqual(['install', 'disable'])
      expect(result.isError).not.toBe(true)
      const answer = JSON.parse(result.content[0]!.text)
      expect(answer).toMatchObject({ ok: true, action: 'disable', runtimeRefresh: 'failed' })
    } finally {
      sm.cleanup()
    }
  })

  it('CONTROL — no codex session: the answer is unchanged, no refresh field at all', async () => {
    const { sm, ctx, plugins } = rig({ codexSession: false })
    try {
      const result = await installThroughTheTool(ctx)
      expect(plugins.calls).toEqual(['install'])
      expect(result.isError).not.toBe(true)
      const answer = JSON.parse(result.content[0]!.text)
      // The exact key set the success answer carried before F1.211 for this fixture.
      expect(Object.keys(answer).sort()).toEqual(['diagnosticCodes', 'ok', 'pluginKey', 'setup'])
      expect(answer).not.toHaveProperty('runtimeRefresh')
      expect(answer).not.toHaveProperty('runtimeRefreshError')
      expect(answer.ok).toBe(true)
    } finally {
      sm.cleanup()
    }
  })

  it('CONTROL — the UI channel over the SAME failing refresh also answers "landed": both say ok, neither claims the refresh applied', async () => {
    const { sm, workspaceId, disposals } = rig({ codexSession: true })
    try {
      const warnings: string[] = []
      const server = { handle() {}, push() {}, async invokeClient() { return undefined }, hasClientCapability() { return false }, findClientsWithCapability() { return [] } }
      const verdict = await afterPluginMutation(server as never, {
        sessionManager: sm,
        platform: { logger: { warn: (line: string) => warnings.push(line) } },
      } as never, { workspaceId }, 'marketplace install')
      expect(disposals).toEqual(['codex-idle'])
      // F1.396 — `'failed'`, no longer `undefined` ("cannot say", which handed the summary to the renderer's
      // active-session proxy): the install summary names the failed refresh and offers the Refresh affordance.
      expect(verdict).toBe('failed')
      expect(warnings.some(line => line.includes('codex-runtime-session-disposal-failed'))).toBe(true)
    } finally {
      sm.cleanup()
    }
  })
})

/**
 * F1.211's residue on the DEFERRED path (found by this lane, fixed in zone): a
 * session busy during the install defers its refresh
 * (`markPendingPluginRuntimeRefresh`), and `onProcessingStopped` flushes it at the
 * turn end — awaited, BEFORE the renderer-facing `complete`. The same failing strict
 * dispose then rejected `onProcessingStopped` itself: the host flag was already down,
 * but no `complete` left the host (a spinner nothing lowers), the queue never
 * drained, and the rejection went unhandled because every caller fires and forgets.
 * Measured by a probe first: `REJECTED: codex-runtime-session-disposal-failed`,
 * events `[]`.
 */
describe('F1.211 residue — a deferred refresh that fails at the turn end does not cost the turn its end marker', () => {
  async function busyInstallThenTurnEnd(disposeFails: boolean) {
    const { sm, ctx, disposals } = rig({ codexSession: true })
    const codex = (sm as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get('ws-f1211:codex-idle')!
    if (!disposeFails) (codex.agent as { disposeForRestart: () => Promise<void> }).disposeForRestart = async () => { disposals.push('codex-idle') }
    codex.isProcessing = true
    const answer = JSON.parse((await installThroughTheTool(ctx)).content[0]!.text)
    const deferredBeforeTurnEnd = codex.pendingPluginRuntimeRefreshReason
    const sent: string[] = []
    sm.setEventSink(((_channel: unknown, _target: unknown, event: { type: string }) => { sent.push(event.type) }) as Parameters<typeof sm.setEventSink>[0])
    let outcome = 'resolved'
    await (sm as unknown as { onProcessingStopped(id: string, reason: string, ws: string): Promise<void> })
      .onProcessingStopped('codex-idle', 'complete', 'ws-f1211')
      .catch((error: Error) => { outcome = `rejected: ${error.message}` })
    return { sm, answer, deferredBeforeTurnEnd, disposals, sent, outcome, codex }
  }

  it('THE DEFECT — the refresh deferred behind a busy codex turn fails at its end: the turn still ends', async () => {
    const r = await busyInstallThenTurnEnd(true)
    try {
      // The install answer carried no failure: the refresh was only deferred then.
      expect(r.answer.ok).toBe(true)
      expect(r.answer).not.toHaveProperty('runtimeRefresh')
      expect(r.deferredBeforeTurnEnd).toBe('plugin_install')
      // The deferred refresh really ran at the turn end and really failed…
      expect(r.disposals).toEqual(['codex-idle'])
      // …and the turn end still happened.
      expect(r.outcome).toBe('resolved')
      expect(r.sent).toContain('complete')
    } finally {
      r.sm.cleanup()
    }
  })

  it('CONTROL — a deferred refresh whose dispose succeeds applies at the turn end, and the turn ends', async () => {
    const r = await busyInstallThenTurnEnd(false)
    try {
      expect(r.deferredBeforeTurnEnd).toBe('plugin_install')
      expect(r.disposals).toEqual(['codex-idle'])
      expect(r.outcome).toBe('resolved')
      expect(r.sent).toContain('complete')
      expect(r.codex.pendingPluginRuntimeRefreshReason).toBeUndefined()
      expect(r.codex.agent).toBeNull()
    } finally {
      r.sm.cleanup()
    }
  })
})

/**
 * F1.265 (origin WJ-y P-WJ-y-3) — one session's failed refresh no longer throws
 * away every OTHER session's outcome.
 *
 * `refreshPluginRuntime` ran the affected sessions under `Promise.all`, so the
 * first strict dispose that failed rejected the whole refresh: the sessions that
 * DID apply were refreshed but nobody could say so — the UI channel answered
 * "cannot say" and the tool channel "failed" with nothing beside it. Now every
 * session settles and the summary carries `failed` (and each failure, by
 * session) beside the counts it always had; both keys are absent when nothing
 * failed. The rig: the F1.211 caller (no runtime → `untouched`), an idle
 * codex-shaped session whose strict dispose FAILS, and a second idle one whose
 * dispose succeeds.
 */
describe('F1.265 — a refresh that fails for one session still reports every other session', () => {
  function twoSessionRig(options: { badDisposeFails: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'f1265-'))
    roots.push(dir)
    const sm = createTestSessionManager()
    const workspaceId = 'ws-f1265'
    const workspace = { id: workspaceId, name: workspaceId, slug: workspaceId, rootPath: join(dir, 'workspace'), createdAt: Date.now() }
    const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set(`${workspaceId}:caller`, createManagedSession({ id: 'caller' }, workspace, { messagesLoaded: true, ephemeral: true }))
    const disposals: string[] = []
    for (const id of ['codex-bad', 'codex-good']) {
      const managed = createManagedSession({ id }, workspace, { messagesLoaded: true, ephemeral: true })
      ;(managed as { agent: unknown }).agent = {
        isProcessing: () => false,
        setCapabilityTurnRuntime: () => {},
        setAutomationSystem: () => {},
        drainAutomationEvents: async () => {},
        disposeForRestart: async () => {
          disposals.push(id)
          if (id === 'codex-bad' && options.badDisposeFails) {
            throw new AggregateError([new Error('CODEX_HOME rm EBUSY')], 'codex-runtime-cleanup-failed')
          }
        },
        dispose: () => {},
      }
      sessions.set(`${workspaceId}:${id}`, managed)
    }
    const internals = sm as unknown as { resolveManagedProvider(managed: { id: string }): string }
    const realProvider = internals.resolveManagedProvider.bind(sm)
    internals.resolveManagedProvider = managed => managed.id.startsWith('codex-') ? 'codex-runtime' : realProvider(managed as never)
    const agentOf = (id: string) => (sessions.get(`${workspaceId}:${id}`) as { agent: unknown }).agent
    return { sm, workspaceId, disposals, agentOf }
  }

  it('THE DEFECT — one failing dispose: the refresh RESOLVES, with applied 1 and failed 1 beside the untouched caller', async () => {
    const { sm, workspaceId, disposals, agentOf } = twoSessionRig({ badDisposeFails: true })
    try {
      let summary: unknown
      try { summary = await sm.refreshPluginRuntime(workspaceId, undefined, 'f1265 install') } catch (error) {
        summary = `REJECTED: ${error instanceof Error ? error.message : String(error)}`
      }
      // Both teardowns really ran (positive control on the rig); the good one really applied.
      expect(disposals.sort()).toEqual(['codex-bad', 'codex-good'])
      expect(agentOf('codex-good')).toBeNull()
      expect(summary).toEqual({
        applied: 1, deferred: 0, untouched: 1, reloaded: 0,
        failed: 1, failures: [{ sessionId: 'codex-bad', error: 'codex-runtime-session-disposal-failed' }],
      })
    } finally {
      sm.cleanup()
    }
  })

  it('CONTROL — every session applies: the summary is byte-identical to before (no `failed`, no `failures`)', async () => {
    const { sm, workspaceId, disposals } = twoSessionRig({ badDisposeFails: false })
    try {
      const summary = await sm.refreshPluginRuntime(workspaceId, undefined, 'f1265 install')
      expect(disposals.sort()).toEqual(['codex-bad', 'codex-good'])
      expect(JSON.stringify(summary)).toBe(JSON.stringify({ applied: 2, deferred: 0, untouched: 1, reloaded: 0 }))
    } finally {
      sm.cleanup()
    }
  })

  it('THE TOOL CHANNEL — the install still answers "landed, refresh failed", and now says which sessions are live', async () => {
    const { sm, workspaceId } = twoSessionRig({ badDisposeFails: true })
    try {
      const outcome = await (sm as unknown as {
        afterAgentPluginMutation(w: string, p: undefined, r: string): Promise<void>
      }).afterAgentPluginMutation(workspaceId, undefined, 'plugin_manage:enable').then(() => 'resolved', (error: Error & { summary?: unknown }) => ({
        message: error.message,
        summary: error.summary,
      }))
      // Still a failure for the tool's `refreshAfterCommit` (F1.211's contract), carrying the whole summary.
      expect(outcome).toEqual({
        message: 'codex-runtime-session-disposal-failed',
        summary: {
          applied: 1, deferred: 0, untouched: 1, reloaded: 0,
          failed: 1, failures: [{ sessionId: 'codex-bad', error: 'codex-runtime-session-disposal-failed' }],
        },
      })
    } finally {
      sm.cleanup()
    }
  })

  it('THE UI CHANNEL — the answer is \'failed\' (F1.396, was "cannot say"), and the log carries every session\'s outcome', async () => {
    const { sm, workspaceId } = twoSessionRig({ badDisposeFails: true })
    try {
      const warnings: string[] = []
      const server = { handle() {}, push() {}, async invokeClient() { return undefined }, hasClientCapability() { return false }, findClientsWithCapability() { return [] } }
      const verdict = await afterPluginMutation(server as never, {
        sessionManager: sm,
        platform: { logger: { warn: (line: string) => warnings.push(line) } },
      } as never, { workspaceId }, 'marketplace install')
      expect(verdict).toBe('failed')
      const line = warnings.find(entry => entry.includes('codex-runtime-session-disposal-failed')) ?? ''
      expect(line).toContain('applied 1')
      expect(line).toContain('codex-bad: codex-runtime-session-disposal-failed')
    } finally {
      sm.cleanup()
    }
  })

  it('THE REFRESH BUTTON — a summary with a failed session is an error, never "refreshed"; without one it reads as before', () => {
    const failedSummary = {
      applied: 1, deferred: 0, untouched: 1, reloaded: 0,
      failed: 1, failures: [{ sessionId: 'codex-bad', error: 'codex-runtime-session-disposal-failed' }],
    }
    let verdict: unknown
    try { verdict = describeRuntimeRefreshVerdict(failedSummary) } catch (error) { verdict = `THREW: ${(error as Error).message}` }
    expect(verdict).toBe('THREW: codex-runtime-session-disposal-failed')
    // CONTROL — the three verdicts it gave before, unchanged.
    expect(describeRuntimeRefreshVerdict({ applied: 1, deferred: 1, untouched: 0 })).toBe('deferred')
    expect(describeRuntimeRefreshVerdict({ applied: 1, deferred: 0, untouched: 0 })).toBe('applied')
    expect(describeRuntimeRefreshVerdict({ applied: 0, deferred: 0, untouched: 2 })).toBe('untouched')
  })
})
