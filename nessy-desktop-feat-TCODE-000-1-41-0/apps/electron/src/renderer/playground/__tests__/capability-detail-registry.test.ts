import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { ComponentEntry } from '../registry/types'

// Info_Markdown (transitively imported by the template) pulls in pdfjs-dist,
// whose worker URL import bun can't resolve — stub it before the dynamic
// import below (a static import would hoist above these mocks).
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

// react-pdf (via @nessy-agent/ui's markdown overlay) bundles its own pdfjs
// which references DOMMatrix at module scope — shim it under bun.
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let capabilityDetailComponents: ComponentEntry[]

/**
 * The hook pays the whole `../registry/capability-detail` graph — the playground
 * template pulls `@nessy-agent/ui`'s markdown overlay, react-pdf and pdfjs — and
 * the import is DYNAMIC on purpose (the `mock.module` stubs above must run
 * first, and a static import would hoist over them), so the graph cannot be
 * lifted to the top of the file the way AGENTS.md's rule 24 prescribes. That
 * leaves the budget as the only knob.
 *
 * It was a hand-written `60_000`, and P6.859 measured that BELOW the floor:
 * at HEAD `cf1613619`, `0 pass / 1 fail`, `(unnamed)`, the hook abandoned at
 * **100 799.27 ms** inside a 144.08 s run at load 9.23 — 1.32 s user / 0.92 s
 * sys, **1.6 % of wall**, so it is I/O and the true cost is unknown, bounded
 * only from below. The zero-case control (`bun test <file> -t '<matches
 * nothing>'`) prices the static graph alone at **34.20 s, 0 cases executed**,
 * 0.65 s user / 0.37 s sys at load 8.72. Minutes later the same bytes ran
 * **8 pass / 0 fail in 1.041 s** at the HIGHER load 12.89 and 134 % cpu — a
 * **138x** spread decided by the page cache, not by load, which is why the
 * warm reading is not the floor.
 *
 * The shared constant rather than another hand-written number: this is the
 * family `packages/shared/src/testing/module-graph-budgets.ts` exists for, and
 * the register records that copying a neighbour's number manufactured a red
 * once.
 */
