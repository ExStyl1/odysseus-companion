/**
 * UB12.41 (born by UB14.5; upstream v0.15.1 `app-shell/CompactSessionListFilter.tsx`) — the compact navigator's
 * filter sheet takes v0.15.1's remaining class hunks: the DrawerHeader without `!text-left`, Clear as
 * `text-label text-secondary`, the `field-surface` search field at `h-control-xl`, `text-label-sm` section heads with
 * no uppercase, `min-h-row-touch` rows on the fill-hover / fill-pressed roles with an ACCENT radio check, the raised /
 * destructive-tint mode pill without the `--shadow-color` style, and the fill-hover pinned chips. Ours kept: UA12.162's
 * `hasUserFilter` (live label ids), UA5.9's `projectsAvailable` Project grouping, our `t()` keys, and the doc-cited
 * lines 321-322 (`kanban/__tests__/project-columns.test.tsx`'s LINES arm).
 *
 * Before the row the sheet drew v0.14.1's `bg-foreground/5 rounded-[8px]` field, `uppercase tracking-wider` heads,
 * `rounded-[10px]` rows and the `shadow-tinted` pill, and no playground entry showed it. Measured 2026-10-17 with
 * HEAD's classes behind this entry (the open-sheet props added): 6 of the 9 arms fail, POSITIVE and NEGATIVE among them.
 *
 * Instrument: one child process (`fixtures/compact-session-list-filter-probe.ts`; its docblock says why a child and
 * how the open sheet is rendered) — `renderToStaticMarkup` of the playground entry's states in the dark theme.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import {
  COMPACT_SESSION_LIST_FILTER_PROBE_MARKER,
  type CompactSessionListFilterProbeReading,
} from './fixtures/compact-session-list-filter-probe'

const CHILD = new URL('./fixtures/compact-session-list-filter-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname

let reading: CompactSessionListFilterProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'compact-session-list-filter-probe-'))
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
  const at = stdout.lastIndexOf(COMPACT_SESSION_LIST_FILTER_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`compact-session-list-filter probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + COMPACT_SESSION_LIST_FILTER_PROBE_MARKER.length)) as CompactSessionListFilterProbeReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const en = enMessages as Record<string, string>
const state = (variant: string) => {
  const html = reading.states[variant]
  if (html === undefined) throw new Error(`no state "${variant}" (threw: ${JSON.stringify(reading.threw)})`)
  return html
}
const count = (html: string, needle: string) => html.split(needle).length - 1
/** The trigger's opening tag (HeaderIconButton, named by the sheet's title key). */
const trigger = (html: string) => html.match(new RegExp(`<button[^>]*aria-label="${en['sidebar.filterChats']}"[^>]*>`))?.[0] ?? ''
/** The sheet itself (vaul's content part); absent while the sheet is closed. */
const SHEET = 'data-slot="drawer-content"'
const TINT = 'bg-accent-tint text-accent hover:bg-accent-tint hover:text-accent'

