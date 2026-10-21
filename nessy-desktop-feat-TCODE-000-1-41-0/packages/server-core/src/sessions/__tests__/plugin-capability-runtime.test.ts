/**
 * A10 — plugin capability runtime conformance (server-core).
 *
 * Closest sibling: `plugin-management-tools.test.ts` (A8) for SessionManager
 * harness/setup patterns. This file proves two additional cross-cutting A10
 * invariants against REAL production code (PluginStoreV2, CapabilityPolicyStore,
 * CapabilityResolver, SessionManager) — no mocks standing in for the pipeline:
 *
 * 1. One installed bundle serves independent global/Workspace/project policy,
 *    and two simultaneous leased session snapshots never copy the bundle,
 *    mutable plugin data, or credentials under the Workspace/SessionStore roots.
 * 2. The four management tools (plugin_plan_install/install/status/manage)
 *    appear EXACTLY ONCE in the captured Pi execution manifest with final
 *    semantic IDs and ToolExecutor-compatible dispatch metadata — no plugin
 *    factory or parallel tool list.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getToolDefsAsJsonSchema, SESSION_TOOL_REGISTRY } from '@nessy-agent/session-tools-core'
import { PluginStoreV2 } from '@nessy-agent/shared/plugins/store-v2'
import { resolvePluginProjectionCandidates } from '@nessy-agent/shared/plugins/projection-candidates'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type CapabilityResolver,
} from '@nessy-agent/shared/capabilities/resolver'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
} from '@nessy-agent/shared/agent/pi-harness/harness-manifest'
import { getHarnessToolDescriptor, getPiToolBindingByBindingName } from '@nessy-agent/shared/agent/pi-harness/harness-tool-descriptor'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import { createManagedSession, SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { createInstallTracker, type InstallTracker } from '@nessy-agent/shared/testing/install-tracker' // F1.488 (1) — F1.424's shared tracker
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS) // F1.268 — each case runs a REAL plugin-store install; readings at the file end
const roots: string[] = [], installs = createInstallTracker() // F1.268 → F1.488 (1): every tracked install, and (F1.423) every whole case body
const cases = installs.track({ run: <T>(body: () => Promise<T>): Promise<T> => body() }) // F1.423 — `it(…, () => cases.run(async () => …))`
afterEach(async () => { await removeRootsWhenSettled(roots, installs) }) // F1.422 + F1.425 — roots taken BEFORE the wait; see the file end
// (F1.268's local `trackInstall` is retired: `installs.track(service)` below holds every call the service makes.)
function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

/** Recursively lists every regular file under `dir` (empty when `dir` is absent). */
function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    const stat = statSync(current)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(join(current, entry))
      continue
    }
    out.push(current)
  }
  return out
}

const FIXTURE_DIR = join(import.meta.dir, '..', '..', '..', '..', 'shared', 'src', 'plugins', '__tests__', 'fixtures', 'format-adapters', 'codex-core')

interface PluginRuntimeHarness {
  storeRoot: string
  store: PluginStoreV2
  policy: CapabilityPolicyStore
  trust: CapabilityTrustStore
  resolver: CapabilityResolver
  pluginKey: string
  instanceId: string
  bundleRoot: string
}

