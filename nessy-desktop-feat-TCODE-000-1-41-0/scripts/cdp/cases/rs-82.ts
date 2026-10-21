/**
 * RS-82 (D1.71) — does installing a plugin by itself turn its bundled MCP server
 * ON? Read off the product's own capability catalog, before and after, in a
 * profile that had no plugins at all.
 *
 * ## The row
 *
 * D1.71, carried from P6.429: *"Rig: install a plugin declaring an MCP server
 * and a connector into a clean profile and read the capability enablement state
 * BEFORE any user action; control = the same plugin after an explicit enable.
 * done_means: the post-install default of every bundled capability kind is
 * recorded, per runtime, with the file:line that sets it."*
 *
 * Every sitting so far has recorded it as an operator precondition, because
 * `scripts/cdp/README.md` reserves plugin INSTALLATION for the operator. This
 * lane was told it may install one into its own fresh profile, so the
 * precondition is gone and the row is drivable — and the install goes through
 * the app's own marketplace RPC, which is the path a user takes.
 *
 * ## The plugin, and why this one
 *
 * `figma-api-mcp` on the `skills-market` marketplace: `kind: 'mcp'`, one declared
 * capability (`figma-api`), no skills, no agents, no hooks. A plugin with one
 * bundled server answers "is the bundled server on by default?" without any of
 * the ambiguity a multi-component bundle brings — and its server needs a Figma
 * token nobody here has, so an accidentally-enabled server cannot reach anything.
 * The listing id is resolved BY NAME through the same `marketplace.list` the
 * Plugins page calls, never hard-coded, because a marketplace id is a fact about
 * a catalogue and not about this product.
 *
 * ## The detector
 *
 * `capabilities.getCatalog({ workspaceId })` — the surface the Plugins page
 * itself renders. It answers `{ generation, installedPlugins, capabilities,
 * diagnostics }`, and every capability entry carries its own state. The case
 * records the WHOLE entry for anything the plugin contributed rather than one
 * field, because the row asks for "the post-install default of every bundled
 * capability kind" and a single boolean chosen in advance would be this case
 * deciding what the answer looks like.
 *
 * ## The controls
 *
 *  1. **the profile had no plugins before** — `installedPlugins: []`. A catalog
 *     that already carried the plugin would make "it is there afterwards" mean
 *     nothing.
 *  2. **the reader SEES the install** — `installedPlugins` gains exactly this
 *     plugin, and the capability list grows. Without that, "its server is not
 *     enabled" is equally true of a catalog this reader could not refresh.
 *  3. **the generation moves** — the catalog's own `generation` hash before and
 *     after. It is the product's own statement that the snapshot was recomputed,
 *     so a stale read cannot be mistaken for a post-install state.
 *
 * ## What it restores
 *
 * The plugin is uninstalled in a `finally` and the catalog is read once more, so
 * a later case in the same profile does not inherit it.
 */

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, listSessions } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-82'
const TITLE = 'whether installing a plugin turns its bundled MCP server on, read off the capability catalog'

/** The listing this case installs; resolved by NAME, never by a hard-coded id. */
const PLUGIN_NAME = process.env.NESSY_CDP_PLUGIN_LISTING ?? 'figma-api-mcp'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.71',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: none. It installs one marketplace plugin into the config dir the run was launched with, through the '
    + 'app\'s own marketplace RPC, and uninstalls it again. No key, token or credential file is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir CREATED FOR THE RUN — the row says "a clean profile" and means it.',
    '2. Read `capabilities.getCatalog({ workspaceId })`: `installedPlugins` must be empty.',
    '3. Resolve the listing by NAME through `marketplace.list({ kind: "plugins", query })`.',
    '4. `marketplace.install({ source: { kind: "listing", marketplaceId, listingId, listingKind: "plugins" } })`.',
    '5. Read the catalog again with NO user action in between, and record every entry the plugin contributed.',
    '6. Uninstall, and read once more.',
  ],
  expected:
    'The bundled MCP server appears in the catalog after the install. Whether it is ENABLED at that moment, with '
    + 'no user action, is the row\'s question and is recorded rather than assumed.',
  detector:
    '`capabilities.getCatalog({ workspaceId })` — the surface the Plugins page renders — read before the install, '
    + 'immediately after it, and after the uninstall. The WHOLE entry for each contributed capability is '
    + 'recorded, not one field chosen in advance.',
  positiveControl:
    '`installedPlugins` empty before and naming exactly this plugin after, plus the catalog\'s own `generation` '
    + 'hash changing. Without them, "the bundled server is not enabled" is equally true of a catalog that never '
    + 'refreshed, and the row would record a default nobody measured.',
  doneMeans:
    'D1.71 records the post-install default of every capability kind the plugin bundles, with the reading behind '
    + 'it — or states which kinds this plugin does not carry, so the row knows what is still owed.',
  doNotConflate:
    'A plugin declaring ONE MCP server answers the MCP clause only. A bundled CONNECTOR and a bundled connected '
    + 'service are separate kinds, and this plugin has neither; the verdict says so instead of generalising.',
} as const satisfies SittingRecipe

interface Catalog {
  generation?: string
  installedPlugins?: Array<Record<string, unknown>>
  capabilities?: Array<Record<string, unknown>>
  diagnostics?: unknown
}

async function catalogOf(session: CdpSession, workspaceId: string): Promise<Catalog> {
  return session.call<Catalog>(`
    return await window.electronAPI.capabilities.getCatalog({ workspaceId: ${JSON.stringify(workspaceId)} })
  `)
}

