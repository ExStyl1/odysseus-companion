/**
 * The ONE Sources card, ONCE PER SUBSECTION (owner decisions 2026-08-01, both
 * from driving the running app).
 *
 * The card is: the status-bearing icon, the name, ONE category, and the
 * description (since UB12.74 everywhere on v0.15.1's row anatomy: the category
 * the title meta, the description line 2). The description half is a CORRECTION — the
 * first pass dropped it from Sources and Skills while the MCP subsection kept
 * rendering it, so the same server read differently one click apart. The gate
 * that asserted its ABSENCE is therefore REPLACED here, not deleted: every arm
 * below now asserts the description is PRESENT, and the provenance assertions
 * (second "Plugin" badge, acquisition pill) stay exactly as they were, because
 * those are still ruled off the card.
 *
 * WHY ONE ARM PER SUBSECTION rather than one shared helper test: the failure
 * this file exists to catch is "one panel drifts". A single test over
 * the card cannot see a panel that stops using it. So each of the
 * seven Sources subsections gets its own arm, driven by the closest production
 * artifact bun can load:
 *
 *   MCPs   → the real `McpServersPanel`, rendered.
 *   Hooks  → the real `ProjectHooksList`, rendered.
 *   Plugins→ the real `SourcesManagementRow` fed by the REAL projection the
 *            subsection uses (`pluginRowSummary`, `plugin-management-rows.ts`).
 *   Sources / APIs / Local Folders / Skills → the card's slots on the real
 *            `EntityRow`, fed by the row each subsection passes, PLUS a wiring
 *            arm that reads the panel source, because those panels cannot be
 *            rendered at all.
 *
 * The unrenderable panels are unrenderable for a MEASURED reason: importing
 * `SourcesListPanel` / `SkillsListPanel` throws `Missing 'default' export in
 * module '…/pdfjs-dist/build/pdf.worker.min.mjs?url'` (re-measured by UB14.57,
 * `list-panel-row-anatomy.test.tsx`). `EntityRow` itself loads. The wiring arms
 * are the honest substitute, and they are worth having: a panel that hand-rolls
 * its own row is exactly the regression the owner reported twice.
 *
 * Mutation probe (the gate's own): delete the description from ONE subsection —
 * e.g. hard-code `description: undefined` in `McpServersPanel`'s
 * `sourceCardSlots` call — and the MCPs arm goes red while Hooks, Plugins and
 * the rest stay green.
 *
 * UB14.57 (v0.15.1 row anatomy, owner 2026-10-14 "redesign 1:1"): the aggregate
 * Sources list (and its APIs / Local Folders / Skills filters) fills
 * `EntityRow`'s `titleTrailing` / `subtitle` from the SAME card
 * (`sourceCardSlots`): the category is the title meta and the description line
 * 2. The Skills NAVIGATOR list is no longer a card surface: it takes v0.15.1's
 * own anatomy ("project" meta, the description), `list-panel-row-anatomy.test.tsx`.
 *
 * UB12.74: the MCPs, Plugins and Hooks subsections take the same slots, and the
 * coloured badge form (`SourceCardBadges`, `SourceCategoryBadge`, the
 * per-category palette) is RETIRED with its arms. Every arm below now reads the
 * slots: the meta names ONE category, line 2 holds the description — or, on the
 * three subsections, the row's own statement in its place, the line-2 rule the
 * aggregate applies to a connection verdict. The card's CONTENT is unchanged:
 * one category, never plural, never absent, the description, no provenance.
 * The MCPs, Plugins and Hooks arms now render the real rows (`EntityRow` and
 * `SourcesManagementRow` load under bun since UB14.57 / P6.844).
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilitySummary, UserCapabilityCatalog } from '@nessy-agent/shared/protocol/capabilities'
import { SOURCE_CATEGORY_BADGE, sourceCategoryFor, type SourceCardRow } from '@/lib/source-card'
import type { SafeSkillRow, SafeSourceRow } from '@/lib/capability-catalog'
import { pluginRowSummary } from '../plugin-management-rows'
import { McpServersPanel } from '../McpServersPanel'
import { ProjectHooksList } from '@/components/sources/ProjectHooksPanel'
import { SourcesManagementRow } from '@/components/info/SourcesManagementRow'
import { EntityRow } from '@/components/ui/entity-row'
import { sourceCardSlots } from '../SourceCardBadges'
import { mcpServersPanelComponents } from '@/playground/registry/mcp-servers-panel'
import { sourcesManagementComponents } from '@/playground/registry/sources-management'
import { entityListComponents } from '@/playground/registry/entity-lists'
import type { ComponentEntry } from '@/playground/registry/types'

const DESCRIPTION = 'Repositories, issues and pull requests'

const translations = {
  'sourcesList.typeApi': 'API',
  'sourcesList.typeHook': 'Hook',
  'sourcesList.typeLocal': 'Local',
  'sourcesList.typeMcp': 'MCP',
  'sourcesList.typeSkill': 'Skill',
  'sourcesList.pluginBadge': 'Plugin',
  // The labels the OLD card also rendered. Registered here on purpose: if the
  // second plugin badge or the acquisition pill comes back, its text lands in
  // the markup and the arms below catch it. An unregistered key would render as
  // the key and still be caught, but registering them is the honest
  // reproduction of the old row.
  'skillsList.pluginBadge': 'plugin badge',
  'plugins.origin.acquisition.externalMarketplace': 'External marketplace',
  'plugins.origin.format.claude': 'Claude',
  // The MCP subsection's own strings. The origin/transport/auth BADGES were
  // removed 2026-08-01 (badge parity), and these stay registered on purpose:
  // if one comes back its text lands in the markup and the arms below catch it.
  'mcpServers.authNeeded': 'Sign in required',
  'mcpServers.empty': 'No MCP servers',
  'mcpServers.emptyDescription': 'Nothing yet.',
  'mcpServers.originBuiltin': 'Built-in',
  'mcpServers.originUser': 'User',
  'mcpServers.stateDisabled': 'Disabled',
  'mcpServers.stateEnabled': 'Enabled',
  'mcpServers.toggleAria': 'Enable server',
  'sourcesHooks.noDescription': 'No description provided.',
  'sourcesHooks.toggleLabel': 'Toggle {{name}}',
  'sourcesManagement.awaitingAuth': 'Awaiting sign-in',
  'plugins.updateAvailable': 'Update available: {{version}}',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

function summary(
  partial: Partial<SafeCapabilitySummary> & Pick<SafeCapabilitySummary, 'key' | 'kind' | 'logicalName'>,
): SafeCapabilitySummary {
  return {
    origin: 'native',
    scope: { kind: 'workspace', workspaceId: 'ws_a' },
    state: 'active',
    readOnly: false,
    trustState: 'trusted',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
    // The description the card MUST render, and the provenance it must not.
    description: DESCRIPTION,
    presentation: { format: 'claude', acquisition: 'external-marketplace' },
    ...partial,
  } as SafeCapabilitySummary
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

const t = (key: string) => testI18n.t(key)

/** The title line's trailing meta text (the `entity-row-meta` slot) of the FIRST row in `html`. */
function metaText(html: string): string | null {
  return html.match(/data-slot="entity-row-meta"[^>]*>(.*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '') ?? null
}

/**
 * The markup of the first row's line 2 (the `entity-row-subtitle` slot, balanced to its own closing `</div>` —
 * the icon spacer inside it nests divs of its own), or null when it has none.
 */
function lineTwo(html: string): string | null {
  const at = html.lastIndexOf('<div', html.indexOf('data-slot="entity-row-subtitle"'))
  if (html.indexOf('data-slot="entity-row-subtitle"') === -1 || at === -1) return null
  const tag = /<div\b|<\/div>/g
  tag.lastIndex = at
  let depth = 0
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1
    if (depth === 0) return html.slice(at, match.index + match[0].length)
  }
  return html.slice(at)
}

