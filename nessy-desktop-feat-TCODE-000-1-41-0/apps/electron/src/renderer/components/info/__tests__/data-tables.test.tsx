/**
 * UB14.58 (R7-08; upstream v0.15.1 `components/info/{LabelsDataTable,ToolsDataTable,PermissionsDataTable,
 * AutoRulesDataTable}.tsx`) — the info data tables on the v0.15.1 look: `Info_FullscreenButton` replaces the
 * inline Maximize2 button, the headers take `INFO_TABLE_HEADER_CLASS` / `INFO_TABLE_SORTABLE_HEADER_CLASS`,
 * ToolsDataTable moves the access column last with a mono `<code>` name and a two-line description,
 * LabelsDataTable names its expander (`aria-expanded` / `aria-label`), and AutoRulesDataTable shows no template
 * on a plain label (`ruleValueText`). Our PermissionsDataTable `unenforceable` / `UnenforceableStyle` /
 * `AccessCell` (P3.351, P6.209) are kept.
 *
 * Before the row every table drew the legacy `bg-background/80 backdrop-blur-sm` button with a `title` and no
 * name, the headers carried no role type, ToolsDataTable put the access chip FIRST with the name in a muted
 * badge, and the expander had no `aria-expanded`; those POSITIVE arms fail on that tree.
 *
 * Instrument: one child process (`fixtures/data-tables-probe.ts`; its docblock says why a child) — the four
 * playground entries' states rendered in DARK (the design surface), plus single-row tables for the row's arms.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import {
  ARM_SENTENCE,
  DATA_TABLES_PROBE_MARKER,
  PLAIN_TEMPLATE,
  VALUED_TEMPLATE,
  type DataTablesProbeReading,
} from './fixtures/data-tables-probe'

const CHILD = new URL('./fixtures/data-tables-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname

let reading: DataTablesProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'data-tables-probe-'))
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
  const at = stdout.lastIndexOf(DATA_TABLES_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`data-tables probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + DATA_TABLES_PROBE_MARKER.length)) as DataTablesProbeReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const state = (key: string) => {
  const html = reading.states[key]
  if (html === undefined) throw new Error(`no state "${key}" (threw: ${JSON.stringify(reading.threw)})`)
  return html
}

/** The template cell's "—" (AutoRulesDataTable: no value to show). */
const NO_TEMPLATE = '<span class="text-label text-tertiary">—</span>'
const SORTABLE_HEADER = 'text-label-sm text-tertiary hover:text-foreground'
const STATIC_HEADER = 'text-label-sm font-medium text-tertiary'
const LEGACY_BUTTON = 'bg-background/80 backdrop-blur-sm'

const STATES = {
  'info-labels-table': ['(base state)', 'No fullscreen', 'Empty'],
  'info-auto-rules-table': ['(base state)', 'No fullscreen', 'Empty'],
  'info-permissions-table': ['(base state)', 'Grey', 'Both', 'No type column', 'No fullscreen', 'Empty'],
  'info-tools-table': ['(base state)', 'Loading', 'Error', 'Needs auth', 'Empty'],
} as const

describe('the probe covered the states', () => {
  it('the four entries are wired into the playground registry index', () => {
    const index = readFileSync(join(REPO_ROOT, 'apps/electron/src/renderer/playground/registry/index.ts'), 'utf8')
    expect(index).toContain("import { infoDataTableComponents } from './info-data-tables'")
    expect(index).toContain('...infoDataTableComponents,')
  })

  it('POSITIVE CONTROL — every state of the four entries rendered in the dark sweep, none threw', () => {
    expect(reading.threw).toEqual({})
    const expected = Object.entries(STATES).flatMap(([id, variants]) => variants.map(v => `${id} · ${v}`))
    expect(Object.keys(reading.states).sort()).toEqual([...expected].sort())
    for (const key of expected) expect({ key, drawn: state(key).length > 150 }).toEqual({ key, drawn: true })
  })
})