async function installOneBundleWithRealResolver(dir: string): Promise<PluginRuntimeHarness> {
  const storeRoot = join(dir, 'plugin-store')
  const store = new PluginStoreV2({ rootDirectory: storeRoot })
  const policy = new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
  })
  const trust = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') })

  const { PluginManagementServiceV2 } = await import('@nessy-agent/shared/plugins/management-service-v2')
  const service = installs.track(new PluginManagementServiceV2({
    store,
    policyStore: policy,
    trustStore: trust,
    fetchImpl: (async () => { throw new Error('network forbidden') }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
  }))
  const installed = await service.install({ kind: 'local-path', path: FIXTURE_DIR })
  if (!installed.ok) throw new Error('fixture install failed')
  const pluginKey = installed.installed!.pluginKey
  const instanceId = installed.installed!.activeInstanceId
  const registry = await store.readInstalledRegistry()
  const entry = registry.plugins.find(p => p.pluginInstanceId === instanceId)!
  const bundleRoot = store.cachePathFor(entry.cacheRef)

  function buildInputs(context: CapabilityContext): CapabilityResolutionInputs {
    return {
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: [entry],
      activePluginInstances: { [pluginKey]: instanceId },
      acquirePluginInstanceLease: id => store.acquireInstanceLease(id),
      pluginCandidates: resolvePluginProjectionCandidates([entry], { kind: 'workspace', workspaceId: context.workspaceId }),
      resolveActivation: target => policy.resolve(
        { pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId },
        { workspaceId: context.workspaceId },
      ),
      resolveTrust: key => trust.resolve(key),
      pluginRuntimeContextFor: id => id === instanceId
        ? { rootPath: bundleRoot, dataPath: join(dir, 'plugin-data', pluginKey), profile: 'codex-plugin-env-v1' as const }
        : undefined,
    }
  }

  const resolver = createCapabilityResolver({ inputs: context => buildInputs(context) })
  return { storeRoot, store, policy, trust, resolver, pluginKey, instanceId, bundleRoot }
}

