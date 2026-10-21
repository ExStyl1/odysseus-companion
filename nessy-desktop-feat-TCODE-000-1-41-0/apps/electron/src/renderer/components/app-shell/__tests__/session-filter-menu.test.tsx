/**
 * UB14.5 (B3-08, R2-04; upstream v0.15.1 `app-shell/SessionFilterMenu.tsx`) — the session list's filter dropdown
 * leaves AppShell for its own file, takes v0.15.1's look, and keeps OUR filter set: statuses, labels (groups nest,
 * valued labels are labels), UA5.9's projects, and UA12.162's rule that the tint and Clear key on LIVE label ids.
 *
 * Before the row the dropdown was ~660 lines inline in AppShell with v0.14.1's classes (`bg-accent/5 shadow-tinted`
 * on the trigger, `shadow-minimal` on the search field, `uppercase` section heads) and its five row helpers sat at
 * AppShell's top; the DONE MEANS arm below fails on that tree, and the playground entry this file sweeps did not
 * exist.
 *
 * Instrument: one child process (`fixtures/session-filter-menu-probe.ts`; its docblock says why a child and how each
 * reading is taken) — `renderToStaticMarkup` of the playground entry's states (the design surface, dark theme, a
 * Radix portal rendered in place so an OPEN menu is readable) and render-phase drives through the menu's own
 * handlers. UB12.3 is not decided by this row: nothing here asserts an auto-clear of a live include.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import { SESSION_FILTER_MENU_PROBE_MARKER, type SessionFilterMenuProbeReading } from './fixtures/session-filter-menu-probe'

const CHILD = new URL('./fixtures/session-filter-menu-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname
const APP_SHELL = join(import.meta.dir, '..')

let reading: SessionFilterMenuProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'session-filter-menu-probe-'))
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
  const at = stdout.lastIndexOf(SESSION_FILTER_MENU_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`session-filter-menu probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + SESSION_FILTER_MENU_PROBE_MARKER.length)) as SessionFilterMenuProbeReading
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
/** The trigger's opening tag (HeaderIconButton, named by v0.15.1's aria-label). */
const trigger = (html: string) => html.match(/<button[^>]*aria-label="Filter Chats"[^>]*>/)?.[0] ?? ''
const TINT = 'bg-accent-tint text-accent hover:bg-accent-tint hover:text-accent'
/** The header's Clear button (v0.15.1 classes) — the only Clear an open menu draws while its submenus are closed. */
const CLEAR = `class="text-label-sm text-tertiary hover:text-foreground">${en['common.clear']}</button>`
/** FilterModeBadge, v0.15.1: include is a raised check, exclude a destructive-tint X. */
const INCLUDE_BADGE = 'bg-raised text-foreground shadow-elev-1'
const EXCLUDE_BADGE = 'bg-destructive-tint text-destructive'
const count = (html: string, needle: string) => html.split(needle).length - 1

describe('UB14.5 — the trigger tint and Clear key on LIVE label ids (UA12.162 carried into SessionFilterMenu)', () => {
  it('POSITIVE — a stored filter holding only a deleted label: the trigger is untinted, the open menu has no Clear and no chip', () => {
    const html = state('Open, deleted label only')
    expect(trigger(html)).toContain('data-state="open"')
    expect(trigger(html)).not.toContain('bg-accent-tint')
    expect(html).not.toContain(CLEAR)
    expect({ include: count(html, INCLUDE_BADGE), exclude: count(html, EXCLUDE_BADGE) }).toEqual({ include: 0, exclude: 0 })
  })

  it('NEGATIVE — a live label filter and nothing else tints the trigger and shows Clear and its one chip', () => {
    const html = reading.liveLabelOnly
    expect(trigger(html)).toContain(TINT)
    expect(html).toContain(CLEAR)
    expect({ include: count(html, INCLUDE_BADGE), exclude: count(html, EXCLUDE_BADGE) }).toEqual({ include: 1, exclude: 0 })
    // v0.14.1's tinted shadow is gone from the trigger.
    expect(trigger(html)).not.toContain('shadow-tinted')
  })
})

