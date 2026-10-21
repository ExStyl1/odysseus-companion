import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import { createSessionStore, type SessionStore } from '@nessy-agent/shared/sessions'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import {
  SessionManager,
  type SessionManagerRuntimeDependencies,
} from '../SessionManager.ts'
import { WorkspaceQuiescenceCoordinator } from '../../workspaces/workspace-quiescence.ts'

type TestSessionManagerOptions = Partial<SessionManagerRuntimeDependencies> & {
  sessionStore?: SessionStore
}

export function createTestSessionManager(
  options: TestSessionManagerOptions = {},
): SessionManager {
  const root = mkdtempSync(join(tmpdir(), 'nessy-session-manager-test-'))
  const layout = {
    storageLayoutVersion: 2 as const,
    verificationId: `test-${randomUUID()}`,
  }
  const resolver = options.resolver ?? createTestCapabilityResolver()
  const projectHandleService = options.projectHandleService ?? new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(root, 'project-trust.json') }),
  })
  const recentProjectStore = options.recentProjectStore ?? new RecentProjectStore(layout, {
    filePath: join(root, 'recent-projects.json'),
  })
  const workspaceService = options.workspaceService ?? createTestWorkspaceService(root)

  return new SessionManager(options.sessionStore ?? createSessionStore(layout), {
    resolver,
    workspaceService,
    projectHandleService,
    recentProjectStore,
    workspaceQuiescence: options.workspaceQuiescence ?? new WorkspaceQuiescenceCoordinator(),
    resolveCredential: options.resolveCredential ?? (() => ({ ready: false, revision: 0 })),
    dpSessionBroker: options.dpSessionBroker ?? {
      probe: async () => ({ state: 'needs-login', version: null, outdated: false }),
      subscribe: () => () => undefined,
    },
    subscribeInvalidation: options.subscribeInvalidation ?? (() => () => undefined),
    ...(options.pluginNodeRuntime ? { pluginNodeRuntime: options.pluginNodeRuntime } : {}),
    ...(options.pluginManagementTools ? { pluginManagementTools: options.pluginManagementTools } : {}),
    ...(options.createWorkspaceMcpPool ? { createWorkspaceMcpPool: options.createWorkspaceMcpPool } : {}),
    ...(options.managedPiPolicy ? { managedPiPolicy: options.managedPiPolicy } : {}),
    // D4 seams. Absent by default, which keeps the construction snapshot frozen
    // — today's behaviour for every existing test — and lets a test drive the
    // re-read without touching the real managed-policy file or config dir.
    ...(options.resolveManagedPiPolicy ? { resolveManagedPiPolicy: options.resolveManagedPiPolicy } : {}),
    ...(options.subscribeManagedPolicyChange
      ? { subscribeManagedPolicyChange: options.subscribeManagedPolicyChange }
      : {}),
    ...(options.piTelemetry ? { piTelemetry: options.piTelemetry } : {}),
    ...(options.usageMetrics ? { usageMetrics: options.usageMetrics } : {}),
    // P6.732 — the host span source, absent by default so every existing
    // test keeps proving the tracing-off shape without saying so.
    ...(options.hostTracer ? { hostTracer: options.hostTracer } : {}),
    // T10 seam. Absent by default so existing tests keep the production
    // resolution (which defaults ON without touching the registry mid-test —
    // see the policy tests in connect-on-startup.test.ts for both directions).
    ...(options.resolveConnectSourcesOnStartup
      ? { resolveConnectSourcesOnStartup: options.resolveConnectSourcesOnStartup }
      : {}),
  })
}

function createTestWorkspaceService(root: string): WorkspaceService {
  const resolved = new Map<string, ReturnType<WorkspaceService['resolve']>>()
  const resolve = (workspaceId: string): ReturnType<WorkspaceService['resolve']> => {
    let workspace = resolved.get(workspaceId)
    if (!workspace) {
      workspace = {
        id: workspaceId,
        workspaceRootPath: join(root, 'workspaces', workspaceId),
        sessionRootPath: join(root, 'sessions', workspaceId),
        config: {
          id: workspaceId,
          name: workspaceId,
          createdAt: 1,
          updatedAt: 1,
        },
        lastAccessedAt: 1,
      }
      resolved.set(workspaceId, workspace)
    }
    return workspace
  }
  return {
    resolve,
    listResolved: () => [...resolved.values()],
  } as WorkspaceService
}

export function createTestCapabilityResolver(): CapabilityResolver {
  let sequence = 0
  const activeLeases = new Set<string>()

  return {
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      sequence += 1
      const leaseId = `test-lease-${sequence}`
      activeLeases.add(leaseId)
      return {
        context,
        generation: `test-generation-${sequence}`,
        leaseId,
        entries: [],
        installedPlugins: [],
        diagnostics: [],
      }
    },
    releaseSnapshot: leaseId => { activeLeases.delete(leaseId) },
    invalidate: () => undefined,
    isLeaseActive: leaseId => activeLeases.has(leaseId),
    referencedInstances: () => new Set(),
    leaseCount: () => activeLeases.size,
  }
}
