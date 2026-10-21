/**
 * UB12.113 — the Sources list's Show in file manager is the ONE capability reveal
 * (`hooks/useCapabilityReveal.ts`) that the Skills list and the skill page already call through
 * `useSkillActions`; `AppShell`'s copy (`handleRevealCapability`, passed as `onOpenResource`) is gone.
 *
 *   positive — inside the app shell a source row's item is live, and choosing it calls
 *              `capabilities.reveal` with the shell's capability context and the row's key;
 *   negative — outside the app shell (no provider, or a provider with no capability context) the
 *              hook answers null and the row's item renders disabled with no reason; boundary: a
 *              catalog-only source inside the shell is disabled WITH the reason.
 *
 * Instrument. `SourcesListPanel` cannot load under `bun test` (the pdfjs barrel trap
 * `list-panel-row-anatomy.test.tsx` measured 2026-10-16), so the row's item is built by the SAME
 * call the panel makes — `revealItemProps(source, reveal, t('sourcesList.revealUnavailable'))` spread
 * into the REAL `SourceMenu` — and the wiring is read from the panel's and AppShell's source.
 * `SourceMenu`'s items live in a closed dropdown a static render never opens, so the menu
 * primitives are plain buttons (the `SkillDetailMenu.test.tsx` recipe: spread a snapshot taken
 * before the mock, restore it after).
 */

import * as React from 'react'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { AppShellContextType } from '@/context/AppShellContext'
import type { CapabilityReveal } from '@/hooks/useCapabilityReveal'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const realMenuContext = { ...(await import('@/components/ui/menu-context')) }
mock.module('@/components/ui/menu-context', () => {
  const Item = ({ children, disabled, title }: { children: React.ReactNode; disabled?: boolean; title?: string }) => (
    <button type="button" disabled={disabled} title={title}>{children}</button>
  )
  const Block = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  return {
    ...realMenuContext,
    useMenuComponents: () => ({ MenuItem: Item, Separator: () => <hr />, Sub: Block, SubTrigger: Item, SubContent: Block }),
  }
})

const originalWindow = (globalThis as { window?: unknown }).window

afterAll(() => {
  mock.module('@/components/ui/menu-context', () => realMenuContext)
  ;(globalThis as { window?: unknown }).window = originalWindow
})

let testI18n: I18nInstance
let AppShellProvider: typeof import('@/context/AppShellContext')['AppShellProvider']
let SourceMenu: typeof import('@/components/app-shell/SourceMenu')['SourceMenu']
let useCapabilityReveal: typeof import('@/hooks/useCapabilityReveal')['useCapabilityReveal']
let revealItemProps: typeof import('@/hooks/useCapabilityReveal')['revealItemProps']

const KEYS = [
  'sessionMenu.showInFileManager',
  'sidebarMenu.deleteSource',
  'sidebarMenu.openInNewWindow',
  'sourcesList.revealUnavailable',
  'toast.failedToReveal',
]

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map((k) => [k, k])) } },
    interpolation: { escapeValue: false },
  })
  AppShellProvider = (await import('@/context/AppShellContext')).AppShellProvider
  SourceMenu = (await import('@/components/app-shell/SourceMenu')).SourceMenu
  const hook = await import('@/hooks/useCapabilityReveal')
  useCapabilityReveal = hook.useCapabilityReveal
  revealItemProps = hook.revealItemProps
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const CONTEXT = { workspaceId: 'ws-1', sessionId: 'session-7' }

function source(overrides: Partial<SafeCapabilitySummary> = {}): SafeCapabilitySummary {
  return {
    key: 'source:ws-1:github', kind: 'source', logicalName: 'github', sourceType: 'mcp', origin: 'native',
    scope: { kind: 'workspace', workspaceId: 'ws-1' }, state: 'active', readOnly: false, trustState: 'trusted',
    credentialState: 'not-required', selectedAsUnqualifiedAlias: false, diagnosticCodes: [],
    ...overrides,
  } as SafeCapabilitySummary
}

/** The slice of the app shell the reveal reads; `capabilityContext` is what "inside" means. */
const shell = (overrides: Partial<AppShellContextType> = {}) => ({
  activeWorkspaceId: 'ws-1',
  capabilityContext: CONTEXT,
  ...overrides,
}) as unknown as AppShellContextType

function render(node: React.ReactElement, value: AppShellContextType | null): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      {value ? <AppShellProvider value={value}>{node}</AppShellProvider> : node}
    </I18nextProvider>,
  )
}