describe('AutoRulesDataTable — ruleValueText (the row arms)', () => {
  it('POSITIVE — a plain label\'s rule shows "—" for the template, never its stray valueTemplate', () => {
    const html = reading.arms.autoRulesPlain
    expect(html).toContain('>Bug</span>')
    expect(html).toContain(NO_TEMPLATE)
    expect(html).not.toContain(PLAIN_TEMPLATE)
  })

  it('NEGATIVE (control) — a valued label shows its valueTemplate in the mono chip, and no "—" template', () => {
    const html = reading.arms.autoRulesValued
    expect(html).toMatch(new RegExp(`<span class="[^"]*font-mono font-normal whitespace-nowrap[^"]*">${VALUED_TEMPLATE.replace('$', '\\$')}</span>`))
    expect(html).not.toContain(NO_TEMPLATE)
  })

  it('the playground sample: the semantic chip, the thresholds in the flags column, a valued semantic rule\'s value', () => {
    const html = state('info-auto-rules-table · (base state)')
    expect(html).toContain('>Semantic</span>')
    expect(html).toContain('≥ 0.90')
    expect(html).toContain('≥ 0.75')
    expect(html).toMatch(/font-mono font-normal whitespace-nowrap[^"]*">release<\/span>/)
    expect(html).toContain('font-mono text-mono-ui text-tertiary')
  })
})

describe('PermissionsDataTable — our unenforceable rows kept on the restyle (P3.351, P6.209)', () => {
  it('POSITIVE — an unenforceable row in `annotate` keeps its sentence verbatim and its Blocked claim', () => {
    const html = reading.arms.permissionsAnnotate
    expect(html).toContain(`<span class="block text-label-sm text-tertiary leading-relaxed">${ARM_SENTENCE}</span>`)
    expect(html).toContain(`>${reading.strings.statusBlocked}</span>`)
    expect(html).not.toContain(`>${reading.strings.unenforcedBadge}</span>`)
    // The comment on the role type (v0.15.1's restyle).
    expect(html).toContain('<span class="truncate block text-label text-secondary">Workspace blockedTools</span>')
  })

  it('NEGATIVE (control) — `grey` withdraws the claim (the Not-enforced badge) and drops the sentence', () => {
    const html = reading.arms.permissionsGrey
    expect(html).not.toContain(ARM_SENTENCE)
    expect(html).toContain(`>${reading.strings.unenforcedBadge}</span>`)
    expect(html).not.toContain(`>${reading.strings.statusBlocked}</span>`)
  })

  it('the pattern chip takes v0.15.1\'s class, and the type column hides on request', () => {
    const base = state('info-permissions-table · (base state)')
    expect(base).toContain('-my-0.5 rounded-xs py-0.5 text-left')
    expect(base).toContain('font-mono font-normal select-none')
    expect(base).toMatch(/>Type<\/button>/)
    expect(state('info-permissions-table · No type column')).not.toMatch(/>Type<\/button>/)
    // `both` (the component default): the sentence AND the withdrawn claim, on the playground sample.
    const both = state('info-permissions-table · Both')
    expect(both).toContain(reading.sampleSentence)
    expect(both).toContain(`>${reading.strings.unenforcedBadge}</span>`)
  })
})

describe('the v0.15.1 look on all four tables', () => {
  it('POSITIVE — the fullscreen knob draws Info_FullscreenButton (named, floating), never the legacy button', () => {
    for (const id of ['info-labels-table', 'info-auto-rules-table', 'info-permissions-table'] as const) {
      const html = state(`${id} · (base state)`)
      expect({ id, named: html.includes(`aria-label="${reading.strings.viewFullscreen}"`) }).toEqual({ id, named: true })
      expect({ id, floating: html.includes('state-overlay bg-floating shadow-elev-1') }).toEqual({ id, floating: true })
    }
    for (const [id, variants] of Object.entries(STATES)) {
      for (const v of variants) expect({ key: `${id} · ${v}`, legacy: state(`${id} · ${v}`).includes(LEGACY_BUTTON) }).toEqual({ key: `${id} · ${v}`, legacy: false })
    }
  })

  it('NEGATIVE (control) — without the knob there is no fullscreen button at all', () => {
    for (const id of ['info-labels-table', 'info-auto-rules-table', 'info-permissions-table'] as const) {
      const html = state(`${id} · No fullscreen`)
      expect({ id, named: html.includes(`aria-label="${reading.strings.viewFullscreen}"`) }).toEqual({ id, named: false })
    }
  })

  it('every table\'s headers wear the role type (sortable and static)', () => {
    for (const id of ['info-labels-table', 'info-auto-rules-table', 'info-permissions-table', 'info-tools-table'] as const) {
      const html = state(`${id} · (base state)`)
      expect({ id, sortable: html.includes(SORTABLE_HEADER) }).toEqual({ id, sortable: true })
      expect({ id, static: html.includes(STATIC_HEADER) }).toEqual({ id, static: true })
    }
  })

  it('ToolsDataTable: the mono name, the two-line description, the access chip LAST', () => {
    const html = state('info-tools-table · (base state)')
    expect(html).toContain('<code class="whitespace-nowrap font-mono text-mono-ui font-medium text-foreground">list_issues</code>')
    expect(html).toContain('line-clamp-2 break-words text-label text-secondary')
    const order = [`>${reading.strings.tool}</button>`, `>${reading.strings.description}</span>`, `>${reading.strings.access}</button>`]
      .map(needle => html.indexOf(needle))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('LabelsDataTable: the expander is named and states whether it is open; a leaf has none', () => {
    const html = state('info-labels-table · (base state)')
    // The tree opens expanded (DataTable's default), so the parent's children render under it.
    expect(html).toMatch(/<button type="button" aria-expanded="true" aria-label="Area"/)
    expect(html).toContain('<span class="truncate text-label text-foreground">Frontend</span>')
    expect(html).not.toContain('aria-label="Bug"')
    expect(html).toContain('<span class="truncate text-label text-foreground">Bug</span>')
  })

  it('the tools table\'s other states: loading, error, needs auth, empty', () => {
    expect(state('info-tools-table · Error')).toContain('The server closed the connection.')
    expect(state('info-tools-table · Needs auth')).toContain('Authenticate with this source to view available data')
    expect(state('info-tools-table · Empty')).toContain('No tools available')
    expect(state('info-tools-table · Loading')).not.toContain('list_issues')
  })
})
