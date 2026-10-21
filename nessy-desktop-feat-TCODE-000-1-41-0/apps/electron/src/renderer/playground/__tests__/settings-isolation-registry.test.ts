import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { ComponentEntry } from '../registry/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

let settingsIsolationComponents: ComponentEntry[]

beforeAll(async () => {
  // Import ONLY this module — registry/index pulls the full app component graph
  // (ThemeContext's import.meta.glob) which bun cannot evaluate. The
  // categoryOrder wiring is asserted against the index source text instead.
  settingsIsolationComponents = (await import('../registry/settings-isolation')).settingsIsolationComponents
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function indexSource(): string {
  return readFileSync(join(import.meta.dir, '..', 'registry', 'index.ts'), 'utf-8')
}

function posture() {
  return settingsIsolationComponents.find(c => c.id === 'settings-isolation-network-posture')
}

describe('isolation network posture playground entry', () => {
  it('registers both isolation entries under the Settings category', () => {
    // P6.607 — this list pinned the posture entry ALONE, and
    // `settings-sandbox-switches` joined the module in `bdd223f82` ("the
    // isolation panel gains its two switches, and says what the boundary does
    // not cover"). Both ids are named here, in registry order, so the pin keeps
    // catching an entry that appears without being looked at.
    //
    // This failure was INVISIBLE until the same row made the suite runnable: the
    // `beforeAll` import above was timing out (see the note on
    // `registry/settings-isolation.tsx`), so bun reported one unnamed hook
    // failure and no assertion ever ran. A starved suite hides real drift, which
    // is the reason the import was fixed rather than given a bigger budget.
    expect(settingsIsolationComponents.map(c => c.id)).toEqual([
      'settings-sandbox-switches',
      'settings-isolation-network-posture',
    ])
    expect(settingsIsolationComponents.map(c => c.category)).toEqual(['Settings', 'Settings'])
    expect(posture()?.category).toBe('Settings')
  })

  it('wires the module and the Settings category into registry/index so it renders', () => {
    const src = indexSource()
    expect(src).toContain("import { settingsIsolationComponents } from './settings-isolation'")
    expect(src).toContain('...settingsIsolationComponents,')
    const orderLine = src.split('\n').find(line => line.includes('const categoryOrder'))
    expect(orderLine).toBeDefined()
    expect(orderLine).toContain("'Settings'")
  })

  it('exposes every posture the host can report as a knob value', () => {
    // These states are otherwise reachable only by deploying a managed policy,
    // which is exactly why the design surface has to carry them.
    const knob = posture()?.props.find(p => p.name === 'state')
    expect(knob?.control.type).toBe('select')
    const values = knob?.control.type === 'select' ? knob.control.options.map(o => o.value) : []
    expect(values.sort()).toEqual(['absent', 'denied', 'denied-unenforceable', 'open', 'open-unenforceable'])
  })

  it('carries a variant per state, including the unenforceable-entry wrapping cases', () => {
    const variants = posture()?.variants ?? []
    for (const state of ['open', 'open-unenforceable', 'denied', 'denied-unenforceable', 'absent']) {
      expect(variants.some(v => v.props.state === state)).toBe(true)
    }
  })
})