const MCP_SOURCE = summary({
  key: 'source:ws_a:github', kind: 'source', logicalName: 'github', sourceType: 'mcp',
}) as SafeSourceRow
const API_SOURCE = summary({
  key: 'source:ws_a:linear', kind: 'source', logicalName: 'linear', sourceType: 'api',
}) as SafeSourceRow
const LOCAL_SOURCE = summary({
  key: 'source:ws_a:files', kind: 'source', logicalName: 'files', sourceType: 'local',
}) as SafeSourceRow
const BUILTIN_MCP = summary({
  key: 'builtin:mcp:dpJira', kind: 'mcp', logicalName: 'dpJira', origin: 'builtin',
  scope: { kind: 'builtin' },
}) as SafeSourceRow
const PLUGIN_MCP = summary({
  key: 'plugin:mk#mcp.tracker', kind: 'mcp', logicalName: 'tracker', origin: 'plugin', readOnly: true,
}) as SafeSourceRow
const PLUGIN_SKILL = summary({
  key: 'skill:ws_a:commit', kind: 'skill', logicalName: 'commit', origin: 'plugin', readOnly: true,
}) as SafeSkillRow
const PROJECT_HOOK = summary({
  key: 'hook::project::ws_a::p::.nessy/hooks.json', kind: 'hook', logicalName: 'PreToolUse',
  displayName: 'Pre tool use', scope: { kind: 'project', workspaceId: 'ws_a', projectKey: `p_${'a'.repeat(32)}` },
})

