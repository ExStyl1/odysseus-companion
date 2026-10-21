/**
 * D1.360 — what a `project`-scope plugin install is bound to, and what the
 * catalog reports about it from somewhere else.
 *
 * ## The measurement this file exists to settle
 *
 * `RS-84` on the packaged 1.40.0 (sitting 5e, narrative
 * `docs/testing/cdp-runs/2026-09-18-measure-sitting-5e.md` §9) installed one
 * plugin with `activateIn: { kind: 'project', context: { workspaceId,
 * sessionId } }` from a session whose working directory was a git checkout, and
 * then found the plugin's NAME in `capabilities.getCatalog({ workspaceId,
 * sessionId })` for a session in an **unrelated git repository** —
 * `installedPlugins` 1, `capabilities` 1 there as well. The case could not tell
 * two causes apart from outside the app:
 *
 *   (a) the project activation target is not scoping the install, or
 *   (b) the catalog does not report project scope.
 *
 * This file drives BOTH halves against production code — the real
 * `PluginManagementServiceV2`, the real `CapabilityPolicyStore`, the real
 * `createCapabilityResolver` and the real `toUserCatalog` — over three REAL
 * project identities minted the way the product mints them, and the answer is
 * **neither (a) nor (b)**:
 *
 *   * the install writes a project override keyed by the installing project's
 *     own `ProjectKey`, and it resolves `enabled` in that project and nowhere
 *     else (`the record is project-scoped` below); and
 *   * the catalog DOES report project scope — but it reports it as a FIELD on
 *     each row (`installedPlugins[].activation.effective`, and every capability
 *     summary's `state`), never by omitting the row.
 *
 * `capabilities.getCatalog` is a LISTING: a plugin is installed once, for the
 * machine, and the Plugins page has to render it everywhere so the user can
 * turn it on where they want it. So the plugin's NAME is present in every
 * project's catalog BY DESIGN, and a detector that counts rows containing that
 * name is blind to the only thing that carries the scope. That is what RS-84
 * counted, and the `the name is present in BOTH catalogs` case below pins it so
 * the next reader of that measurement sees the shape rather than re-deriving
 * it.
 *
 * ## D1.70 — the worktree half, and F1.11's answer to it
 *
 * The row asks whether a project-scope plugin installed in a main checkout
 * loads in a `git worktree` of the same repository. The product's project
 * identity is `resolveProjectIdentity` — device + inode of the resolved
 * realpath — so a worktree is a DIFFERENT directory and therefore a DIFFERENT
 * project, with its own key and its own trust. D1.70 measured that the plugin
 * was therefore inactive in the worktree. F1.11 (option (b), 2026-09-24) keeps
 * the identity and the per-directory trust, and makes project-scope ACTIVATION
 * follow a linked worktree to its main checkout: the input builder passes
 * `mainCheckoutProjectKey` (`resolveMainCheckoutProjectKey`) and the policy
 * store reads the checkout's records first. This harness wires that the way
 * `bootstrap/storage-runtime.ts` does, so the worktree arm below now reads
 * ACTIVE — and the unrelated repository, the negative control, still does not.
 * The production builder itself is driven by
 * `bootstrap/__tests__/worktree-plugin-activation.test.ts`.
 *
 * ## Why this lives in `handlers/rpc/__tests__`
 *
 * The two suspects named by the row are this directory's `plugins.ts` /
 * `marketplace.ts` (which turn a `SafePluginActivationTarget` into a
 * `ProjectKey`) and `capabilities.ts` (which projects the catalog). Both are
 * thin: the identity comes from `resolveProjectIdentity` and the projection
 * from `toUserCatalog`, which is what this file drives directly. Closest
 * sibling for the harness shape: `sessions/__tests__/plugin-capability-runtime.test.ts`.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import {
  createCapabilityResolver,
  withCapabilitySnapshot,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import { toAgentRuntime, toUserCatalog, type AgentRuntimeView } from '@nessy-agent/shared/capabilities/views'
import { PluginManagementServiceV2 } from '@nessy-agent/shared/plugins/management-service-v2'
import { resolvePluginProjectionCandidates } from '@nessy-agent/shared/plugins/projection-candidates'
import { PluginStoreV2 } from '@nessy-agent/shared/plugins/store-v2'
import { resolveMainCheckoutProjectKey, resolveProjectIdentity, type ProjectKey } from '@nessy-agent/shared/projects/project-identity'
import type { UserCapabilityCatalog } from '@nessy-agent/shared/protocol'

const FIXTURE_DIR = join(
  import.meta.dir, '..', '..', '..', '..', '..',
  'shared', 'src', 'plugins', '__tests__', 'fixtures', 'format-adapters', 'codex-core',
)

const WORKSPACE_ID = 'ws_d1360'

const roots: string[] = []

afterEach(async () => { await installs.settle() // F1.424 — never remove a root under an install still copying into it
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/**
 * The three directories RS-84 drove, minted with real git: a checkout, a
 * `git worktree` of it, and an unrelated repository — the negative control.
 */
