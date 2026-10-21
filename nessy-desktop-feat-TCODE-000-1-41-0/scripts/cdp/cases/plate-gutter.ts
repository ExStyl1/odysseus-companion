/**
 * PLATE-GUTTER — the plates above the composer share its left edge.
 *
 * B1's product complaint in one number. The sign-in notice, the task checklist
 * and the running-agents panel each carried their own `px-3` while the composer
 * used `px-3 @xs/panel:px-4`, so their left edges sat a few pixels off — and
 * could drift from each other as well. B1 gave all three the composer's own
 * gutter through one wrapper.
 *
 * Measured as GEOMETRY, not by eye: the case reads each element's own
 * `getBoundingClientRect().left` from the running renderer and asserts the
 * plates and the composer agree to the pixel. A screenshot is taken beside it
 * as the human-readable artifact, never as the assertion.
 *
 * A plate renders null when it has nothing to say, so the case asserts on
 * whichever plates are actually mounted and BLOCKS (never FAILs) if none are —
 * an empty session measures nothing about alignment.
 */

import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'

const ID = 'PLATE-GUTTER'
const TITLE = 'The plates above the composer share its left edge — measured, normal and compact'

/** Every plate B1 put in the shared wrapper, plus the composer they align to. */
const TARGETS: Record<string, string> = {
  notice: '[data-testid="pending-auth-notice"]',
  checklist: '[data-testid="task-checklist-panel"]',
  agents: '[data-testid="agent-panel"]',
  composer: '[data-tutorial="chat-input"]',
}

async function leftEdges(session: CdpSession): Promise<Record<string, number | null>> {
  return session.call(`
    const sel = ${JSON.stringify(TARGETS)}
    const out = {}
    for (const [name, selector] of Object.entries(sel)) {
      const el = document.querySelector(selector)
      out[name] = el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : null
    }
    return out
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', key)
  await Bun.sleep(4_000)

  const edges = await leftEdges(session)
  run.observe('left edges (px)', edges)

  if (edges.composer === null) {
    blocked('the composer is not mounted in this view — nothing to align against')
  }
  const plates = Object.entries(edges).filter(([name, value]) => name !== 'composer' && value !== null)
  if (plates.length === 0) {
    blocked('no plate is mounted in this session (each renders null when it has nothing to say) — '
      + 'alignment is unmeasurable here. Drive a session that has a checklist, a running agent or a pending sign-in.')
  }

  for (const [name, value] of plates) {
    run.check(
      `the ${name} plate's left edge matches the composer's`,
      Math.abs((value as number) - (edges.composer as number)) < 1,
      `plate=${value}px composer=${edges.composer}px`,
    )
  }
  // The plates must also agree with EACH OTHER — B1's second failure mode was
  // three plates drifting apart, which a composer-only check would miss.
  const distinct = new Set(plates.map(([, value]) => value))
  run.check('every mounted plate shares one left edge', distinct.size === 1, `${distinct.size} distinct edge(s): ${[...distinct].join(', ')}`)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
