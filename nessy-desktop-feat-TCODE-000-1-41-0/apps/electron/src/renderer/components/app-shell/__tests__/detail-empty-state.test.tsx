/**
 * UB14.56 (R2-12, the look half; upstream v0.15.1 `MainContentPanel.tsx` +9/−17) — the content panel's empty state
 * per navigator: `SessionsEmptyState` (the serif display heading plus the New session keycaps, "pick up where you
 * left off" with sessions, "what should we work on?" without) and `DetailEmptyState` (one quiet line) for sources,
 * skills, automations and projects.
 *
 * Before the row every one of those branches drew `text-muted-foreground` + `text-sm` and the sessions branch read
 * "No session selected" whatever the list held; every POSITIVE arm below fails on that tree. The components
 * themselves landed with UB14.4 and are pinned bare in `sidebar-pane.test.tsx`; this file pins the MOUNT — the
 * shipped `MainContentPanel`, the route of each navigator with nothing selected, and the two lists it reads
 * (`sessionMetaMapAtom` for `hasSessions`, `automationsAtom` for UB4.26's sentence).
 *
 * Instrument: one child process (`fixtures/main-panel-empty-probe.ts`; its docblock says why a child) renders every
 * state of the playground entry `main-panel-empty-states` through the page's own frame under the dark theme stub,
 * so the dark sweep of the entry and this reading are one render.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import { MAIN_PANEL_EMPTY_PROBE_MARKER, type MainPanelEmptyReading } from './fixtures/main-panel-empty-probe'

const CHILD = new URL('./fixtures/main-panel-empty-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname
const en = enMessages as Record<string, string>

let reading: MainPanelEmptyReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'main-panel-empty-probe-'))
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: REPO_ROOT,
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => child.kill(), MODULE_GRAPH_HOOK_BUDGET_MS - 30_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(killer)
  const at = stdout.lastIndexOf(MAIN_PANEL_EMPTY_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`main-panel-empty probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + MAIN_PANEL_EMPTY_PROBE_MARKER.length)) as MainPanelEmptyReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

/** v0.15.1 `SessionsEmptyState`'s heading, as the panel draws it. */
const heading = (key: string) => `<h2 class="font-serif text-display text-foreground text-balance">${en[key]}</h2>`
/** v0.15.1 `DetailEmptyState`'s one quiet line. */
const quietLine = (key: string) => `<p class="text-label text-tertiary">${en[key]}</p>`
/** The pre-v0.15.1 empty branch every navigator drew. */
const LEGACY_LINE = 'text-muted-foreground"><p class="text-sm">'

describe('UB14.56 — the main panel\'s empty state per navigator', () => {
  it('POSITIVE — with sessions and none selected: the serif "pick up" heading and the New session keycaps', () => {
    const html = reading.Sessions!
    expect(html).toContain(heading('session.emptyTitle'))
    expect(html).toContain('<p class="text-copy text-secondary">')
    expect(html).toContain('data-slot="kbd"')
    // The panel opens on this state.
    expect(reading['(base state)']).toBe(html)
  })

  it('BOUNDARY — a workspace without sessions asks the first-session question instead (hasSessions false)', () => {
    const html = reading['First session']!
    expect(html).toContain(heading('session.emptyTitleFirst'))
    expect(html).not.toContain(heading('session.emptyTitle'))
  })

  it('POSITIVE — sources, skills, automations and projects show one quiet line, each its own sentence', () => {
    expect(reading.Sources).toContain(quietLine('sourcesList.noSourcesConfigured'))
    expect(reading.Skills).toContain(quietLine('skillsList.noSkillsConfigured'))
    expect(reading.Projects).toContain(quietLine('projectsList.noProjectSelected'))
    // UB4.26's sentence choice survives the restyle: a populated list is "Select an automation".
    expect(reading.Automations).toContain(quietLine('automations.selectAutomation'))
    expect(reading['No automations']).toContain(quietLine('automations.noAutomationsConfigured'))
  })

  it('NEGATIVE — no state draws the muted text-sm line, and none says "No session selected"', () => {
    expect(Object.keys(reading)).toEqual([
      '(base state)', 'Sessions', 'First session', 'Sources', 'Skills', 'Automations', 'No automations', 'Projects',
    ])
    for (const [state, html] of Object.entries(reading)) {
      expect({ state, legacy: html.includes(LEGACY_LINE) }).toEqual({ state, legacy: false })
      expect({ state, said: html.includes(en['session.noSessionSelected']!) }).toEqual({ state, said: false })
      // Control: the frame really held the panel, so "absent" above is not an empty render.
      expect({ state, mounted: html.includes('data-testid="main-panel-empty-preview"') }).toEqual({ state, mounted: true })
    }
  })
})