describe('UB14.5 — every filter of ours is reachable and round-trips; stale ids are ignored; Clear empties all', () => {
  it('POSITIVE — a status, an ⌥-excluded label, a label nested in a group and a project are each reached through their own item', () => {
    const drive = reading.drives.everyKind
    expect(drive.ran).toBe(4)
    expect(drive.listFilter).toEqual([['done', 'include']])
    expect(drive.labelFilter).toEqual([['bug', 'exclude'], ['frontend', 'include']])
    expect(drive.projectFilter).toEqual([['p-gateway', 'include']])
    expect(trigger(drive.markup)).toContain(TINT)
  })

  it('POSITIVE — written as AppShell stores a view (statuses / labels / projects), read back, the menu draws the same four chips', () => {
    expect(JSON.parse(reading.drives.storedJson)).toEqual({
      allSessions: {
        statuses: { done: 'include' },
        labels: { bug: 'exclude', frontend: 'include' },
        projects: { 'p-gateway': 'include' },
        groupingMode: 'date',
      },
    })
    const html = reading.drives.storedRender
    expect({ include: count(html, INCLUDE_BADGE), exclude: count(html, EXCLUDE_BADGE) }).toEqual({ include: 3, exclude: 1 })
    expect(html).toContain(CLEAR)
    for (const name of ['Done', 'Bug', 'Frontend', 'Gateway']) expect(html).toContain(`<span class="flex-1">${name}</span>`)
  })

  it('NEGATIVE (control) — a deleted status, label and project in the stored filter draw no row and throw nothing', () => {
    expect(reading.threw).toEqual({})
    const html = state('Open, stale ids')
    expect({ include: count(html, INCLUDE_BADGE), exclude: count(html, EXCLUDE_BADGE) }).toEqual({ include: 0, exclude: 0 })
    // Unchanged behaviour (ours and v0.15.1's): only LABEL ids are pruned for liveness, so a stale status or project
    // id still counts as a user filter — the trigger tints and Clear is there to remove it.
    expect(trigger(html)).toContain(TINT)
    expect(html).toContain(CLEAR)
  })

  it('NEGATIVE (control) — Clear empties every filter, live and stale alike, and the trigger goes quiet', () => {
    const drive = reading.drives.clear
    expect(drive.ran).toBe(1)
    expect({ list: drive.listFilter, label: drive.labelFilter, project: drive.projectFilter }).toEqual({ list: [], label: [], project: [] })
    expect(trigger(drive.markup)).not.toContain('bg-accent-tint')
    expect(drive.markup).not.toContain(CLEAR)
  })

  it('POSITIVE — keyboard: in the flat list Enter toggles the highlighted label in; ⌥ Enter excludes it', () => {
    expect(reading.drives.searchEnter.ran).toBe(1)
    expect(reading.drives.searchEnter.labelFilter).toEqual([['bug', 'include']])
    expect(reading.drives.searchAltEnter.labelFilter).toEqual([['bug', 'exclude']])
    expect(reading.drives.searchAltEnter.listFilter).toEqual([])
  })
})

describe('UB14.5 — the playground entry, every state (the dark sweep)', () => {
  it('renders the base state and all ten variants, none blank', () => {
    expect(reading.threw).toEqual({})
    expect(Object.keys(reading.states)).toEqual([
      '(base state)',
      'Closed, no filter',
      'Closed, active filter',
      'Open, no filter',
      'Open, every kind',
      'Open, deleted label only',
      'Open, pinned status view',
      'Open, stale ids',
      'Open, no labels configured',
      'Search: matches',
      'Search: no matches',
    ])
    for (const [variant, html] of Object.entries(reading.states)) expect({ variant, trigger: trigger(html) !== '' }).toEqual({ variant, trigger: true })
  })

  it('closed: quiet vs tinted trigger; open: the v0.15.1 header, field and section look', () => {
    expect(trigger(state('Closed, no filter'))).not.toContain('bg-accent-tint')
    expect(trigger(state('Closed, active filter'))).toContain(TINT)
    const open = state('Open, no filter')
    expect(open).toContain(`<span class="text-label-sm font-medium text-tertiary">${en['sidebar.filterChats']}</span>`)
    expect(open).toContain('class="field-surface flex h-control items-center rounded-md px-2"')
    expect(open).not.toContain(CLEAR)
    // Statuses, Labels, Projects (UA5.9: the workspace has projects), Group and Search are the hierarchical rows.
    for (const key of ['sidebar.statuses', 'sidebar.labels', 'sidebar.projects', 'sidebar.group', 'sidebar.search']) {
      expect({ key, shown: open.includes(`<span class="flex-1">${en[key]}</span>`) }).toEqual({ key, shown: true })
    }
  })

  it('a status view pins its status and hides Group; the flat list heads its sections; no match says so with the new key', () => {
    const pinned = state('Open, pinned status view')
    expect(pinned).not.toContain(`<span class="flex-1">${en['sidebar.group']}</span>`)
    expect(pinned).toContain('In Progress')
    const matches = state('Search: matches')
    expect(matches).toContain(`<div class="px-2 pt-1.5 pb-1 text-label-sm font-medium text-tertiary">${en['sidebar.statuses']}</div>`)
    expect(matches).toContain(`<div class="px-2 pt-1.5 pb-1 text-label-sm font-medium text-tertiary">${en['sidebar.labels']}</div>`)
    expect(matches).not.toContain('uppercase tracking-wider')
    expect(state('Search: no matches')).toContain(`>${en['sidebar.noMatchingFilters']}</div>`)
    expect(en['sidebar.noMatchingFilters']).toBe('No matching statuses or labels')
  })
})

describe('UB14.5 — DONE MEANS: AppShell holds no filter-menu component', () => {
  const HELPERS = /\bfunction (AltExcludeTooltip|FilterModeBadge|FilterModeSubMenuItems|FilterMenuRow|FilterLabelItems)\b/g

  it('CONTROL — the helper pattern finds all five in SessionFilterMenu.tsx', () => {
    const menu = readFileSync(join(APP_SHELL, 'SessionFilterMenu.tsx'), 'utf8')
    expect([...menu.matchAll(HELPERS)].map(m => m[1])).toEqual([
      'AltExcludeTooltip', 'FilterModeBadge', 'FilterModeSubMenuItems', 'FilterMenuRow', 'FilterLabelItems',
    ])
    expect(menu).toContain('hasLiveLabelFilter(labelConfigs, labelFilter)')
  })

  it('AppShell defines none of them, keeps no dropdown state, and mounts SessionFilterMenu keyed by the workspace', () => {
    const shell = readFileSync(join(APP_SHELL, 'AppShell.tsx'), 'utf8')
    expect([...shell.matchAll(HELPERS)]).toEqual([])
    expect(shell).not.toContain('filterDropdownQuery')
    expect(shell).not.toContain('filterAltHeld')
    expect(shell).toMatch(/<SessionFilterMenu\n\s+key=\{activeWorkspaceId \?\? undefined\}/)
  })
})
