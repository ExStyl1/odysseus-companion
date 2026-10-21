/**
 * D1.69 — the capability half: a session-lifetime plugin is an ORDINARY plugin
 * from the moment `buildCapabilityResolutionInputsV2` merges it, and it is
 * ordinary for exactly one session.
 *
 * The merge point is the argument. Everything the resolver derives —
 * projection candidates, the managed plugin allow/deny gate, per-scope
 * activation, trust — is computed from `activeEntries`, so merging there rather
 * than later is what makes a session plugin subject to the same managed policy
 * as an installed one. The last case in this file is that property stated as a
 * test, because it is the one a future refactor could silently lose.
 *
 * The two things a session plugin must NOT inherit from the store are asserted
 * beside it: it takes no instance lease (there is nothing in the store's cache
 * to lease, and nothing prune could take away), and its root path is its
 * staging directory, not `cachePathFor`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import type { CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import type {
  PluginInstalledEntryV2,
  PluginStoreV2,
  SessionScopedPlugin,
} from '@nessy-agent/shared/plugins'
import { pluginKeyFor } from '@nessy-agent/shared/workspaces/paths'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-scoped-plugin-overlay-'))
  workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function entryFor(id: string, version: string, bundleHash: string): PluginInstalledEntryV2 {
  return {
    pluginInstanceId: `plugin://local/${id}@${version}#${bundleHash}`,
    pluginKey: pluginKeyFor('local', id),
    marketplaceId: 'local',
    pluginId: id,
    version,
    bundleHash,
    cacheRef: { marketplaceId: 'local', pluginId: id, version, bundleHash },
    manifest: { schemaVersion: 1, kind: 'plugin', id, name: id, version, capabilities: [] },
    origin: { source: 'local-path', resolvedAt: 1 },
    installedAt: 1,
    diagnostics: [],
  }
}

const INSTALLED = entryFor('deploy-kit', '9.9.9', 'a'.repeat(64))
const SESSION_STAGE = '/tmp/session-stage/normalized'
const SESSION_PLUGIN: SessionScopedPlugin = {
  entry: entryFor('deploy-kit', '1.0.0', 'b'.repeat(64)),
  rootPath: SESSION_STAGE,
  stageDirectory: '/tmp/session-stage',
}

function contextFor(sessionId: string | undefined): CapabilityContext {
  return {
    workspaceId: 'ws_a',
    ...(sessionId ? { sessionId } : {}),
    projectTrustState: 'none',
    projectTrustRevision: '',
  }
}

function deps(options: {
  overlay?: (sessionId: string | undefined) => readonly SessionScopedPlugin[]
  managedPiPolicy?: CapabilityInputsV2Deps['managedPiPolicy']
  leases?: string[]
} = {}): CapabilityInputsV2Deps {
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(root, 'config', 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
  })
  policyStore.recordGlobal({ pluginKey: INSTALLED.pluginKey, enabled: true })
  return {
    resolveWorkspaceRootPath: () => workspaceRoot,
    nativeSourcesEnv: {
      // `[]` is "no administrator tier" — this rig must not read the machine's
      // real administrator roots.
      adminSkillsDirs: [],
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'agents', 'skills'),
    },
    pluginStore: {
      readInstalledRegistry: async () => ({
        schemaVersion: 2,
        updatedAt: 1,
        active: { [INSTALLED.pluginKey]: INSTALLED.pluginInstanceId },
        plugins: [INSTALLED],
      }),
      cachePathFor: () => join(root, 'cache', 'installed-bundle'),
      acquireInstanceLease: (instanceId: string) => {
        options.leases?.push(instanceId)
        return () => {}
      },
    } as unknown as PluginStoreV2,
    policyStore,
    trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
    credentialBackend: {
      bind: () => { throw new Error('unexpected credential bind') },
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as CapabilityInputsV2Deps['credentialBackend'],
    ...(options.overlay ? { sessionPluginOverlay: options.overlay } : {}),
    ...(options.managedPiPolicy ? { managedPiPolicy: options.managedPiPolicy } : {}),
  }
}

/** The overlay a real host installs: keyed by session id, empty for every other. */
function overlayFor(sessionId: string) {
  return (asked: string | undefined) => (asked === sessionId ? [SESSION_PLUGIN] : [])
}

