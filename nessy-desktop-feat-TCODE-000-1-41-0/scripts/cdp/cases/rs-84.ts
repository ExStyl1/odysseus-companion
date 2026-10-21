/**
 * RS-84 (D1.70) — does a plugin installed at PROJECT scope in a main checkout
 * load in a `git worktree` of the same repository?
 *
 * ## The row
 *
 * D1.70, carried from P6.427: *"Rig: install a plugin at project scope in a main
 * checkout, open a session in a `git worktree add` of the same repo, read the
 * session's project plugin config; control = a session in the main checkout.
 * done_means: the verdict is recorded, and if the handle does not resolve to the
 * main checkout the one-call fix is a follow-up row."*
 *
 * Every earlier sitting recorded it as *"operator precondition — the same plugin
 * install"*. RS-82 (D1.71) removed that: a lane may install into the config dir
 * its own run created, through the app's own `marketplace.install` RPC.
 *
 * ## What "project scope" is here
 *
 * `marketplace.install` takes `activateIn: SafePluginActivationTarget`, whose
 * project form is `{ kind: 'project', context: { workspaceId, sessionId } }` —
 * the project is named by the SESSION whose working directory sits in it, never
 * by a path the renderer supplies. That is exactly the indirection the row is
 * about: a worktree is a different directory with the same repository behind it,
 * so whether the handle resolves to the checkout or to the repo decides the
 * answer.
 *
 * ## The detector — the VERDICT FIELD, not the presence of a row (D1.368)
 *
 * `capabilities.getCatalog({ workspaceId, sessionId })` — the same surface the
 * Plugins page renders, asked with a SESSION ref so the answer is that session's
 * project scope. What is read off it is `installedPlugins[].activation.effective`
 * (`'active'` / `'inactive'`), each capability summary's `state`, and
 * `capabilities[].scope.projectKey` — never whether a row exists. The catalog is
 * a LISTING and reports every installed plugin whatever the session; the scope
 * is a field on the row. The first drive read row COUNTS, asked for an absence
 * the product cannot produce, and filed the resulting non-zero as the install
 * being unscoped (D1.360, refuted by WI-bf against the product itself).
 *
 * ## The controls
 *
 *  1. **the profile starts with no plugins** — `installedPlugins: []` on a
 *     workspace-level read. RS-82 measured what a dirty profile does to this.
 *  2. **the main-checkout session reports it ACTIVE** — if the control session
 *     does not, the install did not take at project scope at all and the
 *     worktree reading says nothing about worktrees.
 *  3. **the two sessions really are in different directories** — each session's
 *     own working directory is read back from the app, not assumed from what the
 *     case asked for.
 *  4. **the worktree really is one** — `git worktree list` names both, and the
 *     `.git` in the worktree is a FILE pointing into the main checkout, which is
 *     what makes this a worktree rather than a second clone.
 *
 * ## What it creates and restores
 *
 * A git repository and a worktree of it under the OS temp directory, both
 * removed in a `finally`; two sessions it names itself; one plugin, uninstalled
 * with the key the catalog reports (RS-82 measured that the listing's NAME
 * answers `plugin.manage.invalid-plugin-key` and leaves it installed).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindWorkingDirectory, buttonTextInPage, DIALOG_DISMISS_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, trustScratchProject } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, listSessions, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-84'
const TITLE = 'whether a project-scope plugin installed in a main checkout loads in a worktree of the same repo'

const PLUGIN_NAME = process.env.NESSY_CDP_PLUGIN_LISTING ?? 'figma-api-mcp'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.70',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: none. It installs one marketplace plugin at PROJECT scope into the config dir the run was launched '
    + 'with and uninstalls it; it mints and removes its own git repository and worktree under the OS temp dir.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run — the install must start from `installedPlugins: []`.',
    '2. The case mints a git repository under the OS temp dir and `git worktree add`s a sibling of it.',
    '3. Session A: working directory = the main checkout. Install the plugin with `activateIn: { kind: "project", context: { workspaceId, sessionId } }`.',
    '4. Read `capabilities.getCatalog({ workspaceId, sessionId })` for session A — the control; the plugin\'s `activation.effective` must read `active` there.',
    '5. Session B: working directory = the WORKTREE. Read the same catalog for it — the subject.',
    '6. Uninstall with the key the catalog reports, and remove both trees.',
  ],
  expected:
    'A project-scope install is bound to a project. Whether the worktree resolves to the same project as the main '
    + 'checkout is the row\'s question; both answers are real and the case records which one this build gives.',
  detector:
    '`capabilities.getCatalog({ workspaceId, sessionId })`, asked once per session so each answer is that '
    + 'session\'s own project scope — and read for its VERDICT FIELDS (`installedPlugins[].activation.effective`, '
    + 'each capability summary\'s `state`, `capabilities[].scope.projectKey`), never for whether a row exists. The '
    + 'catalog is a listing; the scope is a field on the row (D1.368).',
  positiveControl:
    'the MAIN-checkout session reporting `activation.effective: "active"`. If the control session does not, the '
    + 'install did not take at project scope at all and the worktree reading says nothing about worktrees. Two more: each '
    + 'session\'s working directory is read back from the app rather than assumed, and `git worktree list` plus a '
    + '`.git` FILE in the worktree prove it is a worktree and not a second clone.',
  doneMeans:
    'D1.70 records the verdict with the reading behind it, and — per the row — whether the handle resolves to the '
    + 'main checkout, so a one-call fix can become a follow-up row if it does not.',
  doNotConflate:
    'A plugin that reads `inactive` in the worktree because the project was never TRUSTED there is a different '
    + 'finding. The case reads each session\'s own trust state beside the catalog so the two cannot be merged. And '
    + '`no-row` is a THIRD state: it means this build does not list what it does not activate, in which case the '
    + 'verdict field is the wrong instrument here and the row count was right after all.',
} as const satisfies SittingRecipe

interface Catalog {
  generation?: string
  installedPlugins?: Array<Record<string, unknown>>
  capabilities?: Array<Record<string, unknown>>
}

/**
 * D1.368 — what this case reads, and why the ROW COUNT it used to read was a
 * control the product cannot pass.
 *
 * The first drive (SIT-5e) asked `capabilities.getCatalog` for an ABSENCE: the
 * plugin naming zero rows in a session whose working directory is an unrelated
 * git repository. It named rows there, the case reported the install as
 * unscoped, and the finding became D1.360. WI-bf then measured the product
 * directly and REFUTED it: the scoping is correct and the catalog is a
 * **listing** — it reports every installed plugin and carries the scope verdict
 * as a FIELD on each row. It never omits the row, so the absence this control
 * asked for is one it structurally cannot produce, and every OTHER control in
 * the case passed, which is exactly what made the negative one look meaningful.
 *
 * The fields, all of them already across the RPC boundary (`toSafeInstalledPlugin`,
 * `toSafeSummary`):
 *
 *  - `installedPlugins[].activation.effective` — `'active'` inside the project
 *    the install named, `'inactive'` anywhere else. THIS is the verdict.
 *  - each capability summary's `state` — `'disabled'` outside that project.
 *  - `capabilities[].scope.projectKey` — which project an answer is FOR, so the
 *    case asserts the identity rather than inferring it from the directory it
 *    asked about.
 *
 * The rule this cost is in `scripts/cdp/README.md`: when a control asserts an
 * absence from a DTO, read the DTO's own verdict field first and assert on that.
 */
