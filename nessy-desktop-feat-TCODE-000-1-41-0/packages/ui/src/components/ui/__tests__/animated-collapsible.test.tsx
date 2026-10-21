/**
 * UB13.9 — AnimatedCollapsibleContent (ADDED upstream v0.15.1): content expands in place, fading
 * in with a 4px drop and fading out before unmount; no height animation (transform/opacity only,
 * per the guardrail rule) and the fade-only residue under reduced motion comes from
 * MotionConfig, not this file.
 *
 * packages/ui has no RTL/jsdom harness, so "renders" is asserted through renderToStaticMarkup:
 * closed → the children are absent; open → present. The timing/motion arms are source guards:
 * the transition is `TWEEN.fast` (a transform/opacity preset) and the enter starts at y: -4.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnimatedCollapsibleContent } from '../AnimatedCollapsibleContent'

const source = readFileSync(join(import.meta.dir, '../AnimatedCollapsibleContent.tsx'), 'utf8')

describe('AnimatedCollapsibleContent (UB13.9)', () => {
  it('positive: open renders the children', () => {
    const html = renderToStaticMarkup(
      <AnimatedCollapsibleContent isOpen className="wrap-test">
        <button type="button">collapsible-child-marker</button>
      </AnimatedCollapsibleContent>,
    )
    expect(html).toContain('collapsible-child-marker')
    expect(html).toContain('wrap-test')
  })

  it('positive: closed renders nothing (AnimatePresence initial={false}, no exit ghost in static markup)', () => {
    const html = renderToStaticMarkup(
      <AnimatedCollapsibleContent isOpen={false}>
        <button type="button">collapsible-child-marker</button>
      </AnimatedCollapsibleContent>,
    )
    expect(html).not.toContain('collapsible-child-marker')
  })

  it('negative (control): reduced motion needs nothing here — the fade-only residue is MotionConfig\'s; this file animates transform/opacity only', () => {
    // No height KEY anywhere (the layout animates ONCE, by mounting/unmounting):
    expect(source).not.toMatch(/height\s*:/)
    // the enter is the documented fade + 4px drop on the TWEEN.fast preset
    expect(source).toContain('initial={{ opacity: 0, y: -4 }}')
    expect(source).toContain('transition={TWEEN.fast}')
    // reduced motion is the provider's MotionConfig (motion/react), not a local media query
    expect(source).not.toContain('prefers-reduced-motion')
  })
})
