/**
 * R83 — the update indicator on the surfaces a user PASSES THROUGH.
 *
 * R82 put the badge where a plugin is managed (the marketplace detail view),
 * and `DetailActions` is the only renderer code that read `installed.actions`
 * at all — so a user who never opens that page was never told. This proves the
 * two pass-through surfaces now tell them, and the detail page they land on
 * repeats it:
 *
 *   1. the browse page's installed strip — a DOT on the icon tile, with the
 *      sentence (and the version) in the tile's tooltip/accessible name,
 *   2. Sources ▸ Plugins rows — the sentence as a NOTE in the row's own note
 *      family, projected through `pluginRowProjection`,
 *   3. `PluginInfoPage`, where both handoffs land — the R82 badge.
 *
 * Every one of them reads the WIRE (R81): `availableUpdateVersion` present →
 * indicator, absent → nothing. A dependency-held plugin has the field withheld
 * server-side, so "absent → nothing" is what keeps the renderer from
 * resurrecting the badge R81 suppresses.
 *
 * Same shape as `plugin-update-affordance.test.tsx`: this package has no DOM
 * harness (renderToStaticMarkup only), so an inline surface is RENDERED and a
 * portalled/wired one is pinned at its single call site.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeInstalledPluginSummary } from '@nessy-agent/shared/protocol/capabilities'
import { MarketplaceInstalledStrip } from '@/components/marketplace/MarketplaceInstalledStrip'
import { SourcesManagementRow } from '@/components/info/SourcesManagementRow'
import { pluginRowProjection } from '@/components/app-shell/plugin-management-rows'

const pluginsPageSource = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
const pluginInfoPageSource = readFileSync(new URL('../PluginInfoPage.tsx', import.meta.url), 'utf8')
const managementPanelSource = readFileSync(
  new URL('../../components/app-shell/PluginsManagementPanel.tsx', import.meta.url),
  'utf8',
)
const en = JSON.parse(readFileSync(
  new URL('../../../../../../packages/shared/src/i18n/locales/en.json', import.meta.url),
  'utf8',
)) as Record<string, string>

/**
 * Source with comment lines dropped, so an absence assertion is about CODE.
 * (Both widened components name the wire field in their prose — deliberately,
 * since the prose is where the R81 constraint is recorded.)
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('*') && !trimmed.startsWith('/*') && !trimmed.startsWith('//')
    })
    .join('\n')
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    // The REAL English catalogue, so the row's note is the sentence the user
    // reads — the same key R82's badge renders.
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

/** Exactly the shape the server sends (`SafeInstalledPluginSummary`). */
function installed(over: Partial<SafeInstalledPluginSummary> = {}): SafeInstalledPluginSummary {
  return {
    pluginKey: 'pk-1',
    activeInstanceId: 'inst-1',
    origin: { marketplaceId: 'acme', pluginId: 'tools' },
    name: 'Acme Tools',
    version: '1.0.0',
    installedAt: 1000,
    lifecycleState: 'ready',
    capabilityKinds: ['skill'],
    activation: { effective: 'active', global: 'unset', workspace: 'enabled' },
    actions: {
      canEnable: true, canDisable: true, canUpdate: false,
      canRepair: true, canUninstall: true, reasonCodes: [],
    },
    ...over,
  }
}

// ── Surface 1: the browse page's installed strip ────────────────────────────

function strip(entry: { name: string; updateLabel?: string }): string {
  return renderToStaticMarkup(
    <MarketplaceInstalledStrip
      title="Installed"
      manageLabel="Manage in Sources"
      entries={[{
        id: 'e1',
        icon: <span />,
        name: entry.name,
        ...(entry.updateLabel ? { updateLabel: entry.updateLabel } : {}),
      }]}
    />,
  )
}

describe('installed strip: an icon-only tile gets a dot, and says why on hover', () => {
  it('advertised update → the dot renders, and the sentence is the tile label', () => {
    const html = strip({ name: 'Acme Tools', updateLabel: 'Update available: 2.4.0' })
    expect(html).toContain('data-testid="marketplace-installed-update-dot"')
    // A 32 px tile cannot carry the sentence, so it rides the tooltip and the
    // accessible name instead — both, not one.
    expect(html).toContain('title="Acme Tools — Update available: 2.4.0"')
    expect(html).toContain('aria-label="Acme Tools — Update available: 2.4.0"')
  })

  it('no advertised update → no dot, and the tile label is unchanged', () => {
    const html = strip({ name: 'Acme Tools' })
    expect(html).not.toContain('marketplace-installed-update-dot')
    expect(html).toContain('title="Acme Tools"')
    expect(html).toContain('aria-label="Acme Tools"')
    // The tile itself is untouched for the (vast) majority of installed rows.
    expect(html).toContain('data-testid="marketplace-installed-tile"')
  })

  it('the browse page feeds it from the wire via pluginUpdateVersion, not its own read', () => {
    // The strip takes display strings; the DECISION stays in the R81/R82 module.
    const entries = pluginsPageSource.indexOf('const installedEntries = useMemo')
    const derive = pluginsPageSource.indexOf('pluginUpdateVersion(item.installed)', entries)
    const label = pluginsPageSource.indexOf("t('plugins.updateAvailable', { version: updateVersion })", derive)
    expect(entries).toBeGreaterThanOrEqual(0)
    expect(derive).toBeGreaterThan(entries)
    expect(label).toBeGreaterThan(derive)
    expect(pluginsPageSource).toContain('pluginUpdateVersion')
    // …and never by reading the raw field at this call site.
    expect(pluginsPageSource.slice(entries, label)).not.toContain('availableUpdateVersion')
  })
})