/** Every capability entry whose key or plugin field names this plugin. */
function contributed(catalog: Catalog, needle: string): Array<Record<string, unknown>> {
  return (catalog.capabilities ?? []).filter(entry => JSON.stringify(entry).toLowerCase().includes(needle.toLowerCase()))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the capability catalog a plugin install changes')
  if (contaminated !== undefined) blocked(contaminated)

  const sessions = await listSessions(session)
  const workspaceId = sessions[0]?.workspaceId
  if (!workspaceId) blocked('no session exists yet, so there is no workspace to read a capability catalog for')

  const before = await catalogOf(session, workspaceId)
  run.observe('the catalog BEFORE', {
    generation: before.generation,
    installedPlugins: before.installedPlugins,
    capabilityCount: (before.capabilities ?? []).length,
  })
  run.require(
    'THE CONTROL — this profile had no plugin installed before the case',
    (before.installedPlugins ?? []).length === 0,
    `\`installedPlugins\` already names ${JSON.stringify(before.installedPlugins)}. The row asks for a CLEAN `
    + 'profile, and on a dirty one "the plugin is there afterwards" says nothing',
  )

  const listing = await session.call<{ marketplaceId?: string; id?: string; name?: string; capabilities?: string[]; kind?: string } | null>(`
    const page = await window.electronAPI.marketplace.list({ kind: 'plugins', query: ${JSON.stringify(PLUGIN_NAME)}, pageSize: 20 })
    const hit = (page.items ?? []).find(item => item.name === ${JSON.stringify(PLUGIN_NAME)})
    return hit ? { marketplaceId: hit.marketplaceId, id: hit.id, name: hit.name, capabilities: hit.capabilities, kind: hit.kind } : null
  `)
  run.observe('the listing, resolved by name', listing)
  if (!listing?.marketplaceId || !listing.id) {
    blocked(
      `no marketplace listing named ${JSON.stringify(PLUGIN_NAME)} is reachable from this profile. Add a registry `
      + 'through the app first, or name another listing with NESSY_CDP_PLUGIN_LISTING',
    )
  }

  let installed = false
  try {
    const install = await session.call<unknown>(`
      return await window.electronAPI.marketplace.install({
        source: {
          kind: 'listing',
          marketplaceId: ${JSON.stringify(listing.marketplaceId)},
          listingId: ${JSON.stringify(listing.id)},
          listingKind: 'plugins',
        },
      })
    `)
    installed = true
    run.observe('the install result', install)

    const after = await catalogOf(session, workspaceId)
    const entries = contributed(after, PLUGIN_NAME)
    run.observe('the catalog AFTER, with NO user action', {
      generation: after.generation,
      installedPlugins: after.installedPlugins,
      capabilityCount: (after.capabilities ?? []).length,
      contributedEntries: entries,
    })

    run.require(
      'THE CONTROL — the reader SEES the install',
      (after.installedPlugins ?? []).length > (before.installedPlugins ?? []).length,
      `\`installedPlugins\` went from ${JSON.stringify(before.installedPlugins)} to `
      + `${JSON.stringify(after.installedPlugins)}. If the catalog did not move, everything below is a stale read`,
    )
    run.check(
      'THE CONTROL — the catalog\'s own generation hash changed',
      before.generation !== after.generation,
      `generation stayed ${String(before.generation)}. The product recomputes it per snapshot, so an unchanged `
      + 'hash means this is the SAME snapshot and the post-install state was never read',
    )
    run.check(
      'D1.71 — the plugin\'s bundled capability appears in the catalog at all',
      entries.length > 0,
      `no catalog entry names ${JSON.stringify(PLUGIN_NAME)} after the install, over `
      + `${(after.capabilities ?? []).length} entries. The listing declares `
      + `${JSON.stringify(listing.capabilities)}`,
    )
    run.observe('D1.71 — the post-install DEFAULT of every bundled kind', {
      declared: listing.capabilities,
      listingKind: listing.kind,
      entries: entries.map(entry => ({
        key: entry.key,
        kind: entry.kind,
        logicalName: entry.logicalName,
        enabled: entry.enabled,
        state: entry.state,
        trust: entry.trust ?? entry.trustState,
      })),
      note:
        'the row asks for the post-install default of every bundled kind. This plugin bundles an MCP server and '
        + 'nothing else — no connector and no connected service — so the connector clause of D1.71 is owed and '
        + 'is not generalised from this reading.',
    })
  } finally {
    if (installed) {
      // The key is the one the CATALOG reports, never the listing's name: the
      // first drive passed the name and the RPC answered
      // `plugin.manage.invalid-plugin-key`, leaving the plugin installed in the
      // profile for whatever ran next.
      const removal = await session.call<unknown>(`
        const catalog = await window.electronAPI.capabilities.getCatalog({ workspaceId: ${JSON.stringify(workspaceId)} })
        const row = (catalog.installedPlugins ?? []).find(entry => JSON.stringify(entry).includes(${JSON.stringify(PLUGIN_NAME)}))
        if (!row) return { uninstall: 'nothing-to-remove' }
        try { return { pluginKey: row.pluginKey, result: await window.electronAPI.plugin.manage({ action: 'uninstall', pluginKey: row.pluginKey }) } }
        catch (error) { return { pluginKey: row.pluginKey, uninstallError: String(error).slice(0, 200) } }
      `).catch(error => ({ uninstallThrew: String(error).slice(0, 200) }))
      const restored = await catalogOf(session, workspaceId).catch(() => ({} as Catalog))
      run.observe('the teardown', { removal, installedPluginsNow: restored.installedPlugins })
      run.check(
        'the case left the profile as it found it',
        (restored.installedPlugins ?? []).length === 0,
        `\`installedPlugins\` still carries ${JSON.stringify(restored.installedPlugins)} after the uninstall. A `
        + 'plugin left behind is inherited by every later case in this profile, and this case\'s own first '
        + 'control would then refuse to run',
      )
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
