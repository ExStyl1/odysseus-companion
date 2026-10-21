/**
 * P2.486 — the shipped runtime-switch confirmation is reviewable, and it reads
 * the REAL cost table. P2.491's second half rides along.
 *
 * The measurement P2.486 is built on: four DRAFT runtime-switch entries across
 * nineteen playground states, and ZERO of them referenced `runtimeSwitchCosts`,
 * while the dialog that actually shows a user what a switch costs had no entry
 * at all. That measurement is re-run below as a live CONTROL, so the day a
 * draft starts reading the table — or this entry stops — the file says which.
 *
 * ## Why this file reads SOURCE and imports nothing
 *
 * Measured, not assumed: importing `../registry/runtime-switch-costs` under bun
 * fails with `Missing 'default' export in module
 * 'pdfjs-dist/build/pdf.worker.min.mjs?url'` (68.1 s, zero tests executed). The
 * entry mounts the REAL `RuntimeSwitchDialog`, whose graph reaches `Markdown` →
 * `MarkdownPdfBlock` → `pdfjs-dist`, so the import is neither cheap nor
 * loadable.
 *
 * The five existing test files that DO load it stub the specifier with a bare
 * `mock.module` — no spread, no restore — which is exactly the class P3.316 is
 * removing, and a spread is impossible here because spreading means importing
 * the module that cannot load. So this file does not become the sixth site.
 *
 * The division of labour that makes that safe: `tsc` already proves the entry is
 * a well-formed `ComponentEntry[]` (the annotation is on the export and
 * `apps/electron`'s typecheck reaches the file), so structure is machine-checked
 * elsewhere and this file checks WIRING and CONTENT — the two things a type
 * cannot see. The sibling `settings-isolation-registry.test.ts` asserts its own
 * index wiring against source text for the same reason.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

function playgroundSource(...segments: string[]): string {
  return readFileSync(join(import.meta.dir, '..', ...segments), 'utf-8')
}

function indexSource(): string {
  return playgroundSource('registry', 'index.ts')
}

function entrySource(): string {
  return playgroundSource('registry', 'runtime-switch-costs.tsx')
}

describe('P2.486 · the cost rows are reviewable on a screen', () => {
  it('reads every file it asserts about', () => {
    // Positive control: a `readFileSync` that silently returned '' would make
    // every `toContain` below fail loudly, but every `not.toContain` VACUOUS.
    for (const [name, source] of [
      ['index.ts', indexSource()],
      ['runtime-switch-costs.tsx', entrySource()],
      ['runtime-switch.tsx', playgroundSource('registry', 'runtime-switch.tsx')],
      ['label-badges.tsx', playgroundSource('registry', 'label-badges.tsx')],
    ] as const) {
      expect(source.length, name).toBeGreaterThan(500)
    }
  })

  it('wires the module into registry/index so it renders', () => {
    const src = indexSource()
    expect(src).toContain("import { runtimeSwitchCostsComponents } from './runtime-switch-costs'")
    expect(src).toContain('...runtimeSwitchCostsComponents,')
  })

  it('registers one entry, under a category the index actually renders', () => {
    const src = entrySource()
    expect(src).toContain("id: 'runtime-switch-dialog-costs'")
    expect(src).toContain("category: 'Chat Inputs'")
    // `getCategories()` silently DROPS a category missing from this list, so
    // being spread into the registry is not the same as being reachable.
    const orderLine = indexSource().split('\n').find(line => line.includes('const categoryOrder'))
    expect(orderLine).toBeDefined()
    expect(orderLine).toContain("'Chat Inputs'")
  })

  /**
   * The heart of the row. The entry must reach the cost table THROUGH the
   * shipped component, never by importing it and re-rendering the rows itself —
   * a playground that re-words a cost is a second surface to keep true, which is
   * the defect this entry exists to catch.
   */
  it('reaches the cost table through the real dialog, and re-implements nothing', () => {
    const src = entrySource()
    expect(src).toContain('RuntimeSwitchDialog,')
    expect(src).toContain("from '@/components/app-shell/input/RuntimeSwitchDialog'")
    // The component computes the rows; this entry must not. Asserted as the
    // absence of the IMPORT rather than of the identifier: the entry's own
    // docblock names `runtimeSwitchCosts(from, to)` to say where the rows come
    // from, which is documentation, not computation — the first draft of this
    // line matched that prose and failed against a correct file.
    expect(src).not.toContain('input/runtime-switch-costs')
    // …and the dialog it imports is the one that does.
    const dialog = readFileSync(
      join(import.meta.dir, '..', '..', 'components', 'app-shell', 'input', 'RuntimeSwitchDialog.tsx'),
      'utf-8',
    )
    expect(dialog).toContain('runtimeSwitchCosts(fromRuntime, toRuntime)')
  })

  it('CONTROL: the draft entries still read no cost table', () => {
    // The measurement the row was written from, kept live rather than quoted.
    // If a draft starts reading the table, this fails and the premise is
    // re-stated instead of silently outgrown.
    expect(playgroundSource('registry', 'runtime-switch.tsx')).not.toContain('runtimeSwitchCosts')
  })

  it('offers every direction whose cost list differs, including the empty one', () => {
    const src = entrySource()
    for (const direction of ['pi-to-codex', 'pi-to-claude', 'claude-to-codex', 'codex-to-pi', 'same-runtime']) {
      expect(src, direction).toContain(`value: '${direction}'`)
    }
    // The return leg renders NO cost block at all, and a reviewer has to be able
    // to look at that absence — "nothing listed" must not read as "not asked" —
    // so it needs a VARIANT and not merely a knob value.
    expect(src).toContain("props: { direction: 'codex-to-pi'")
  })

  it('offers the carry plan and its P3.266 reason, including both nulls', () => {
    const src = entrySource()
    for (const plan of ['native', 'anchor', 'text']) {
      expect(src, plan).toContain(`value: '${plan}'`)
    }
    for (const reason of ['does-not-fit', 'no-native-carry-implemented', 'context-window-unknown']) {
      expect(src, reason).toContain(`value: '${reason}'`)
    }
    // `none` is the preview declining to answer — the dialog then omits the line
    // rather than guessing, and that is a state only this knob can produce.
    expect(src).toContain("value: 'none'")
    expect(src).toContain("historyCarry: 'none'")
  })
})

describe('P2.491 · a playground file no reviewer could reach', () => {
  it('imports label-badges into the registry index', () => {
    const src = indexSource()
    expect(src).toContain("import { labelBadgeComponents } from './label-badges'")
    expect(src).toContain('...labelBadgeComponents,')
  })

  it('and its category is one the index actually renders', () => {
    const src = playgroundSource('registry', 'label-badges.tsx')
    expect(src).toContain('export const labelBadgeComponents')
    const match = /category:\s*'([^']+)'/.exec(src)
    expect(match).not.toBeNull()
    const orderLine = indexSource().split('\n').find(line => line.includes('const categoryOrder'))
    expect(orderLine, match?.[1]).toContain(`'${match?.[1]}'`)
  })
})
