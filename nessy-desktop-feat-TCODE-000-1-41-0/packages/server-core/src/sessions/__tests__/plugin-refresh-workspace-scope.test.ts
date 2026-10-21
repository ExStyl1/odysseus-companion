/**
 * F1.407 + F1.408 (origin WJ-ff verifier on F1.265, 2026-09-23) — a GLOBAL
 * plugin mutation made from workspace A answers A's model about A's sessions
 * only; every other workspace is a bare count.
 *
 * `plugin_install` (and repair/update/uninstall, and a global target) refreshes
 * EVERY live session, in every workspace. F1.265 made the refresh's summary
 * ride the tool answer (`runtimeRefreshSessions`), so a failed dispose in
 * workspace B put B's session id (`failedSessionIds: ['260923-secret-project']`)
 * and B's live-session counts into A's model answer — F1.407. And ids repeat
 * across workspaces, so a `'dup'` failing in B read as A's healthy `'dup'` —
 * F1.408. DECIDED by the controller (2026-09-23): name only the caller's
 * workspace's sessions; report other workspaces as a bare count. With the
 * answer scoped to one workspace, a session id is unambiguous again (F1.408
 * folds into F1.407, as its own proposal offered).
 *
 * The rig is F1.211's (`plugin-install-refresh-failure.test.ts`): the real
 * session tool handler over the real `afterAgentPluginMutation`, the real
 * refresh and the real strict dispose; the planted fact is each idle codex
 * session's runtime, whose `disposeForRestart` succeeds or rejects.
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
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakePluginManagement(): PluginManagementApi {
  return {
    async status() { return { installed: [], diagnostics: [] } },
    async install() {
      const summary = {
        pluginKey: 'local.toolkit-1', activeInstanceId: 'instance-1', marketplaceId: 'local', pluginId: 'toolkit',
        version: '1.0.0', name: 'toolkit', installedAt: Date.now(), capabilityKinds: ['skill'], diagnostics: [],
      } as unknown as PluginManagementInstalledSummary
      return { ok: true, installed: summary, diagnostics: [] }
    },
  } as unknown as PluginManagementApi
}

type SessionSpec = { id: string; runtime?: 'ok' | 'fails' }

/** Two workspaces' live sessions; the caller is `caller` in `ws-a`. */
function rig(spec: Record<'ws-a' | 'ws-b', SessionSpec[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'f1407-'))
  roots.push(dir)
  const sm = createTestSessionManager()
  const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions
  const codexIds = new Set<string>()
  for (const workspaceId of ['ws-a', 'ws-b'] as const) {
    const workspace = { id: workspaceId, name: workspaceId, slug: workspaceId, rootPath: join(dir, workspaceId), createdAt: Date.now() }
    for (const { id, runtime } of spec[workspaceId]) {
      const managed = createManagedSession({ id }, workspace, { messagesLoaded: true, ephemeral: true })
      if (runtime) {
        codexIds.add(id)
        ;(managed as { agent: unknown }).agent = {
          isProcessing: () => false,
          setCapabilityTurnRuntime: () => {},
          setAutomationSystem: () => {},
          drainAutomationEvents: async () => {},
          disposeForRestart: async () => {
            if (runtime === 'fails') throw new AggregateError([new Error(`EBUSY ${workspaceId}/${id}`)], 'codex-runtime-cleanup-failed')
          },
          dispose: () => {},
        }
      }
      sessions.set(`${workspaceId}:${id}`, managed)
    }
  }
  const internals = sm as unknown as { resolveManagedProvider(managed: { id: string }): string }
  const realProvider = internals.resolveManagedProvider.bind(sm)
  internals.resolveManagedProvider = managed => codexIds.has(managed.id) ? 'codex-runtime' : realProvider(managed as never)

  const workspacePath = join(dir, 'ws-a')
  const proposalRegistry = new MarketplaceProposalRegistry()
  const plugins = fakePluginManagement()
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
      pluginManagement: plugins,
      marketplaceService: {
        proposeInstall: request => proposeRepositoryInstall(request),
        inspect: async () => { throw new Error('inspect not used') },
        install: async request => plugins.install(request.source!, { activateIn: request.activateIn ?? { kind: 'global' } }),
      },
      proposalRegistry,
      clientId: 'session:ws-a:caller',
      resolveScope: () => ({ workspaceId: 'ws-a' }),
      // Production's own binding (`getOrCreateAgent`): the SAME host hook, called with the CALLER's workspace.
      afterMutation: (reason, target, effect) => (sm as unknown as {
        afterAgentPluginMutation(w: string, p: undefined, r: string, t?: PluginActivationTarget, e?: 'add-or-refresh' | 'remove'): Promise<void>
      }).afterAgentPluginMutation('ws-a', undefined, reason, target, effect),
    }),
  }
  return { sm, ctx }
}

