/**
 * UB13.3 — the `--*-rgb` sweep guard.
 *
 * UB13.3 stopped `themeToCSS` emitting the `--{accent,destructive,foreground,info,success}-rgb`
 * triplets and removed their static definitions (renderer `index.css`, `styles/index.css`), so a
 * remaining reader would get an INVALID property that CSS silently drops — the failure mode the
 * row was written for ("otherwise the properties are invalid and silently dropped"). Zero
 * references may remain in `apps/electron/src` + `packages/ui/src`, in the `var(` form AND the
 * quoted-name form (the JS `getPropertyValue('--accent-rgb')` read is the one a `var(` regex
 * misses — BrowserShader was exactly that reader until this row took it).
 *
 * Subsumes R7-06's `no-rgb-vars` guard (that guard was never landed; this file is its home).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = [
  join(import.meta.dir, '../../../../../apps/electron/src'),
  join(import.meta.dir, '../../../../../packages/ui/src'),
]

/** The triplet name itself, in any context — `var(--x-rgb`, `'-x-rgb'`, `"--x-rgb"`. */
const RGB_TOKEN = /--(accent|destructive|foreground|info|success)-rgb/
/** The two consumption spellings the sweep covered (kept explicit so the control can fail). */
const VAR_FORM = /var\(--(accent|destructive|foreground|info|success)-rgb/
const QUOTED_FORM = /['"]--(accent|destructive|foreground|info|success)-rgb['"]/

const ALLOWED_BASENAMES = new Set(['no-rgb-triplets.test.ts', 'browser-shader-accent.test.ts'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx|css|jsx)$/.test(entry.name)) yield p
  }
}

describe('no --*-rgb triplets remain (UB13.3 sweep guard)', () => {
  it('positive control: the regexes match the planted consumption spellings', () => {
    const planted = [
      'rgba(var(--accent-rgb), .5)',
      "getPropertyValue('--accent-rgb')",
      'box-shadow: rgba(var(--foreground-rgb), 0.06) 0px 0px 0px 1px',
      '{ "--shadow-color": "var(--destructive-rgb)" }',
    ]
    for (const s of planted) {
      expect(RGB_TOKEN.test(s), s).toBe(true)
      expect(VAR_FORM.test(s) || QUOTED_FORM.test(s), s).toBe(true)
    }
  })

  it('the sweep roots exist and are non-empty (the guard cannot pass on a misrooted walk)', () => {
    for (const root of ROOTS) {
      expect(readdirSync(root).length, root).toBeGreaterThan(0)
    }
  })

  it('zero triplet references anywhere under apps/electron/src + packages/ui/src', () => {
    const hits: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED_BASENAMES.has(file.split('/').pop()!)) continue // this guard's own needles
        const text = readFileSync(file, 'utf-8')
        const line = text.split('\n').findIndex((l) => RGB_TOKEN.test(l))
        if (line >= 0) hits.push(`${file}:${line + 1}`)
      }
    }
    expect(hits).toEqual([])
  })
})