const PLUGIN = {
  pluginKey: 'mk.figma',
  name: 'Figma',
  presentation: { format: 'codex' as const, acquisition: 'external-marketplace' as const },
  activation: { effective: 'active' as const, global: 'unset' as const, workspace: 'enabled' as const },
}
const pluginSummary = () => pluginRowSummary(PLUGIN as Parameters<typeof pluginRowSummary>[0])

describe('the card category', () => {
  it('is the row kind, never its provenance — a plugin MCP is still MCP', () => {
    expect(sourceCategoryFor(MCP_SOURCE)).toBe('mcp')
    expect(sourceCategoryFor(API_SOURCE)).toBe('api')
    expect(sourceCategoryFor(LOCAL_SOURCE)).toBe('local')
    expect(sourceCategoryFor(BUILTIN_MCP)).toBe('mcp')
    expect(sourceCategoryFor(PLUGIN_MCP)).toBe('mcp')
    expect(sourceCategoryFor(PLUGIN_SKILL)).toBe('skill')
    expect(sourceCategoryFor(PROJECT_HOOK)).toBe('hook')
    // The Plugins subsection's own projection, not a hand-made fixture.
    expect(sourceCategoryFor({ kind: 'app' })).toBe('plugin')
  })

  it('covers every subsection — six categories, no "unknown" label to design', () => {
    expect(Object.keys(SOURCE_CATEGORY_BADGE).sort())
      .toEqual(['api', 'hook', 'local', 'mcp', 'plugin', 'skill'])
  })

  it('UB12.74 — the meta carries a LABEL and nothing else: the coloured badge and its palette are retired', () => {
    for (const config of Object.values(SOURCE_CATEGORY_BADGE)) expect(Object.keys(config)).toEqual(['labelKey'])
    // Positive control on the same table: every label resolves in the card's own words.
    expect(Object.values(SOURCE_CATEGORY_BADGE).map(config => t(config.labelKey)).sort())
      .toEqual(['API', 'Hook', 'Local', 'MCP', 'Plugin', 'Skill'])
  })
})

// ---------------------------------------------------------------------------
// The slots — every row kind of every subsection
// ---------------------------------------------------------------------------

