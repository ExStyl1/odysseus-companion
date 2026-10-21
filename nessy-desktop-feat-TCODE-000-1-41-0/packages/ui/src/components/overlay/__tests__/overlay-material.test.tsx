/**
 * UB14.45 (R7-06) — the overlays on the new material: v0.15.1
 * `packages/ui/src/components/overlay/{FullscreenOverlayBaseHeader,ZoomControls,OverlayErrorBanner}.tsx`
 * taken 1:1 and `MultiDiffPreviewOverlay.tsx`'s one `--shadow-color` line re-applied (the two
 * banner lines landed with UB13.3's triplet sweep, guarded by `styles/__tests__/no-rgb-triplets.test.ts`;
 * this row took the two menu surfaces).
 *
 * Instruments. packages/ui ships no DOM harness, so markup comes from `renderToStaticMarkup` (the
 * instrument of `markdown/__tests__/preview-block-chrome.test.tsx`), labels through a private
 * i18next instance. The two menus this row restyles open only on a right-click (a Radix portal) or a
 * click (a local `isOpen`), which static markup cannot reach, so their material is pinned from
 * source: each must read as the shared menu surface of `ui/StyledDropdown.tsx` (UB13.9).
 *
 * Arms:
 * - positive: the header's close is a NAMED control — a button whose name is `common.closeEsc` in en
 *   and in ru, its X glyph aria-hidden. The row's wording said "a named `IconButton`"; v0.15.1
 *   `ui/PreviewHeader.tsx` (byte-identical to ours) draws a plain `<button title>`, and this row takes
 *   the overlay 1:1, so the arm asserts the name, not the component (a recorded deviation).
 * - negative (the row's control): an overlay with no error renders no error banner at all; the same
 *   overlay with one renders it on the role colour (`--shadow-color: var(--destructive)`), and so does
 *   the multi-diff overlay's failed change (its one re-applied line).
 * - material: the right-click menu rows are StyledDropdown's item rows (30px row, label size,
 *   fill-hover) with the old ad-hoc classes gone; the zoom presets panel is `popover-styled
 *   motion-pop-in`, not the old bordered `shadow-strong` box; a closed zoom control draws no panel.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { FileText } from 'lucide-react'
import en from '../../../../../shared/src/i18n/locales/en.json'
import ru from '../../../../../shared/src/i18n/locales/ru.json'
import { FullscreenOverlayBaseHeader } from '../FullscreenOverlayBaseHeader'
import { MultiDiffPreviewOverlay } from '../MultiDiffPreviewOverlay'
import { PreviewOverlay } from '../PreviewOverlay'
import { ZoomControls } from '../ZoomControls'

const readSource = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8')
const HEADER_SOURCE = readSource('../FullscreenOverlayBaseHeader.tsx')
const ZOOM_SOURCE = readSource('../ZoomControls.tsx')
const STYLED_DROPDOWN_SOURCE = readSource('../../ui/StyledDropdown.tsx')

const i18nFor: Record<'en' | 'ru', I18nInstance> = {} as Record<'en' | 'ru', I18nInstance>
beforeAll(async () => {
  for (const lng of ['en', 'ru'] as const) {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: 'en',
      resources: { en: { translation: en }, ru: { translation: ru } },
      interpolation: { escapeValue: false },
    })
    i18nFor[lng] = instance
  }
})

function render(node: React.ReactNode, lng: 'en' | 'ru' = 'en'): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18nFor[lng]}>{node}</I18nextProvider>)
}

/** The string literals inside `const <name> = cn( … )` of a source file. */
function cnLiterals(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = cn(`)
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n)', start))
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => (m[1] ?? m[2])!)
}

const escapeHtmlAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

describe('the fullscreen overlay header (UB14.45)', () => {
  for (const lng of ['en', 'ru'] as const) {
    it(`positive: the close is a button named by common.closeEsc (${lng}), its glyph aria-hidden`, () => {
      const html = render(<FullscreenOverlayBaseHeader onClose={() => {}} title="report.md" />, lng)
      const name = (lng === 'en' ? en : ru)['common.closeEsc']
      expect(name.length).toBeGreaterThan(0)
      const close = html.match(new RegExp(`<button[^>]*title="${escapeHtmlAttr(name).replace(/[()]/g, '\\$&')}"[^>]*>(.*?)</button>`))
      expect(close).not.toBeNull()
      const inner = close?.[1] ?? ''
      // The button's only content is the X glyph, hidden from assistive tech — so the title IS its name.
      expect(inner).toContain('lucide-x')
      expect(inner).toContain('aria-hidden="true"')
      expect(inner.replace(/<[^>]+>/g, '').trim()).toBe('')
    })
  }

  it('material: the right-click menu rows are StyledDropdown\'s item rows, the old ad-hoc classes gone', () => {
    const items = cnLiterals(HEADER_SOURCE, 'contextMenuItemClasses')
    const content = cnLiterals(HEADER_SOURCE, 'contextMenuContentClasses')
    expect(items.length).toBe(3)
    // positive: every row literal is one StyledDropdownMenuItem carries, and the surface is the popover one
    for (const literal of items) expect(STYLED_DROPDOWN_SOURCE).toContain(literal)
    expect(items.join(' ')).toContain('min-h-row-menu')
    expect(items.join(' ')).toContain('hover:bg-fill-hover')
    expect(content.join(' ')).toContain('popover-styled motion-popover')
    // negative: none of the v0.14 hand-rolled row/animation classes survives
    for (const old of ['animate-in', 'zoom-in-95', 'hover:bg-foreground/[0.03]', 'rounded-[4px]', 'text-xs', 'text-sm', 'gap-0.5']) {
      expect([...items, ...content].join(' ').split(/\s+/)).not.toContain(old)
    }
  })
})

describe('the overlay error banner (UB14.45)', () => {
  const overlay = (error?: { label: string; message: string }) =>
    render(
      <PreviewOverlay
        isOpen
        onClose={() => {}}
        embedded
        typeBadge={{ icon: FileText, label: 'Read', variant: 'read' }}
        title="a.ts"
        error={error}
      >
        <p>overlay-child-marker</p>
      </PreviewOverlay>,
    )

  it('negative (control): an overlay with no error renders no banner at all', () => {
    const html = overlay()
    expect(html).toContain('overlay-child-marker')
    expect(html).not.toContain('shadow-tinted')
    expect(html).not.toContain('--shadow-color')
    expect(html).not.toContain('text-destructive')
  })

  it('positive: with an error the banner renders its label and message on the destructive role colour', () => {
    const html = overlay({ label: 'Read Failed', message: 'ENOENT: no such file' })
    expect(html).toContain('Read Failed')
    expect(html).toContain('ENOENT: no such file')
    expect(html).toContain('shadow-tinted')
    // The exact property value: the role colour itself, with no suffix after the name.
    expect(html).toContain('style="--shadow-color:var(--destructive)"')
    // Banner above the content (inside the same centring column).
    expect(html.indexOf('Read Failed')).toBeLessThan(html.indexOf('overlay-child-marker'))
  })
})

describe('the multi-diff overlay\'s failed change (UB14.45, the one re-applied line)', () => {
  it('positive: a failed edit renders its tinted banner, with the reason, on the destructive role colour', () => {
    const html = render(
      <MultiDiffPreviewOverlay
        isOpen
        onClose={() => {}}
        embedded
        changes={[{ id: 'c1', filePath: '/src/auth/index.ts', toolType: 'Edit', original: 'a', modified: 'b', error: 'old_string not found in file' }]}
      />,
    )
    expect(html).toContain('old_string not found in file')
    expect(html).toContain('shadow-tinted')
    expect(html).toContain('style="--shadow-color:var(--destructive)"')
  })
})

describe('the zoom controls (UB14.45)', () => {
  const zoom = () =>
    render(
      <ZoomControls
        scale={1}
        minScale={0.25}
        maxScale={4}
        zoomPresets={[50, 100, 200]}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onZoomToPreset={() => {}}
        onZoomToFit={() => {}}
        onReset={() => {}}
        resetDisabled
      />,
    )

  it('positive: the controls render named, and the presets panel is the popover surface with pop-in motion', () => {
    const html = zoom()
    for (const key of ['overlay.zoomOut', 'overlay.zoomIn', 'overlay.zoomReset', 'overlay.zoomPresets'] as const) {
      expect(html).toContain(`title="${escapeHtmlAttr(en[key])}"`)
    }
    expect(html).toContain('100%')
    expect(ZOOM_SOURCE).toContain("'popover-styled motion-pop-in absolute top-full right-0 mt-1 min-w-[140px] origin-top-right p-1'")
  })

  it('negative: a closed control draws no panel, and the old bordered shadow-strong box is gone from source', () => {
    const html = zoom()
    expect(html).not.toContain('popover-styled')
    expect(html).not.toContain(en['overlay.zoomToFit'])
    for (const old of ['shadow-strong', 'border-border/50', 'animate-in', 'zoom-in-95']) {
      expect(ZOOM_SOURCE).not.toContain(old)
    }
  })
})