// ── Surface 2: Sources ▸ Plugins rows ───────────────────────────────────────

function row(updateAvailableVersion?: string): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SourcesManagementRow
        summary={pluginRowProjection(installed()).summary}
        displayName="Acme Tools"
        avatar={<span />}
        enablement={{ enabled: true, scope: 'workspace' }}
        {...(updateAvailableVersion ? { updateAvailableVersion } : {})}
      />
    </I18nextProvider>,
  )
}

describe('Sources ▸ Plugins row: the note, in the row note family', () => {
  it('advertised update → the note renders the sentence with the version', () => {
    const html = row('2.4.0')
    expect(html).toContain('data-testid="row-update-available"')
    expect(html).toContain('Update available: 2.4.0')
  })

  it('no advertised update → no note at all', () => {
    const html = row()
    expect(html).not.toContain('row-update-available')
    expect(html).not.toContain('Update available')
  })

  it('the note is NOT a badge: the title meta still names only the category, and the note is line 2', () => {
    // The card (`sourceCardSlots`) has no extension slot by owner ruling
    // ("badges are the shape"); an update label in the meta would be exactly
    // the re-growth that rule exists to prevent. It stays a note, on the row's
    // line 2 in place of the description (UB12.74, v0.15.1's line-2 rule).
    const html = row('2.4.0')
    const meta = html.indexOf('data-slot="entity-row-meta"')
    const lineTwo = html.indexOf('data-slot="entity-row-subtitle"')
    const note = html.indexOf('data-testid="row-update-available"')
    expect(meta).toBeGreaterThanOrEqual(0)
    expect(html.slice(meta, lineTwo)).not.toContain('row-update-available')
    expect(html.slice(meta, lineTwo)).toContain('data-testid="source-card-meta-plugin"')
    expect(note).toBeGreaterThan(lineTwo) // the note sits on line 2, under the meta
    expect(html).not.toContain('source-category-badge-')
  })
})

describe('the row projection carries the wire version — R83 widened it', () => {
  it('projects availableUpdateVersion when the wire advertises one', () => {
    expect(pluginRowProjection(installed({ availableUpdateVersion: '2.4.0' })).availableUpdateVersion)
      .toBe('2.4.0')
    expect(pluginRowProjection(installed({ availableUpdateVersion: '0.0.1-beta.3' })).availableUpdateVersion)
      .toBe('0.0.1-beta.3')
  })

  it('omits it when the wire does not — including R81\'s withheld dependency hold', () => {
    expect(pluginRowProjection(installed())).not.toHaveProperty('availableUpdateVersion')
    expect(pluginRowProjection(installed({ availableUpdateVersion: '' })))
      .not.toHaveProperty('availableUpdateVersion')
  })

  it('reads the decision module rather than the raw field', () => {
    const source = readFileSync(
      new URL('../../components/app-shell/plugin-management-rows.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain("import { pluginUpdateVersion } from '@/pages/plugin-update-affordance'")
    expect(source).toContain('const availableUpdateVersion = pluginUpdateVersion(plugin)')
    expect(source).not.toContain('plugin.availableUpdateVersion')
  })

  it('the panel hands the projected version to the row', () => {
    expect(managementPanelSource).toContain('projection.availableUpdateVersion')
    expect(managementPanelSource).toContain('{ updateAvailableVersion: projection.availableUpdateVersion }')
  })
})

// ── Surface 3: the page both handoffs land on ───────────────────────────────

describe('PluginInfoPage repeats it, so the indicator survives the click', () => {
  it('renders the R82 badge from the same wire fields, beside the actions menu', () => {
    // Radix portals the menu and the page is IPC-bound, so this is pinned at
    // its call site — the badge component itself is rendered by
    // plugin-update-affordance.test.tsx.
    const badge = pluginInfoPageSource.indexOf('<PluginUpdateBadge')
    // UB14.59: the actions menu is the header's `Info_HeaderMenu` (v0.15.1 detail anatomy).
    const menu = pluginInfoPageSource.indexOf('<Info_HeaderMenu', badge)
    expect(pluginInfoPageSource).toContain("import { PluginUpdateBadge, PluginUpdateStalledBadge } from './plugin-update-affordance'")
    expect(badge).toBeGreaterThanOrEqual(0)
    expect(menu).toBeGreaterThan(badge)
    expect(pluginInfoPageSource).toContain('installed={plugin}')
    expect(pluginInfoPageSource).toContain("t('plugins.updateAvailable', { version })")
  })
})

// ── The constraint carried from R81 ─────────────────────────────────────────

describe('no surface re-derives what the server withheld', () => {
  it('the two widened surfaces read the field only through pluginUpdateVersion', () => {
    const strip = readFileSync(
      new URL('../../components/marketplace/MarketplaceInstalledStrip.tsx', import.meta.url),
      'utf8',
    )
    const rowSource = readFileSync(
      new URL('../../components/info/SourcesManagementRow.tsx', import.meta.url),
      'utf8',
    )
    // Neither component reads the wire — each takes a caller-supplied string,
    // which is why neither can invent an update the server did not advertise.
    // (Prose naming the field is fine; a READ of it is not.)
    expect(codeOnly(strip)).not.toContain('availableUpdateVersion')
    expect(codeOnly(strip)).not.toContain('SafeInstalledPluginSummary')
    expect(rowSource).toContain('updateAvailableVersion?: string')
    expect(codeOnly(rowSource)).not.toContain('.availableUpdateVersion')
    expect(codeOnly(managementPanelSource)).not.toContain('installed.availableUpdateVersion')
  })
})
