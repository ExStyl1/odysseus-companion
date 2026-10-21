/**
 * R6-04 / UB13.13 — EntityRow: mail-style rows whose "⋯" actions button is a SIBLING of the row
 * button (never nested), named by `moreButtonLabel`, and which REPLACES the trailing meta on
 * hover; a `disabled` row (our Keep: model catalog unavailable rows) says `aria-disabled` and
 * does not invite a click; `showSeparator` is deprecated and renders nothing; the row button
 * keeps `type="button"` (our measured Keep — rows inside the personal-key form).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EntityRow } from '../entity-row'

const source = readFileSync(join(import.meta.dir, '../entity-row.tsx'), 'utf8')

const row = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    React.createElement(EntityRow, {
      title: 'Weekly digest',
      ...props,
    }),
  )

describe('EntityRow (UB13.13, R6-04)', () => {
  it('positive: the "⋯" button is a SIBLING of the row button and carries moreButtonLabel as its aria-label', () => {
    const html = row({ menuContent: <div>menu items</div>, moreButtonLabel: 'Actions for Weekly digest' })
    // two sibling buttons: the row and the ⋯
    expect(html.match(/<button/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('aria-label="Actions for Weekly digest"')
    // the dropdown trigger is outside the row button's markup (sibling, not nested):
    // the row button closes before the trigger opens
    const rowClose = html.indexOf('</button>')
    const moreOpen = html.indexOf('aria-label="Actions for Weekly digest"')
    expect(rowClose).toBeGreaterThan(-1)
    expect(moreOpen).toBeGreaterThan(rowClose)
  })

  it('positive: a disabled row has aria-disabled, the disabled attribute, and no hover fill', () => {
    const html = row({ disabled: true })
    expect(html).toContain('aria-disabled="true"')
    expect(source).toContain(': disabled ? "" : "hover:bg-fill-hover"')
    expect(source).toContain('disabled && "cursor-not-allowed opacity-60"')
  })

  it('negative (control): showSeparator renders no separator element — the deprecated prop changes nothing', () => {
    const withFlag = row({ showSeparator: true })
    const without = row({})
    // the hairline class on the row wrapper is the mail-style divider (always present); what the
    // deprecated prop must NOT do is add a separator ELEMENT
    expect(withFlag).not.toContain('data-separator')
    // stronger: the deprecated prop changes the markup not at all
    expect(withFlag).toBe(without)
  })

  it("the row button keeps type=\"button\" (the personal-key form arm)", () => {
    const html = row({})
    expect(html).toContain('<button')
    expect(html).toContain('type="button"')
    expect(source).toContain('type="button"')
    expect(source).toContain('REQUIRED, not stylistic')
  })
})
