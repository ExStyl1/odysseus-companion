/**
 * UB14.57 (R2-13; upstream v0.15.1 `SourcesListPanel.tsx`, `SkillsListPanel.tsx`, `ui/entity-panel.tsx`) — the
 * Sources and Skills list rows on the row anatomy.
 *
 * Before the row, a Sources row was `name` over a badge strip (the coloured category badge, then the
 * description) and a source whose last `source_test` FAILED read exactly like a healthy one on its line 2 — the
 * pip alone (UB14.48) carried the verdict. v0.15.1 puts the type in the title line's trailing meta and gives line
 * 2 to a non-connected state, in its status colour, with the stored connection error as its tooltip.
 *
 * Instrument. The two panels cannot load under `bun test` — measured 2026-10-16: importing either throws
 * `Missing 'default' export in module '…/pdfjs-dist/build/pdf.worker.min.mjs?url'` (the barrel trap
 * `source-card.test.tsx` documents). So the rows are driven through the SAME call the Sources panel makes
 * (`sourceCardSlots(source, t, sourceRowConnection(source, localMcpEnabled))`) into the REAL `EntityRow`, the
 * wiring is read from each panel's source, and the playground entries (the design surface) are rendered with the
 * real English locale.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { EntityRow } from '@/components/ui/entity-row'
import { TooltipContent, TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { sourceCardSlots, sourceRowConnection, SOURCE_ROW_STATUS } from '../SourceCardBadges'
import { entityListComponents } from '@/playground/registry/entity-lists'

const APP_SHELL = join(import.meta.dir, '..')
const read = (relative: string) => readFileSync(join(APP_SHELL, relative), 'utf8')
const en = JSON.parse(readFileSync(
  join(import.meta.dir, '../../../../../../../packages/shared/src/i18n/locales/en.json'), 'utf8',
)) as Record<string, string>

let i18n: I18nInstance
beforeAll(async () => {
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

const t = (key: string) => i18n.t(key)
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)

const DESCRIPTION = 'Repositories, issues and pull requests'
const ERROR = 'MCP connection failed: HTTP 502 Bad Gateway from https://mcp.github.example'

function source(partial: Partial<SafeCapabilitySummary> = {}): SafeCapabilitySummary {
  return {
    key: 'source:ws_a:github',
    kind: 'source',
    logicalName: 'github',
    sourceType: 'mcp',
    origin: 'native',
    scope: { kind: 'workspace', workspaceId: 'ws_a' },
    state: 'active',
    readOnly: false,
    trustState: 'trusted',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
    description: DESCRIPTION,
    ...partial,
  } as SafeCapabilitySummary
}

/** One Sources-list row, exactly as `SourcesListPanel`'s `sourceListItem` fills it. */
function sourceRow(summary: SafeCapabilitySummary, localMcpEnabled = true): string {
  return render(<EntityRow title="GitHub" {...sourceCardSlots(summary, t, sourceRowConnection(summary, localMcpEnabled))} />)
}

/** The markup of the row's line 2 (the `entity-row-subtitle` slot), or null when the row has none. */
function lineTwo(html: string): string | null {
  const at = html.indexOf('data-slot="entity-row-subtitle"')
  if (at === -1) return null
  return html.slice(at, html.indexOf('</div></div>', at))
}

