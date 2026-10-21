/**
 * UB14.28 — `FollowUpChips`, taken 1:1 from v0.15.1 (ours was v0.14.0's inline block in `FreeFormInput`).
 *
 * Instruments without a DOM: `renderToStaticMarkup` for the material, and the element tree the component
 * returns (captured inside a probe's render) for the two handlers.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { FollowUpChips } from '../FollowUpChips'
import type { FollowUpInputItem } from '../FreeFormInput'

const EN = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>
const KEYS = ['chat.selectedText', 'chat.followUp'] as const

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    resources: { en: { translation: Object.fromEntries(KEYS.map(key => [key, EN[key]])) } },
    interpolation: { escapeValue: false },
  })
})

const wrap = (node: React.ReactNode) => (
  <I18nextProvider i18n={testI18n}>
    <TooltipProvider>{node}</TooltipProvider>
  </I18nextProvider>
)
const render = (node: React.ReactNode) => renderToStaticMarkup(wrap(node))

const item = (overrides: Partial<FollowUpInputItem> = {}): FollowUpInputItem => ({
  id: 'fu-a',
  messageId: 'm-1',
  annotationId: 'a-1',
  index: 3,
  noteLabel: 'Check the compact mode',
  selectedText: 'Validate the animation',
  ...overrides,
})

describe('UB14.28 · FollowUpChips — v0.15.1 1:1', () => {
  it('the shipped fallback keys exist', () => {
    expect(KEYS.filter(key => typeof EN[key] !== 'string')).toEqual([])
  })

  it('POSITIVE — a chip on upstream\'s material: keycap index, italic excerpt · note', () => {
    const markup = render(<FollowUpChips items={[item()]} animateLayout={false} />)
    expect(markup).toContain('flex flex-wrap gap-1.5 px-2.5 pt-2.5')
    for (const cls of ['h-control', 'rounded-md', 'bg-fill-hover', 'text-label', 'text-secondary', 'hover:bg-fill-pressed']) expect(markup).toContain(cls)
    expect(markup).toContain('class="keycap ')
    expect(markup).toContain('>3</span>')
    expect(markup).toContain('<span class="italic text-tertiary">Validate the animation</span>')
    expect(markup).toContain('<span class="mx-1 text-tertiary">·</span>')
    expect(markup).toContain('<span>Check the compact mode</span>')
    // The v0.14.0 inline material is gone.
    expect(markup).not.toContain('bg-foreground/2')
  })

  it('boundary — the index falls back to the position, an empty excerpt to its key, a long one is cut at 50', () => {
    const long = 'x'.repeat(80)
    const markup = render(
      <FollowUpChips
        items={[item(), item({ id: 'fu-b', index: undefined, selectedText: '   ', noteLabel: long })]}
        animateLayout={false}
      />,
    )
    expect(markup).toContain('>2</span>')
    expect(markup).toContain(`<span class="italic text-tertiary">${EN['chat.selectedText']}</span>`)
    expect(markup).toContain(`<span>${'x'.repeat(49)}…</span>`)
  })

  it('NEGATIVE — no items: nothing at all (the row mounts once, no empty wrapper)', () => {
    expect(render(<FollowUpChips items={[]} animateLayout={false} />)).toBe('')
  })

  it('the chip body opens the annotation at its anchor; the keycap jumps to it without bubbling', () => {
    const onItemClick = mock((_item: FollowUpInputItem, _anchor?: { x: number; y: number }) => {})
    const onIndexClick = mock((_item: FollowUpInputItem) => {})
    let tree: React.ReactNode = null
    function Probe() {
      tree = FollowUpChips({ items: [item()], animateLayout: false, onItemClick, onIndexClick })
      return null
    }
    renderToStaticMarkup(wrap(<Probe />))
    const found: Record<string, unknown>[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      if (typeof node.props.onClick === 'function') found.push(node.props)
      walk(node.props.children)
    }
    walk(tree)
    expect(found).toHaveLength(2)
    const [chip, keycap] = found as [Record<string, (event: unknown) => void>, Record<string, (event: unknown) => void>]
    chip.onClick!({ currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 40, top: 100 }) } })
    expect(onItemClick).toHaveBeenCalledWith(item(), { x: 30, y: 92 })
    const stopPropagation = mock(() => {})
    keycap.onClick!({ preventDefault: () => {}, stopPropagation })
    expect(onIndexClick).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(onItemClick).toHaveBeenCalledTimes(1)
  })
})