interface ScopeReading {
  /** `'active'` / `'inactive'`, or `'no-row'` when the plugin is not listed at all. */
  effective: string
  /** The capability states this plugin's entries carry, distinct and sorted. */
  capabilityStates: string[]
  /** `capabilities[].scope.projectKey` for this plugin's entries — which project answered. */
  projectKeys: string[]
  /** Kept beside the verdict, because "the row is missing" is its own reading. */
  pluginRows: number
  capabilityRows: number
}

/**
 * Read the SCOPE VERDICT off the catalog, never the presence of a row.
 *
 * `pluginRows`/`capabilityRows` are still recorded — a missing row IS a distinct
 * state and this case must be able to tell it from `'inactive'` — but nothing
 * asserts on them any more.
 */
function scopeOf(catalog: Catalog, needle: string): ScopeReading {
  const pluginRows = (catalog.installedPlugins ?? []).filter(row => JSON.stringify(row).includes(needle))
  const capabilityRows = (catalog.capabilities ?? []).filter(row => JSON.stringify(row).includes(needle))
  const activation = pluginRows[0]?.activation as { effective?: unknown } | undefined
  const states = new Set<string>()
  const keys = new Set<string>()
  for (const row of capabilityRows) {
    if (typeof row.state === 'string') states.add(row.state)
    const scope = row.scope as { projectKey?: unknown } | undefined
    if (scope && typeof scope.projectKey === 'string') keys.add(scope.projectKey)
  }
  return {
    effective: typeof activation?.effective === 'string' ? activation.effective : (pluginRows.length === 0 ? 'no-row' : 'no-field'),
    capabilityStates: [...states].sort(),
    projectKeys: [...keys].sort(),
    pluginRows: pluginRows.length,
    capabilityRows: capabilityRows.length,
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function catalogFor(session: CdpSession, workspaceId: string, sessionId?: string): Promise<Catalog> {
  const ref = sessionId ? `{ workspaceId: ${JSON.stringify(workspaceId)}, sessionId: ${JSON.stringify(sessionId)} }`
    : `{ workspaceId: ${JSON.stringify(workspaceId)} }`
  return session.call<Catalog>(`return await window.electronAPI.capabilities.getCatalog(${ref})`)
}

/** Bind a session to a card, point it at `dir`, answer the trust gate if raised. */
async function sessionIn(
  run: CaseRun,
  session: CdpSession,
  label: string,
  slug: string,
  dir: string,
): Promise<SessionKey & { cwd?: string; trust: string }> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`[${label}] ran in a session it created`, key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages}`)
  const bind = await switchRuntime(session, key.sessionId, slug)
  run.check(`[${label}] bound to ${slug}`, bind.ok, bind.ok ? undefined : bind.error)
  // F1.182 — started, not awaited: the gate is answered while the mutation is
  // in flight, and `cwd` is the bind's own polled reading rather than a single
  // sample, which answers `''` even when the bind succeeded (SIT-9).
  const binding = bindWorkingDirectory(session, key.sessionId, dir)
  const trust = await trustScratchProject(session, dir, 20_000).catch(error => `threw: ${String(error).slice(0, 120)}`)
  const bound = await binding
  run.check(`[${label}] the session is bound to ${dir}`, bound.bound, bound.reason ?? '')
  const cwd = bound.reported === '' ? undefined : bound.reported
  return { ...key, ...(cwd ? { cwd } : {}), trust: String(trust) }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the project scope a plugin install is bound to')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const card = cards.find(row => runtimeOf(row.providerType) === 'pi') ?? cards[0]
  if (!card) blocked('this profile lists no connection at all, so no session can be bound')

  const existing = await listSessions(session)
  const workspaceId = existing[0]?.workspaceId
  if (!workspaceId) blocked('no session exists yet, so there is no workspace to read a capability catalog for')

  const base = await catalogFor(session, workspaceId)
  run.require(
    'THE CONTROL — this profile starts with no plugin installed',
    (base.installedPlugins ?? []).length === 0,
    `\`installedPlugins\` already names ${JSON.stringify(base.installedPlugins)}. On a dirty profile "the worktree `
    + 'session carries it" cannot be attributed to this install',
  )

  // ---- the repository and its worktree -------------------------------------
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cdp-rs84-')))
  const checkout = join(root, 'main')
  const tree = join(root, 'wt')
  /** A different repository entirely — the negative control's working directory. */
  const outside = join(root, 'elsewhere')
  let installed: string | undefined
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', checkout], { stdio: 'ignore' })
    writeFileSync(join(checkout, 'README.md'), 'CDP RS-84 fixture repository.\n', 'utf8')
    git(checkout, 'config', 'user.email', 'cdp@example.invalid')
    git(checkout, 'config', 'user.name', 'CDP')
    git(checkout, 'add', 'README.md')
    git(checkout, 'commit', '-q', '-m', 'seed')
    git(checkout, 'worktree', 'add', '-q', tree, '-b', 'cdp-wt')
    execFileSync('git', ['init', '-q', '-b', 'main', outside], { stdio: 'ignore' })
    writeFileSync(join(outside, 'README.md'), 'CDP RS-84 unrelated repository.\n', 'utf8')
    const worktrees = git(checkout, 'worktree', 'list')
    const dotGit = statSync(join(tree, '.git'))
    run.observe('the repository and its worktree', {
      checkout,
      tree,
      worktrees: worktrees.split('\n'),
      worktreeDotGitIsFile: dotGit.isFile(),
      worktreeDotGitPoints: dotGit.isFile() ? readFileSync(join(tree, '.git'), 'utf8').trim() : undefined,
    })
    run.require(
      'THE CONTROL — the second directory really is a git WORKTREE of the first',
      dotGit.isFile() && worktrees.split('\n').length >= 2,
      `\`git worktree list\` answered ${JSON.stringify(worktrees)} and the worktree's .git is a `
      + `${dotGit.isFile() ? 'file' : 'directory'}. A second CLONE would answer the row's question about clones`,
    )

    // ---- session A: the main checkout, and the install ---------------------
    const mainSession = await sessionIn(run, session, 'main', card.slug, checkout)
    run.observe('session A', { sessionId: mainSession.sessionId, cwd: mainSession.cwd, trust: mainSession.trust })

    const listing = await session.call<{ marketplaceId?: string; id?: string; name?: string } | null>(`
      const page = await window.electronAPI.marketplace.list({ kind: 'plugins', query: ${JSON.stringify(PLUGIN_NAME)}, pageSize: 20 })
      const hit = (page.items ?? []).find(item => item.name === ${JSON.stringify(PLUGIN_NAME)})
      return hit ? { marketplaceId: hit.marketplaceId, id: hit.id, name: hit.name } : null
    `)
    if (!listing?.marketplaceId || !listing.id) {
      blocked(`no marketplace listing named ${JSON.stringify(PLUGIN_NAME)} is reachable from this profile`)
    }
    const install = await session.call<unknown>(`
      return await window.electronAPI.marketplace.install({
        source: { kind: 'listing', marketplaceId: ${JSON.stringify(listing.marketplaceId)}, listingId: ${JSON.stringify(listing.id)}, listingKind: 'plugins' },
        activateIn: { kind: 'project', context: { workspaceId: ${JSON.stringify(workspaceId)}, sessionId: ${JSON.stringify(mainSession.sessionId)} } },
      })
    `)
    installed = PLUGIN_NAME
    run.observe('the PROJECT-scope install', install)

    const mainCatalog = await catalogFor(session, workspaceId, mainSession.sessionId)
    const mainScope = scopeOf(mainCatalog, PLUGIN_NAME)
    run.observe('session A — the scope verdict', { ...mainScope, generation: mainCatalog.generation })
    run.require(
      'THE CONTROL — the MAIN-checkout session reports the project-scope plugin ACTIVE',
      mainScope.effective === 'active',
      `the main checkout's own catalog answers \`activation.effective: ${JSON.stringify(mainScope.effective)}\` `
      + `with capability states ${JSON.stringify(mainScope.capabilityStates)} (${mainScope.pluginRows} plugin row(s), `
      + `${mainScope.capabilityRows} capability row(s)). If the install did not take at project scope HERE, the `
      + 'worktree reading below says nothing about worktrees',
    )

    // ---- session B: the worktree -------------------------------------------
    const treeSession = await sessionIn(run, session, 'worktree', card.slug, tree)
    run.observe('session B', { sessionId: treeSession.sessionId, cwd: treeSession.cwd, trust: treeSession.trust })
    run.require(
      'THE CONTROL — the two sessions really are in different directories',
      mainSession.cwd !== treeSession.cwd,
      `both sessions report ${JSON.stringify(mainSession.cwd)}. If the app put them in the same directory there `
      + 'is no worktree question left to ask',
    )

    const treeCatalog = await catalogFor(session, workspaceId, treeSession.sessionId)
    const treeScope = scopeOf(treeCatalog, PLUGIN_NAME)
    run.observe('session B — the scope verdict', { ...treeScope, generation: treeCatalog.generation })
    run.check(
      'D1.70 — a project-scope plugin installed in the main checkout ALSO loads in a worktree of the same repo',
      treeScope.effective === 'active',
      `the worktree session answers \`activation.effective: ${JSON.stringify(treeScope.effective)}\` with capability `
      + `states ${JSON.stringify(treeScope.capabilityStates)} and \`scope.projectKey\` `
      + `${JSON.stringify(treeScope.projectKeys)}, against ${JSON.stringify(mainScope.effective)} / `
      + `${JSON.stringify(mainScope.projectKeys)} in the main checkout. A worktree is a different directory with the `
      + 'same repository behind it, so this is whether the project handle resolves to the checkout or to the repo',
    )
    // ---- session C: the NEGATIVE control, an UNRELATED directory ----------
    // Without this, "the worktree session carries it" is equally true of a
    // plugin that is visible from everywhere, and the row would record a
    // project-scope resolution nobody measured.
    const outsideSession = await sessionIn(run, session, 'outside', card.slug, outside)
    const outsideCatalog = await catalogFor(session, workspaceId, outsideSession.sessionId)
    const outsideScope = scopeOf(outsideCatalog, PLUGIN_NAME)
    run.observe('session C — an unrelated directory', {
      sessionId: outsideSession.sessionId, cwd: outsideSession.cwd, trust: outsideSession.trust, ...outsideScope,
    })
    // D1.368 — this control asks for `'inactive'`, not for a missing row. The
    // catalog is a LISTING: it reports every installed plugin whatever the
    // session asks from, and the scope lives in `activation.effective`. The
    // row-count version asked the product for an absence it cannot produce, and
    // reported the resulting non-zero as the install being unscoped (D1.360,
    // refuted by WI-bf against the product itself).
    run.require(
      'THE NEGATIVE CONTROL — a session in an UNRELATED directory reports the project-scope plugin INACTIVE',
      outsideScope.effective === 'inactive',
      `a session whose working directory is ${outside} — a different git repository entirely — answers `
      + `\`activation.effective: ${JSON.stringify(outsideScope.effective)}\` with capability states `
      + `${JSON.stringify(outsideScope.capabilityStates)}. An \`active\` here means the install is not `
      + 'project-scoped at all and the worktree reading above measures nothing about worktrees; a `no-row` means '
      + 'this build does not list what it does not activate, and then the verdict field is the wrong instrument '
      + 'and the row-count one was right after all',
    )

    run.observe('D1.70 — the answer, with both trust states beside it', {
      outsideControl: { ...outsideScope, cwd: outsideSession.cwd },
      mainCheckout: { ...mainScope, trust: mainSession.trust, cwd: mainSession.cwd },
      worktree: { ...treeScope, trust: treeSession.trust, cwd: treeSession.cwd },
      note:
        'a plugin absent from the worktree because that directory was never TRUSTED is a different finding from '
        + 'a project handle that does not follow the repository, so both trust states are recorded here.',
    })
  } finally {
    if (installed) {
      const removal = await session.call<unknown>(`
        const catalog = await window.electronAPI.capabilities.getCatalog({ workspaceId: ${JSON.stringify(workspaceId)} })
        const row = (catalog.installedPlugins ?? []).find(entry => JSON.stringify(entry).includes(${JSON.stringify(PLUGIN_NAME)}))
        if (!row) return { uninstall: 'nothing-to-remove' }
        try { return { pluginKey: row.pluginKey, result: await window.electronAPI.plugin.manage({ action: 'uninstall', pluginKey: row.pluginKey }) } }
        catch (error) { return { pluginKey: row.pluginKey, uninstallError: String(error).slice(0, 200) } }
      `).catch(error => ({ uninstallThrew: String(error).slice(0, 200) }))
      const after = await catalogFor(session, workspaceId).catch(() => ({} as Catalog))
      run.observe('the teardown', { removal, installedPluginsNow: (after.installedPlugins ?? []).length })
    }
    // Dismiss anything this case left on screen BEFORE deleting the trees:
    // RS-80 measured that a modal naming a deleted directory answers
    // `Could not update project trust` to every click afterwards and blocks the
    // whole profile.
    await session.call<string>(`
      const d = document.querySelector('[role="dialog"]')
      if (!d) return 'none'
      const b = Array.from(d.querySelectorAll('button')).find(${buttonTextInPage(DIALOG_DISMISS_BUTTON_TEXTS)})
      if (!b) return 'no-button'
      b.click()
      return 'dismissed'
    `).catch(() => 'unreadable')
    try { execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: checkout, stdio: 'ignore' }) } catch { /* the rmSync below covers it */ }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* the temp dir is the OS's problem */ }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