function registerManagedSession(sm: SessionManager, workspaceId: string, sessionId: string, workspaceRoot: string) {
  const workspace = {
    id: workspaceId,
    name: workspaceId,
    slug: workspaceId,
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession({ id: sessionId }, workspace, { messagesLoaded: true, ephemeral: true })
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
  return managed
}

describe('plugin capability runtime — independent scoped policy + no bundle/data/credential copy', () => {
  it('one installed bundle serves independent global/Workspace/project policy simultaneously', () => cases.run(async () => {
    const dir = root('plugin-capability-runtime-policy-')
    const harness = await installOneBundleWithRealResolver(dir)

    // Independent enablement per scope: enabling globally does not force
    // workspace-b on, and disabling workspace-b's project override does not
    // touch workspace-a or the global record.
    harness.policy.recordGlobal({ pluginKey: harness.pluginKey, enabled: true })
    harness.policy.recordWorkspace('ws_a', { pluginKey: harness.pluginKey, enabled: true })
    harness.policy.recordWorkspace('ws_b', { pluginKey: harness.pluginKey, enabled: true })
    const projectKey = `p_${'a'.repeat(32)}`
    harness.policy.recordProjectOverride('ws_b', projectKey, { pluginKey: harness.pluginKey, enabled: false })

    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }).enabled).toBe(true)
    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(true)
    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }, { workspaceId: 'ws_b' }).enabled).toBe(true)
    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }, { workspaceId: 'ws_b', projectKey }).enabled).toBe(false)

    // Disabling ws_a alone must not affect ws_b or the global record.
    harness.policy.recordWorkspace('ws_a', { pluginKey: harness.pluginKey, enabled: false })
    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }, { workspaceId: 'ws_a' }).enabled).toBe(false)
    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }, { workspaceId: 'ws_b' }).enabled).toBe(true)
    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }).enabled).toBe(true)
  }))

  it('two simultaneous leased session snapshots copy no bundle/mutable-data/credential file under Workspace/SessionStore roots', () => cases.run(async () => {
    const dir = root('plugin-capability-runtime-nocopy-')
    const harness = await installOneBundleWithRealResolver(dir)
    harness.policy.recordGlobal({ pluginKey: harness.pluginKey, enabled: true })

    const sm = createTestSessionManager({ resolver: harness.resolver })
    const workspaceARoot = join(dir, 'workspaces', 'ws_a')
    const workspaceBRoot = join(dir, 'workspaces', 'ws_b')
    registerManagedSession(sm, 'ws_a', 'session-a', workspaceARoot)
    registerManagedSession(sm, 'ws_b', 'session-b', workspaceBRoot)
    const managedA = (sm as unknown as { sessions: Map<string, { workspace: { id: string } }> }).sessions.get('ws_a:session-a')!
    const managedB = (sm as unknown as { sessions: Map<string, { workspace: { id: string } }> }).sessions.get('ws_b:session-b')!

    const createCapabilityTurn = (sm as unknown as {
      createCapabilityTurn(managed: unknown): Promise<{ snapshot: { leaseId: string; generation: string }; runtime: unknown }>
    }).createCapabilityTurn.bind(sm)

    // Two simultaneous leases over the SAME installed instance.
    const [turnA, turnB] = await Promise.all([createCapabilityTurn(managedA), createCapabilityTurn(managedB)])
    expect(harness.resolver.isLeaseActive(turnA.snapshot.leaseId)).toBe(true)
    expect(harness.resolver.isLeaseActive(turnB.snapshot.leaseId)).toBe(true)
    expect(turnA.snapshot.leaseId).not.toBe(turnB.snapshot.leaseId)

    // The bundle/skill content is readable from the real cache root...
    expect(existsSync(join(harness.bundleRoot, 'skills', 'hello-skill', 'SKILL.md'))).toBe(true)

    // ...but NEVER copied under either Workspace root or the SessionStore
    // root: no plugin bundle files, no mutable per-instance data files, and
    // no credential files exist anywhere under those roots. Only the
    // app-global immutable store (harness.storeRoot, disjoint from both
    // Workspace roots by construction) holds the bundle.
    const sessionStoreRoot = join(dir, 'sessions')
    const filesUnderWorkspaceA = listFilesRecursive(workspaceARoot)
    const filesUnderWorkspaceB = listFilesRecursive(workspaceBRoot)
    const filesUnderSessionStore = listFilesRecursive(sessionStoreRoot)
    const allWatchedFiles = [...filesUnderWorkspaceA, ...filesUnderWorkspaceB, ...filesUnderSessionStore]

    expect(allWatchedFiles.some(f => f.endsWith('SKILL.md'))).toBe(false)
    expect(allWatchedFiles.some(f => f.includes('hook.js'))).toBe(false)
    expect(allWatchedFiles.some(f => f.includes('mcp-server.js'))).toBe(false)
    expect(allWatchedFiles.some(f => f.includes('plugin.json'))).toBe(false)
    expect(allWatchedFiles.some(f => f.toLowerCase().includes('credential'))).toBe(false)
    expect(allWatchedFiles.some(f => f.toLowerCase().includes('capability-trust'))).toBe(false)

    // The store root itself lives at a disjoint path from both Workspace roots.
    expect(harness.storeRoot.startsWith(workspaceARoot)).toBe(false)
    expect(harness.storeRoot.startsWith(workspaceBRoot)).toBe(false)
    expect(harness.storeRoot.startsWith(sessionStoreRoot)).toBe(false)

    harness.resolver.releaseSnapshot(turnA.snapshot.leaseId)
    harness.resolver.releaseSnapshot(turnB.snapshot.leaseId)
    sm.cleanup()
  }))
})

