/**
 * MCP-W3 — two marketplaces, one `pluginId`, one wire name.
 *
 * F1 (2026-08-11) could not reproduce this and said so: every `local-path`
 * install collapses onto `marketplaceId: "local"`, `pluginKey` derives from
 * `marketplaceId + pluginId`, so a second install of the same plugin became an
 * UPDATE of one slot instead of a second instance. Its report closed the item
 * as needing "a real second marketplace registry reachable from this machine".
 *
 * Two LOCAL-FOLDER registries are exactly that. `registry-source.ts` treats a
 * local directory as a first-class registry (its `upgrade` is a typed `not-git`
 * no-op), each `add()` mints its own `registry-<uuid>`, and each plugin gets a
 * durable `local-path` install source under that registry's id — so the two
 * installs land in two different plugin slots on one machine, with no network.
 *
 * ## Why this is the interesting case for naming
 *
 * `pluginMcpWireName(pluginId, serverName)` is a PURE function of the plugin's
 * identity — that is the whole point of N1, because it means an unrelated
 * install can never move a name. The cost of that purity is that two copies of
 * ONE plugin from two marketplaces mint the SAME wire name. Something has to
 * decide, and this case measures what: `mcp.md:457`'s "plugins and connectors
 * match by endpoint" is implemented as the T4b endpoint-identity pass, which
 * stands the loser down BEFORE the collision can reach the pool.
 *
 * So a PASS here is not "two servers coexist under two names". It is: two
 * instances genuinely coexist as plugins, exactly one serves the name, the
 * other says why, and the surviving one still answers.
 */

import type { CdpSession } from '../lib/connect.ts'
import { EXPECTED, FIXTURE } from '../fixtures/mcp-naming.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  capabilityDiagnostics,
  catalogRows,
  ensureDarkTheme,
  fixtureWorkspaceId,
  mcpTools,
  requireTokens,
} from '../lib/mcp-fixture.ts'
import { assertElectronApi } from '../lib/state.ts'

const ID = 'MCP-W3'
const TITLE = 'The same pluginId installed from two marketplaces: both instances exist, one serves the name, the other says why'

const ENDPOINT_DIAGNOSTIC = 'capability.dedup.endpoint-identity'

/** `plugin://<marketplaceId>/<pluginId>@<version>#<hash>#<capabilityId>@…` */
function marketplaceIdOf(capabilityKey: string): string | undefined {
  return /^plugin:\/\/([^/]+)\//.exec(capabilityKey)?.[1]
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  requireTokens()
  run.observe('theme', await ensureDarkTheme(session))

  const workspaceId = await fixtureWorkspaceId(session)

  const registries = await session.call<{ marketplaceId: string; displayName: string }[]>(`
    const r = await window.electronAPI.marketplace.listRegistries()
    return (r.registries ?? []).map(x => ({ marketplaceId: x.marketplaceId, displayName: x.displayName }))
  `)
  run.observe('registries', registries)

  const rows = await catalogRows(session, workspaceId)
  const dual = rows.filter(r => r.kind === 'mcp' && r.origin === 'plugin' && r.logicalName === FIXTURE.dualServerName)
  run.observe('dual-rows', dual.map(r => ({ key: r.key.slice(0, 110), state: r.state, reason: r.unavailableReason })))

  if (dual.length < 2) {
    blocked(
      `only ${dual.length} instance(s) of "${FIXTURE.pluginDualId}" are installed. This case needs it installed from BOTH `
      + 'local-folder registries — add `<root>/market-a` and `<root>/market-b` as marketplaces and install '
      + `${FIXTURE.pluginDualId} from each (recipe: the MCP-W row in docs/testing/cdp-live-checklist.md).`,
    )
  }

  const marketplaceIds = new Set(dual.map(r => marketplaceIdOf(r.key)).filter(Boolean) as string[])
  run.observe('distinct-marketplace-ids', [...marketplaceIds])
  // The thing F1 could not produce: two instances of one pluginId that did NOT
  // collapse into a single slot.
  run.check(
    'the two instances come from two DIFFERENT marketplaces (they did not collapse into one plugin slot)',
    marketplaceIds.size === 2,
    `${marketplaceIds.size} distinct marketplaceId(s) across ${dual.length} rows`,
  )

  const enabled = dual.filter(r => r.state === 'active')
  const standDown = dual.filter(r => r.state !== 'active')
  run.check(
    'exactly one of them serves the name',
    enabled.length === 1,
    `${enabled.length} active, ${standDown.length} stood down`,
  )
  run.check(
    'the other is stood down with duplicates-endpoint',
    standDown.length >= 1 && standDown.every(r => r.unavailableReason === 'duplicates-endpoint'),
    standDown.map(r => `${r.state}/${String(r.unavailableReason)}`).join(', ') || 'nothing stood down',
  )

  // Both would mint the SAME wire name — that is what the dedup is preventing,
  // and it is why "two marketplaces, one plugin" is a naming question at all.
  run.observe('wire-name-both-would-mint', EXPECTED.pluginDualWire)

  for (const loser of standDown) {
    const diagnostics = await capabilityDiagnostics(session, workspaceId, loser.key)
    const dedup = diagnostics.find(d => d.code === ENDPOINT_DIAGNOSTIC)
    run.observe(`stood-down-diagnostic:${marketplaceIdOf(loser.key)}`, dedup ?? diagnostics)
    run.check(
      `the stood-down copy carries ${ENDPOINT_DIAGNOSTIC}`,
      Boolean(dedup),
      dedup ? undefined : `diagnostics: ${JSON.stringify(diagnostics.map(d => d.code))}`,
    )
  }

  if (enabled.length === 1) {
    const tools = await mcpTools(session, workspaceId, enabled[0]!.key)
    run.observe('winner-tools', tools)
    run.check(
      'the surviving copy still connects and lists its tool',
      tools.status === 'ok' && (tools.tools ?? []).some(t => t.name === FIXTURE.toolName),
      tools.status === 'ok' ? undefined : `listMcpTools refused: ${String(tools.reason)}`,
    )
    const loserTools = standDown.length > 0 ? await mcpTools(session, workspaceId, standDown[0]!.key) : undefined
    run.observe('stood-down-tools', loserTools ?? '(none stood down)')
    // The negative control: "one of them is disabled" must mean the pool does
    // not serve it either, otherwise the dedup is cosmetic.
    run.check(
      'the stood-down copy is NOT served by the pool',
      loserTools?.status === 'refused',
      loserTools ? `status=${loserTools.status} reason=${String(loserTools.reason)}` : 'no stood-down copy to check',
    )
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
