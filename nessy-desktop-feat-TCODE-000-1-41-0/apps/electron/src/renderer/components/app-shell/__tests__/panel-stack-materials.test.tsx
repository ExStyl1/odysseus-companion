/**
 * UB14.2 (R2-02, B3-05; upstream v0.15.1 `PanelStackContainer.tsx` / `PanelSlot.tsx`, design spec §7.1 / §6.3) —
 * the navigator canvas and the joined paper card, the FLIP panel motion and the toast anchor.
 *
 * Before the row the sidebar and the list were spring-animated `motion.div`s (width / margin / opacity per frame),
 * the list and every content panel were separate `bg-background shadow-middle` cards, and nothing published the
 * toast anchor (toasts sat at the sonner default). Every POSITIVE arm below fails on that tree.
 *
 * Instrument: one child process (`fixtures/panel-stack-probe.ts`; its docblock says why a child and how each
 * reading is taken) — `renderToStaticMarkup` of the playground entry's states for the materials, the real
 * `useToastAnchor` effect body for the anchor, and the real `FlipOnChange` lifecycle over the container's own
 * targets for the motion. "One card" is read as its cause in the markup: the list's inner corners and the first
 * panel's are square and the panel is pulled over the flex gap (`margin-left: -PANEL_GAP`), which is how
 * upstream joins them — two elements edge to edge, not a wrapping element.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { PANEL_STACK_PROBE_MARKER, type ProbeReading } from './fixtures/panel-stack-probe'

const CHILD = new URL('./fixtures/panel-stack-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname

let reading: ProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'panel-stack-probe-'))
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
  const at = stdout.lastIndexOf(PANEL_STACK_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`panel-stack probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + PANEL_STACK_PROBE_MARKER.length)) as ProbeReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

/** Every opening tag carrying `attr`, in document order. */
const tagsWith = (html: string, attr: string) => html.match(new RegExp(`<[a-z]+ [^>]*${attr}[^>]*>`, 'g')) ?? []
const role = (html: string, name: string) => tagsWith(html, `data-panel-role="${name}"`)
const materials = (html: string) => tagsWith(html, 'aria-hidden="true" class="shell-card absolute')
const shellCards = (html: string) => tagsWith(html, 'class="shell-card')
const radii = (tag: string) =>
  ['top-left', 'bottom-left', 'top-right', 'bottom-right'].map(corner => tag.match(new RegExp(`border-${corner}-radius:([0-9.]+)(px)?`))?.[1] ?? null)

describe('UB14.2 — the joined paper card (materials)', () => {
  it('POSITIVE — the sidebar sits flush on the canvas; the list and the first panel join into ONE card', () => {
    const html = reading.materials['Joined card']!
    const inner = String(reading.radiusInner)
    expect(reading.radiusInner).toBe(12)
    // The sidebar is no card: no material, no shadow.
    const [sidebar] = role(html, 'sidebar')
    expect(sidebar).toBeDefined()
    expect(sidebar).not.toContain('shell-card')
    expect(sidebar).not.toContain('shadow')
    // The list: paper, its two inner (right) corners square.
    const [navigator] = role(html, 'navigator')
    expect(navigator).toContain('shell-card')
    expect(navigator).toContain('bg-paper')
    expect(navigator).toContain('shadow-elev-0')
    expect(radii(navigator!)).toEqual([inner, inner, '0', '0'])
    // The first panel is pulled over the gap, and its material's two inner (left) corners are square.
    const [panel] = role(html, 'content')
    expect(panel).toContain(`margin-left:-${reading.panelGap}px`)
    const [material] = materials(html)
    expect(material).toContain('bg-paper')
    expect(radii(material!).slice(0, 3)).toEqual(['0', '0', inner])
    // Two shell cards drawn, read as one: the list and the first panel's material.
    expect(shellCards(html)).toHaveLength(2)
    expect(reading.materials['(base state)']).toBe(html)
  })

  it('POSITIVE — a second panel gets its own card, and the focused one is lifted', () => {
    const html = reading.materials['Joined card + second panel']!
    const inner = String(reading.radiusInner)
    const edge = String(reading.radiusEdge)
    const panels = role(html, 'content')
    expect(panels).toHaveLength(2)
    // Only the first panel joins the list.
    expect(panels[0]).toContain(`margin-left:-${reading.panelGap}px`)
    expect(panels[1]).not.toContain('margin-left')
    const [first, second] = materials(html)
    expect(radii(first!).slice(0, 2)).toEqual(['0', '0'])
    // Its own card: every corner rounded (the outer right one meets the window edge).
    expect(radii(second!)).toEqual([inner, inner, inner, edge])
    // The focused (last) panel is lifted, the other stays flat.
    expect(first).toContain('shadow-elev-0')
    expect(second).toContain('shadow-elev-2')
    expect(shellCards(html)).toHaveLength(3)
  })

  it('BOUNDARY — with the list hidden there is no joined card: the first panel rounds all four corners', () => {
    const html = reading.materials['List hidden']!
    const inner = String(reading.radiusInner)
    expect(html).not.toContain(`margin-left:-${reading.panelGap}px`)
    const [first] = materials(html)
    expect(radii(first!).slice(0, 3)).toEqual([inner, inner, inner])
    const [navigator] = role(html, 'navigator')
    expect(navigator).toContain('width:0')
    expect(navigator).not.toContain('shadow-elev-0')
  })

  it('BOUNDARY — sidebar hidden: the joined card moves to the window inset and its outer corner takes RADIUS_EDGE', () => {
    const html = reading.materials['Sidebar hidden']!
    const [navigator] = role(html, 'navigator')
    expect(radii(navigator!)[1]).toBe(String(reading.radiusEdge))
    expect(html).toContain(`padding-left:${reading.edgeInset}px`)
    const [sidebar] = role(html, 'sidebar')
    expect(sidebar).toContain('width:0')
  })

  it('BOUNDARY (control) — compact renders the absolute slide stack with no sidebar and no joined card', () => {
    const html = reading.materials.Compact!
    expect(html).toContain('--compact-panel-stack-top')
    expect(role(html, 'sidebar')).toHaveLength(0)
    expect(html).not.toContain(`margin-left:-${reading.panelGap}px`)
    const [navigator] = role(html, 'navigator')
    const inner = String(reading.radiusInner)
    // Flush to the viewport floor: no rounded bottom, and both top corners rounded — its own card.
    expect(radii(navigator!)).toEqual([inner, '0', inner, '0'])
    expect(role(html, 'content')).toHaveLength(1)
  })
})

