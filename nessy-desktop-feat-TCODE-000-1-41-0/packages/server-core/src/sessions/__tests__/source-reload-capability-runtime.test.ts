import { describe, expect, it, jest } from 'bun:test'
import type { CapabilityTurnRuntime } from '@nessy-agent/shared/agent/backend'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

describe('SessionManager source reload', () => {
  it('rebuilds sources from one pinned resolver snapshot and releases its lease', async () => {
    let resolvedContext: CapabilityContext | undefined
    const released: string[] = []
    const resolver: CapabilityResolver = {
      resolve: async context => {
        resolvedContext = context
        return snapshot(context)
      },
      releaseSnapshot: leaseId => { released.push(leaseId) },
      invalidate: () => undefined,
      isLeaseActive: leaseId => !released.includes(leaseId),
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }
    const manager = createTestSessionManager({ resolver })
    const managed = createManagedSession(
      {
        id: 'session-1',
        name: 'Session 1',
        enabledSourceSlugs: ['stale-source', 'resolved-source'],
      },
      {
        id: 'ws_test',
        name: 'Test Workspace',
        rootPath: '/unused/managed/workspace/path',
        createdAt: 1,
      },
      { messagesLoaded: true },
    )

    let activeRuntime: CapabilityTurnRuntime | null = null
    let generationDuringReload: string | undefined
    let manifestGenerationDuringReload: string | undefined
    let manifestMcpSourcesDuringReload: unknown
    const setCapabilityTurnRuntime = jest.fn((runtime: CapabilityTurnRuntime | null) => {
      activeRuntime = runtime
    })
    const setSourceServers = jest.fn(async () => {
      generationDuringReload = activeRuntime?.view.generation
      manifestGenerationDuringReload = activeRuntime?.piExecutionManifestSeed?.snapshotGeneration
      manifestMcpSourcesDuringReload = (activeRuntime?.piExecutionManifestSeed as unknown as { mcpSources?: unknown })?.mcpSources
    })
    managed.agent = {
      forceAbort: () => {},
      endLifecycle: async () => {},
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime,
      setSourceServers,
    } as never

    await (manager as unknown as {
      reloadSessionSources(session: typeof managed): Promise<void>
    }).reloadSessionSources(managed)

    expect(resolvedContext?.enabledSourceNames).toEqual(['resolved-source', 'stale-source'])
    expect(generationDuringReload).toBe('generation-v2')
    expect(manifestGenerationDuringReload).toBe('generation-v2')
    expect(manifestMcpSourcesDuringReload).toEqual([{
      wireName: 'resolved-source',
      capabilityKey: 'native:workspace:source:resolved-source',
      generation: 'generation-v2',
    }])
    expect(setSourceServers).toHaveBeenCalledWith({}, {}, ['resolved-source'])
    expect(setCapabilityTurnRuntime).toHaveBeenLastCalledWith(null)
    expect(released).toEqual(['lease-v2'])
    manager.cleanup()
  })
})

function snapshot(context: CapabilityContext): EffectiveCapabilitySnapshot {
  return {
    context,
    generation: 'generation-v2',
    leaseId: 'lease-v2',
    entries: [{
      summary: {
        key: 'native:workspace:source:resolved-source',
        kind: 'source',
        logicalName: 'resolved-source',
        origin: 'native',
        scope: { kind: 'workspace', workspaceId: context.workspaceId },
        enabled: true,
        selectedAsUnqualifiedAlias: true,
        readOnly: false,
        trustState: 'not-required',
        credentialState: 'not-required',
        diagnostics: [],
      },
      runtimeBinding: {
        kind: 'source',
        mcpWireName: 'resolved-source',
        resource: {
          source: 'workspace',
          scope: { kind: 'workspace', workspaceId: context.workspaceId },
          resourceId: 'source:resolved-source',
          absolutePath: '/unused/pinned/source.json',
          revision: '1',
          contentHash: 'hash',
        },
      },
    }],
    installedPlugins: [],
    diagnostics: [],
  }
}
