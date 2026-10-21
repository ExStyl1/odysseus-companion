/**
 * UA1.19 — the Published pages playground (`registry/published-pages.tsx`): every list state the plan names (none,
 * live, expiring in under 24 h, expired, needs-login, pending deletion) and the chip's three, rendered offline with
 * `renderToStaticMarkup` (no DOM in this repo's `bun test`) — the sweep's structural half; the dark-theme visual half
 * is the sitting's (lanes never launch the app). Also pins that the index spreads the entries.
 */
import { createElement, type ComponentType } from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { publishedPagesComponents } from '../registry/published-pages'

const PLAYGROUND_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(PLAYGROUND_DIR, '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

beforeAll(async () => {
  // The GLOBAL instance: the chip (packages/ui) calls `i18n.t` directly, as TurnCard does.
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

function render(id: string, props: Record<string, unknown>): string {
  const found = publishedPagesComponents.find(c => c.id === id)
  if (!found) throw new Error(`no playground entry ${id}`)
  const Component = found.component as ComponentType<Record<string, unknown>>
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18next }, createElement(Component, props)))
}

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('UA1.19 — Published pages playground', () => {
  it('the list has a variant for each of the six states (and UB12.58\'s five material states), and the chip for its three', () => {
    const list = publishedPagesComponents.find(c => c.id === 'published-pages-list')!
    expect(list.variants!.map(v => v.name)).toEqual([
      'none', 'live', 'expiring-soon', 'expired', 'needs-login', 'pending-deletion',
      'loading', 'unavailable', 'registry-unreadable', 'busy', 'shared-chat',
    ])
    expect(publishedPagesComponents.find(c => c.id === 'published-artifact-chip')!.variants!.map(v => v.name))
      .toEqual(['live', 'never expires', 'expired'])
  })

  it('live: open, copy, extend and delete; a page published elsewhere says so', () => {
    const html = render('published-pages-list', { state: 'live' })
    expect(html).toContain('data-state="live"')
    expect(count(html, en['settings.workspace.publishedPages.extend']!)).toBeGreaterThanOrEqual(2)
    expect(html).toContain(en['settings.workspace.publishedPages.outside']!)
    expect(html).toContain('From out/q3.html')
  })

  it('expiring in under 24 h is marked; none shows the empty sentence', () => {
    expect(render('published-pages-list', { state: 'expiring-soon' })).toContain('data-state="expiring-soon"')
    expect(render('published-pages-list', { state: 'none' })).toContain(en['settings.workspace.publishedPages.empty']!)
  })

  it('negative: an expired row offers no extend; a pending deletion offers no action and says it is pending', () => {
    const expired = render('published-pages-list', { state: 'expired' })
    expect(expired).toContain('data-state="expired"')
    expect(expired).not.toContain(`</svg>${en['settings.workspace.publishedPages.extend']}`)
    const pending = render('published-pages-list', { state: 'pending-deletion' })
    expect(pending).toContain(en['settings.workspace.publishedPages.pendingDeletion']!)
    expect(count(pending, `</svg>${en['settings.workspace.publishedPages.delete']}`)).toBe(1) // only the live row's
  })

  it('needs-login: ONE card for the whole list, and the pending row still shows', () => {
    const html = render('published-pages-list', { state: 'needs-login' })
    expect(count(html, 'role="status"')).toBe(1)
    expect(html).toContain(en['settings.workspace.publishedPages.needsLogin']!)
    expect(html).toContain('data-state="pending-deletion"')
  })

  it('the chip: an absolute date on a live link, "No expiry", and a disabled expired link', () => {
    expect(render('published-artifact-chip', { state: 'live' })).toContain('data-artifact-chip="live"')
    expect(render('published-artifact-chip', { state: 'live' })).toContain('Expires ')
    expect(render('published-artifact-chip', { state: 'never' })).toContain(en['chat.artifactChip.expiresNever']!)
    const expired = render('published-artifact-chip', { state: 'expired' })
    expect(expired).toContain('data-artifact-chip="expired"')
    expect(expired).toContain('disabled')
  })

  it('the index imports and spreads the entries (else no reviewer can open them)', () => {
    const index = readFileSync(join(PLAYGROUND_DIR, 'registry', 'index.ts'), 'utf8')
    expect(index).toContain("import { publishedPagesComponents } from './published-pages'")
    expect(index).toContain('...publishedPagesComponents,')
  })
})
