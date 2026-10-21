/**
 * U4 PluginComponentsSection — Codex plugin-detail IA adapted to our
 * components: a section per kind with a count, per-component switches,
 * collapse after 5, loading/empty placeholders (placeholder-not-hidden).
 *
 * Imported directly (not via the info barrel) so this test does not
 * transitively pull Info_Markdown → pdfjs-dist worker URLs.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PluginComponentsSection,
  type PluginComponentGroup,
  type PluginComponentKind,
} from '@/components/info/PluginComponentsSection'

const KEYS = [
  'pluginDetail.componentsTitle', 'pluginDetail.componentsEmpty',
  'pluginDetail.componentsSkills', 'pluginDetail.componentsHooks',
  'pluginDetail.componentsConnectors', 'pluginDetail.componentsMcpServers',
  'pluginDetail.componentsCommands', 'pluginDetail.componentsApps',
  'pluginDetail.componentCapabilityDisabled',
  'pluginDetail.componentsUndeclared', 'pluginDetail.componentsDeclaredLead',
  'pluginDetail.componentsDeclaredNote', 'pluginDetail.componentsLspServers',
  'pluginDetail.componentsAgents', 'pluginDetail.componentsWorkflows',
]

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          ...Object.fromEntries(KEYS.map((k) => [k, k])),
          'pluginDetail.componentToggleLabel': 'Toggle {{name}}',
          'pluginDetail.componentsShowMore': 'Show {{count}} more',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
})

function render(groups?: PluginComponentGroup[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PluginComponentsSection groups={groups} onOpen={() => {}} onToggle={() => {}} />
    </I18nextProvider>,
  )
}

const skills = (n: number): PluginComponentGroup => ({
  kind: 'skill',
  items: Array.from({ length: n }, (_, i) => ({
    key: `skill:${i}`,
    name: `Skill ${i}`,
    description: `Does thing ${i}.`,
    clickable: true,
    toggle: { capabilityId: `c-skill-${i}`, enabled: i % 2 === 0 },
  })),
})

describe('PluginComponentsSection', () => {
  it('renders one section per present kind with a count, rows, and switches', () => {
    const html = render([
      skills(2),
      { kind: 'hook', items: [{ key: 'h1', name: 'pre-tool-lint', description: 'PreToolUse.' }] },
      { kind: 'connector', items: [] }, // empty group omitted
    ])
    expect(html).toContain('pluginDetail.componentsSkills')
    expect(html).toContain('pluginDetail.componentsHooks')
    expect(html).not.toContain('pluginDetail.componentsConnectors')
    expect((html.match(/data-testid="plugin-component-row"/g) ?? []).length).toBe(3)
    // Switches only on rows that carry enablement (skills here, not the hook).
    expect((html.match(/data-testid="plugin-component-toggle"/g) ?? []).length).toBe(2)
    expect(html).toContain('aria-label="Toggle Skill 0"')
    expect(html).toContain('aria-label="Toggle Skill 1"')
  })

  it('renders a disabled row dimmed with its reason line', () => {
    const html = render([{
      kind: 'mcp',
      items: [{
        key: 'mcp:fs',
        name: 'FS',
        description: 'Filesystem server.',
        toggle: { capabilityId: 'c-mcp', enabled: false },
        dimmed: true,
        disabledReasonKey: 'pluginDetail.componentCapabilityDisabled',
      }],
    }])
    expect(html).toContain('data-testid="plugin-component-disabled-reason"')
    expect(html).toContain('pluginDetail.componentCapabilityDisabled')
    // UB14.59: the name carries the state on the tertiary role (AA); no text is faded to 50%.
    expect(html).toContain('<span class="block truncate font-medium text-tertiary">FS</span>')
    expect(html).not.toContain('opacity-50')
  })

  it('UB14.59 control: an enabled row keeps its name on the foreground role; only a dimmed icon is 50%', () => {
    const html = render([{
      kind: 'skill',
      items: [
        { key: 'skill:on', name: 'On', icon: <i data-icon="on" /> },
        { key: 'skill:off', name: 'Off', icon: <i data-icon="off" />, dimmed: true },
      ],
    }])
    expect(html).toContain('<span class="block truncate font-medium text-foreground">On</span>')
    expect(html).toContain('<span class="block truncate font-medium text-tertiary">Off</span>')
    expect(html).toContain('<span class="shrink-0 opacity-50"><i data-icon="off"></i></span>')
    expect(html).toContain('<span class="shrink-0"><i data-icon="on"></i></span>')
    // The per-kind count is Info_Section's own (tertiary, tabular) beside the title.
    expect(html).toContain('tabular-nums">2</span>')
  })

  it('collapses long groups after 5 rows behind a Show-more expander', () => {
    const html = render([skills(8)])
    expect((html.match(/data-testid="plugin-component-row"/g) ?? []).length).toBe(5)
    expect(html).toContain('data-testid="plugin-components-more"')
    expect(html).toContain('Show 3 more')
  })

  it('loading (groups undefined) and empty inventory keep the surface (placeholder-not-hidden)', () => {
    expect(render(undefined)).toContain('data-testid="plugin-components-loading"')
    const empty = render([])
    expect(empty).toContain('data-testid="plugin-components-empty"')
    expect(empty).toContain('pluginDetail.componentsTitle')
  })
})

/**
 * D1 — the two emptinesses. A listing's silence is not an empty plugin, because
 * both loaders auto-discover from default directories when the manifest is
 * silent (`plugins-reference.md` § Plugin manifest schema). The installed
 * sentence must never appear on a listing, and the listing sentence must never
 * appear on an installed bundle.
 */