/** A GLOBAL mutation: `plugin_install` refreshes every workspace's live sessions. */
async function installFromWorkspaceA(ctx: SessionToolContext): Promise<{ text: string; answer: Record<string, unknown> }> {
  const plan = await SESSION_TOOL_REGISTRY.get('plugin_plan_install')!.handler!(ctx, { repositoryUrl: 'https://github.com/acme/widgets' })
  const proposalId = JSON.parse(plan.content[0]!.text).proposalId as string
  const result = await SESSION_TOOL_REGISTRY.get('plugin_install')!.handler!(ctx, { proposalId })
  expect(result.isError).not.toBe(true)
  const text = result.content[0]!.text
  return { text, answer: JSON.parse(text) as Record<string, unknown> }
}

describe('F1.407 + F1.408 — workspace A\'s model hears about workspace A\'s sessions only', () => {
  it('THE DEFECT — failures only in B: no B id, no B error text, B only as a bare count; A\'s healthy `dup` is not named', async () => {
    const { sm, ctx } = rig({
      'ws-a': [{ id: 'caller' }, { id: 'dup', runtime: 'ok' }],
      'ws-b': [{ id: 'dup', runtime: 'fails' }, { id: '260923-secret-project', runtime: 'fails' }, { id: 'b-quiet' }],
    })
    try {
      const { text, answer } = await installFromWorkspaceA(ctx)
      expect(answer.ok).toBe(true)
      // The refresh DID fail somewhere, and the answer still says so (F1.211's contract).
      expect(answer.runtimeRefresh).toBe('failed')
      // Nothing of B's reaches A's model: not its ids, not its paths.
      expect(text).not.toContain('260923-secret-project')
      expect(text).not.toContain('b-quiet')
      expect(text).not.toContain('ws-b')
      // A's counts are A's; B is two bare numbers; `dup` is not named, because A's `dup` is healthy (F1.408).
      expect(answer.runtimeRefreshSessions).toEqual({
        applied: 1, reloaded: 0, deferred: 0, untouched: 1, failed: 0, failedSessionIds: [],
        otherWorkspaceSessions: 3, otherWorkspaceFailed: 2,
      })
      expect(answer.runtimeRefreshError).toBe('plugin-runtime-refresh-failed')
    } finally {
      sm.cleanup()
    }
  })

  it('CONTROL — a failure in A is still named, beside B\'s bare count', async () => {
    const { sm, ctx } = rig({
      'ws-a': [{ id: 'caller' }, { id: 'a-bad', runtime: 'fails' }],
      'ws-b': [{ id: '260923-secret-project', runtime: 'fails' }],
    })
    try {
      const { text, answer } = await installFromWorkspaceA(ctx)
      expect(text).not.toContain('260923-secret-project')
      expect(answer.runtimeRefreshSessions).toEqual({
        applied: 0, reloaded: 0, deferred: 0, untouched: 1, failed: 1, failedSessionIds: ['a-bad'],
        otherWorkspaceSessions: 1, otherWorkspaceFailed: 1,
      })
      expect(answer.runtimeRefreshError).toBe('codex-runtime-session-disposal-failed')
    } finally {
      sm.cleanup()
    }
  })

  it('CONTROL — nothing failed anywhere: the answer carries no refresh field at all, B included', async () => {
    const { sm, ctx } = rig({
      'ws-a': [{ id: 'caller' }, { id: 'dup', runtime: 'ok' }],
      'ws-b': [{ id: 'dup', runtime: 'ok' }],
    })
    try {
      const { answer } = await installFromWorkspaceA(ctx)
      expect(Object.keys(answer).sort()).toEqual(['diagnosticCodes', 'ok', 'pluginKey', 'setup'])
    } finally {
      sm.cleanup()
    }
  })

  it('CONTROL — the UI channel\'s unscoped summary is unchanged: it still counts every workspace', async () => {
    const { sm } = rig({
      'ws-a': [{ id: 'caller' }, { id: 'dup', runtime: 'ok' }],
      'ws-b': [{ id: 'dup', runtime: 'fails' }],
    })
    try {
      const summary = await sm.refreshPluginRuntime(undefined, undefined, 'marketplace install')
      expect(summary).toEqual({
        applied: 1, deferred: 0, untouched: 1, reloaded: 0,
        failed: 1, failures: [{ sessionId: 'dup', error: 'codex-runtime-session-disposal-failed' }],
      })
    } finally {
      sm.cleanup()
    }
  })
})