/** v0.15.1's classes, verbatim from the tag's file. */
const V0151 = {
  // DrawerHeader's own `flex-col gap-0.5` give way to the row's classes (tailwind-merge); no `!text-left` left over.
  header: 'data-slot="drawer-header" class="p-4 text-left md:gap-1.5 flex flex-row items-center justify-between gap-3"',
  clear: `class="text-label text-secondary hover:text-foreground">${en['common.clear']}</button>`,
  field: 'class="field-surface rounded-md px-3 h-control-xl flex items-center gap-2"',
  fieldIcon: 'class="lucide lucide-search size-4 text-tertiary shrink-0"',
  input: 'class="flex-1 min-w-0 bg-transparent text-copy-lg text-foreground placeholder:text-tertiary outline-none"',
  clearX: 'class="shrink-0 size-7 flex items-center justify-center text-tertiary rounded-full hover:bg-fill-hover"',
  section: 'class="px-2 pb-1 flex items-center gap-1.5 text-label-sm font-medium text-tertiary"',
  row: 'class="flex items-center gap-3 px-3 min-h-row-touch rounded-md cursor-pointer hover:bg-fill-hover active:bg-fill-pressed"',
  pinnedRow: 'class="flex items-center gap-3 px-3 min-h-row-touch rounded-md opacity-60"',
  radioCheck: 'size-4 text-accent shrink-0',
  pinnedCheck: 'size-4 text-tertiary shrink-0',
  pill: 'shrink-0 h-9 min-w-9 px-2.5 rounded-sm text-label-sm font-medium flex items-center justify-center gap-1',
  include: 'bg-raised text-foreground shadow-elev-1',
  exclude: 'bg-destructive-tint text-destructive',
  searchRow: 'class="w-full flex items-center gap-3 px-2 min-h-row-touch rounded-md hover:bg-fill-hover active:bg-fill-pressed text-left"',
  chip: 'class="inline-flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-sm bg-fill-hover text-label text-secondary"',
  noMatches: `class="px-4 py-6 text-center text-label text-tertiary">${en['sidebar.filter.noMatches']}</div>`,
} as const

/**
 * v0.14.1's markers in this file (every one is gone in v0.15.1's). Each is specific to the sheet's own parts: the
 * drawer, label icons and status icons this entry also renders carry none of them (the NEGATIVE arm reads them all).
 */
const V0141_MARKERS = [
  '!text-left',
  'bg-foreground/5',
  'active:bg-foreground/10',
  'rounded-[8px]',
  'rounded-[10px]',
  'rounded-[6px]',
  'uppercase tracking-wider',
  'shadow-tinted',
  '--shadow-color',
  'text-foreground/70',
  'text-muted-foreground',
] as const
const v0141MarkersIn = (html: string) => V0141_MARKERS.filter(marker => html.includes(marker))

describe('UB12.41 — the compact filter sheet wears v0.15.1\'s classes', () => {
  it('POSITIVE — the open sheet over every kind of filter: header, Clear, search field, heads, rows, pills, radio check', () => {
    const html = state('Open, every kind')
    expect(html).toContain(SHEET)
    expect(trigger(html)).toContain(TINT)
    for (const part of ['header', 'clear', 'field', 'fieldIcon', 'input', 'row', 'searchRow'] as const) {
      expect({ part, shown: html.includes(V0151[part]) }).toEqual({ part, shown: true })
    }
    // Statuses, Labels and Group heads, each in the quiet label-sm style (Group's head leads with its icon).
    expect(count(html, V0151.section)).toBe(3)
    for (const key of ['sidebar.statuses', 'sidebar.labels']) expect(html).toContain(`${V0151.section}><span>${en[key]}</span>`)
    expect(html).toContain(`${V0151.section}><svg`)
    expect(html).toContain(`</svg><span>${en['sidebar.group']}</span>`)
    // Done and Frontend included (raised), Bug excluded (destructive tint); the pill is v0.15.1's 36px square.
    expect(count(html, `${V0151.pill} ${V0151.include}`)).toBe(2)
    expect(count(html, `${V0151.pill} ${V0151.exclude}`)).toBe(1)
    // The one checked grouping (Date) carries the accent check.
    expect(count(html, V0151.radioCheck)).toBe(1)
  })

  it('NEGATIVE — no state of the sheet keeps a v0.14.1 class (and the detector finds one in a v0.14.1 line)', () => {
    // Control on the same instrument: v0.14.1's mode-pill line and its tinted-shadow style are caught.
    expect(v0141MarkersIn(`<button class="shrink-0 h-7 px-2.5 rounded-[6px] text-xs font-medium flex items-center gap-1 shadow-tinted" style="--shadow-color:var(--destructive)">`))
      .toEqual(['rounded-[6px]', 'shadow-tinted', '--shadow-color'])
    expect(reading.threw).toEqual({})
    for (const [variant, html] of Object.entries(reading.states)) {
      expect({ variant, v0141: v0141MarkersIn(html) }).toEqual({ variant, v0141: [] })
    }
  })

  it('pinned view: the fill-hover chip, the fixed row\'s tertiary check, and no Group section', () => {
    const html = state('Open, pinned status view')
    expect(html).toContain(`${V0151.chip}>`)
    expect(html).toContain('In Progress')
    expect(html).toContain(V0151.pinnedRow)
    expect(html).toContain(V0151.pinnedCheck)
    expect(html).not.toContain(`<span>${en['sidebar.group']}</span>`)
  })

  it('search: the combined result keeps the field look; no match says so in the label style with our key', () => {
    const matches = state('Search: matches')
    expect(matches).toContain(V0151.field)
    expect(matches).toContain(V0151.clearX)
    expect(matches).toContain('<span class="text-tertiary">Area / </span>Frontend')
    expect(matches).not.toContain(V0151.searchRow)
    expect(state('Search: no matches')).toContain(V0151.noMatches)
  })
})

