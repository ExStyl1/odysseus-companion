/**
 * R6-01 / UB13.10 — the renderer control primitives. The Button contract (design spec D5):
 * ONE accent-solid primary (OQ-B3-1b (a)), a raised-neutral secondary, ghost Cancel/Deny, and
 * danger-solid only for irreversible confirmations. The deprecated `default`/`outline`/
 * `destructive` aliases keep our 85 call sites compiling and RENDER AS THEIR SUCCESSORS.
 *
 * Rendering is asserted through renderToStaticMarkup (no RTL/jsdom harness in this repo); the
 * type-level arm is a source guard on the props type.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, IconButton } from '../button'

const source = readFileSync(join(import.meta.dir, '../button.tsx'), 'utf8')

describe('Button variants (UB13.10, design spec D5)', () => {
  it('positive: a bare <Button> renders data-variant="primary"', () => {
    const html = renderToStaticMarkup(<Button>Send</Button>)
    expect(html).toContain('data-variant="primary"')
    expect(html).toContain('bg-accent-solid')
    expect(html).toContain('>Send<')
  })

  it('negative (control): variant="outline" renders the SECONDARY classes — the alias is the successor', () => {
    const html = renderToStaticMarkup(<Button variant="outline">Cancel</Button>)
    expect(html).toContain('data-variant="outline"')
    expect(html).toContain('bg-raised')
    expect(html).toContain('shadow-elev-1')
    expect(html).not.toContain('bg-accent-solid')
  })

  it('the deprecated aliases map onto their successors in the variant table', () => {
    expect(source).toContain("/** @deprecated use `primary` */\n        default: \"state-overlay bg-accent-solid")
    expect(source).toContain("/** @deprecated use `secondary` */\n        outline: \"state-overlay bg-raised")
    expect(source).toContain("/** @deprecated use `danger-solid` */\n        destructive: \"state-overlay bg-destructive-solid")
    expect(source).toContain('defaultVariants: {\n      variant: "primary",')
  })

  it('IconButton requires an accessible name (WCAG 4.1.2) — the type drops the inherited aria-label', () => {
    expect(source).toContain('Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children">')
    expect(source).toContain('"aria-label": string')
    // and a default type="button" so an IconButton can never submit a form
    expect(source).toContain('type = "button"')
    void IconButton
  })
})