describe('plugin management tools in the captured Pi execution manifest', () => {
  it('the 4 management tools appear exactly once with final semantic IDs and ToolExecutor-compatible dispatch metadata', () => {
    const PLUGIN_TOOL_NAMES = ['plugin_plan_install', 'plugin_install', 'plugin_status', 'plugin_manage'] as const

    // Real production session tool set, prefixed exactly as pi-agent.ts's
    // `buildCurrentProxyToolDefinitions` does (session-tool-defs.ts
    // `getSessionToolProxyDefs`) — same underlying session-tools-core call.
    const sessionToolDefs = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', projection: 'pi' })
    for (const name of PLUGIN_TOOL_NAMES) {
      expect(sessionToolDefs.filter(def => def.name === `mcp__session__${name}`)).toHaveLength(1)
    }

    const snapshot = {
      context: { workspaceId: 'ws-manifest', sessionId: 'session-manifest', projectTrustState: 'none' as const, projectTrustRevision: '' },
      generation: 'generation-manifest',
      leaseId: 'lease-manifest',
      entries: [],
      installedPlugins: [],
      diagnostics: [],
    }
    const view = toAgentRuntime(snapshot as never)
    const seed = createPiExecutionManifestSeed({
      snapshot: snapshot as never,
      view,
      sessionKey: { workspaceId: 'ws-manifest', sessionId: 'session-manifest' },
    })

    const dynamicTools: PiDynamicToolDefinition[] = sessionToolDefs.map(definition => ({
      bindingName: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema as Record<string, unknown>,
      modelSchemaVersion: 1,
      bindingSchemaVersion: 1,
      provenance: { capabilityKey: 'runtime:pi-session', generation: seed.snapshotGeneration },
    }))

    const manifest = finalizePiExecutionManifest(seed, dynamicTools)

    // EXACTLY ONCE per tool, by the final semantic piName.
    for (const name of PLUGIN_TOOL_NAMES) {
      const matches = manifest.tools.filter(tool => tool.binding.piName === `mcp__session__${name}`)
      expect(matches).toHaveLength(1)
      const tool = matches[0]!
      // Final semantic descriptor id + scheduling/effect metadata (harness-tool-descriptor.ts).
      expect(tool.descriptor.id).toBe(name)
      expect(tool.descriptor.schemaVersion).toBe(1)
      expect(['read', 'workspaceMutation', 'externalMutation']).toContain(tool.descriptor.effect)
      expect(['parallel', 'serialByScope', 'exclusive']).toContain(tool.descriptor.scheduling)
      // Binding carries a handler name — the ToolExecutor/session dispatch
      // seam, not a bespoke plugin-only executor.
      expect(tool.binding.handlerName).toBe(name)
      expect(tool.binding.provider).toBe('pi')
    }

    // No duplicate piName in the finalized manifest (finalizePiExecutionManifest
    // keeps one tool per piName by construction — since F1.706 it drops a later
    // dynamic repeat rather than throwing — so the LENGTH pin below is what
    // proves no plugin tool was the one dropped; uniqueness is asserted too).
    const pluginPiNames = manifest.tools
      .map(tool => tool.binding.piName)
      .filter(piName => PLUGIN_TOOL_NAMES.some(name => piName === `mcp__session__${name}`))
    expect(new Set(pluginPiNames).size).toBe(pluginPiNames.length)
    expect(pluginPiNames).toHaveLength(PLUGIN_TOOL_NAMES.length)

    // Dispatch reaches the SAME SESSION_TOOL_REGISTRY/ToolExecutor handler
    // seam every other session tool uses — no separate plugin factory or
    // parallel tool list is created (harness-tool-descriptor.ts declares no
    // second "plugin tool" registry; these 4 tools are ordinary entries in
    // the single PI_TOOL_BINDINGS/HARNESS_TOOL_DESCRIPTORS arrays alongside
    // read/write/bash/etc., dispatched through the same binding shape).
    for (const name of PLUGIN_TOOL_NAMES) {
      const binding = getPiToolBindingByBindingName(`mcp__session__${name}`)
      expect(binding).toBeDefined()
      expect(binding!.descriptorId).toBe(name)
      const descriptor = getHarnessToolDescriptor(binding!.descriptorId)
      expect(descriptor.id).toBe(name)
      const registryEntry = SESSION_TOOL_REGISTRY.get(name)
      expect(registryEntry).toBeDefined()
      expect(registryEntry!.executionMode).toBe('registry')
      expect(typeof registryEntry!.handler).toBe('function')
    }
  })
})

