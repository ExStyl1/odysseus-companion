import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { ComponentEntry } from '../registry/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

/**
 * P6.741 — the two OTHER startup dialogs' playground entries.
 *
 * P6.725 gave the broken-`config.json` dialog one; its neighbours, the
 * boot-fatal refusal and the storage-readiness block, each carried a local en/ru
 * copy table that no surface could render. Neither can be reached on purpose:
 * both need a startup that has already failed, at which point there is no
 * renderer to open a playground in.
 *
 * What is pinned here is that each entry renders the SAME builder its dialog is
 * built from, in BOTH languages — a hand-copied mock-up of the copy is how the
 * two versions drift, and copy is the only thing these entries exist to review.
 */
let startupDialogComponents: ComponentEntry[]

beforeAll(async () => {
  // Import ONLY this module, for the reason the sibling registry suites give:
  // `registry/index` pulls the full app component graph.
  startupDialogComponents = (await import('../registry/startup-dialogs')).startupDialogComponents
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function source(name: string): string {
  return readFileSync(join(import.meta.dir, '..', 'registry', name), 'utf-8')
}

describe('startup dialog playground entries', () => {
  it('registers both dialogs as Settings entries with a language knob each', () => {
    expect(startupDialogComponents.map(c => c.id))
      .toEqual(['boot-fatal-dialog', 'storage-readiness-dialog'])
    for (const entry of startupDialogComponents) {
      expect(entry.category).toBe('Settings')
      const locale = (entry.props ?? []).find(p => p.name === 'locale')?.control
      // Both languages, because these dialogs read the OS locale rather than the
      // persisted UI language — the configuration that carries it may be exactly
      // what could not be read.
      expect(locale?.type === 'select' && locale.options.map(o => o.value)).toEqual(['en', 'ru-RU'])
    }
  })

  it('wires the module into registry/index so both render', () => {
    const index = source('index.ts')
    expect(index).toContain("from './startup-dialogs'")
    expect(index).toContain('...startupDialogComponents,')
  })

  it('renders the real builders rather than a second copy of the copy', () => {
    const entry = source('startup-dialogs.tsx')
    expect(entry).toContain("from '../../../shared/boot-fatal-dialog'")
    expect(entry).toContain("from '../../../shared/storage-readiness-dialog'")
    expect(entry).toContain('buildBootFatalDialog(')
    expect(entry).toContain('buildStorageReadinessDialog(')
    // The negative control: no button label may be hard-coded here, which is
    // precisely what a mock-up of an OS dialog tends to become.
    for (const label of ['Quit', 'Retry', 'Open diagnostics', 'Выйти', 'Повторить']) {
      expect(entry).not.toContain(`'${label}'`)
    }
  })

  it('renders both languages from the builders themselves', async () => {
    const { buildBootFatalDialog } = await import('../../../shared/boot-fatal-dialog')
    const { buildStorageReadinessDialog } = await import('../../../shared/storage-readiness-dialog')
    const described = { name: 'Error', message: 'boom' }

    expect(buildBootFatalDialog({ configDir: '/c', described }, 'en').buttons).toEqual(['Quit'])
    expect(buildBootFatalDialog({ configDir: '/c', described }, 'ru-RU').buttons).toEqual(['Выйти'])
    expect(buildStorageReadinessDialog({ code: 'unsafe-root', diagnostics: '/c' }, 'en').buttons)
      .toEqual(['Retry', 'Open diagnostics', 'Quit'])
    expect(buildStorageReadinessDialog({ code: 'unsafe-root', diagnostics: '/c' }, 'ru-RU').buttons)
      .toEqual(['Повторить', 'Открыть диагностику', 'Выйти'])
  })
})
