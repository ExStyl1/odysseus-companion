/**
 * R6-01 / UB13.10 — the barrel trap: the renderer control primitives (and the floating-material
 * files that predate this row's siblings) must import their siblings through SUBPATHS, never
 * through the `@nessy-agent/ui` barrel — the barrel reaches pdfjs-dist workers and breaks
 * non-renderer consumers (R6-01; the same trap P2.229's exports-map guards for packages/ui).
 *
 * The file list is the row's: button.tsx (this row moved its Tooltip import to the subpath),
 * sonner.tsx and collapsible.tsx (UB13.11's files, already subpath-clean — pinned here so the
 * property holds across both rows).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const UI_DIR = join(import.meta.dir, '..')
const FILES = ['button.tsx', 'sonner.tsx', 'collapsible.tsx'] as const
/** The import specifier that would pull the whole barrel (and its pdfjs workers) in. */
const BARREL_IMPORT = /from\s+['"]@nessy-agent\/ui['"]/

describe('primitives import through subpaths, never the barrel (R6-01)', () => {
  it('positive control: the regex catches a planted barrel import', () => {
    // The SAME regex the per-file check below runs (UB12.30: this control used to test a
    // second, renamed pattern, so a break in the real one could not fail it).
    expect(BARREL_IMPORT.test("import { Button } from '@nessy-agent/ui'")).toBe(true)
    // Boundary: a subpath import is not the barrel.
    expect(BARREL_IMPORT.test('import { Tooltip } from "@nessy-agent/ui/ui/tooltip"')).toBe(false)
  })

  for (const file of FILES) {
    it(`${file}: no bare '@nessy-agent/ui' import`, () => {
      const src = readFileSync(join(UI_DIR, file), 'utf8')
      const bare = src.split('\n').filter((l) => BARREL_IMPORT.test(l))
      expect(bare).toEqual([])
    })
  }

  // Its own test rather than an `if (file === 'button.tsx')` arm inside the loop (UB12.30):
  // subpath imports are fine and expected, and button.tsx is the file this row moved onto one.
  it('button.tsx imports Tooltip through the subpath', () => {
    expect(FILES).toContain('button.tsx')
    expect(readFileSync(join(UI_DIR, 'button.tsx'), 'utf8')).toContain('from "@nessy-agent/ui/ui/tooltip"')
  })
})