function mintRepositories(dir: string): { checkout: string; worktree: string; outside: string } {
  const checkout = join(dir, 'main')
  const worktree = join(dir, 'wt')
  const outside = join(dir, 'elsewhere')
  execFileSync('git', ['init', '-q', '-b', 'main', checkout], { stdio: 'ignore' })
  writeFileSync(join(checkout, 'README.md'), 'D1.360 fixture repository.\n', 'utf8')
  git(checkout, 'config', 'user.email', 'lane@example.invalid')
  git(checkout, 'config', 'user.name', 'lane')
  git(checkout, 'add', 'README.md')
  git(checkout, 'commit', '-q', '-m', 'seed')
  git(checkout, 'worktree', 'add', '-q', worktree, '-b', 'd1360-wt')
  execFileSync('git', ['init', '-q', '-b', 'main', outside], { stdio: 'ignore' })
  writeFileSync(join(outside, 'README.md'), 'D1.360 unrelated repository.\n', 'utf8')
  return { checkout, worktree, outside }
}

interface Harness {
  policy: CapabilityPolicyStore
  pluginKey: string
  /** The catalog `capabilities.getCatalog` would answer for this project (its root, as the handle carries it). */
  catalogFor: (projectKey?: ProjectKey, projectRoot?: string) => Promise<UserCapabilityCatalog>
  /** What a turn in this project would actually mount. */
  runtimeFor: (projectKey?: ProjectKey, projectRoot?: string) => Promise<AgentRuntimeView>
}

/**
 * Install the fixture bundle at PROJECT scope through the real service, and
 * return a catalog projector wired the way `bootstrap/storage-runtime.ts` wires
 * the shipped one: `policyStore.resolve` receives `context.workspaceId` AND
 * `context.projectKey`, and the projection candidates carry the context's own
 * selected scope (`selectedCapabilityScope`).
 */
async function installAtProject(dir: string, projectKey: ProjectKey): Promise<Harness> {
  const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugin-store') })
  const policy = new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
  })
  const trust = new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') })
  const service = installs.track(new PluginManagementServiceV2({
    store,
    policyStore: policy,
    trustStore: trust,
    fetchImpl: (async () => { throw new Error('network forbidden') }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
  }))

  const installed = await service.install(
    { kind: 'local-path', path: FIXTURE_DIR },
    { activateIn: { kind: 'project', workspaceId: WORKSPACE_ID, projectKey } },
  )
  if (!installed.ok) throw new Error('fixture install failed')
  const pluginKey = installed.installed!.pluginKey
  const instanceId = installed.installed!.activeInstanceId
  const registry = await store.readInstalledRegistry()
  const entry = registry.plugins.find(plugin => plugin.pluginInstanceId === instanceId)!

  // F1.11 — `mainCheckoutProjectKey` is what the production builder derives from `projectRoot` for every context.
  const buildInputs = (context: CapabilityContext, mainCheckoutProjectKey: ProjectKey | undefined): CapabilityResolutionInputs => ({
    nativeInventory: { records: [], blockedLayers: [] },
    installedPlugins: [entry],
    activePluginInstances: { [pluginKey]: instanceId },
    acquirePluginInstanceLease: id => store.acquireInstanceLease(id),
    pluginCandidates: resolvePluginProjectionCandidates(
      [entry],
      context.projectKey
        ? { kind: 'project', workspaceId: context.workspaceId, projectKey: context.projectKey }
        : { kind: 'workspace', workspaceId: context.workspaceId },
    ),
    resolveActivation: target => policy.resolve(
      { pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId },
      {
        workspaceId: context.workspaceId,
        ...(context.projectKey ? { projectKey: context.projectKey } : {}),
        ...(mainCheckoutProjectKey ? { mainCheckoutProjectKey } : {}),
      },
    ),
    resolvePluginScopeActivation: target => policy.resolveScopes(
      { pluginKey: target.pluginKey, pluginInstanceId: target.pluginInstanceId },
      {
        workspaceId: context.workspaceId,
        ...(context.projectKey ? { projectKey: context.projectKey } : {}),
        ...(mainCheckoutProjectKey ? { mainCheckoutProjectKey } : {}),
      },
    ),
    resolveTrust: key => trust.resolve(key),
  })

  const resolver = createCapabilityResolver({
    inputs: async context => buildInputs(context, context.projectKey ? await resolveMainCheckoutProjectKey(context.projectRoot) : undefined),
  })
  const project = <T>(key: ProjectKey | undefined, root: string | undefined, projection: (snapshot: EffectiveCapabilitySnapshot) => T): Promise<T> =>
    withCapabilitySnapshot(
      resolver,
      {
        workspaceId: WORKSPACE_ID,
        sessionId: 'session-d1360',
        ...(key ? { projectKey: key, projectRoot: root ?? '/unused', workingDirectory: root ?? '/unused' } : {}),
        projectTrustState: 'none',
        projectTrustRevision: '',
      },
      projection,
    )

  return {
    policy,
    pluginKey,
    catalogFor: (key, root) => project(key, root, snapshot => toUserCatalog(snapshot)),
    runtimeFor: (key, root) => project(key, root, snapshot => toAgentRuntime(snapshot)),
  }
}

