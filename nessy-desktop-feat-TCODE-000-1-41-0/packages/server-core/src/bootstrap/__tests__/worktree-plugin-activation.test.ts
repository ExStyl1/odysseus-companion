/**
 * F1.11 (origin D1.367, decided 2026-09-24 as option (b)) — project-scope plugin ACTIVATION follows a
 * linked `git worktree` to its main checkout; project TRUST stays per directory.
 *
 * ## The decision, and where it came from
 *
 * The nearest documented solution is Claude Code's: workspace trust is asked per DIRECTORY, while a
 * plugin enabled for a project lives in the repository's own `.claude/settings.json`, so a worktree —
 * which checks that file out — inherits it, and an edit made inside the worktree stays the worktree's.
 * Our project-scope activation is a record keyed on the project's `ProjectKey` (device + inode), so a
 * worktree used to be a different, plugin-less project. The fix reads the MAIN CHECKOUT's project
 * records first and the worktree's own records after them (the narrower layer); nothing is written
 * anywhere new, and trust is not consulted at all — option (a), unifying trust as well, would transfer
 * whole-project trust into a directory the user never approved, and is refused.
 *
 * ## What this file drives
 *
 * The REAL `buildCapabilityResolutionInputsV2` (the one production input builder), the real
 * `CapabilityPolicyStore`, `PluginManagementServiceV2`, `createCapabilityResolver`, `toUserCatalog` /
 * `toAgentRuntime` and `ProjectHandleService` + `ProjectTrustStore`, over three directories minted with
 * real git — a checkout, a worktree of it, an unrelated repository — plus a directory that only CLAIMS
 * to be a worktree (a hand-written `.git` file pointing at the real worktree's admin directory), which
 * must not inherit anything.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import { toAgentRuntime, toUserCatalog } from '@nessy-agent/shared/capabilities/views'
import { PluginManagementServiceV2, PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { resolveProjectIdentity, type ProjectKey } from '@nessy-agent/shared/projects/project-identity'
import { buildCapabilityResolutionInputsV2, type CapabilityInputsV2Deps } from '../storage-runtime'

const FIXTURE_DIR = join(
  import.meta.dir, '..', '..', '..', '..',
  'shared', 'src', 'plugins', '__tests__', 'fixtures', 'format-adapters', 'codex-core',
)
const WORKSPACE_ID = 'ws_f111'

const roots: string[] = []
afterEach(async () => {
  const mine = roots.splice(0)
  await installs.settle()
  for (const dir of mine) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

interface Repositories { checkout: string; worktree: string; nested: string; outside: string; impostor: string }

function mintRepositories(dir: string): Repositories {
  const checkout = join(dir, 'main')
  const worktree = join(dir, 'wt')
  const outside = join(dir, 'elsewhere')
  const impostor = join(dir, 'impostor')
  execFileSync('git', ['init', '-q', '-b', 'main', checkout], { stdio: 'ignore' })
  mkdirSync(join(checkout, 'pkg'), { recursive: true })
  writeFileSync(join(checkout, 'pkg', 'README.md'), 'F1.11 fixture repository.\n', 'utf8')
  git(checkout, 'config', 'user.email', 'lane@example.invalid')
  git(checkout, 'config', 'user.name', 'lane')
  git(checkout, 'add', 'pkg/README.md')
  git(checkout, 'commit', '-q', '-m', 'seed')
  git(checkout, 'worktree', 'add', '-q', worktree, '-b', 'f111-wt')
  execFileSync('git', ['init', '-q', '-b', 'main', outside], { stdio: 'ignore' })
  // A directory that only CLAIMS to be a worktree of `checkout`: its `.git` FILE points at the real
  // worktree's admin directory, whose own `gitdir` back-link names `wt/.git`, not this one.
  mkdirSync(impostor, { recursive: true })
  writeFileSync(join(impostor, '.git'), `gitdir: ${join(realpathSync(checkout), '.git', 'worktrees', 'wt')}\n`, 'utf8')
  return { checkout, worktree, nested: join(worktree, 'pkg'), outside, impostor }
}

async function keyOf(path: string): Promise<ProjectKey> {
  return (await resolveProjectIdentity(path)).projectKey
}

async function harness(dir: string) {
  const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugin-store') })
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(dir, 'config', 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
  })
  const trustStore = new CapabilityTrustStore({ path: join(dir, 'config', 'trust.json') })
  const service = installs.track(new PluginManagementServiceV2({
    store,
    policyStore,
    trustStore,
    fetchImpl: (async () => { throw new Error('network forbidden') }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
    pluginDataDir: join(dir, 'plugin-data'),
  }))
  const workspaceRoot = join(dir, 'workspaces', WORKSPACE_ID)
  mkdirSync(workspaceRoot, { recursive: true })
  const deps: CapabilityInputsV2Deps = {
    resolveWorkspaceRootPath: () => workspaceRoot,
    nativeSourcesEnv: { adminSkillsDirs: [], configDir: join(dir, 'config'), homeAgentsSkillsDir: join(dir, 'agents', 'skills') },
    pluginStore: store,
    policyStore,
    trustStore,
    credentialBackend: {
      bind: (id: unknown) => ({ id, expectedRevision: 0 }),
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as unknown as CapabilityInputsV2Deps['credentialBackend'],
  }
  const resolver = createCapabilityResolver({ inputs: context => buildCapabilityResolutionInputsV2(context, deps) })
  const contextFor = async (projectRoot: string, extra: Partial<CapabilityContext> = {}): Promise<CapabilityContext> => {
    const canonical = realpathSync(projectRoot)
    return {
      workspaceId: WORKSPACE_ID,
      sessionId: 'session-f111',
      workingDirectory: canonical,
      projectRoot: canonical,
      projectKey: await keyOf(canonical),
      projectTrustState: 'none',
      projectTrustRevision: '',
      ...extra,
    }
  }
  const read = async (projectRoot: string) => {
    const snapshot = await resolver.resolve(await contextFor(projectRoot))
    try {
      const catalog = toUserCatalog(snapshot)
      const runtime = toAgentRuntime(snapshot)
      return {
        effective: catalog.installedPlugins[0]?.activation.effective,
        projectScope: catalog.installedPlugins[0]?.activation.project,
        mounted: runtime.skills.length + runtime.mcpServers.length + runtime.hooks.length,
        withheld: (runtime.withheld ?? []).map(item => item.reason),
      }
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  }
  return { service, store, policyStore, resolver, contextFor, read }
}

describe('F1.11 — a plugin enabled for the repository loads in its worktree; trust is asked there once more', () => {
  it('ACTIVATION follows the worktree to its main checkout, through the real input builder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f111-activation-'))
    roots.push(dir)
    const repos = mintRepositories(dir)
    const h = await harness(dir)
    const keyMain = await keyOf(repos.checkout)
    // The directories really are different projects — without this the readings below could agree
    // for the wrong reason.
    expect(new Set([keyMain, await keyOf(repos.worktree), await keyOf(repos.outside)]).size).toBe(3)

    const installed = await h.service.install(
      { kind: 'local-path', path: FIXTURE_DIR },
      { activateIn: { kind: 'project', workspaceId: WORKSPACE_ID, projectKey: keyMain } },
    )
    expect(installed.ok).toBe(true)

    const main = await h.read(repos.checkout)
    expect(main.effective).toBe('active')
    expect(main.mounted).toBeGreaterThan(0)

    // THE ROW: the worktree of the same repository mounts what its main checkout mounts.
    const tree = await h.read(repos.worktree)
    expect(tree.effective).toBe('active')
    expect(tree.projectScope).toBe('enabled')
    expect(tree.mounted).toBe(main.mounted)
    // Withheld exactly what the checkout withholds (the builder's own non-plugin records), nothing of the plugin.
    expect(tree.withheld).toEqual(main.withheld)
    // A subdirectory of the worktree answers to the SAME subdirectory of the checkout — which is a
    // different project from the checkout root, so it inherits nothing the root was given.
    const nested = await h.read(repos.nested)
    expect(nested.effective).toBe('inactive')

    // CONTROLS: an unrelated repository, and a directory that only claims to be a worktree.
    for (const other of [repos.outside, repos.impostor]) {
      const view = await h.read(other)
      expect(view.effective).toBe('inactive')
      expect(view.mounted).toBe(0)
      expect(new Set(view.withheld)).toEqual(new Set(['disabled']))
    }
  })

  it("the worktree's OWN record is the narrower layer: disabling there leaves the checkout active", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f111-narrower-'))
    roots.push(dir)
    const repos = mintRepositories(dir)
    const h = await harness(dir)
    const keyMain = await keyOf(repos.checkout)
    const installed = await h.service.install(
      { kind: 'local-path', path: FIXTURE_DIR },
      { activateIn: { kind: 'project', workspaceId: WORKSPACE_ID, projectKey: keyMain } },
    )
    const pluginKey = installed.installed!.pluginKey
    h.policyStore.recordProjectOverride(WORKSPACE_ID, await keyOf(repos.worktree), { pluginKey, enabled: false })

    expect((await h.read(repos.worktree)).effective).toBe('inactive')
    expect((await h.read(repos.checkout)).effective).toBe('active')
  })

  it('a change keyed on the checkout revokes a live worktree snapshot that answers to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f111-lease-'))
    roots.push(dir)
    const repos = mintRepositories(dir)
    const h = await harness(dir)
    const keyMain = await keyOf(repos.checkout)
    const tree = await h.resolver.resolve(await h.contextFor(repos.worktree, { mainCheckoutProjectKey: keyMain }))
    const outside = await h.resolver.resolve(await h.contextFor(repos.outside))
    try {
      h.resolver.invalidate({ kind: 'project', workspaceId: WORKSPACE_ID, projectKey: keyMain }, 'test', 'revoke-active-snapshot')
      expect(h.resolver.isLeaseActive(tree.leaseId)).toBe(false)
      // CONTROL: a snapshot of an unrelated project is untouched by the same invalidation.
      expect(h.resolver.isLeaseActive(outside.leaseId)).toBe(true)
    } finally {
      h.resolver.releaseSnapshot(tree.leaseId)
      h.resolver.releaseSnapshot(outside.leaseId)
    }
  })

  it('TRUST stays per directory: trusting the checkout does not trust its worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f111-trust-'))
    roots.push(dir)
    const repos = mintRepositories(dir)
    const handles = new ProjectHandleService({ trustStore: new ProjectTrustStore({ path: join(dir, 'config', 'project-trust.json') }) })
    const main = await handles.validateProjectDirectory(WORKSPACE_ID, repos.checkout)
    await handles.setProjectTrust({ workspaceId: WORKSPACE_ID, projectHandleId: main.id }, 'trusted')
    expect((await handles.validateProjectDirectory(WORKSPACE_ID, repos.checkout)).trustState).toBe('trusted')
    // The worktree asks once more — option (a) would have answered 'trusted' here.
    expect((await handles.validateProjectDirectory(WORKSPACE_ID, repos.worktree)).trustState).toBe('unknown')
  })
})

// A per-CASE budget and the shared install tracker (F1.424's recipe): every case above runs a REAL
// plugin-store install, and the teardown waits for it before removing the root.
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { createInstallTracker } from '@nessy-agent/shared/testing/install-tracker'
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)
const installs = createInstallTracker()