const CARD_ROWS: Array<[string, SourceCardRow, string]> = [
  ['an MCP source', MCP_SOURCE, 'MCP'],
  ['a built-in MCP', BUILTIN_MCP, 'MCP'],
  ['a plugin MCP', PLUGIN_MCP, 'MCP'],
  ['an API', API_SOURCE, 'API'],
  ['a local folder', LOCAL_SOURCE, 'Local'],
  ['a skill', PLUGIN_SKILL, 'Skill'],
  ['a plugin package', { ...pluginSummary(), description: DESCRIPTION }, 'Plugin'],
  ['a project hook', PROJECT_HOOK, 'Hook'],
]

describe('on the row anatomy the card keeps its content: ONE category as the meta, the description on line 2', () => {
  for (const [name, row, label] of CARD_ROWS) {
    it(`${name}: the meta names the category, line 2 is the description`, () => {
      const markup = render(<EntityRow title="Row" {...sourceCardSlots(row, t)} />)
      expect(metaText(markup)).toBe(label)
      const lineTwoAt = markup.indexOf('data-slot="entity-row-subtitle"')
      expect(lineTwoAt).toBeGreaterThan(-1)
      expect(markup.indexOf(DESCRIPTION)).toBeGreaterThan(lineTwoAt)
      // Still exactly one category, and still no provenance.
      expect(markup.match(/data-testid="source-card-meta-/g)?.length).toBe(1)
      expect(markup).not.toContain('plugin badge')
      expect(markup).not.toContain('External marketplace')
    })
  }

  it('renders no line 2 at all when the row has no description (and no statement)', () => {
    const markup = render(<EntityRow title="Row" {...sourceCardSlots({ kind: 'source', sourceType: 'api' }, t)} />)
    expect(metaText(markup)).toBe('API')
    expect(lineTwo(markup)).toBeNull()
  })
})

/**
 * The panels bun cannot render. Their arm is that the slot is the SHARED card
 * handed the WHOLE row — which is the only way the description can reach the
 * markup, and the only shape the arms above prove.
 */
describe('the aggregate Sources list fills its row slots with the shared card (UB14.57)', () => {
  it('both row kinds spread sourceCardSlots over the WHOLE row, and no badge strip is left', () => {
    const source = readFileSync(fileURLToPath(new URL('../SourcesListPanel.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('...sourceCardSlots(row.item, t)')
    expect(source).toContain('...sourceCardSlots(source, options.t, sourceRowConnection(')
    expect(source).not.toMatch(/badges[=:]/)
  })
})

// ---------------------------------------------------------------------------
// UB12.74 — the three subsections whose rows carry a right-edge control
// ---------------------------------------------------------------------------

function mcpCatalog(credentialState: SafeCapabilitySummary['credentialState'] = 'not-required'):
  Pick<UserCapabilityCatalog, 'installedPlugins' | 'capabilities'> {
  return {
    installedPlugins: [],
    capabilities: [summary({
      key: 'source:ws_a:codeSearch', kind: 'source', logicalName: 'codeSearch',
      sourceType: 'mcp', mcpTransport: 'stdio', origin: 'native', credentialState,
      description: 'Tool for searching code',
    })],
  }
}

const mcpPanel = (credentialState?: SafeCapabilitySummary['credentialState']) =>
  render(<McpServersPanel catalog={mcpCatalog(credentialState)} onToggleServer={() => {}} />)
const hooksList = (hook: SafeCapabilitySummary = { ...PROJECT_HOOK, description: 'Lints staged edits' }) =>
  render(<ProjectHooksList hooks={[hook]} pendingKeys={new Set()} onSetEnabled={() => {}} />)
const pluginsRow = (props: Partial<React.ComponentProps<typeof SourcesManagementRow>> = {}) => render(
  <SourcesManagementRow
    summary={{ ...pluginSummary(), description: DESCRIPTION }}
    displayName="Figma"
    avatar={<span data-testid="mock-avatar" />}
    enablement={{ enabled: true, scope: 'workspace' }}
    {...props}
  />,
)

describe('UB12.74 — MCPs, Plugins and Hooks take the ONE card\'s anatomy slots', () => {
  it('POSITIVE — the MCP subsection row\'s entity-row-meta reads MCP and line 2 holds the description, as the aggregate row does', () => {
    const html = mcpPanel()
    expect(metaText(html)).toBe('MCP')
    expect(lineTwo(html)).toContain('Tool for searching code')
    // Content parity with the aggregate Sources row for this same server, built
    // from the aggregate's own row shape (`kind: 'source'` + `sourceType: 'mcp'`),
    // so this is a genuine cross-panel comparison rather than the same input twice.
    const aggregate = render(<EntityRow title="codeSearch" {...sourceCardSlots(
      { kind: 'source', sourceType: 'mcp', description: 'Tool for searching code' }, t,
    )} />)
    expect(metaText(html)).toBe(metaText(aggregate))
    const text = (markup: string | null) => markup?.replace(/<[^>]+>/g, '')
    expect(text(lineTwo(html))).toBe(text(lineTwo(aggregate)))
  })

  it('POSITIVE — the Plugins row (the subsection\'s own projection) and the Hooks row read the same way', () => {
    const plugins = pluginsRow()
    expect(metaText(plugins)).toBe('Plugin')
    expect(lineTwo(plugins)).toContain(DESCRIPTION)
    const hooks = hooksList()
    expect(metaText(hooks)).toBe('Hook')
    expect(lineTwo(hooks)).toContain('Lints staged edits')
    // The name is still the row title, and the icon still carries the status.
    expect(hooks).toContain('Pre tool use')
    expect(hooks).toContain('aria-label="active"')
  })

  it('NEGATIVE — no source-category-badge- element remains in the three subsections', () => {
    for (const [name, html] of [
      ['MCPs', mcpPanel()], ['MCPs (sign-in marker)', mcpPanel('missing')],
      ['Plugins', pluginsRow()], ['Plugins (notes)', pluginsRow({ updateAvailableVersion: '2.4.0' })],
      ['Hooks', hooksList()],
    ] as const) {
      expect({ name, badge: html.includes('source-category-badge-') }).toEqual({ name, badge: false })
      // Positive control on the same markup: the category IS there, as the meta.
      expect({ name, meta: html.includes('data-slot="entity-row-meta"') }).toEqual({ name, meta: true })
    }
  })

  it('boundary — a row\'s own statement takes line 2 in place of the description; a row without one reads the description', () => {
    // MCPs: the outstanding sign-in (owner 2026-08-01: the row STATES it) is line 2 in its colour.
    const signIn = lineTwo(mcpPanel('missing'))!
    expect(signIn).toContain('data-testid="mcp-server-auth-codeSearch"')
    expect(signIn).toContain('text-info')
    expect(signIn).toContain('Sign in required')
    expect(signIn).not.toContain('Tool for searching code')
    // Plugins: the update note (R83) — and an awaiting-auth note — replace the description the same way.
    const update = lineTwo(pluginsRow({ updateAvailableVersion: '2.4.0' }))!
    expect(update).toContain('data-testid="row-update-available"')
    expect(update).not.toContain(DESCRIPTION)
    expect(lineTwo(pluginsRow({ enablement: { enabled: true, scope: 'workspace', awaitingAuth: true } }))!)
      .toContain('data-testid="row-awaiting-auth"')
    // Hooks carry no statement: a hook with no description keeps saying so (placeholder-not-hidden).
    const { description: _dropped, ...noDescription } = PROJECT_HOOK
    expect(lineTwo(hooksList(noDescription))).toContain('No description provided.')
  })

  it('boundary — the control clearance protects the meta: it sits inside the padded row body, before the right-edge control', () => {
    const cases: Array<[string, string, string, string]> = [
      // A user-created server has no switch of its own: its control area is the read-only state text.
      ['MCPs', mcpPanel(), 'pr-16', '>Enabled</span>'],
      ['Plugins (display-only)', pluginsRow({ enablement: undefined }), 'pr-24', 'data-testid="row-display-only-state"'],
      ['Hooks', hooksList(), 'pr-16', 'data-testid="project-hook-toggle"'],
    ]
    for (const [name, html, clearance, control] of cases) {
      const body = html.search(new RegExp(`class="[^"]*\\b${clearance}\\b`))
      const meta = html.indexOf('data-slot="entity-row-meta"')
      const lineTwoAt = html.indexOf('data-slot="entity-row-subtitle"')
      const controlAt = html.indexOf(control)
      expect({ name, order: [body > -1, body < meta, meta < lineTwoAt, lineTwoAt < controlAt] })
        .toEqual({ name, order: [true, true, true, true] })
    }
  })

  it('the three subsection files fill their rows from the card, and none hand-rolls a badge strip', () => {
    const files: Array<[string, string]> = [
      ['MCPs', '../McpServersPanel.tsx'],
      ['Plugins', '../../info/SourcesManagementRow.tsx'],
      ['Hooks', '../../sources/ProjectHooksPanel.tsx'],
    ]
    for (const [name, relative] of files) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      expect({ name, slots: source.includes('sourceCardSlots(') }).toEqual({ name, slots: true })
      expect({ name, badges: /\bbadges[=:]|<SourceCardBadges|SourceCategoryBadge/.test(source) })
        .toEqual({ name, badges: false })
    }
  })
})

// ---------------------------------------------------------------------------
// Plugins — the subsection's own projection, on the same card
// ---------------------------------------------------------------------------

describe('Plugins subsection', () => {
  it('is a Plugin meta, and the acquisition text is nowhere on the row', () => {
    const rowSummary = pluginSummary()
    const markup = pluginsRow({ summary: rowSummary })
    expect(metaText(markup)).toBe('Plugin')
    // Owner report 2026-08-01: "Figma ⊙ External marketplace" beside the name is
    // gone. `pluginRowSummary` still CARRIES the presentation, so this is the
    // card refusing to render it, not a missing input.
    expect(rowSummary.presentation).toBeDefined()
    expect(markup).not.toContain('External marketplace')
  })

  it('shows the description on line 2 when the plugin has one, and no line 2 when it has none', () => {
    // `SafeInstalledPluginSummary` carries no `description` today, so the live
    // Plugins subsection renders no line 2. The SHAPE is asserted here so that
    // the day the safe summary gains one, it lands on line 2 like every other
    // subsection rather than under the name.
    expect(lineTwo(pluginsRow())).toContain(DESCRIPTION)
    expect(lineTwo(pluginsRow({ summary: pluginSummary() }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MCPs — the real panel
// ---------------------------------------------------------------------------

describe('MCPs subsection', () => {
  const html = () => mcpPanel()

  it('wears the status pip the rest of the card wears', () => {
    expect(html()).toContain('aria-label="active"')
  })

  it('drops the origin, transport and enabled-state badges', () => {
    // These four are what the owner measured as the divergence (`MCP`
    // `Built-in` `stdio` `Disabled` against the aggregate's single `MCP`).
    // They belong on the detail page the row already opens.
    const markup = html()
    expect(markup).not.toContain('>User<')
    expect(markup).not.toContain('>Built-in<')
    expect(markup).not.toContain('>stdio<')
    // Positive control: the category that SURVIVES, so this arm cannot pass by
    // rendering nothing at all.
    expect(markup).toContain('>MCP<')
  })

  it('keeps its controls — the card rule never removed a control', () => {
    // The toggle arm lives in `McpServersPanel.test.tsx`; here the fixture's
    // plugin-less row renders the read-only state text. Either way the control
    // is OUTSIDE the row body, which is why the card parity above and this can
    // both hold.
    expect(render(<McpServersPanel catalog={mcpCatalog()} />)).toContain('>Enabled<')
  })
})

// ---------------------------------------------------------------------------
// Hooks — the real list
// ---------------------------------------------------------------------------

describe('Hooks subsection', () => {
  it('keeps its toggle, and keeps saying so when a hook has no description', () => {
    const { description: _dropped, ...noDescription } = PROJECT_HOOK
    const markup = hooksList(noDescription)
    expect(markup).toContain('project-hook-toggle')
    // Placeholder-not-hidden: this list's own rule, and the one difference it
    // keeps from the other subsections — a fallback description, not a
    // different shape.
    expect(markup).toContain('No description provided.')
  })
})

// ---------------------------------------------------------------------------
// The design surface: every playground state the three subsections draw, DARK
// ---------------------------------------------------------------------------

/** Every state an entry opens in (its base state and each variant), rendered in the dark theme. */
function sweep(entry: ComponentEntry): Array<[string, string]> {
  const defaults = Object.fromEntries(entry.props.map(prop => [prop.name, prop.defaultValue]))
  const Preview = entry.component as React.ComponentType<Record<string, unknown>>
  return [['base', {}] as const, ...(entry.variants ?? []).map(variant => [variant.name, variant.props] as const)]
    .map(([name, props]) => [name, render(<div className="dark"><Preview {...defaults} {...props} /></div>)])
}

describe('UB12.74 — the playground states of the three subsections, swept in the dark theme', () => {
  const find = (entries: ComponentEntry[], id: string) => {
    const found = entries.find(entry => entry.id === id)
    if (!found) throw new Error(`no playground entry ${id}`)
    return found
  }

  it('MCP Servers Panel: every state draws the meta on every row and no coloured badge', () => {
    for (const [state, html] of sweep(find(mcpServersPanelComponents, 'mcp-servers-panel'))) {
      const rows = html.match(/data-testid="mcp-server-row-/g)?.length ?? 0
      expect({ state, badge: html.includes('source-category-badge-') }).toEqual({ state, badge: false })
      expect({ state, metas: html.match(/data-testid="source-card-meta-mcp"/g)?.length ?? 0 }).toEqual({ state, metas: rows })
      // Every non-empty state has a line 2 (the description, or the sign-in statement in its place).
      if (rows > 0) expect({ state, lineTwo: html.includes('data-slot="entity-row-subtitle"') }).toEqual({ state, lineTwo: true })
    }
  })

  it('Plugins Subsection List and the Source List\'s Management, Plugin and Hook states: the meta, never the badge', () => {
    const plugins = sweep(find(sourcesManagementComponents, 'entity-list-plugins-subsection'))
    const sourceList = sweep(find(entityListComponents, 'entity-list-sources'))
      .filter(([state]) => ['All Sources', 'Plugin', 'Hook', 'Management'].includes(state))
    expect(sourceList.map(([state]) => state).sort()).toEqual(['All Sources', 'Hook', 'Management', 'Plugin'])
    for (const [state, html] of [...plugins, ...sourceList]) {
      expect({ state, badge: html.includes('source-category-badge-') }).toEqual({ state, badge: false })
    }
    const byState = Object.fromEntries(sourceList)
    expect(byState['Plugin']).toContain('data-testid="source-card-meta-plugin"')
    expect(byState['Hook']).toContain('data-testid="source-card-meta-hook"')
    expect(byState['All Sources']).toContain('data-testid="source-card-meta-plugin"')
    expect(byState['All Sources']).toContain('data-testid="source-card-meta-hook"')
    // The management rows: a note-bearing row prints the note on line 2.
    expect(byState['Management']).toContain('data-testid="row-update-available"')
    expect(byState['Management']).toContain('data-testid="source-card-meta-plugin"')
    const populated = Object.fromEntries(plugins)['Populated']!
    expect(populated.match(/data-testid="source-card-meta-/g)?.length).toBe(4)
  })
})
