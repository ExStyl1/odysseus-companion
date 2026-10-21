import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { ComponentEntry } from '../registry/types'

/*
 * P6.844 — the pdfjs carve-out that stood here is GONE, and with it the three
 * dynamic imports it forced. The row → `SourceAvatar` chain reached the
 * `@nessy-agent/ui` BARREL, whose graph ends at the Vite-only
 * `pdfjs-dist/build/pdf.worker.min.mjs?url` specifier bun cannot resolve;
 * `registry/entity-lists.tsx` was the last such reach in this suite's graph and
 * now takes `Spinner` and the tooltip trio from their own subpaths, so the two
 * `mock.module` stubs and the `DOMMatrix` shim replaced modules nothing here
 * loads any more.
 *
 * The imports are STATIC because the graph's load then happens at file load,
 * outside bun's 5 000 ms per-test timer. This file is the known-failing
 * register's §`sources-management-registry.test.ts` entry — `0 pass / 1 fail`
 * with a `beforeAll` measured between 24.5 s and 95.7 s and ZERO of its cases
 * executed. That entry's remedy was "give the file its own budget once someone
 * takes a quiet-tree reading"; the smaller answer was to stop loading a
 * 250-module barrel it never used.
 */
import { sourcesManagementComponents } from '../registry/sources-management'
import { entityListComponents } from '../registry/entity-lists'
import { SourcesManagementRowList } from '@/components/info/SourcesManagementRowList'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: { 'sourcesList.typeMcp': 'MCP', 'sourcesList.pluginBadge': 'Plugin' } } },
    interpolation: { escapeValue: false },
  })
})

function sourceList() {
  return entityListComponents.find((c) => c.id === 'entity-list-sources')
}
function pluginsList() {
  return sourcesManagementComponents.find((c) => c.id === 'entity-list-plugins-subsection')
}

describe('sources management playground registry (U4 — extends the Source List entry)', () => {
  it('does NOT invent a separate category: everything lives under Entity Lists', () => {
    // Owner direction 2026-07-19: extend the existing Source List entry
    // instead of a new playground section.
    expect(sourcesManagementComponents.map((c) => c.id)).toEqual(['entity-list-plugins-subsection'])
    for (const entry of sourcesManagementComponents) {
      expect(entry.category).toBe('Entity Lists')
    }
    expect(sourceList()?.category).toBe('Entity Lists')
  })

  it('Source List exposes the management knob (menu-only enablement — owner decision)', () => {
    const props = sourceList()?.props ?? []
    expect(props.find((p) => p.name === 'management')?.control.type).toBe('boolean')
    // NO inline-switch affordance knob: enablement lives in the row menu.
    expect(props.find((p) => p.name === 'affordance')).toBeUndefined()
  })

  it('Source List keeps its original knobs/variants AND gains the management variant', () => {
    const props = sourceList()?.props ?? []
    expect(props.find((p) => p.name === 'typeFilter')).toBeDefined()
    expect(props.find((p) => p.name === 'selectedIndex')).toBeDefined()
    const variants = sourceList()?.variants ?? []
    expect(variants.some((v) => v.props.typeFilter === 'all')).toBe(true)
    expect(variants.some((v) => v.props.management === true)).toBe(true)
  })

  it('plugins-subsection entry exposes an empty knob and populated + empty variants', () => {
    const emptyProp = pluginsList()?.props.find((p) => p.name === 'empty')
    expect(emptyProp?.control.type).toBe('boolean')
    const variants = pluginsList()?.variants ?? []
    expect(variants.some((v) => v.props.empty === false)).toBe(true)
    expect(variants.some((v) => v.props.empty === true)).toBe(true)
  })

  it('plugins-subsection entry exposes the selection knob and a Selected variant', () => {
    // The playground is this repo's design surface, so a row state that
    // production can reach must be reachable here too.
    const selectedProp = pluginsList()?.props.find((p) => p.name === 'selectedIndex')
    expect(selectedProp?.control.type).toBe('number')
    const variants = pluginsList()?.variants ?? []
    expect(variants.some((v) => typeof v.props.selectedIndex === 'number' && v.props.selectedIndex >= 0)).toBe(true)
    // …and every canonical state names its selection rather than inheriting a
    // default, so the sweep cannot silently skip one.
    for (const variant of variants) expect(variant.props.selectedIndex).toBeDefined()
  })
})

/**
 * The open plugin's row is highlighted (owner report 2026-08-01: it was not,
 * unlike every sibling list). The list owns the decision, so this drives the
 * REAL `SourcesManagementRowList` and reads `EntityRow`'s own `data-selected`
 * marker — the same attribute the Sources/Skills/Sessions lists set, which is
 * what makes this "the established treatment" rather than a second look.
 *
 * `React.createElement` and not JSX because this file is `.ts`; the pdfjs stubs
 * above are what let the row's import graph load at all under bun.
 */
describe('plugins subsection: the open plugin\'s row is the selected one', () => {
  const summary = (key: string): SafeCapabilitySummary => ({
    key,
    kind: 'mcp',
    logicalName: key,
    origin: 'plugin',
    scope: { kind: 'workspace', workspaceId: 'ws_a' },
    state: 'active',
    readOnly: true,
    trustState: 'trusted',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
  } as SafeCapabilitySummary)

  const render = (selectedId: string | null) =>
    renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n: testI18n },
        React.createElement(SourcesManagementRowList, {
          rows: ['plug-a', 'plug-b', 'plug-c'].map(id => ({
            id,
            summary: summary(id),
            displayName: id,
          })),
          selectedId,
        }),
      ),
    )

  it('marks exactly the open row, and only while one is open', () => {
    const opened = render('plug-b')
    expect(opened.match(/data-selected="true"/g) ?? []).toHaveLength(1)
    // The marked row is `plug-b` and not merely "some row": the attribute sits
    // on the wrapper that opens immediately before that row's own name.
    expect(opened.indexOf('data-selected="true"')).toBeLessThan(opened.indexOf('plug-b'))
    expect(opened.indexOf('plug-a')).toBeLessThan(opened.indexOf('data-selected="true"'))

    // Positive control for the count above: the same list with nothing open
    // marks nothing, so `1` is a decision and not a constant.
    expect(render(null)).not.toContain('data-selected')
  })
})