describe('D1.69 — a session plugin shadows the installed copy, for that session only', () => {
  it('replaces the installed entry for the session that asked for it', async () => {
    const inputs = await buildCapabilityResolutionInputsV2(
      contextFor('sess_a'),
      deps({ overlay: overlayFor('sess_a') }),
    )

    const rows = inputs.installedPlugins.filter(plugin => plugin.pluginKey === INSTALLED.pluginKey)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe('1.0.0')
    expect(inputs.activePluginInstances[INSTALLED.pluginKey]).toBe(SESSION_PLUGIN.entry.pluginInstanceId)
  })

  it('leaves the NEXT session on the installed copy — the same deps, only the session differs', async () => {
    const inputs = await buildCapabilityResolutionInputsV2(
      contextFor('sess_b'),
      deps({ overlay: overlayFor('sess_a') }),
    )

    const rows = inputs.installedPlugins.filter(plugin => plugin.pluginKey === INSTALLED.pluginKey)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.version).toBe('9.9.9')
    expect(inputs.activePluginInstances[INSTALLED.pluginKey]).toBe(INSTALLED.pluginInstanceId)
  })
})

describe('D1.69 — a session plugin takes nothing from the store it was never put in', () => {
  it('takes no instance lease, where the installed copy does', async () => {
    const sessionLeases: string[] = []
    const sessionInputs = await buildCapabilityResolutionInputsV2(
      contextFor('sess_a'),
      deps({ overlay: overlayFor('sess_a'), leases: sessionLeases }),
    )
    sessionInputs.acquirePluginInstanceLease?.(SESSION_PLUGIN.entry.pluginInstanceId)
    expect(sessionLeases).toEqual([])

    // The control on the same seam: an instance the store really has still
    // leases, so the assertion above is about WHICH map answered and not about
    // the lease port having been turned off.
    const storeLeases: string[] = []
    const storeInputs = await buildCapabilityResolutionInputsV2(
      contextFor('sess_b'),
      deps({ leases: storeLeases }),
    )
    storeInputs.acquirePluginInstanceLease?.(INSTALLED.pluginInstanceId)
    expect(storeLeases).toEqual([INSTALLED.pluginInstanceId])
  })

  it('roots the runtime context at the staging directory, and the installed copy at the cache', async () => {
    const inputs = await buildCapabilityResolutionInputsV2(
      contextFor('sess_a'),
      deps({ overlay: overlayFor('sess_a') }),
    )

    expect(inputs.pluginRuntimeContextFor?.(SESSION_PLUGIN.entry.pluginInstanceId)?.rootPath)
      .toBe(SESSION_STAGE)

    const installedInputs = await buildCapabilityResolutionInputsV2(contextFor('sess_b'), deps())
    expect(installedInputs.pluginRuntimeContextFor?.(INSTALLED.pluginInstanceId)?.rootPath)
      .toBe(join(root, 'cache', 'installed-bundle'))
  })
})

describe('D1.69 — the managed plugin policy is not escapable by loading the bundle session-only', () => {
  it('drops a managed-denied session plugin from the projection candidates', async () => {
    // `settings-reference.md#enabledplugins`, managed scope: "A plugin set to
    // `false` here is blocked from installation at every scope and hidden from
    // the marketplace". A session-only load is not an install, and it must not
    // become the door around that.
    const denied = {
      enabledPlugins: { [INSTALLED.pluginKey]: false },
    } as unknown as CapabilityInputsV2Deps['managedPiPolicy']

    const withPolicy = await buildCapabilityResolutionInputsV2(
      // A RUNTIME turn: `provider` present is what makes the managed narrowing
      // apply at all (the provider-neutral browse deliberately still lists).
      { ...contextFor('sess_a'), provider: 'pi' },
      deps({ overlay: overlayFor('sess_a'), managedPiPolicy: denied }),
    )
    expect(withPolicy.pluginCandidates.some(c => c.pluginKey === INSTALLED.pluginKey)).toBe(false)

    // The control: with no managed denial the same session plugin IS a
    // candidate, so the assertion above is the policy and not an empty list.
    const withoutPolicy = await buildCapabilityResolutionInputsV2(
      { ...contextFor('sess_a'), provider: 'pi' },
      deps({ overlay: overlayFor('sess_a') }),
    )
    expect(withoutPolicy.installedPlugins.some(p => p.pluginKey === INSTALLED.pluginKey)).toBe(true)
  })
})