describe('UB14.2 — the toast anchor is the first pane of the content card', () => {
  const byCase = (name: string) => reading.anchor.find(a => a.case === name)!

  it('POSITIVE — sidebar 220 + list 300: left = 220 + PANEL_GAP, width = the list (the first pane); cleanup removes both', () => {
    const anchor = byCase('desktop: sidebar 220 + list 300')
    expect(anchor.deps).toEqual([220 + reading.panelGap, 300])
    expect(anchor.set).toEqual({ '--toast-anchor-left': `${220 + reading.panelGap}px`, '--toast-anchor-width': '300px' })
    expect(anchor.afterCleanup).toEqual([])
  })

  it('POSITIVE — sidebar hidden: the card starts at the window inset', () => {
    expect(byCase('desktop: sidebar hidden').set).toEqual({
      '--toast-anchor-left': `${reading.edgeInset}px`,
      '--toast-anchor-width': '300px',
    })
  })

  it('BOUNDARY — list hidden: the left edge is published, the width is not (the first pane is the wide content)', () => {
    expect(byCase('desktop: list hidden').set).toEqual({ '--toast-anchor-left': `${220 + reading.panelGap}px` })
  })

  it('NEGATIVE (control) — compact publishes nothing (toasts go top-centre there)', () => {
    const anchor = byCase('compact')
    expect(anchor.deps[0]).toBeNull()
    expect(anchor.set).toEqual({})
  })
})

describe('UB14.2 — collapse and expand FLIP the cards', () => {
  const byCase = (name: string) => reading.flip.find(f => f.case === name)!

  it('the container hands FLIP its own targets: the list and each panel translate, each material only scales', () => {
    const flip = byCase('sidebar collapse (pointer)')
    expect(flip.targets).toEqual([
      { role: 'navigator', mode: 'translate' },
      { role: 'panel-1', mode: 'translate' },
      { role: 'material-1', mode: 'scale' },
    ])
    expect(flip.axis).toBe('x')
  })

  it('POSITIVE — a pointer collapse commits once and FLIPs the cards from where they were', () => {
    const flip = byCase('sidebar collapse (pointer)')
    expect(flip.enabled).toBe(true)
    expect(flip.value).toBe('0:1')
    expect(flip.played).toEqual({ count: 3, from: '1:1', to: '0:1' })
    // The list and the panel slide back 220px (transform only); the material scales from its old width.
    expect(flip.animations).toEqual([
      { role: 'navigator', from: 'translate(220px, 0px)' },
      { role: 'panel-1', from: 'translate(220px, 0px)' },
      { role: 'material-1', from: `scale(${Math.round((600 / 820) * 1e4) / 1e4}, 1)` },
    ])
  })

  it('POSITIVE — a pointer expand FLIPs the cards and slides the sidebar in from the left', () => {
    const flip = byCase('sidebar expand (pointer)')
    expect(flip.played).toEqual({ count: 3, from: '0:1', to: '1:1' })
    expect(flip.animations.map(a => a.role)).toEqual(['navigator', 'panel-1', 'material-1', 'sidebar'])
    expect(flip.animations.at(-1)!.from).toBe(`translateX(-${220 + reading.panelGap}px)`)
  })

  it('NEGATIVE (control) — under reduced motion the same collapse animates nothing', () => {
    const flip = byCase('sidebar collapse, reduced motion')
    expect(flip.enabled).toBe(true)
    expect(flip.played).toEqual({ count: 0, from: '1:1', to: '0:1' })
    expect(flip.animations).toEqual([])
  })

  it('NEGATIVE — a keyboard toggle (animateLayout false) and a drag are instant: no snapshot, no FLIP', () => {
    for (const name of ['sidebar collapse, keyboard (animateLayout false)', 'sidebar collapse while resizing']) {
      const flip = byCase(name)
      expect({ name, enabled: flip.enabled, played: flip.played, animations: flip.animations }).toEqual({
        name,
        enabled: false,
        played: null,
        animations: [],
      })
    }
  })
})

describe('UB14.2 — the playground entry', () => {
  it('carries the five states and is registered (getCategories would drop an unspread file)', () => {
    expect(Object.keys(reading.materials)).toEqual([
      '(base state)',
      'Joined card',
      'Joined card + second panel',
      'Sidebar hidden',
      'List hidden',
      'Compact',
    ])
    const index = readFileSync(join(import.meta.dir, '..', '..', '..', 'playground', 'registry', 'index.ts'), 'utf8')
    expect(index.length).toBeGreaterThan(500)
    expect(index).toContain("import { panelStackComponents } from './panel-stack'")
    expect(index).toContain('...panelStackComponents,')
  })
})
