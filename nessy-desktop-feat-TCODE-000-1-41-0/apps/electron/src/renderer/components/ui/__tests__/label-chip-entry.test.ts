/**
 * UB4.13 (B4-02, R6-06 functional half, R4 §3; upstream v0.15.0 "Editable label values", taken from v0.15.1) — a
 * label chip edits and removes only its own entry; the `#` menu and the composer never add a bare duplicate.
 *
 * Before the row: the chip's edit rewrote EVERY entry whose id matched (editing `customer::globex` overwrote
 * `customer::acme`) and its removal dropped them all; the session row drew one chip per entry, so a legacy
 * `bug::bug` beside `bug` showed twice; the `#` menu excluded labels by the raw entry (`bug::bug` never matched
 * `bug`); and the composer's `current.includes(labelId)` appended a bare `priority` beside `priority::3`. Every
 * POSITIVE arm below fails on that tree.
 *
 * Instrument: one child process (`fixtures/label-entry-probe.ts`; its docblock says why a child and how each
 * reading is taken through the components' own handlers). `sessionLabelChips` itself is pinned by upstream's
 * `packages/shared/src/labels/__tests__/chips.test.ts`, copied with this row.
 *
 * UB14.35 (R6-06, the look half, v0.15.1 `ui/entity-list-label-badge.tsx`) adds the chip's own arms below: Enter /
 * Space opens its editor (the chip is a `div role="button"` because list rows nest it inside the row's button, so
 * keyboard activation is wired by hand), the controlled `open` / `onOpenChange` the chat header pins a chip with,
 * the `popoverSide` / `sessionId` it hands its editor, and the tint. Before UB14.35 the chip had no `onKeyDown`
 * (`handled: false`), no controlled props and a 6% tint with colour-mixed text, so every POSITIVE there fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { LABEL_ENTRY_PROBE_MARKER, type LabelEntryProbeReading } from './fixtures/label-entry-probe'

const CHILD = new URL('./fixtures/label-entry-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../../', import.meta.url).pathname

let reading: LabelEntryProbeReading
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'label-entry-probe-'))
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
  const at = stdout.lastIndexOf(LABEL_ENTRY_PROBE_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`label-entry probe exited ${exitCode} without a reading:\n${stderr.slice(-4000)}`)
  }
  reading = JSON.parse(stdout.slice(at + LABEL_ENTRY_PROBE_MARKER.length)) as LabelEntryProbeReading
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

describe('UB4.13 — a label chip edits and removes only its own entry (EntityListLabelBadge `entryIndex`)', () => {
  it('POSITIVE — two `customer::` entries: editing the second leaves the first unchanged', () => {
    expect(reading.badge.editOwnEntry).toEqual([['customer::acme', 'bug', 'customer::initech']])
  })

  it('POSITIVE — removing the second `customer::` entry keeps the first', () => {
    expect(reading.badge.removeOwnEntry).toEqual([['customer::acme', 'bug']])
  })

  it('NEGATIVE (control) — without `entryIndex` both entries change (upstream\'s documented fallback)', () => {
    expect(reading.badge.editWithoutIndex).toEqual([['customer::initech', 'bug', 'customer::initech']])
  })

  it('NEGATIVE (control) — a plain label\'s chip still removes every entry of its id, legacy values included', () => {
    expect(reading.badge.removePlain).toEqual([['code']])
  })
})

describe('UB4.13 — the session row draws `sessionLabelChips` and hands each chip its entry', () => {
  it('POSITIVE — one chip per valued entry carrying its index; a plain label\'s entries collapse into one chip without one', () => {
    expect(reading.row.chips).toEqual([
      { id: 'customer', rawValue: 'acme', entryIndex: 0 },
      { id: 'bug', rawValue: null, entryIndex: null },
      { id: 'customer', rawValue: 'globex', entryIndex: 2 },
      { id: 'priority', rawValue: '3', entryIndex: 4 },
    ])
  })

  it('POSITIVE — the row\'s second `customer` chip edits only its entry, through the row\'s own onLabelsChange', () => {
    expect(reading.row.editSecond).toEqual([
      { sessionId: 'session-1', labels: ['customer::acme', 'bug::bug', 'customer::initech', 'bug', 'priority::3'] },
    ])
  })
})

describe('UB4.13 — the `#` menu excludes applied PLAIN labels by id; valued labels stay listed', () => {
  it('NEGATIVE (control) — a session holding legacy `bug::bug` does not list `bug`; `priority::3` keeps `priority` listed', () => {
    expect(reading.menu.legacyPlainAndValued).not.toContain('bug')
    expect(reading.menu.legacyPlainAndValued).toContain('priority')
    expect(reading.menu.legacyPlainAndValued).toContain('code')
  })

  it('boundary — with nothing applied every label is listed', () => {
    expect([...reading.menu.nothingApplied].sort()).toEqual(['bug', 'code', 'customer', 'priority'])
  })
})

describe('UB4.13 — the composer never appends a bare duplicate (ChatInputZone `handleLabelAdd`)', () => {
  it('POSITIVE — adding `priority` while `priority::3` is applied leaves the list unchanged', () => {
    expect(reading.composer.valuedAlreadyApplied).toEqual([])
  })

  it('POSITIVE — adding `bug` while legacy `bug::bug` is applied leaves the list unchanged', () => {
    expect(reading.composer.plainLegacyApplied).toEqual([])
  })

  it('NEGATIVE (control) — adding a label the session lacks still appends it', () => {
    expect(reading.composer.plainFresh).toEqual([['priority::3', 'bug']])
  })
})

describe('UB14.33 — a valued label picked in the composer asks the chat header to open its editor (pendingLabelValueEditAtom)', () => {
  it('POSITIVE — picking valued `priority` on desktop records the request for this session and label, stamped', () => {
    // Re-picking an applied valued label still asks: the header opens the EXISTING chip's editor (upstream's comment).
    expect(reading.composer.pending.valuedAlreadyApplied).toEqual({ sessionId: 'session-1', panelId: null, labelId: 'priority', stamped: true })
  })

  it('NEGATIVE (control) — a plain label asks nothing, applied or fresh', () => {
    expect(reading.composer.pending.plainLegacyApplied).toBeNull()
    expect(reading.composer.pending.plainFresh).toBeNull()
  })

  it('NEGATIVE — a compact composer asks nothing (its header shows no chips), yet still applies the label', () => {
    expect(reading.composer.pending.valuedCompact).toBeNull()
    expect(reading.composer.pending.valuedCompactWrites).toEqual([['bug', 'priority']])
  })
})

describe('UB14.35 — the chip opens its editor from the keyboard (Enter / Space), controlled or not', () => {
  it('POSITIVE — Enter on a focused, uncontrolled chip opens its editor and stops there', () => {
    expect(reading.chip.enterUncontrolled).toEqual({ handled: true, onOpenChange: [true], prevented: 1, stopped: 1, popoverOpen: true })
  })

  it('POSITIVE — a controlled chip asks its parent: Enter while closed reports open, the editor stays as the parent holds it', () => {
    expect(reading.chip.enterControlledClosed).toEqual({ handled: true, onOpenChange: [true], prevented: 1, stopped: 1, popoverOpen: false })
  })

  it('POSITIVE — Space on an open controlled chip reports close', () => {
    expect(reading.chip.spaceControlledOpen).toEqual({ handled: true, onOpenChange: [false], prevented: 1, stopped: 1, popoverOpen: true })
  })

  it('NEGATIVE — any other key leaves the chip alone (no open, no preventDefault: typing and Tab pass through)', () => {
    expect(reading.chip.otherKey).toEqual({ handled: true, onOpenChange: [], prevented: 0, stopped: 0, popoverOpen: false })
  })
})

describe('UB14.35 — the chip hands its editor the side and the session to refocus', () => {
  it('POSITIVE — `popoverSide` and `sessionId` reach the value popover', () => {
    expect(reading.chip.popoverPinned).toEqual({ side: 'bottom', sessionId: 'session-9' })
  })

  it('boundary — without them the popover keeps its own defaults (side top, no session)', () => {
    expect(reading.chip.popoverDefaults).toEqual({ side: null, sessionId: null })
  })
})

describe('UB14.35 — the chip tint (v0.15.1): the label colour at 18% behind text in the solved roles', () => {
  it('POSITIVE — a coloured chip: 18% colour-mix fill, foreground text, no inline text colour', () => {
    const look = reading.chip.lookColored
    expect(look.background).toBe('color-mix(in srgb, #F87171 18%, transparent)')
    expect(look.color).toBeNull()
    expect(look.className.split(/\s+/)).toEqual(expect.arrayContaining(['h-5', 'max-w-[140px]', 'rounded-xs', 'text-label-sm', 'text-foreground']))
    expect(look.className).not.toContain('bg-fill-hover')
  })

  it('NEGATIVE — an uncoloured chip has no inline style: the neutral fill and the secondary role', () => {
    const look = reading.chip.lookUncolored
    expect(look).toEqual({ className: expect.any(String), background: null, color: null })
    expect(look.className.split(/\s+/)).toEqual(expect.arrayContaining(['bg-fill-hover', 'text-secondary']))
    for (const old of ['h-[18px]', 'max-w-[120px]', 'text-[10px]']) expect(look.className).not.toContain(old)
  })
})