/**
 * F1.268 (origin WJ-y P-WJ-y-6) — every case here runs a REAL `PluginStoreV2` install (an fs copy of the fixture
 * bundle into a staging root), and that is I/O this rig can starve. Two things went wrong together in an 8-file
 * batch (WJ-y, 2026-09-23 14:36, load 10.7): two cases hit bun's 5 000 ms default at 5 011 ms, and the timed-out
 * case's install KEPT RUNNING while `afterEach` removed its root, which surfaced as an unhandled
 * `ENOENT … copyfile …/staging/…/expected-inventory.json` charged to whichever case was next.
 *
 * - The budget: `setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)` at the top — the per-CASE shape of the shared
 *   module, because the import is ordinary and the cases are not. Readings (junit `time=` per body, WJ-ff
 *   2026-09-23): ALONE at load 13.06 the three bodies took 0.102 s, 0.060 s and 0.009 s (file 15.94 s); in the
 *   8-file batch at load 19.57 the two install cases took 2 277 ms and 1 253 ms — 22x their solo reading and
 *   already 0.46 of the 5 s default — and WJ-y's batch crossed it. The solo file total has read 61 s (WJ-y, load
 *   9.06). A timer sized to the solo bodies would be the warm-reading mistake the budgets module warns about.
 * - The race, as F1.268 closed it: an install was tracked from its start until it settled, and `afterEach` waited
 *   for every tracked install before removing any root (measured by a probe the same day: removing the root 10 ms
 *   into a real install turned `ok: true` into `ok: false`; awaiting it first kept `ok: true` at every delay).
 *
 * The WJ-ff verifier then measured three gaps in that teardown, closed here (2026-09-24, WJ-be):
 *
 * - F1.488 (1): the local tracker is F1.424's shared one (`installs.track(service)` holds every call the service
 *   makes, not only the `install` a hand-written wrapper remembered).
 * - F1.423: the tracked window was the install ALONE. A case that timed out in the `await import(…)` before it,
 *   or in `readInstalledRegistry`, a policy write, `createCapabilityTurn` or `listFilesRecursive` after it, kept
 *   running on a removed root (the verifier's timeout-real3 arm watched a victim's `policy.recordGlobal`
 *   RE-CREATE the removed root, leaking a tmpdir). Each install case now runs inside `cases.run`, a tracked
 *   runner, so the teardown waits for the WHOLE body.
 * - F1.422: the old hook waited, THEN took `roots.splice(0)`. The hook runs on the same budget, so when it timed
 *   out its late continuation spliced the NEXT case's root and removed it mid-run (probe sem-e: the next case's
 *   root gone at 1 504 ms). {@link removeRootsWhenSettled} takes the roots FIRST, so a late continuation can only
 *   remove what was registered before the hook began.
 * - F1.425: nothing committed pinned any of it — at the 300 s budget, deleting the wait left all three cases
 *   green. The last describe below drives the teardown against a deferred fake install, with no timer, and fails
 *   on either mutant (the wait removed, or the old order restored).
 */
async function removeRootsWhenSettled(list: string[], tracker: InstallTracker): Promise<void> {
  const mine = list.splice(0) // F1.422 — BEFORE the wait: a root registered after this line belongs to a later case
  await tracker.settle() // F1.268 / F1.423 — every tracked install and every tracked case body has settled
  for (const dir of mine) rmSync(dir, { recursive: true, force: true })
}

describe('F1.422 / F1.425 — the teardown itself, driven with a deferred install and no timer', () => {
  it('keeps a root until the tracked work settles, and never removes a root registered after it began', async () => {
    const tracker = createInstallTracker()
    const list: string[] = []
    const early = mkdtempSync(join(tmpdir(), 'f1425-early-'))
    list.push(early)
    let finish: () => void = () => {}
    const fake = tracker.track({ install: () => new Promise<void>(resolve => { finish = resolve }) })
    const pending = fake.install()
    const teardown = removeRootsWhenSettled(list, tracker)
    // The NEXT case's root, registered while this teardown is still waiting (what a timed-out hook meets).
    const late = mkdtempSync(join(tmpdir(), 'f1425-late-'))
    list.push(late)
    await Promise.resolve()
    expect(existsSync(early)).toBe(true) // F1.425 — red with the wait removed
    finish()
    await pending
    await teardown
    expect(existsSync(early)).toBe(false) // …and removed once the work settled (the positive control)
    expect(existsSync(late)).toBe(true) // F1.422 — red with the old wait-then-splice order
    expect(list).toEqual([late])
    rmSync(late, { recursive: true, force: true })
  })
})