function renderListing(props: {
  declaredKinds?: PluginComponentKind[]
  declaredPending?: boolean
} = {}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PluginComponentsSection groups={[]} source="listing" {...props} />
    </I18nextProvider>,
  )
}

describe('PluginComponentsSection — declared vs measured (D1)', () => {
  it('a listing that declares nothing says so, and never says the plugin ships nothing', () => {
    const html = renderListing()
    expect(html).toContain('data-testid="plugin-components-undeclared"')
    expect(html).toContain('pluginDetail.componentsUndeclared')
    expect(html).not.toContain('pluginDetail.componentsEmpty')
    expect(html).not.toContain('data-testid="plugin-components-empty"')
  })

  it('an INSTALLED bundle with an empty inventory keeps the measured sentence', () => {
    const html = render([])
    expect(html).toContain('data-testid="plugin-components-empty"')
    expect(html).not.toContain('pluginDetail.componentsUndeclared')
  })

  it('renders the kinds a listing declares — with no count anywhere', () => {
    const html = renderListing({ declaredKinds: ['skill', 'mcp', 'lsp'] })
    expect(html).toContain('data-testid="plugin-components-declared"')
    expect((html.match(/data-testid="plugin-components-declared-kind"/g) ?? []).length).toBe(3)
    expect(html).toContain('pluginDetail.componentsSkills')
    expect(html).toContain('pluginDetail.componentsMcpServers')
    expect(html).toContain('pluginDetail.componentsLspServers')
    expect(html).toContain('pluginDetail.componentsDeclaredLead')
    expect(html).toContain('pluginDetail.componentsDeclaredNote')
    // A declaration is a set of PATHS: it can never justify a number.
    expect(html).toContain('pluginDetail.componentsTitle')
    expect(html).not.toMatch(/tabular-nums/)
    expect(html).not.toContain('data-testid="plugin-component-row"')
  })

  it('shows the skeleton while the declaration is still being resolved, never a claim', () => {
    const html = renderListing({ declaredPending: true })
    expect(html).toContain('data-testid="plugin-components-loading"')
    expect(html).not.toContain('pluginDetail.componentsUndeclared')
    expect(html).not.toContain('pluginDetail.componentsEmpty')
  })
})