/** The title line's trailing meta text (the `entity-row-meta` slot). */
function meta(html: string): string | null {
  return html.match(/data-slot="entity-row-meta"[^>]*>(.*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '') ?? null
}

describe('UB14.57 — a Sources row: the category is the meta, line 2 is the state or the description', () => {
  it('POSITIVE — a summary whose stored verdict is failed renders sourcesList.statusDisconnected in destructive text on line 2', () => {
    const html = sourceRow(source({ lastTestStatus: 'failed', connectionError: ERROR }))
    const second = lineTwo(html)
    expect(second).not.toBeNull()
    expect(second!).toContain('data-source-row-status="failed"')
    expect(second!).toContain('text-destructive')
    expect(second!).toContain(`>${en['sourcesList.statusDisconnected']}</span>`)
    // The state REPLACES the description on line 2 (v0.15.1), it does not sit beside it.
    expect(html).not.toContain(DESCRIPTION)
    // The type is the title meta, as plain text — not the coloured badge.
    expect(meta(html)).toBe(en['sourcesList.typeMcp'])
    expect(html).not.toContain('source-category-badge-')
  })

  it('POSITIVE — the stored connection error is line 2\'s tooltip (its own provider, so any host can render it)', () => {
    const slots = sourceCardSlots(source({ lastTestStatus: 'failed', connectionError: `  ${ERROR}  ` }), t,
      sourceRowConnection(source({ lastTestStatus: 'failed', connectionError: `  ${ERROR}  ` }), true))
    const subtitle = slots.subtitle as React.ReactElement<{ children: React.ReactNode }>
    expect(subtitle.type).toBe(TooltipProvider)
    const tooltip = subtitle.props.children as React.ReactElement<{ children: React.ReactNode[] }>
    const content = (tooltip.props.children as React.ReactElement<{ children: React.ReactNode }>[])
      .find(child => child.type === TooltipContent)
    expect(content?.props.children).toBe(ERROR)
  })

  it('NEGATIVE (control) — a connected source renders its description on line 2, and no state', () => {
    const html = sourceRow(source())
    const second = lineTwo(html)
    expect(second).not.toBeNull()
    expect(second!).toContain(DESCRIPTION)
    expect(second!).toContain('data-testid="source-card-description"')
    expect(html).not.toContain('data-source-row-status')
    expect(meta(html)).toBe(en['sourcesList.typeMcp'])
  })

  it('boundary — no stored error: the state has no tooltip wrapper; no description and connected: no line 2 at all', () => {
    const authSlots = sourceCardSlots(source({ credentialState: 'missing' }), t, sourceRowConnection(source({ credentialState: 'missing' }), true))
    expect((authSlots.subtitle as React.ReactElement).type).toBe('span')
    const bare = sourceRow(source({ description: undefined }))
    expect(lineTwo(bare)).toBeNull()
    expect(meta(bare)).toBe(en['sourcesList.typeMcp'])
  })

  it('every non-connected status takes v0.15.1\'s label and colour; the shared verdict feeds it (P6.769 local MCP off)', () => {
    const cases: Array<[SafeCapabilitySummary, boolean, string, string, string]> = [
      [source({ credentialState: 'missing' }), true, 'needs_auth', 'sourcesList.statusAuthRequired', 'text-info'],
      [source({ state: 'review-required' }), true, 'untested', 'sourcesList.statusNotTested', 'text-tertiary'],
      [source({ mcpTransport: 'stdio' }), false, 'local_disabled', 'sourcesList.statusDisabled', 'text-tertiary'],
      [source({ state: 'disabled' }), true, 'disabled', 'sourcesList.statusDisabled', 'text-tertiary'],
    ]
    for (const [summary, localMcpEnabled, status, labelKey, textClass] of cases) {
      const second = lineTwo(sourceRow(summary, localMcpEnabled))!
      expect(second).toContain(`data-source-row-status="${status}"`)
      expect(second).toContain(textClass)
      expect(second).toContain(`>${en[labelKey]}</span>`)
    }
    // The same stdio server with local MCP on is connected again: the setting is the cause, not the transport.
    expect(lineTwo(sourceRow(source({ mcpTransport: 'stdio' }), true))).toContain(DESCRIPTION)
    expect(SOURCE_ROW_STATUS.connected).toBeNull()
  })

  it('a skill row in the Sources list keeps the ONE card\'s content: the "Skill" meta and its description on line 2', () => {
    const html = render(<EntityRow title="Commit" {...sourceCardSlots(source({ kind: 'skill', sourceType: undefined }), t)} />)
    expect(meta(html)).toBe(en['sourcesList.typeSkill'])
    expect(lineTwo(html)).toContain(DESCRIPTION)
  })
})

/**
 * UB12.75 — our `untested` bucket is wider than upstream's (rule 4 of `capabilitySummaryConnectionStatus`), and
 * since UB14.57 line 2 prints it: a source the user switched off read "Not Tested" where its description used to be.
 * `capabilitySummaryDisplayStatus` takes `state: 'disabled'` back out of the bucket, and ONLY out of the bucket.
 */
describe('UB12.75 — a source the user switched off reads Disabled on line 2, not Not Tested', () => {
  it('POSITIVE — a `state: \'disabled\'` summary (a switched-off dp or plugin MCP) prints sourcesList.statusDisabled in tertiary text', () => {
    const second = lineTwo(sourceRow(source({ state: 'disabled', credentialState: 'ready' })))!
    expect(second).toContain('data-source-row-status="disabled"')
    expect(second).toContain('text-tertiary')
    expect(second).toContain(`>${en['sourcesList.statusDisabled']}</span>`)
    expect(second).not.toContain(en['sourcesList.statusNotTested'])
    expect(second).not.toContain(DESCRIPTION)
  })

  it('NEGATIVE (control) — a never-tested row that is not switched off keeps Not Tested (the rest of rule 4\'s bucket)', () => {
    for (const state of ['review-required', 'shadowed', 'unsupported-runtime'] as const) {
      const second = lineTwo(sourceRow(source({ state })))!
      expect(second, state).toContain('data-source-row-status="untested"')
      expect(second, state).toContain(`>${en['sourcesList.statusNotTested']}</span>`)
    }
  })

  it('boundary — a switched-off source with a stronger verdict keeps it: failed (UB14.48), needs auth (rule 1), local MCP off (P6.769)', () => {
    const failed = lineTwo(sourceRow(source({ state: 'disabled', lastTestStatus: 'failed', connectionError: ERROR })))!
    expect(failed).toContain('data-source-row-status="failed"')
    expect(failed).toContain(`>${en['sourcesList.statusDisconnected']}</span>`)
    expect(lineTwo(sourceRow(source({ state: 'disabled', credentialState: 'missing' })))!)
      .toContain('data-source-row-status="needs_auth"')
    expect(lineTwo(sourceRow(source({ state: 'disabled', mcpTransport: 'stdio' }), false))!)
      .toContain('data-source-row-status="local_disabled"')
  })
})

describe('UB14.57 — the panels make exactly these calls (read from source: neither panel loads under bun)', () => {
  const sources = read('SourcesListPanel.tsx')
  const skills = read('SkillsListPanel.tsx')
  const panel = readFileSync(join(import.meta.dir, '../../ui/entity-panel.tsx'), 'utf8')

  it('Sources: both row kinds fill their slots from the ONE card; the source row passes its verdict; no badge strip is left', () => {
    expect(sources).toContain('...sourceCardSlots(source, options.t, sourceRowConnection(source, options.localMcpEnabled)),')
    expect(sources).toContain('...sourceCardSlots(row.item, t),')
    expect(sources).not.toMatch(/\bbadges\s*:/)
    // P6.769 Keep: the pip still renders beside line 2.
    expect(sources).toMatch(/<SourceAvatar[^>]*showStatus localMcpEnabled=\{/)
  })

  it('Skills: "project" as the meta keyed on OUR capability scope, the description as line 2, no badge strip', () => {
    expect(skills).toContain("titleTrailing: skill.scope.kind === 'project' ? t('skillsList.projectBadge') : undefined,")
    expect(skills).toContain('subtitle: skillRussianDescription(skill) || undefined,')
    expect(skills).not.toMatch(/\bbadges\s*:/)
    expect(en['skillsList.projectBadge']).toBe('project')
  })

  it('EntityPanel passes the three anatomy slots through to EntityRow (v0.15.1, div 0)', () => {
    for (const slot of ['titleTrailing', 'subtitle', 'subtitleTrailing']) {
      expect(panel).toContain(`${slot}={mapped.${slot}}`)
    }
    // The deprecated prop is no longer passed (the header names it, so the PROP is what is asserted).
    expect(panel).not.toContain('showSeparator=')
  })

  it('both empty states offer Add on the secondary Button, not the hand-rolled pill', () => {
    for (const file of [sources, skills]) {
      expect(file).toContain('<Button variant="secondary">')
      expect(file).not.toContain('rounded-[8px] bg-background shadow-minimal')
    }
    expect(read('ProjectsListPanel.tsx')).toContain('h-control px-2.5 text-label font-medium rounded-md bg-raised shadow-elev-1 state-overlay motion-press')
  })
})

describe('UB14.57 — the playground entries draw these states (the design surface)', () => {
  const entry = (id: string) => {
    const found = entityListComponents.find(component => component.id === id)
    if (!found) throw new Error(`no playground entry ${id}`)
    return found
  }
  const renderEntry = (id: string, props: Record<string, unknown>) => {
    const component = entry(id)
    const defaults = Object.fromEntries(component.props.map(prop => [prop.name, prop.defaultValue]))
    const Preview = component.component as React.ComponentType<Record<string, unknown>>
    return render(<div className="dark"><Preview {...defaults} {...props} /></div>)
  }

  it('Source List · All Sources: every line-2 state, and the description on the connected rows', () => {
    const variant = entry('entity-list-sources').variants?.find(v => v.name === 'All Sources')
    const html = renderEntry('entity-list-sources', variant!.props)
    for (const status of ['needs_auth', 'failed', 'untested', 'local_disabled', 'disabled']) {
      expect(html).toContain(`data-source-row-status="${status}"`)
    }
    // UB12.75: the switched-off sample says so, in the same words the Sources list prints.
    expect(html).toMatch(new RegExp(`data-source-row-status="disabled"[^>]*>${en['sourcesList.statusDisabled']}<`))
    expect(html).toContain('Repositories, issues, and pull requests')
    // UB12.74: the Plugin and Hook rows took the same slots when their subsections did — no badge form is left.
    expect(html).toContain('data-testid="source-card-meta-plugin"')
    expect(html).toContain('data-testid="source-card-meta-hook"')
    expect(html).not.toContain('source-category-badge-')
  })

  it('Source List · Skills subsection, and the Skills list: the two skill metas', () => {
    const sub = renderEntry('entity-list-sources', { typeFilter: 'skill' })
    expect(sub.match(/data-testid="source-card-meta-skill"/g)?.length).toBe(4)
    const list = renderEntry('entity-list-skills', {})
    // One project skill in the sample: exactly one "project" meta; the others carry none.
    expect(list.match(/data-slot="entity-row-meta"/g)?.length).toBe(1)
    expect(meta(list)).toBe(en['skillsList.projectBadge'])
    expect(list).toContain('Create well-structured git commits with conventional messages')
  })
})
