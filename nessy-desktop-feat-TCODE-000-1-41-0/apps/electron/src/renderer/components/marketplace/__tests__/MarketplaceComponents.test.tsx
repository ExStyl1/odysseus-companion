/**
 * U5 marketplace component state matrix (renderToStaticMarkup, mirrors
 * PluginComponentsSection.test.tsx style). Components are imported directly
 * (not via the info barrel) and driven by props/callbacks — they take display
 * strings via PROPS, so the test asserts state markup + the passed-through copy,
 * not i18n keys (except the CapabilityContentPanel/PluginOriginBadge internals,
 * which we seed).
 *
 * pdfjs is stubbed because CapabilityContentPanel → Info_Markdown pulls the
 * worker URL bun can't resolve.
 *
 * AND THE STUB HAS TO BEAT THE IMPORT, which a STATIC import cannot let it do
 * (measured 2026-09-20, D1.442). ESM hoists every `import` declaration above the
 * whole module body, so the components below were linked — and their chain
 * reached `pdfjs-dist/build/pdf.worker.min.mjs?url` — BEFORE the three lines that
 * stub it had run. This file was therefore red ALONE at every HEAD since it was
 * written (`0 pass / 1 fail / 1 error`, `SyntaxError: Missing 'default' export in
 * module … pdf.worker.min.mjs?url`), and green only when some OTHER file in the
 * same bun process had installed that stub first — which is why it died the day
 * the CI job started running one process per directory, taking its whole chunk
 * with it (the child exits 1 with ZERO failing tests and one file that never
 * ran). Its sibling `MarketplaceBrowseCardSuggestion.test.tsx` exists because of
 * exactly this and says so in its own docblock.
 *
 * So the values are loaded with `await import(...)` AFTER the stubs, the recipe
 * `pages/__tests__/capability-info-pages.test.tsx` already uses next door. Only
 * `import type` may stay static — types are erased and link nothing.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MarketplaceBrowseSection } from '@/components/marketplace/MarketplaceBrowsePage'
import type { MarketplaceAddSubmit } from '@/components/marketplace/MarketplaceAddDialog'
import type { CapabilityContentPanelStatus } from '@/components/info/CapabilityContentPanel'
import ruMessages from '../../../../../../../packages/shared/src/i18n/locales/ru.json'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

const { MarketplaceBrowseCard } = await import('@/components/marketplace/MarketplaceBrowseCard')
const { MarketplaceBrowsePage } = await import('@/components/marketplace/MarketplaceBrowsePage')
const { MarketplaceInstalledStrip } = await import('@/components/marketplace/MarketplaceInstalledStrip')
const { MarketplaceDetail } = await import('@/components/marketplace/MarketplaceDetail')
const { MarketplaceAddBody } = await import('@/components/marketplace/MarketplaceAddDialog')
const { MarketplaceSkillPreviewBody } = await import('@/components/marketplace/MarketplaceSkillPreviewModal')
const { PluginComponentsSection } = await import('@/components/info/PluginComponentsSection')
const { toGroups } = await import('@/pages/plugin-components-groups')
const { Dialog } = await import('@/components/ui/dialog')

// Keys the internal reused primitives resolve (content panel + origin badge).
const KEYS = {
  'capabilityDetail.contentUnavailable': 'Content unavailable',
  'capabilityDetail.retry': 'Retry',
  'capabilityDetail.noContent': 'No documentation provided',
  'plugins.origin.format.codex': 'Codex',
  'plugins.origin.format.nessy': 'Nessy',
  'plugins.origin.format.claude': 'Claude',
  'plugins.origin.format.unknown': 'Plugin',
  'plugins.origin.acquisition.nessyMarketplace': 'Nessy Marketplace',
  'plugins.origin.acquisition.externalMarketplace': 'External Marketplace',
  'plugins.origin.acquisition.repository': 'Repository',
  'plugins.origin.acquisition.local': 'Local',
  'plugins.origin.acquisition.url': 'URL',
  'plugins.origin.acquisition.unknown': 'Unknown',
  'table.viewFullscreen': 'View fullscreen',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: KEYS } },
    interpolation: { escapeValue: false },
  })
})

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

const tile = <span>icon</span>

describe('MarketplaceBrowseCard install-state matrix', () => {
  function card(installState: 'not-installed' | 'installing' | 'installed' | 'blocked') {
    return render(
      <MarketplaceBrowseCard
        id="x"
        icon={tile}
        name="ASP.NET Web API"
        description="Scaffold Web APIs."
        installState={installState}
        installLabel="Install"
        installedLabel="Installed"
        installingLabel="Installing…"
        blockedReason="Blocked by policy"
      />,
    )
  }

  it('not-installed → an Install button (never an installed chip)', () => {
    const html = card('not-installed')
    expect(html).toContain('data-testid="marketplace-card-install"')
    expect(html).toContain('Install')
    expect(html).not.toContain('data-testid="marketplace-card-installed"')
  })

  it('installing → a disabled Installing… button', () => {
    const html = card('installing')
    expect(html).toContain('data-testid="marketplace-card-installing"')
    expect(html).toContain('Installing')
  })

  it('installed → an Installed state chip, NOT an install button', () => {
    const html = card('installed')
    expect(html).toContain('data-testid="marketplace-card-installed"')
    expect(html).toContain('Installed')
    expect(html).not.toContain('data-testid="marketplace-card-install"')
  })

  it('blocked → a disabled button carrying the reason tooltip', () => {
    const html = card('blocked')
    expect(html).toContain('data-testid="marketplace-card-blocked"')
    expect(html).toContain('Blocked by policy')
  })

  it('renders the origin badge from presentation', () => {
    const html = render(
      <MarketplaceBrowseCard
        id="x"
        icon={tile}
        name="GitHub"
        installState="not-installed"
        installLabel="Connect"
        installedLabel="Installed"
        installingLabel="Installing…"
        presentation={{ format: 'nessy', acquisition: 'nessy-marketplace' }}
      />,
    )
    expect(html).toContain('Nessy Marketplace')
    expect(html).toContain('Connect')
  })
})

describe('MarketplaceBrowsePage list-state matrix', () => {
  const sections: MarketplaceBrowseSection[] = [
    {
      id: 'featured',
      title: 'Featured',
      cards: [
        {
          id: 'a',
          icon: tile,
          name: 'Skill A',
          installState: 'not-installed',
          installLabel: 'Install',
          installedLabel: 'Installed',
          installingLabel: 'Installing…',
        },
      ],
    },
  ]

  function page(status: 'ready' | 'loading' | 'empty' | 'error') {
    return render(
      <MarketplaceBrowsePage
        title="Marketplace"
        subtitle="Discover skills."
        status={status}
        query=""
        searchPlaceholder="Search…"
        sections={status === 'ready' ? sections : []}
        emptyMessage="No results found"
        errorMessage="Failed to load the marketplace"
        retryLabel="Retry"
        onRetry={() => {}}
      />,
    )
  }

  it('ready → section shelves with cards + search field', () => {
    const html = page('ready')
    expect(html).toContain('data-testid="marketplace-search"')
    expect(html).toContain('data-testid="marketplace-section"')
    expect(html).toContain('data-testid="marketplace-browse-card"')
  })

  it('loading → skeleton grid', () => {
    expect(page('loading')).toContain('data-testid="marketplace-loading"')
  })

  it('empty → a single quiet no-results line, no sections', () => {
    const html = page('empty')
    expect(html).toContain('data-testid="marketplace-empty"')
    expect(html).toContain('No results found')
    expect(html).not.toContain('data-testid="marketplace-section"')
  })

  it('error → Info_Alert with a Retry affordance', () => {
    const html = page('error')
    expect(html).toContain('data-testid="marketplace-error"')
    expect(html).toContain('data-testid="marketplace-retry"')
    expect(html).toContain('Failed to load the marketplace')
  })

  it('shows the clear (×) affordance only when the query is non-empty', () => {
    const withQuery = render(
      <MarketplaceBrowsePage
        title="Marketplace"
        status="ready"
        query="github"
        searchPlaceholder="Search…"
        sections={sections}
        emptyMessage="No results found"
      />,
    )
    expect(withQuery).toContain('data-testid="marketplace-search-clear"')
    expect(page('ready')).not.toContain('data-testid="marketplace-search-clear"')
  })

  // ── R3: grouped registry sections + per-section actions/note + load-error ──
  it('renders a registry section beside the built-in market with per-section actions + note, plus the load-error note', () => {
    const grouped: MarketplaceBrowseSection[] = [
      { id: 'catalog:plugins', title: 'Plugins', cards: sections[0].cards },
      {
        id: 'registry:reg-1',
        title: 'Acme Registry',
        actions: <button data-testid="marketplace-registry-upgrade">Upgrade</button>,
        note: 'This marketplace could not be loaded.',
        cards: [],
      },
    ]
    const html = render(
      <MarketplaceBrowsePage
        title="Marketplace"
        status="ready"
        query=""
        searchPlaceholder="Search…"
        sections={grouped}
        loadErrorNote="Some marketplaces could not be loaded."
        emptyMessage="No results found"
      />,
    )
    // Two grouped sections; the registry section carries its Upgrade affordance.
    expect(html.split('data-testid="marketplace-section"').length - 1).toBe(2)
    expect(html).toContain('Acme Registry')
    expect(html).toContain('data-testid="marketplace-registry-upgrade"')
    // Per-registry note + top-level partial-state note both render.
    expect(html).toContain('data-testid="marketplace-section-note"')
    expect(html).toContain('data-testid="marketplace-load-error-note"')
    expect(html).toContain('Some marketplaces could not be loaded.')
  })
})

describe('MarketplaceInstalledStrip', () => {
  it('renders installed tiles + a Manage-in-Sources handoff', () => {
    const html = render(
      <MarketplaceInstalledStrip
        title="Installed"
        entries={[
          { id: '1', icon: tile, name: 'GitHub' },
          { id: '2', icon: tile, name: 'Sentry' },
        ]}
        manageLabel="Manage in Sources"
      />,
    )
    expect(html).toContain('data-testid="marketplace-installed-strip"')
    expect((html.match(/data-testid="marketplace-installed-tile"/g) ?? []).length).toBe(2)
    expect(html).toContain('data-testid="marketplace-manage-in-sources"')
    expect(html).toContain('Manage in Sources')
  })
})

describe('MarketplaceDetail skill-preview matrix', () => {
  function detail(status: CapabilityContentPanelStatus, opts?: { fileRefs?: boolean; information?: boolean; starters?: boolean }) {
    return render(
      <MarketplaceDetail
        icon={tile}
        name="ASP.NET Web API"
        tagline="Scaffold Web APIs."
        breadcrumbParent="Plugins"
        presentation={{ format: 'codex', acquisition: 'external-marketplace' }}
        starterPrompts={opts?.starters === false ? undefined : ['Scaffold a CRUD controller']}
        aboutTitle="About"
        content={{
          status,
          markdown: '# ASP.NET Web API\n\nBody text.',
          fileRefs:
            opts?.fileRefs === false
              ? undefined
              : [{ id: 'r', label: 'Program.cs', relativePath: 'src/Api/Program.cs' }],
        }}
        informationTitle="Information"
        information={opts?.information === false ? undefined : [{ label: 'Developer', value: 'acme' }]}
        informationEmpty="No additional information provided."
      />,
    )
  }

  it('loaded → breadcrumb + markdown body + file-ref chip (tooltip = relative path) + info table', () => {
    const html = detail('loaded')
    expect(html).toContain('data-testid="marketplace-detail-breadcrumb"')
    expect(html).toContain('data-testid="content-loaded"')
    expect(html).toContain('data-testid="content-file-ref"')
    expect(html).toContain('title="src/Api/Program.cs"')
    expect(html).toContain('Developer')
    // starter-prompt promo pills
    expect(html).toContain('data-testid="marketplace-detail-starter"')
  })

  it('loading → content skeleton', () => {
    expect(detail('loading')).toContain('data-testid="content-loading"')
  })

  it('error → content error placeholder', () => {
    expect(detail('error')).toContain('data-testid="content-error"')
  })

  it('empty → content empty placeholder (section still renders)', () => {
    const html = detail('empty', { fileRefs: false })
    expect(html).toContain('data-testid="content-empty"')
  })

  it('no Information rows → in-section placeholder (placeholder-not-hidden)', () => {
    const html = detail('loaded', { information: false })
    expect(html).toContain('data-testid="marketplace-detail-info-empty"')
    expect(html).toContain('No additional information provided.')
  })

  it('file-ref tooltip is the RELATIVE path only (no absolute path)', () => {
    // The chip tooltip is exactly the relativePath we pass — never an absolute
    // one. (The origin-badge <img> in the hero points at a local dev asset path
    // unrelated to the file-ref channel, so scope the check to the chip.)
    const html = detail('loaded')
    expect(html).toContain('title="src/Api/Program.cs"')
    expect(html).not.toMatch(/title="\/Users/)
    expect(html).not.toMatch(/title="\/[a-z]+\/.*Program\.cs"/)
  })
})

describe('MarketplaceAddDialog (body)', () => {
  function addBody(): string {
    // Wrap in a Dialog root so the body's Radix DialogTitle/Description have context.
    return renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <Dialog open>
          <MarketplaceAddBody
            title="Add plugin marketplace"
            description="Add from a GitHub repo, Git URL, or local folder."
            sourceLabel="Source"
            sourcePlaceholder="openai/plugins"
            gitRefLabel="Git ref"
            sparsePathsLabel="Sparse paths"
            sparsePathsPlaceholder="plugins/codex"
            cancelLabel="Cancel"
            submitLabel="Add marketplace"
            onCancel={() => {}}
          />
        </Dialog>
      </I18nextProvider>,
    )
  }

  it('renders the three fields (Source / Git ref / Sparse paths) with a default ref', () => {
    const html = addBody()
    expect(html).toContain('data-testid="marketplace-add-source"')
    expect(html).toContain('data-testid="marketplace-add-ref"')
    expect(html).toContain('data-testid="marketplace-add-sparse"')
    // Git ref defaults to "main".
    expect(html).toMatch(/data-testid="marketplace-add-ref"[^>]*value="main"/)
  })

  it('submit starts disabled (Source empty)', () => {
    const html = addBody()
    // The submit button carries a disabled attribute (attr order is not fixed).
    const submitTag = html.match(/<button[^>]*data-testid="marketplace-add-submit"[^>]*>/)?.[0] ?? ''
    expect(submitTag).toContain('disabled')
  })

  it('trims Source and splits Sparse paths per line, empty ref falls back to main', () => {
    // Exercise the pure transform the body applies on submit.
    const parse = (source: string, gitRef: string, sparse: string): MarketplaceAddSubmit => ({
      source: source.trim(),
      gitRef: gitRef.trim() || 'main',
      sparsePaths: sparse.split('\n').map((l) => l.trim()).filter(Boolean),
    })
    expect(parse('  openai/plugins  ', '', 'a\n b \n\nc')).toEqual({
      source: 'openai/plugins',
      gitRef: 'main',
      sparsePaths: ['a', 'b', 'c'],
    })
  })
})

describe('MarketplaceSkillPreviewModal (body)', () => {
  it('renders SKILL.md content + primary/close footer', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <Dialog open>
          <MarketplaceSkillPreviewBody
            name="ASP.NET Web API"
            description="Design and review APIs."
            content={{ status: 'loaded', markdown: '# Heading\n\nbody' }}
            primaryLabel="Install plugin"
            onPrimary={() => {}}
            closeLabel="Close"
            onClose={() => {}}
          />
        </Dialog>
      </I18nextProvider>,
    )
    expect(html).toContain('data-testid="marketplace-skill-preview"')
    expect(html).toContain('ASP.NET Web API')
    expect(html).toContain('data-testid="content-loaded"')
    expect(html).toContain('data-testid="skill-preview-primary"')
    expect(html).toContain('data-testid="skill-preview-close"')
  })

  // Integration wiring (U5 Step 3): PluginsPage feeds the modal an HONEST empty
  // content state — no SKILL.md is available pre-install (no inline preview in
  // the safe data layer, no renderer-side preview RPC) — and NO primary CTA, so
  // the Codex-faithful single-Close footer renders.
  it('honest pre-install state → empty placeholder + single Close (no primary CTA)', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <Dialog open>
          <MarketplaceSkillPreviewBody
            name="Code Review"
            kindLabel="Skill"
            content={{ status: 'empty', emptyMessage: 'Available after you install it.' }}
            closeLabel="Close"
            onClose={() => {}}
          />
        </Dialog>
      </I18nextProvider>,
    )
    expect(html).toContain('data-testid="content-empty"')
    expect(html).toContain('Available after you install it.')
    // No primary CTA wired → Codex-faithful single quiet Close, no Install.
    expect(html).not.toContain('data-testid="skill-preview-primary"')
    expect(html).toContain('data-testid="skill-preview-close"')
  })

  // UB12.86: the kind label the body supplies itself reads `plugins.kind.skill` (it was the literal "Skill" under
  // every locale); a caller's own kindLabel still wins, and an empty one still hides the span.
  it('kind label: under ru with no kindLabel it renders the ru value; an explicit one wins; empty hides it', async () => {
    const ruI18n = createInstance()
    await ruI18n.use(initReactI18next).init({
      lng: 'ru',
      fallbackLng: 'en',
      resources: { ru: { translation: ruMessages as Record<string, string> }, en: { translation: KEYS } },
      interpolation: { escapeValue: false },
    })
    const ruSkill = (ruMessages as Record<string, string>)['plugins.kind.skill']!
    const body = (kindLabel?: string) => renderToStaticMarkup(
      <I18nextProvider i18n={ruI18n}>
        <Dialog open>
          <MarketplaceSkillPreviewBody
            name="Code Review"
            kindLabel={kindLabel}
            content={{ status: 'empty', emptyMessage: 'x' }}
            closeLabel="Close"
            onClose={() => {}}
          />
        </Dialog>
      </I18nextProvider>,
    )
    const kindSpan = (text: string) => `<span class="ml-2 font-normal text-tertiary">${text}</span>`
    expect(ruSkill).not.toBe('Skill')
    // positive: the label-less body names the kind in Russian, and not in English
    expect(body()).toContain(kindSpan(ruSkill))
    expect(body()).not.toContain(kindSpan('Skill'))
    // negative: the caller's label wins over the locale default
    expect(body('Плагин')).toContain(kindSpan('Плагин'))
    expect(body('Плагин')).not.toContain(kindSpan(ruSkill))
    // boundary: an empty label still hides the span (`??` keeps '', as the old default parameter did)
    expect(body('')).not.toContain('ml-2 font-normal text-tertiary')
  })
})

// PluginsPage's Step-3 detail wiring is a PRESENTATION of the same safe catalog
// item onto the approved MarketplaceDetail: the component inventory is empty
// pre-install and real once installed (via toGroups), and the About panel shows
// the item description or the honest empty state.
describe('MarketplaceDetail integration wiring (U5 Step 3)', () => {
  it('not-installed → honest empty inventory + description About (no fabricated components)', () => {
    const html = render(
      <MarketplaceDetail
        icon={tile}
        name="Linear"
        tagline="Issue tracking via the Linear API."
        breadcrumbParent="Plugins"
        aboutTitle="About"
        content={{ status: 'loaded', markdown: 'Issue tracking via the Linear API.' }}
        componentsSlot={<PluginComponentsSection groups={[]} onOpen={() => {}} />}
        informationTitle="Information"
        information={[{ label: 'Kind', value: 'Plugin' }]}
        informationEmpty="No additional information provided."
      />,
    )
    // Empty (not loading, not fabricated) inventory placeholder.
    expect(html).toContain('data-testid="plugin-components-empty"')
    expect(html).not.toContain('data-testid="plugin-component-row"')
    // Description drives the About panel; Information from safe fields renders.
    expect(html).toContain('data-testid="content-loaded"')
    expect(html).toContain('Kind')
  })

  it('installed → real inventory rows; a skill row is clickable (opens the preview modal / routes)', () => {
    const groups = toGroups([
      { kind: 'skill', name: 'Code Review', description: 'Adversarial review.', capabilityKey: 'skill:code-review' },
      { kind: 'hook', name: 'pre-tool-lint', description: 'Lints staged edits.' },
    ])
    const html = render(
      <MarketplaceDetail
        icon={tile}
        name="DevTools Suite"
        breadcrumbParent="Plugins"
        aboutTitle="About"
        content={{ status: 'empty', emptyMessage: 'No description available for this item.' }}
        componentsSlot={<PluginComponentsSection groups={groups} onOpen={() => {}} />}
        informationTitle="Information"
        information={[{ label: 'Kind', value: 'Plugin' }]}
        informationEmpty="No additional information provided."
      />,
    )
    expect(html).toContain('data-testid="plugin-component-row"')
    expect(html).toContain('Code Review')
    // The skill row carries a capabilityKey → clickable (routes/opens modal);
    // rendered as role=button so PluginsPage's onOpen can fire.
    expect(html).toContain('role="button"')
  })
})
