import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { PluginOriginBadge } from '../PluginOriginBadge'

const translations = {
  'plugins.origin.format.nessy': 'Nessy',
  'plugins.origin.format.codex': 'Codex',
  'plugins.origin.format.claude': 'Claude',
  'plugins.origin.format.unknown': 'Unknown format',
  'plugins.origin.acquisition.nessyMarketplace': 'Nessy Marketplace',
  'plugins.origin.acquisition.externalMarketplace': 'External marketplace',
  'plugins.origin.acquisition.repository': 'Repository',
  'plugins.origin.acquisition.local': 'Local',
  'plugins.origin.acquisition.url': 'URL',
  'plugins.origin.acquisition.unknown': 'Unknown source',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translations } },
      interpolation: { escapeValue: false },
    })
})

function renderBadge(props: React.ComponentProps<typeof PluginOriginBadge>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PluginOriginBadge {...props} />
    </I18nextProvider>,
  )
}

describe('PluginOriginBadge', () => {
  it('renders the format logo and acquisition label for a Codex plugin from the Nessy marketplace', () => {
    const html = renderBadge({ presentation: { format: 'codex', acquisition: 'nessy-marketplace' } })
    expect(html).toContain('Nessy Marketplace')
    // Mono mark, not an <img>: it has to inherit currentColor in both themes.
    expect(html).toContain('<svg')
    expect(html).not.toContain('<img')
    expect(html).toMatch(/aria-label="Codex"/)
  })

  it('renders the Claude mark as an inline mono svg for the claude format', () => {
    const html = renderBadge({ presentation: { format: 'claude', acquisition: 'repository' } })
    expect(html).toContain('Repository')
    expect(html).not.toContain('<img')
    expect(html).toMatch(/aria-label="Claude"/)
    expect(html).toContain('currentColor')
  })

  it('renders the Nessy symbol (not an <img>) for the nessy format', () => {
    const html = renderBadge({ presentation: { format: 'nessy', acquisition: 'repository' } })
    expect(html).toContain('Repository')
    expect(html).toContain('<svg')
    expect(html).not.toContain('<img')
    // The mark is the only thing naming the format — it must carry the name.
    expect(html).toMatch(/aria-label="Nessy"/)
  })

  it('shows a generic package icon and acquisition-only label for a pre-inspection catalog row (no presentation)', () => {
    const html = renderBadge({})
    expect(html).toContain('Unknown source')
    expect(html).not.toContain('<img')
    // Lucide's Package icon renders an inline <svg>, never a format logo <img>.
    expect(html).toContain('<svg')
  })

  it('keeps format unknown (generic icon) even when acquisition is already known pre-inspection', () => {
    const html = renderBadge({ presentation: { format: 'unknown', acquisition: 'nessy-marketplace' } })
    expect(html).toContain('Nessy Marketplace')
    expect(html).not.toContain('<img')
  })
})
