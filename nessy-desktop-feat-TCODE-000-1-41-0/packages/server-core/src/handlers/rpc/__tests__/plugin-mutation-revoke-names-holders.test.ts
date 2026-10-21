/**
 * F1.766 (origin release sitting SIT-b, owner decision 2026-09-26 option A) — uninstalling a plugin stops only the
 * running turns whose capability snapshot held that plugin.
 *
 * SIT-b measured a busy codex session losing its turn to `plugin uninstall (<key>)` although its install refresh had
 * been deferred, so the plugin never reached its snapshot: `emitPluginMutationInvalidation` revoked every lease in
 * the mutation's scope. The key the RPC and agent paths already hand it (F1.493 (1), F1.582) now rides on the catalog
 * invalidation as `pluginKey`, `storage-runtime.ts` forwards it to `resolver.invalidate`, and the resolver revokes a
 * lease only when its `instances` include that plugin's.
 *
 * The rig: the real `emitPluginMutationInvalidation`, the real catalog bus and a real `createCapabilityResolver` fed
 * by the bus exactly as `storage-runtime.ts` feeds it (that line is pinned by source below).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { onCapabilityCatalogInvalidation } from '@nessy-agent/shared/capabilities/invalidation'
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
} from '@nessy-agent/shared/capabilities/resolver'
import type { RpcServer } from '../../../transport/types'
import { emitPluginMutationInvalidation } from '../plugin-runtime-refresh'

const WORKSPACE_ID = 'ws-f1766'
const PLUGIN_KEY = 'pk-f1766'
const INSTANCE_ID = 'plugin://m/p@1.0.0#' + 'b'.repeat(64)
const CONTEXT: CapabilityContext = {
  workspaceId: WORKSPACE_ID,
  sessionId: 'holding',
  projectKey: 'p_00000000000000000000000000000000',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
}

function inputs(holdsPlugin: boolean): CapabilityResolutionInputs {
  return {
    nativeInventory: { records: [], blockedLayers: [] },
    installedPlugins: holdsPlugin ? [{
      pluginInstanceId: INSTANCE_ID,
      pluginKey: PLUGIN_KEY,
      marketplaceId: 'm',
      pluginId: 'p',
      version: '1.0.0',
      bundleHash: 'b'.repeat(64),
      cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash: 'b'.repeat(64) },
      manifest: { schemaVersion: 1, kind: 'plugin', id: 'p', name: 'Plugin P', version: '1.0.0', capabilities: [] },
      origin: { source: 'marketplace', resolvedAt: 0 },
      installedAt: 1000,
      diagnostics: [],
    }] : [],
    activePluginInstances: holdsPlugin ? { [PLUGIN_KEY]: INSTANCE_ID } : {},
    pluginCandidates: holdsPlugin ? [{
      key: 'plug:skill:alpha',
      capabilityId: 'c-skill',
      kind: 'skill',
      logicalName: 'alpha',
      pluginKey: PLUGIN_KEY,
      pluginInstanceId: INSTANCE_ID,
      selectedScope: { kind: 'global' },
      trust: { required: false },
      resource: { pluginInstanceId: INSTANCE_ID, relativePath: 'skills/alpha/SKILL.md', contentHash: 'c'.repeat(64) },
    }] : [],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
  }
}

const server = { push() {} } as unknown as RpcServer
const unsubscribers: Array<() => void> = []
afterEach(() => { for (const off of unsubscribers.splice(0)) off() })

async function rig() {
  const resolver = createCapabilityResolver({ inputs: context => inputs(context.sessionId === 'holding') })
  // `storage-runtime.ts`'s catalog subscription, verbatim in shape (pinned below).
  unsubscribers.push(onCapabilityCatalogInvalidation(event => {
    resolver.invalidate(event.scope, event.reason, event.effect, event.pluginKey)
  }))
  const holding = await resolver.resolve(CONTEXT)
  const deferred = await resolver.resolve({ ...CONTEXT, sessionId: 'deferred' })
  return { resolver, holding, deferred }
}

describe('F1.766 — a plugin uninstall stops only the turns whose snapshot held that plugin', () => {
  test('THE DEFECT — the busy session that never loaded the plugin keeps its turn; the one holding it is stopped', async () => {
    const { resolver, holding, deferred } = await rig()
    emitPluginMutationInvalidation(server, { workspaceId: WORKSPACE_ID, pluginKey: PLUGIN_KEY }, 'plugin uninstall', 'remove')
    expect(resolver.isLeaseActive(holding.leaseId)).toBe(false)
    expect(resolver.isLeaseActive(deferred.leaseId)).toBe(true)
  })

  test('CONTROL — a remove that names no plugin keeps revoking every lease in its scope', async () => {
    const { resolver, holding, deferred } = await rig()
    emitPluginMutationInvalidation(server, { workspaceId: WORKSPACE_ID }, 'plugin uninstall', 'remove')
    expect(resolver.isLeaseActive(holding.leaseId)).toBe(false)
    expect(resolver.isLeaseActive(deferred.leaseId)).toBe(false)
  })

  test('THE BINDING — production\'s catalog subscription forwards the key to the resolver', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', '..', 'bootstrap', 'storage-runtime.ts'), 'utf-8')
    expect(source).toContain('capabilityResolver.invalidate(event.scope, event.reason, event.effect, event.pluginKey)')
  })
})