describe('UB12.41 — ours kept: UA12.162\'s live-label tint and Clear, UA5.9\'s Project grouping', () => {
  it('BOUNDARY — a stored filter holding only a deleted label: quiet trigger, no Clear, no pill', () => {
    const html = state('Open, deleted label only')
    expect(html).toContain(SHEET)
    expect(trigger(html)).not.toContain('bg-accent-tint')
    expect(html).not.toContain(V0151.clear)
    expect(count(html, V0151.pill)).toBe(0)
  })

  it('BOUNDARY — a stale status id still counts as a user filter: tinted trigger and Clear, but no row for it', () => {
    const html = state('Open, stale ids')
    expect(trigger(html)).toContain(TINT)
    expect(html).toContain(V0151.clear)
    expect(count(html, V0151.pill)).toBe(0)
  })

  it('Group by Project shows only when the workspace has projects, and is then the checked row', () => {
    const projectRow = `<span class="flex-1 min-w-0 text-copy truncate">${en['sidebar.groupByProject']}</span><svg`
    const grouped = state('Open, grouped by project')
    expect(grouped).toContain(projectRow)
    expect(grouped.slice(grouped.indexOf(projectRow))).toContain(V0151.radioCheck)
    expect(state('Open, no filter')).not.toContain(projectRow)
  })
})

describe('UB12.41 — the playground entry, every state (the dark sweep)', () => {
  const STATES = [
    '(base state)',
    'Closed, no filter',
    'Closed, active filter',
    'Open, no filter',
    'Open, every kind',
    'Open, deleted label only',
    'Open, pinned status view',
    'Open, stale ids',
    'Open, grouped by project',
    'Open, no labels configured',
    'Search: matches',
    'Search: no matches',
  ]

  it('renders the base state and all eleven variants in a dark root; only the closed ones draw no sheet', () => {
    expect(reading.threw).toEqual({})
    expect(Object.keys(reading.states)).toEqual(STATES)
    for (const [variant, html] of Object.entries(reading.states)) {
      const closed = variant.startsWith('Closed')
      expect({ variant, dark: html.startsWith('<div class="dark">'), trigger: trigger(html) !== '', sheet: html.includes(SHEET) })
        .toEqual({ variant, dark: true, trigger: true, sheet: !closed })
    }
    expect(trigger(state('Closed, no filter'))).not.toContain('bg-accent-tint')
    expect(trigger(state('Closed, active filter'))).toContain(TINT)
    expect(state('Open, no labels configured')).not.toContain(`<span>${en['sidebar.labels']}</span>`)
  })

  it('BOUNDARY — with no DOM (the F1.216 registry sweep) every state draws the trigger alone and throws nothing', () => {
    expect(Object.keys(reading.staticSweep)).toEqual(STATES)
    for (const [variant, html] of Object.entries(reading.staticSweep)) {
      expect({ variant, trigger: trigger(html) !== '', sheet: html.includes(SHEET) }).toEqual({ variant, trigger: true, sheet: false })
    }
  })
})
