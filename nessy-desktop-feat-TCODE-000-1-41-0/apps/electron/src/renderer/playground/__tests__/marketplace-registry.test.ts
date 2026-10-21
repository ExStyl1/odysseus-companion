import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import type { ComponentEntry } from '../registry/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// The detail preview → CapabilityContentPanel → Info_Markdown chain
// transitively references pdfjs-dist worker URLs bun can't resolve; stub them
// before the dynamic imports below (mirrors sources-management-registry.test).
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let marketplaceComponents: ComponentEntry[]

beforeAll(async () => {
  // Import ONLY this module — importing registry/index pulls the full app
  // component graph (ThemeContext's import.meta.glob) which bun can't evaluate.
  // The categoryOrder wiring is asserted against the index source text instead.
  marketplaceComponents = (await import('../registry/marketplace')).marketplaceComponents
}, MODULE_GRAPH_HOOK_BUDGET_MS)

/** registry/index.ts source — read statically to prove the wiring without
 *  importing the heavy app graph. */
function indexSource(): string {
  return readFileSync(join(import.meta.dir, '..', 'registry', 'index.ts'), 'utf-8')
}

function browse() {
  return marketplaceComponents.find((c) => c.id === 'marketplace-browse')
}
function detail() {
  return marketplaceComponents.find((c) => c.id === 'marketplace-detail')
}

describe('marketplace playground registry (U5)', () => {
  it('registers the browse + detail entries under the Marketplace category', () => {
    expect(marketplaceComponents.map((c) => c.id).sort()).toEqual(['marketplace-browse', 'marketplace-detail'])
    for (const entry of marketplaceComponents) {
      expect(entry.category).toBe('Marketplace')
    }
  })

  it('wires the Marketplace module + category into registry/index so it renders', () => {
    // A category absent from categoryOrder silently doesn't render; and a module
    // not spread into componentRegistry never reaches getCategories at all.
    const src = indexSource()
    expect(src).toContain("import { marketplaceComponents } from './marketplace'")
    expect(src).toContain('...marketplaceComponents,')
    // categoryOrder allow-list must include 'Marketplace'.
    const orderLine = src.split('\n').find((l) => l.includes('const categoryOrder'))
    expect(orderLine).toBeDefined()
    expect(orderLine).toContain("'Marketplace'")
  })

  it('Browse exposes the list-state knob covering every required state', () => {
    const stateKnob = browse()?.props.find((p) => p.name === 'state')
    expect(stateKnob?.control.type).toBe('select')
    const values = stateKnob?.control.type === 'select' ? stateKnob.control.options.map((o) => o.value) : []
    for (const s of ['populated', 'searching', 'mixed', 'loading', 'empty', 'error']) {
      expect(values).toContain(s)
    }
    // Search query knob (server-side search UX; playground filters mock data).
    expect(browse()?.props.find((p) => p.name === 'query')?.control.type).toBe('string')
    // Installed strip / manage handoff toggle.
    expect(browse()?.props.find((p) => p.name === 'showInstalledStrip')?.control.type).toBe('boolean')
  })

  it('Browse variants cover populated/searching/loading/empty/error and the no-installed-strip case', () => {
    const variants = browse()?.variants ?? []
    expect(variants.some((v) => v.props.state === 'populated')).toBe(true)
    expect(variants.some((v) => v.props.state === 'searching')).toBe(true)
    expect(variants.some((v) => v.props.state === 'mixed')).toBe(true)
    expect(variants.some((v) => v.props.state === 'loading')).toBe(true)
    expect(variants.some((v) => v.props.state === 'empty')).toBe(true)
    expect(variants.some((v) => v.props.state === 'error')).toBe(true)
    expect(variants.some((v) => v.props.showInstalledStrip === false)).toBe(true)
  })

  it('Browse exposes the R3 registry knobs (grouped / upgrading / load-error)', () => {
    for (const knob of ['showRegistries', 'registryUpgrading', 'registryLoadError']) {
      expect(browse()?.props.find((p) => p.name === knob)?.control.type).toBe('boolean')
    }
  })

  it('Browse variants cover the R3 registry states (grouped / upgrading / load-error / empty)', () => {
    const variants = browse()?.variants ?? []
    expect(variants.some((v) => v.props.showRegistries === true && !v.props.registryUpgrading && !v.props.registryLoadError)).toBe(true)
    expect(variants.some((v) => v.props.registryUpgrading === true)).toBe(true)
    expect(variants.some((v) => v.props.registryLoadError === true)).toBe(true)
    // Add-marketplace dialog reachable from Create ▾.
    expect(variants.some((v) => v.props.addMarketplaceOpen === true)).toBe(true)
  })

  it('Detail exposes the skill-preview content-state knob across all four states', () => {
    const knob = detail()?.props.find((p) => p.name === 'contentState')
    expect(knob?.control.type).toBe('select')
    const values = knob?.control.type === 'select' ? knob.control.options.map((o) => o.value) : []
    expect(values.sort()).toEqual(['empty', 'error', 'loaded', 'loading'])
    // Installed vs not-installed CTA + file-ref + information knobs.
    expect(detail()?.props.find((p) => p.name === 'installed')?.control.type).toBe('boolean')
    expect(detail()?.props.find((p) => p.name === 'showFileRefs')?.control.type).toBe('boolean')
    expect(detail()?.props.find((p) => p.name === 'showInformation')?.control.type).toBe('boolean')
  })

  it('Detail variants cover loaded/loading/error/empty preview + placeholder Information', () => {
    const variants = detail()?.variants ?? []
    expect(variants.some((v) => v.props.contentState === 'loaded')).toBe(true)
    expect(variants.some((v) => v.props.contentState === 'loading')).toBe(true)
    expect(variants.some((v) => v.props.contentState === 'error')).toBe(true)
    expect(variants.some((v) => v.props.contentState === 'empty')).toBe(true)
    expect(variants.some((v) => v.props.showInformation === false)).toBe(true)
  })
})
