/**
 * UB15.1 — `SettingsRow` at v0.15.1: every description WRAPS, and nothing in this directory truncates one.
 *
 * ## What changed, and what it supersedes
 *
 * Until UB15.1 the row rendered `description` with `truncate` by default and let a VALUE row opt into
 * wrapping through `wrapDescription` (P6.1004; the default kept by D1.101, the AI connection row opted in
 * by D1.213). v0.15.1 drops the choice: a description always wraps, with `[overflow-wrap:anywhere]` so
 * an unbroken path breaks instead of overflowing its column. The owner's "settings 1:1" rule
 * (2026-10-14) takes upstream's row; `wrapDescription` survives as a deprecated no-op so the call sites
 * still passing it compile until their page rows (UB15.6, UB15.11) drop it.
 *
 * ## Why the assertions are shaped this way
 *
 * Truncation is CSS, so `renderToStaticMarkup` never shows a cut string: the text is in the markup either
 * way. The instrument is the CLASS the description carries — asserted positively (the wrap class is
 * there, the full value is there) and as a census over the directory's source (no description anywhere
 * carries `truncate`), with a control that proves the census can see a hit.
 */
import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsRow } from '../SettingsRow'

const render = (props: React.ComponentProps<typeof SettingsRow>): string =>
  renderToStaticMarkup(<SettingsRow {...props} />)

/** A real one: unbroken, long, and discriminating at its END. */
const LONG_PATH = '/Users/example/Documents/workspaces/nessy-desktop-release-candidate/projects'

/** The description element: the `<div>` whose text is the description. */
const descriptionTag = (html: string, text: string): string => {
  const at = html.indexOf(`>${text}</div>`)
  expect(at, `no description element in: ${html.slice(0, 200)}`).toBeGreaterThan(-1)
  const open = html.lastIndexOf('<div', at)
  return html.slice(open, at + 1)
}

/**
 * The census classifier: a `truncate` counts as a TRUNCATED DESCRIPTION only when
 * `settingsUI.description` (or `descriptionSmall`) precedes it inside the same 400 characters — the
 * selected-value span of `SettingsMenuSelect` and the segment label of `SettingsSegmentedControl` carry
 * a `truncate` on purpose and are not descriptions. Comment lines are dropped first: prose in this
 * directory names the word while explaining it.
 */
function truncatedDescriptions(source: string): { hits: number; decoys: number } {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  let hits = 0
  let decoys = 0
  for (let at = code.indexOf('truncate'); at !== -1; at = code.indexOf('truncate', at + 1)) {
    if (code.slice(Math.max(0, at - 400), at).includes('settingsUI.description')) hits += 1
    else decoys += 1
  }
  return { hits, decoys }
}

describe('UB15.1 — SettingsRow (v0.15.1)', () => {
  it('POSITIVE — a long path renders in full on a wrapping description that breaks anywhere', () => {
    const html = render({ label: 'Default project folder', description: LONG_PATH })
    const tag = descriptionTag(html, LONG_PATH)
    expect(tag).toContain('[overflow-wrap:anywhere]')
    expect(tag).not.toContain('truncate')
    // The new description material, not the legacy muted-foreground one.
    expect(tag).toContain('text-label-sm')
    expect(tag).toContain('text-secondary')
    expect(html).toContain(LONG_PATH)
    // The ≥ 56px in-card geometry.
    expect(html).toContain('min-h-14')
  })

  it('wrapDescription is a deprecated no-op: true, false and absent render the same markup', () => {
    const base = render({ label: 'Name', description: LONG_PATH })
    expect(render({ label: 'Name', description: LONG_PATH, wrapDescription: true })).toBe(base)
    expect(render({ label: 'Name', description: LONG_PATH, wrapDescription: false })).toBe(base)
  })

  it('NEGATIVE — no description in any components/settings/*.tsx carries truncate (census)', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url))
    const files = readdirSync(dir).filter((name) => name.endsWith('.tsx'))
    // The probe reads the real directory (SettingsPage.tsx included), not an empty one.
    expect(files).toEqual(expect.arrayContaining(['SettingsRow.tsx', 'SettingsToggle.tsx', 'SettingsPage.tsx']))

    const offenders: string[] = []
    let decoys = 0
    for (const name of files) {
      const result = truncatedDescriptions(readFileSync(join(dir, name), 'utf8'))
      if (result.hits > 0) offenders.push(name)
      decoys += result.decoys
    }
    expect(offenders).toEqual([])
    // Control 1: the corpus really carries a `truncate` the classifier must NOT count (the menu-select
    // value and the segment label) — without it the assertion above would pass on a classifier that
    // matched nothing at all.
    expect(decoys).toBeGreaterThan(0)
  })

  it('control — the census classifier counts a planted truncating description', () => {
    // The pre-UB15.1 SettingsRow shape, planted: the classifier must see it.
    const planted = "<div className={cn(settingsUI.description, settingsUI.labelDescriptionGap, 'truncate')}>"
    expect(truncatedDescriptions(planted)).toEqual({ hits: 1, decoys: 0 })
    // And a comment that merely names the word is not code.
    expect(truncatedDescriptions(' * settingsUI.description used to truncate')).toEqual({ hits: 0, decoys: 0 })
  })
})