/**
 * Every plugin-contributed capability summary's `state`.
 *
 * `toSafeSummary` carries no plugin key — the plugin a capability came from is
 * reached through the installed-plugin row's components — so this filters by
 * `origin`, which is sound here because the harness feeds the resolver an EMPTY
 * native inventory: the fixture bundle is the only contributor there is, and
 * the `installedPlugins` assertion beside every use pins that.
 */
function pluginStates(catalog: UserCapabilityCatalog): string[] {
  return catalog.capabilities
    .filter(item => item.origin === 'plugin')
    .map(item => item.state)
    .sort()
}

describe('D1.360 — a project-scope plugin install, read from another project', () => {
  it('the RECORD is project-scoped: it resolves enabled in the installing project and nowhere else', async () => {
    const dir = root('d1360-record-')
    const { checkout, worktree, outside } = mintRepositories(dir)
    const keyMain = (await resolveProjectIdentity(checkout)).projectKey
    const keyTree = (await resolveProjectIdentity(worktree)).projectKey
    const keyOutside = (await resolveProjectIdentity(outside)).projectKey

    // The three directories really are three projects — without this the two
    // readings below could agree for the wrong reason.
    expect(new Set([keyMain, keyTree, keyOutside]).size).toBe(3)

    const harness = await installAtProject(dir, keyMain)
    const resolveAt = (projectKey?: ProjectKey, mainCheckoutProjectKey?: ProjectKey) => harness.policy.resolve(
      { pluginKey: harness.pluginKey },
      { workspaceId: WORKSPACE_ID, ...(projectKey ? { projectKey } : {}), ...(mainCheckoutProjectKey ? { mainCheckoutProjectKey } : {}) },
    )

    // POSITIVE: the project the install named.
    expect(resolveAt(keyMain).enabled).toBe(true)
    // NEGATIVE, and this is RS-84's third session: an unrelated repository.
    expect(resolveAt(keyOutside).enabled).toBe(false)
    // D1.70: a worktree is its own directory, so its own project — its OWN key carries no record…
    expect(resolveAt(keyTree).enabled).toBe(false)
    // …and F1.11: read with its main checkout's key (what the input builder passes for a linked worktree), the
    // repository's record reaches it. The key really is the checkout's — derived, not asserted.
    expect(await resolveMainCheckoutProjectKey(worktree)).toBe(keyMain)
    expect(await resolveMainCheckoutProjectKey(outside)).toBeUndefined()
    expect(resolveAt(keyTree, keyMain).enabled).toBe(true)
    // BOUNDARY: the enclosing workspace, and the global layer, are untouched —
    // a project install must not leak upwards either.
    expect(resolveAt().enabled).toBe(false)
    expect(harness.policy.resolve({ pluginKey: harness.pluginKey }).enabled).toBe(false)
  })

  it('the CATALOG reports project scope — on the row, and the row is present in every project', async () => {
    const dir = root('d1360-catalog-')
    const { checkout, worktree, outside } = mintRepositories(dir)
    const keyMain = (await resolveProjectIdentity(checkout)).projectKey
    const keyTree = (await resolveProjectIdentity(worktree)).projectKey
    const keyOutside = (await resolveProjectIdentity(outside)).projectKey
    const harness = await installAtProject(dir, keyMain)

    const main = await harness.catalogFor(keyMain, checkout)
    const elsewhere = await harness.catalogFor(keyOutside, outside)
    const tree = await harness.catalogFor(keyTree, worktree)

    // THE SHAPE RS-84 COUNTED — the plugin is LISTED in all three, because a
    // plugin is installed once for the machine and the Plugins page has to
    // offer it wherever the user might enable it. A detector that counts rows
    // carrying the plugin's name therefore cannot see project scope at all.
    for (const catalog of [main, elsewhere, tree]) {
      expect(catalog.installedPlugins.map(plugin => plugin.pluginKey)).toEqual([harness.pluginKey])
      expect(catalog.capabilities.length).toBeGreaterThan(0)
    }

    // THE SCOPE VERDICT — the field the row carries, which is what the case
    // needed to read.
    const effectiveIn = (catalog: UserCapabilityCatalog) =>
      catalog.installedPlugins.find(plugin => plugin.pluginKey === harness.pluginKey)?.activation.effective
    expect(effectiveIn(main)).toBe('active')
    expect(effectiveIn(elsewhere)).toBe('inactive')
    // F1.11's answer to D1.70: the worktree's handle is still its own project, and its plugin ACTIVATION
    // follows it to the main checkout.
    expect(effectiveIn(tree)).toBe('active')

    // And every capability the plugin contributes carries the same verdict, so
    // nothing of it is offered in a project it was not installed for. The three
    // lists are the SAME LENGTH and non-empty — without that, `main` having no
    // `disabled` state would be vacuously true on an empty filter.
    const statesMain = pluginStates(main)
    const statesElsewhere = pluginStates(elsewhere)
    const statesTree = pluginStates(tree)
    expect(statesMain.length).toBeGreaterThan(0)
    expect(statesElsewhere.length).toBe(statesMain.length)
    expect(statesTree.length).toBe(statesMain.length)
    expect(statesMain.includes('disabled')).toBe(false)
    expect(new Set(statesElsewhere)).toEqual(new Set(['disabled']))
    expect(statesTree).toEqual(statesMain)
  })

  it('NOTHING of the plugin is mounted by a turn in another project — it is withheld as disabled', async () => {
    const dir = root('d1360-runtime-')
    const { checkout, worktree, outside } = mintRepositories(dir)
    const keyMain = (await resolveProjectIdentity(checkout)).projectKey
    const keyTree = (await resolveProjectIdentity(worktree)).projectKey
    const keyOutside = (await resolveProjectIdentity(outside)).projectKey
    const harness = await installAtProject(dir, keyMain)

    // The listing above is what the PAGE shows; this is what a TURN mounts, and
    // it is the half a user would feel. `toAgentRuntime` drops a capability
    // whose summary is not `enabled` and records it under `withheld`, so a
    // plugin listed-but-inactive contributes no skill, no MCP server and no
    // hook to the session's runtime.
    const mounted = (view: AgentRuntimeView) =>
      view.skills.length + view.mcpServers.length + view.hooks.length

    const main = await harness.runtimeFor(keyMain, checkout)
    expect(mounted(main)).toBeGreaterThan(0)
    expect(main.withheld).toEqual([])

    // F1.11 — the worktree mounts what its main checkout mounts.
    const tree = await harness.runtimeFor(keyTree, worktree)
    expect(mounted(tree)).toBe(mounted(main))
    expect(tree.withheld).toEqual([])

    for (const [key, root] of [[keyOutside, outside]] as const) {
      const view = await harness.runtimeFor(key, root)
      expect(mounted(view)).toBe(0)
      // Withheld, and withheld FOR THE RIGHT REASON — an empty runtime would
      // also be produced by a bundle that failed to resolve at all.
      const withheld = view.withheld ?? []
      expect(withheld.length).toBe(mounted(main))
      expect(new Set(withheld.map(item => item.reason))).toEqual(new Set(['disabled']))
    }
  })
})

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { createInstallTracker } from '@nessy-agent/shared/testing/install-tracker'
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)
const installs = createInstallTracker()
