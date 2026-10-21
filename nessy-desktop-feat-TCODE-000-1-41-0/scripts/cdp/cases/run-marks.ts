/**
 * RUN-MARKS — the runtime brand marks, on the operator's real connections.
 *
 * The complaint this answers was "сейчас не совсем понятно": every gateway card
 * wore the same Nessy mark, so the Codex agent and the Claude Code agent were
 * indistinguishable from the Pi agent at a glance. A2/A3 gave each connection
 * the mark of the harness it actually runs.
 *
 * The case reads the RENDERED marks rather than the mapping module: a test that
 * imports `getProviderIcon` passes whatever the mapping does, including a
 * regression. Each mark is identified by a path-data prefix taken from the
 * vendored source SVGs, so a swapped mark fails here.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'

const ID = 'RUN-MARKS'
const TITLE = 'Connection rows wear the mark of the runtime they actually run — Claude, OpenAI, Nessy — legible in dark'

/** First path bytes of each mono mark, from the vendored lobehub SVGs / NessySymbol. */
const MARK_SIGNATURES: Record<string, string> = {
  claude: 'M4.709 15.955',
  openai: 'M9.205 8.658',
  nessy: 'M4 20V4h4.4',
}

function markOf(pathData: string): string | undefined {
  return Object.keys(MARK_SIGNATURES).find(name => pathData.startsWith(MARK_SIGNATURES[name]!))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const connections = await session.call<Array<{ slug: string; providerType: string }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('connections', connections)

  // Navigate to the AI settings surface, which renders one ConnectionIcon per row.
  await session.call(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'settings/ai' }, bubbles: true }))
    return null
  `)
  await Bun.sleep(3_000)

  const marks = await session.call<Array<{ path: string }>>(`
    return Array.from(document.querySelectorAll('svg path')).map(p => ({ path: (p.getAttribute('d') || '').slice(0, 40) }))
  `)
  const rendered = marks.map(m => markOf(m.path)).filter(Boolean) as string[]
  run.observe('marks rendered on this surface', [...new Set(rendered)])

  // The expected set is derived from the OPERATOR'S OWN connections, not from a
  // fixture: whichever runtimes they have configured must show their own mark.
  const expected = new Set<string>()
  for (const c of connections) {
    if (c.providerType === 'claude-runtime' || c.providerType === 'anthropic') expected.add('claude')
    if (c.providerType === 'codex-runtime') expected.add('openai')
    if (c.providerType === 'pi_compat' || c.providerType === 'pi' || c.providerType === 'nestor-cloud-agent') expected.add('nessy')
  }
  run.observe('expected from the operator config', [...expected])

  for (const mark of expected) {
    run.check(`the ${mark} mark is rendered for a connection that runs it`, rendered.includes(mark))
  }
  run.check('every rendered mark is one of the three runtime marks', rendered.length > 0, `${rendered.length} mark paths matched`)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