beforeAll(async () => {
  capabilityDetailComponents = (await import('../registry/capability-detail')).capabilityDetailComponents
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function entry() {
  return capabilityDetailComponents.find((c) => c.id === 'capability-detail-template')
}

describe('capability detail playground registry', () => {
  it('registers the universal capability detail entry and wires it into the registry', () => {
    expect(capabilityDetailComponents.map((c) => c.id)).toEqual(['capability-detail-template'])
    expect(entry()?.category).toBe('Capability Detail')

    const indexSource = readFileSync(new URL('../registry/index.ts', import.meta.url), 'utf8')
    expect(indexSource).toContain("import { capabilityDetailComponents } from './capability-detail'")
    expect(indexSource).toContain('...capabilityDetailComponents')
    // The category must be in the render allow-list or it never shows.
    expect(indexSource).toContain("'Capability Detail'")
  })

  it('exposes a kind knob covering every capability kind', () => {
    const kindProp = entry()?.props.find((p) => p.name === 'kind')
    expect(kindProp?.control.type).toBe('select')
    const values = kindProp?.control.type === 'select'
      ? kindProp.control.options.map((o) => o.value)
      : []
    expect(values).toEqual(['skill', 'mcp', 'api', 'folder', 'plugin'])
  })

  it('exposes a content-state knob covering loaded/loading/error/empty', () => {
    const stateProp = entry()?.props.find((p) => p.name === 'contentState')
    const values = stateProp?.control.type === 'select'
      ? stateProp.control.options.map((o) => o.value)
      : []
    expect(values).toEqual(['loaded', 'loading', 'error', 'empty'])
  })

  it('exposes U2 present/absent knobs for permission modes and permissions', () => {
    const props = entry()?.props ?? []
    const modesKnob = props.find((p) => p.name === 'showPermissionModes')
    const permsKnob = props.find((p) => p.name === 'showPermissions')
    expect(modesKnob?.control.type).toBe('boolean')
    expect(permsKnob?.control.type).toBe('boolean')
  })

  it('keeps variants covering the U2 present + placeholder states', () => {
    const variants = entry()?.variants ?? []
    // Skill permission-modes present and absent.
    expect(variants.some((v) => v.props.kind === 'skill' && v.props.showPermissionModes === true)).toBe(true)
    expect(variants.some((v) => v.props.kind === 'skill' && v.props.showPermissionModes === false)).toBe(true)
    // Source permissions present and absent.
    expect(variants.some((v) => v.props.kind === 'api' && v.props.showPermissions === true)).toBe(true)
    expect(variants.some((v) => v.props.showPermissions === false)).toBe(true)
  })

  it('exposes a U3 mcpToolsState knob covering every tools-section state', () => {
    const knob = entry()?.props.find((p) => p.name === 'mcpToolsState')
    expect(knob?.control.type).toBe('select')
    const values = knob?.control.type === 'select' ? knob.control.options.map((o) => o.value) : []
    expect(values).toEqual(['collapsed', 'loading', 'loaded', 'empty', 'error', 'disabled', 'disconnected'])
  })

  it('keeps MCP variants covering the U3 tools-section states', () => {
    const variants = entry()?.variants ?? []
    const mcpStates = variants
      .filter((v) => v.props.kind === 'mcp')
      .map((v) => v.props.mcpToolsState)
    for (const state of ['loaded', 'collapsed', 'loading', 'error', 'empty', 'disabled', 'disconnected']) {
      expect(mcpStates).toContain(state)
    }
  })

  it('keeps variants covering each kind, each content state, and the bare-placeholder case', () => {
    const variants = entry()?.variants ?? []
    const names = variants.map((v) => v.name)

    // Every kind is represented by at least one variant.
    for (const kind of ['skill', 'mcp', 'api', 'folder', 'plugin']) {
      expect(variants.some((v) => v.props.kind === kind)).toBe(true)
    }
    // Every content state is represented.
    for (const state of ['loaded', 'loading', 'error', 'empty']) {
      expect(variants.some((v) => v.props.contentState === state)).toBe(true)
    }
    // Diagnostics-present and all-placeholder cases exist.
    expect(variants.some((v) => v.props.showDiagnostics === true)).toBe(true)
    expect(names).toContain('Bare — all placeholders')
  })

  it('UB14.48 — a failed-source-test variant renders the connection-error alert in dark; the base state none', async () => {
    const knob = entry()?.props.find((p) => p.name === 'lastTestFailed')
    expect(knob?.control.type).toBe('boolean')
    expect(knob?.defaultValue).toBe(false)
    const variant = entry()?.variants?.find((v) => v.props.lastTestFailed === true)
    expect(variant?.name).toBe('MCP source — last test failed')

    // Rendered for real, inside a dark root, through the entry's own component. `createElement`
    // rather than JSX keeps this file a `.ts` (its name is pinned by the registry census).
    const { createElement: h } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createInstance } = await import('i18next')
    const { I18nextProvider, initReactI18next } = await import('react-i18next')
    const { AppShellProvider } = await import('@/context/AppShellContext')
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } } })
    const Preview = entry()!.component as (props: Record<string, unknown>) => ReturnType<typeof h>
    const renderDark = (props: Record<string, unknown>): string => renderToStaticMarkup(
      h(I18nextProvider, { i18n },
        h(AppShellProvider, {
          value: { isCompactMode: false } as never,
          children: h('div', { className: 'dark' }, h(Preview, props)),
        })),
    )

    const failed = renderDark(variant!.props)
    expect(failed).toContain('data-testid="connection-error"')
    expect(failed).toContain('sourceInfo.connectionErrorTitle')
    expect(failed).toContain('https://mcp.github.example/…')
    const base = renderDark({ kind: 'mcp', contentState: 'loaded', mcpToolsState: 'loaded' })
    expect(base).not.toContain('data-testid="connection-error"')
  })

  it('UB14.59 — every variant renders in a dark root on the hero anatomy; each pill tone and the no-menu page', async () => {
    const { createElement: h } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createInstance } = await import('i18next')
    const { I18nextProvider, initReactI18next } = await import('react-i18next')
    const { AppShellProvider } = await import('@/context/AppShellContext')
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } } })
    const Preview = entry()!.component as (props: Record<string, unknown>) => ReturnType<typeof h>
    const renderDark = (props: Record<string, unknown>): string => renderToStaticMarkup(
      h(I18nextProvider, { i18n },
        h(AppShellProvider, {
          value: { isCompactMode: false } as never,
          children: h('div', { className: 'dark' }, h(Preview, props)),
        })),
    )
    const hero = (html: string): string => {
      const start = html.indexOf('mt-2 flex items-center gap-3.5')
      expect(start).toBeGreaterThan(-1)
      return html.slice(start, html.indexOf('<section', start))
    }

    const variants = entry()?.variants ?? []
    expect(variants.length).toBeGreaterThanOrEqual(19)
    for (const variant of variants) {
      const html = renderDark(variant.props)
      // The anatomy holds in every state: the name in the hero h2, and nowhere above it (no header title).
      const name = (html.match(/<h2 class="text-title[^"]*">([^<]+)<\/h2>/) ?? [])[1]
      expect(name, variant.name).toBeTruthy()
      expect(html.slice(0, html.indexOf('mt-2 flex items-center gap-3.5')).includes(name!), variant.name).toBe(false)
      // None of the pre-redesign classes this row retired, in any state of the entry.
      for (const legacy of ['border-border/30', 'bg-foreground/5', 'rounded-[6px]', 'text-foreground/70', 'text-foreground/80']) {
        expect(html.includes(legacy), `${variant.name}: ${legacy}`).toBe(false)
      }
    }

    const tone = (props: Record<string, unknown>): string => hero(renderDark(props))
    expect(tone({ kind: 'mcp', connection: 'connected' })).toContain('bg-success-tint text-success')
    expect(tone({ kind: 'mcp', connection: 'needsAuth' })).toContain('bg-info-tint text-info')
    expect(tone({ kind: 'mcp', connection: 'untested' })).toContain('bg-fill-hover text-secondary')
    // UB12.75 — the switched-off source and the merely untested one share the neutral tone, not the word.
    const switchedOff = tone({ kind: 'mcp', connection: 'disabled' })
    expect(switchedOff).toContain('bg-fill-hover text-secondary')
    expect(switchedOff).toContain('sourcesList.statusDisabled')
    expect(switchedOff).not.toContain('sourcesList.statusNotTested')
    expect(tone({ kind: 'mcp', connection: 'untested' })).toContain('sourcesList.statusNotTested')
    expect(tone({ kind: 'mcp', lastTestFailed: true })).toContain('bg-destructive-tint text-destructive')
    // A skill carries no connection, so no pill.
    expect(tone({ kind: 'skill' })).not.toContain('rounded-full px-2 text-label-sm')
    // The header menu: present by default, absent (no trigger at all) when the page has no actions.
    expect(renderDark({ kind: 'mcp' })).toContain('aria-haspopup="menu"')
    expect(renderDark({ kind: 'mcp', showHeaderMenu: false })).not.toContain('aria-haspopup="menu"')
  })

  it('UB12.80 — a skill\'s header "⋯" is the real SkillMenu: a tier knob, both Delete states as variants, the named trigger in dark', async () => {
    const knob = entry()?.props.find((p) => p.name === 'skillTier')
    const tiers = knob?.control.type === 'select' ? knob.control.options.map((o) => o.value) : []
    expect(tiers).toEqual(['plugin', 'workspace', 'global', 'administrator'])
    const variants = entry()?.variants ?? []
    expect(variants.find((v) => v.props.skillTier === 'workspace')?.name).toBe('Skill — header menu, workspace skill (Delete)')
    expect(variants.find((v) => v.props.skillTier === 'administrator')?.name).toBe('Skill — header menu, administrator skill (owner label)')

    const { createElement: h } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createInstance } = await import('i18next')
    const { I18nextProvider, initReactI18next } = await import('react-i18next')
    const { AppShellProvider } = await import('@/context/AppShellContext')
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } } })
    const Preview = entry()!.component as (props: Record<string, unknown>) => ReturnType<typeof h>
    const renderDark = (props: Record<string, unknown>): string => renderToStaticMarkup(
      h(I18nextProvider, { i18n },
        h(AppShellProvider, {
          value: { isCompactMode: false } as never,
          children: h('div', { className: 'dark' }, h(Preview, props)),
        })),
    )
    // v0.15.1's page: `Info_HeaderMenu` with no label, so the trigger is named "More" — not the
    // sources' "Actions" the other kinds' mock menu carries.
    for (const tier of tiers) {
      const html = renderDark({ kind: 'skill', skillTier: tier })
      expect(html, tier).toContain('aria-label="common.more"')
      expect(html, tier).not.toContain('aria-label="sourcesManagement.actions"')
    }
    expect(renderDark({ kind: 'skill', skillTier: 'workspace', showHeaderMenu: false })).not.toContain('aria-haspopup="menu"')
  })
})