/** The hook's answer under `value` (null = no provider at all). */
function revealUnder(value: AppShellContextType | null): CapabilityReveal | null | undefined {
  let captured: CapabilityReveal | null | undefined
  function Probe() { captured = useCapabilityReveal(); return null }
  render(<Probe />, value)
  return captured
}

/** One Sources-list row's menu, its reveal item built exactly as `SourcesListPanel`'s `sourceListItem` builds it. */
function sourceRowMenu(summary: SafeCapabilitySummary, reveal: CapabilityReveal | null): string {
  return render(
    <SourceMenu
      sourceSlug="github"
      sourceName="GitHub"
      onOpenInNewWindow={() => {}}
      {...revealItemProps(summary, reveal, 'sourcesList.revealUnavailable')}
    />,
    null,
  )
}

/** The opening tag of the menu item whose text holds `text` — its `disabled`/`title` are the item's state. */
function itemHolding(html: string, text: string): string {
  const at = html.indexOf(text)
  expect(at, text).toBeGreaterThan(-1)
  const start = html.lastIndexOf('<button', at)
  return html.slice(start, html.indexOf('>', start) + 1)
}

describe('UB12.113 — positive: inside the app shell a source row reveals through the shared hook', () => {
  it('the item is live, and choosing it calls capabilities.reveal with the shell\'s context and the row\'s key', async () => {
    const calls: Array<[unknown, string]> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: { capabilities: { reveal: async (ctx: unknown, key: string) => { calls.push([ctx, key]) } } },
    }
    const reveal = revealUnder(shell())
    expect(typeof reveal).toBe('function')

    expect(itemHolding(sourceRowMenu(source(), reveal!), 'sessionMenu.showInFileManager')).toBe('<button type="button">')
    const item = revealItemProps(source(), reveal!, 'sourcesList.revealUnavailable')
    expect(item.showInFinderDisabledReason).toBeUndefined()
    await item.onShowInFinder!()
    expect(calls).toEqual([[CONTEXT, 'source:ws-1:github']])
  })

  it('the panel reads the hook and the shared gate; AppShell no longer carries a reveal handler or the prop', () => {
    const appShellDir = join(import.meta.dir, '..', '..', 'components', 'app-shell')
    const panel = readFileSync(join(appShellDir, 'SourcesListPanel.tsx'), 'utf8')
    const appShell = readFileSync(join(appShellDir, 'AppShell.tsx'), 'utf8')
    const skills = readFileSync(join(import.meta.dir, '..', 'useSkillActions.ts'), 'utf8')
    expect(panel).toContain('const reveal = useCapabilityReveal()')
    expect(panel).toContain("{...revealItemProps(source, options.reveal, options.t('sourcesList.revealUnavailable'))}")
    expect(panel).not.toMatch(/onOpenResource\s*[?:=,]/)
    expect(appShell).not.toContain('handleRevealCapability')
    expect(appShell).not.toContain('onOpenResource')
    expect(appShell).not.toContain('capabilities.reveal(')
    // The skill side calls the same two, so the two lists cannot drift apart again.
    expect(skills).toContain('const reveal = useCapabilityReveal()')
    expect(skills).toContain('revealItemProps(')
    expect(skills).not.toContain('capabilities.reveal(')
  })
})

describe('UB12.113 — negative: outside the app shell the item is disabled', () => {
  it('no provider, or a provider with no capability context or no workspace: the hook answers null', () => {
    expect(revealUnder(null)).toBeNull()
    expect(revealUnder(shell({ capabilityContext: undefined }))).toBeNull()
    expect(revealUnder(shell({ activeWorkspaceId: null }))).toBeNull()
  })

  it('with no reveal the source row\'s item renders disabled, with no reason and no click', () => {
    expect(revealItemProps(source(), null, 'sourcesList.revealUnavailable')).toEqual({})
    expect(itemHolding(sourceRowMenu(source(), null), 'sessionMenu.showInFileManager'))
      .toBe('<button type="button" disabled="">')
  })

  it('boundary — a catalog-only source inside the shell is disabled WITH the reason', () => {
    const reveal: CapabilityReveal = async () => { throw new Error('a catalog-only row must not be revealed') }
    const catalogOnly = source({ state: 'unsupported-runtime' })
    expect(revealItemProps(catalogOnly, reveal, 'sourcesList.revealUnavailable'))
      .toEqual({ showInFinderDisabledReason: 'sourcesList.revealUnavailable' })
    expect(itemHolding(sourceRowMenu(catalogOnly, reveal), 'sessionMenu.showInFileManager'))
      .toBe('<button type="button" disabled="" title="sourcesList.revealUnavailable">')
  })
})
