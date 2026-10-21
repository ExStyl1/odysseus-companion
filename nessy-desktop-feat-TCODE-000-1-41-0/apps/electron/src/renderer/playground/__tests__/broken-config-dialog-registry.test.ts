import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { ComponentEntry } from '../registry/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/**
 * P6.725 — the broken-`config.json` dialog's playground entry.
 *
 * It exists because this is the one startup surface a reviewer cannot reach on
 * purpose: seeing the real thing means the app refused its own `config.json`,
 * at which point there is no renderer to open a playground in. What is pinned
 * here is that the entry renders the SAME builder the dialog is built from —
 * a hand-copied mock-up of the copy is how the two versions drift, and copy is
 * the only thing this entry exists to review.
 */
let brokenConfigDialogComponents: ComponentEntry[]

beforeAll(async () => {
  // Import ONLY this module, for the reason the sibling registry suites give:
  // `registry/index` pulls the full app component graph.
  brokenConfigDialogComponents = (await import('../registry/broken-config-dialog')).brokenConfigDialogComponents
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function indexSource(): string {
  return readFileSync(join(import.meta.dir, '..', 'registry', 'index.ts'), 'utf-8')
}

describe('broken configuration dialog playground entry', () => {
  it('registers one Settings entry with both states a user can meet', () => {
    expect(brokenConfigDialogComponents.map(c => c.id)).toEqual(['broken-config-dialog'])
    expect(brokenConfigDialogComponents[0]?.category).toBe('Settings')
    const props = brokenConfigDialogComponents[0]?.props ?? []
    expect(props.map(p => p.name).sort()).toEqual(['locale', 'problem'])
    // Both languages, because the dialog reads the OS locale rather than the
    // persisted UI language — the file it would have read is the broken one.
    const locale = props.find(p => p.name === 'locale')?.control
    expect(locale?.type === 'select' && locale.options.map(o => o.value)).toEqual(['en', 'ru-RU'])
  })

  it('wires the module into registry/index so it renders', () => {
    const src = indexSource()
    expect(src).toContain("from './broken-config-dialog'")
    expect(src).toContain('...brokenConfigDialogComponents,')
  })

  it('renders the real builder rather than a second copy of the copy', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'registry', 'broken-config-dialog.tsx'), 'utf-8')
    expect(source).toContain("from '../../../shared/broken-config-dialog'")
    expect(source).toContain('buildBrokenConfigDialog(')
    // The negative control: the entry must not hard-code the button labels,
    // which is precisely what a mock-up of an OS dialog tends to become.
    expect(source).not.toContain('Set it aside and quit')
  })
})
