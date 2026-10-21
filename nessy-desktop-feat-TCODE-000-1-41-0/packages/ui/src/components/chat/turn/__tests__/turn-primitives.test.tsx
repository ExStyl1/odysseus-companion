/**
 * UB14.8 (R3-01) — the transcript primitives taken 1:1 from v0.15.1
 * `packages/ui/src/components/chat/turn/{turn-classes.ts,TurnIconButton.tsx,use-row-reveal.ts,
 * ThinkingRow.tsx,ActivityIcons.tsx}`.
 *
 * packages/ui has no DOM harness, so "renders" is asserted through `renderToStaticMarkup` (the
 * instrument of `ui/__tests__/animated-collapsible.test.tsx`). Lucide draws `lucide-<kebab-name>`
 * into the svg class, which is what the glyph arms read.
 *
 * Arms:
 * - positive: `ResultGlyph status="error"` draws the destructive circle-x; `TurnIconButton` carries
 *   its required `aria-label`, `data-slot="icon-button"` and `type="button"`;
 * - negative (the row's control): `ToolIcon` for codex's collab `spawn_agent` falls to Wrench and
 *   the codex bridge shape `mcp__sources__wire__tool` to Plug — never a native tool's glyph; the
 *   `Bash` arm beside them is the positive control that keeps the fallback arms discriminating;
 * - boundary: `useRowReveal(…, false)` (the card's first render — session switch, reload) gives no
 *   animation props at all, and `true` gives the insert drop with the stagger only on the rows
 *   present when the list mounted;
 * - the move: `SIZE_CONFIG` and `ActivityStatusIcon` live in `turn/` and `TurnCard.tsx` re-exports
 *   them (as upstream), so `InlineExecution.tsx` and the package barrels keep importing them from
 *   `./TurnCard` unchanged.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityStatusIcon, ResultGlyph, ToolIcon } from '../ActivityIcons'
import { ThinkingRow } from '../ThinkingRow'
import { TurnIconButton } from '../TurnIconButton'
import { INSERT_DROP, SIZE_CONFIG } from '../turn-classes'
import { useRowReveal, type RowRevealProps } from '../use-row-reveal'

const svgClass = (html: string): string => html.match(/<svg[^>]*class="([^"]*)"/)?.[1] ?? ''

describe('ResultGlyph / ActivityStatusIcon (UB14.8)', () => {
  it('positive: status="error" draws the destructive circle-x', () => {
    const cls = svgClass(renderToStaticMarkup(<ResultGlyph status="error" />))
    expect(cls).toContain('lucide-circle-x')
    expect(cls).toContain('text-destructive')
  })

  it('boundary: status="completed" draws the success check, never the error glyph', () => {
    const cls = svgClass(renderToStaticMarkup(<ResultGlyph status="completed" />))
    expect(cls).toContain('lucide-check')
    expect(cls).toContain('text-success')
    expect(cls).not.toContain('lucide-circle-x')
  })

  it('ActivityStatusIcon keeps the Edit/Write glyphs and shows the first render as is (no fade-in)', () => {
    const edit = renderToStaticMarkup(<ActivityStatusIcon status="completed" toolName="Edit" />)
    expect(svgClass(edit)).toContain('lucide-pencil')
    // first render: `initial={false}` — a session switch or reload paints the icon at full opacity
    expect(edit).not.toContain('opacity:0')
    const error = renderToStaticMarkup(<ActivityStatusIcon status="error" toolName="Edit" />)
    expect(svgClass(error)).toContain('text-destructive')
  })
})

describe('ToolIcon (UB14.8)', () => {
  it('positive control: a native tool name gets its own glyph (Bash → square-terminal)', () => {
    expect(svgClass(renderToStaticMarkup(<ToolIcon toolName="Bash" />))).toContain('lucide-square-terminal')
  })

  it('negative (control): codex spawn_agent falls to Wrench, the codex bridge mcp__sources__wire__tool to Plug', () => {
    const spawn = svgClass(renderToStaticMarkup(<ToolIcon toolName="spawn_agent" />))
    expect(spawn).toContain('lucide-wrench')
    expect(spawn).not.toContain('lucide-bot')
    const bridged = svgClass(renderToStaticMarkup(<ToolIcon toolName="mcp__sources__wire__tool" />))
    expect(bridged).toContain('lucide-plug')
    expect(bridged).not.toContain('lucide-wrench')
  })

  it('a custom emoji icon wins over the built-in glyph', () => {
    const html = renderToStaticMarkup(<ToolIcon toolName="Bash" customIcon="🔧" />)
    expect(html).toContain('🔧')
    expect(html).not.toContain('<svg')
  })
})

describe('TurnIconButton (UB14.8)', () => {
  it('positive: carries its aria-label, data-slot="icon-button" and type="button"', () => {
    const html = renderToStaticMarkup(<TurnIconButton aria-label="Copy response" icon={<svg />} />)
    expect(html).toContain('aria-label="Copy response"')
    expect(html).toContain('data-slot="icon-button"')
    expect(html).toContain('type="button"')
    expect(html).toContain('size-control-sm')
  })
})

describe('ThinkingRow (UB14.8)', () => {
  it('renders its label beside the accent spinner on the icon column', () => {
    const html = renderToStaticMarkup(<ThinkingRow label="Thinking..." />)
    expect(html).toContain('Thinking...')
    expect(html).toContain('text-accent')
    expect(html).toContain('size-4 shrink-0') // ROW_ICON_SLOT
  })
})

describe('useRowReveal (UB14.8)', () => {
  function Probe({ rows, enabled, sink }: { rows: number; enabled: boolean; sink: Array<RowRevealProps | undefined> }) {
    const reveal = useRowReveal(rows, enabled)
    for (let i = 0; i < rows + 1; i++) sink.push(reveal(i))
    return null
  }

  it('boundary: disabled (the card\'s first render) gives no animation props', () => {
    const sink: Array<RowRevealProps | undefined> = []
    renderToStaticMarkup(<Probe rows={3} enabled={false} sink={sink} />)
    expect(sink).toEqual([undefined, undefined, undefined, undefined])
  })

  it('enabled: every row drops in; only rows present at mount are staggered (index 0 has no delay)', () => {
    const sink: Array<RowRevealProps | undefined> = []
    renderToStaticMarkup(<Probe rows={3} enabled sink={sink} />)
    expect(sink.every((p) => p?.className === INSERT_DROP)).toBe(true)
    expect(sink[0]?.style).toBeUndefined()
    expect(sink[2]?.style?.transitionDelay).toBe('calc(var(--stagger) * 2)')
    expect(sink[3]?.style).toBeUndefined() // a row added after the reveal just drops in
  })
})

describe('the SIZE_CONFIG / ActivityStatusIcon move (UB14.8 Method)', () => {
  const turnCard = readFileSync(join(import.meta.dir, '../../TurnCard.tsx'), 'utf8')

  it('TurnCard re-exports both from turn/ and defines neither itself', () => {
    expect(turnCard).toContain("export { SIZE_CONFIG } from './turn/turn-classes'")
    expect(turnCard).toContain("export { ActivityStatusIcon } from './turn/ActivityIcons'")
    expect(turnCard).not.toMatch(/export const SIZE_CONFIG\b/)
    expect(turnCard).not.toMatch(/export function ActivityStatusIcon\b/)
  })

  it('SIZE_CONFIG carries upstream v0.15.1 values (the token classes, 28px rows, a stagger of 6)', () => {
    expect(SIZE_CONFIG.fontSize).toBe('text-label')
    expect(SIZE_CONFIG.iconSize).toBe('size-3.5')
    expect(SIZE_CONFIG.activityRowHeight).toBe(28)
    expect(SIZE_CONFIG.staggeredAnimationLimit).toBe(6)
  })
})
