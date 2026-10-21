/**
 * R6-03 / UB13.12 — the header buttons' a11y contract: the tooltip text doubles as the accessible
 * name (WCAG 4.1.2 — icon-only controls must be named), an EXPLICIT aria-label always wins, and
 * nothing is invented when neither is given (a decorative or labelled-elsewhere control stays
 * unlabelled rather than getting a placeholder name).
 *
 * renderToStaticMarkup runs the real component: HeaderIconButton wraps its button in the Radix
 * Tooltip (SSR-safe: the trigger renders inline).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { renderToStaticMarkup } from 'react-dom/server'
import { HeaderIconButton } from '../HeaderIconButton'

const XIcon = <svg data-testid="x" />

describe('header buttons a11y (UB13.12, R6-03)', () => {
  it("positive: tooltip=\"Share\" becomes aria-label=\"Share\"", () => {
    const html = renderToStaticMarkup(<TooltipProvider><HeaderIconButton icon={XIcon} tooltip="Share" /></TooltipProvider>)
    expect(html).toContain('aria-label="Share"')
  })

  it('positive: an explicit aria-label wins over the tooltip text', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HeaderIconButton icon={XIcon} tooltip="Share" aria-label="Share page" />
      </TooltipProvider>,
    )
    expect(html).toContain('aria-label="Share page"')
    expect(html).not.toContain('aria-label="Share"')
  })

  it('negative (control): no tooltip and no aria-label — no attribute is invented', () => {
    const html = renderToStaticMarkup(<TooltipProvider><HeaderIconButton icon={XIcon} /></TooltipProvider>)
    expect(html).not.toContain('aria-label')
  })

  it('the upstream restyle landed: size-control ghost with fill-hover, duration-micro (source)', () => {
    const src = readFileSync(join(import.meta.dir, '../HeaderIconButton.tsx'), 'utf8')
    expect(src).toContain('aria-label={props[\'aria-label\'] ?? tooltip}')
    expect(src).toContain('hover:bg-fill-hover')
    expect(src).toContain('duration-micro')
  })
})
