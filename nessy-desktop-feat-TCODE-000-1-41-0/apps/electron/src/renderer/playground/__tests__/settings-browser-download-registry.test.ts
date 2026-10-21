/**
 * P6.564 — the download card's design surface.
 *
 * Import ONLY this module: `registry/index` pulls the full app component graph
 * (ThemeContext's `import.meta.glob`) which bun cannot evaluate, and the barrel
 * `@/components/settings` costs 39 s under `bun test` — both measured, both
 * recorded on `registry/settings-isolation.tsx`. The index wiring is asserted
 * against the index SOURCE TEXT instead, which is what makes the entry
 * reachable in the app at all.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { ComponentEntry } from '../registry/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

let entries: ComponentEntry[]

beforeAll(async () => {
  entries = (await import('../registry/settings-browser-download')).settingsBrowserDownloadComponents
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function entry() {
  return entries.find(candidate => candidate.id === 'settings-browser-download')
}

describe('browser download settings playground entry', () => {
  it('registers under the Settings category', () => {
    expect(entries.map(candidate => candidate.id)).toEqual(['settings-browser-download'])
    expect(entry()?.category).toBe('Settings')
  })

  it('wires the module into registry/index so it renders', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'registry', 'index.ts'), 'utf-8')
    expect(src).toContain(
      "import { settingsBrowserDownloadComponents } from './settings-browser-download'",
    )
    expect(src).toContain('...settingsBrowserDownloadComponents,')
  })

  it('carries every state the two layers can produce, as a knob and as a variant', () => {
    // The four env/refused states are otherwise reachable only by setting an
    // environment variable on the host and restarting the app, which is exactly
    // why the design surface has to hold them.
    const expected = ['env-both', 'env-refused', 'env-root', 'refused', 'stored', 'unset']
    const knob = entry()?.props.find(prop => prop.name === 'state')
    expect(knob?.control.type).toBe('select')
    const values = knob?.control.type === 'select' ? knob.control.options.map(o => o.value) : []
    expect([...values].sort()).toEqual(expected)

    const variants = entry()?.variants ?? []
    expect(variants.map(variant => variant.props.state).sort()).toEqual(expected)
  })
})

/**
 * P6.623 — the folder picker beside the field.
 *
 * Asserted against SOURCE TEXT for the reason this file's header records: the
 * page and the barrel cannot be imported here. What that buys is the pair of
 * facts a screenshot cannot show — that the button is wired to the EXISTING
 * folder channel with a translated title, and that it goes disabled with the
 * field it fills whenever the environment holds the value.
 */
describe('P6.623 — the download folder Browse button', () => {
  const page = readFileSync(
    join(import.meta.dir, '..', '..', 'pages', 'settings', 'AppSettingsPage.tsx'),
    'utf-8',
  )
  const card = readFileSync(
    join(import.meta.dir, '..', 'registry', 'settings-browser-download.tsx'),
    'utf-8',
  )

  it('fills the field from Electron own folder dialog, under a translated title', () => {
    // The channel is the one that already existed; no new IPC surface was added,
    // which is the refutation of the row premise recorded in the lane report.
    expect(page).toContain('window.electronAPI.openFolderDialog({')
    expect(page).toContain("title: t('settings.tools.downloadRootPickerTitle'),")
    expect(page).toContain('setDownloadRootInput(picked)')
    // A pick writes, the same way a blur does — otherwise the picked path would
    // sit in the box unsaved and the resolved view would never come back.
    expect(page).toContain('await commitDownloadSettings({ root: picked')
  })

  it('NEGATIVE: cancel writes nothing, and the button dies with the field the environment took', () => {
    // `if (!picked) return` before any write: a dismissed dialog must not clear
    // a configured folder.
    expect(page).toContain('if (!picked) return')
    // Both the input and its button carry the same guard. A button that opens a
    // picker whose result cannot be applied is the control P6.564 argued against.
    expect(page.match(/disabled=\{downloadPolicy\?\.rootFromEnv === true\}/g) ?? []).toHaveLength(2)
    expect(card).toContain('disabled={view.rootFromEnv}')
    expect(card).toContain("{t('settings.tools.downloadRootBrowse')}")
  })
})

/**
 * UB15.5 — the twin and the page wear the same note material.
 *
 * The page's free-form note lines moved onto v0.15.1's in-card padding + prose (`CARD_NOTE_CLASS`), and its Browse
 * button onto the shared `secondary md`. This entry claims to draw the Tools card's download half "exactly as
 * `AppSettingsPage` renders it", so both sources must spell the same material — read as SOURCE TEXT for this file's
 * reason (the page cannot be imported here). The rendered states are swept in dark by `registry-render.test.ts`.
 */
describe('UB15.5 — the download card twin on the page note material', () => {
  const page = readFileSync(
    join(import.meta.dir, '..', '..', 'pages', 'settings', 'AppSettingsPage.tsx'),
    'utf-8',
  )
  const card = readFileSync(
    join(import.meta.dir, '..', 'registry', 'settings-browser-download.tsx'),
    'utf-8',
  )
  const NOTE_CLASS = 'const CARD_NOTE_CLASS = cn(settingsUI.cardPadding, settingsUI.prose)'
  const LEGACY_NOTE = /px-4 py-3\.5 text-sm text-muted-foreground/g

  it('POSITIVE: page and twin spell one note class and one Browse button', () => {
    for (const [name, source] of [['page', page], ['card', card]] as const) {
      expect({ name, noteClass: source.includes(NOTE_CLASS) }).toEqual({ name, noteClass: true })
      expect({ name, noteBlock: source.includes('<div className={CARD_NOTE_CLASS}>') }).toEqual({ name, noteBlock: true })
    }
    // The Browse button: one per source, on the shared secondary md.
    expect(page).toMatch(/<Button\s+variant="secondary"\s+size="md"\s+onClick=\{handleBrowseDownloadRoot\}/)
    expect(card).toContain('<Button variant="secondary" size="md" disabled={view.rootFromEnv}>')
  })

  it('NEGATIVE: neither source keeps the hand-spelled note block or the deprecated outline variant', () => {
    expect({ page: page.match(LEGACY_NOTE)?.length ?? 0, card: card.match(LEGACY_NOTE)?.length ?? 0 })
      .toEqual({ page: 0, card: 0 })
    expect({ page: page.includes('variant="outline"'), card: card.includes('variant="outline"') })
      .toEqual({ page: false, card: false })
    // Control: the pattern fires on the block both sources spelled until UB15.5.
    expect('<div className="px-4 py-3.5 text-sm text-muted-foreground space-y-1">'.match(LEGACY_NOTE)?.length).toBe(1)
  })
})
