/**
 * UB12.80 — the skill detail page's header "⋯" (v0.15.1 `pages/SkillInfoPage.tsx` L153-168:
 * `SkillMenu` in `Info_HeaderMenu`), built from the SAME `skillMenuProps` and acted on by the
 * SAME `useSkillActions` as the Skills list row.
 *
 *   positive — a native workspace skill: the named "⋯" renders inside the app shell, Delete is
 *              live and labelled Delete, and it deletes through the shared action (RPC order
 *              pinned), then leaves the page;
 *   negative — a plugin-tier skill: Delete is greyed and names its owning tier, no Send to
 *              workspace; the action refuses a non-workspace resource; and outside the app shell
 *              (no provider, or a provider with no capability context) no trigger renders.
 *
 * `SkillMenu`'s items live in a closed dropdown that a static render never opens, so the item arm
 * renders `SkillMenu` itself with plain menu primitives (the `SessionMenu.test.tsx` recipe: spread
 * a snapshot taken before the mock, restore it after).
 */

import * as React from 'react'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilityDetail } from '@nessy-agent/shared/protocol/capabilities'
import type { AppShellContextType } from '@/context/AppShellContext'
import type { SafeSkillRow } from '@/lib/capability-catalog'
import type { SkillActions } from '@/hooks/useSkillActions'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const realMenuContext = { ...(await import('@/components/ui/menu-context')) }
mock.module('@/components/ui/menu-context', () => {
  const Item = ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
    <button type="button" disabled={disabled}>{children}</button>
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
let SkillDetailMenu: typeof import('../SkillDetailActions')['SkillDetailMenu']
let SkillMenu: typeof import('../SkillMenu')['SkillMenu']
let skillMenuProps: typeof import('@/hooks/useSkillActions')['skillMenuProps']
let useSkillActions: typeof import('@/hooks/useSkillActions')['useSkillActions']

const KEYS = [
  'common.more',
  'sessionMenu.sendToWorkspace',
  'sessionMenu.showInFileManager',
  'sidebarMenu.openInNewWindow',
  'skillsList.deleteSkill',
  'skillsList.managedByPlugin',
  'skillsList.revealUnavailable',
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
  SkillDetailMenu = (await import('../SkillDetailActions')).SkillDetailMenu
  SkillMenu = (await import('../SkillMenu')).SkillMenu
  const hook = await import('@/hooks/useSkillActions')
  skillMenuProps = hook.skillMenuProps
  useSkillActions = hook.useSkillActions
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const t = ((key: string) => key) as (key: string, options?: Record<string, unknown>) => string

function skill(overrides: Partial<SafeSkillRow> = {}): SafeSkillRow {
  return {
    key: 'skill:release-notes', kind: 'skill', logicalName: 'release-notes', displayName: 'Release Notes',
    description: 'Draft release notes.', origin: 'native', scope: { kind: 'workspace', workspaceId: 'ws-1' },
    state: 'active', readOnly: false, trustState: 'not-required', credentialState: 'not-required',
    selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
    ...overrides,
  } as SafeSkillRow
}
const pluginSkill = () => skill({ key: 'skill:acme:lint', origin: 'plugin', readOnly: true })

/** The slice of the app shell the skill actions read; `capabilityContext` is what "inside" means. */
const shell = (overrides: Partial<AppShellContextType> = {}) => ({
  isCompactMode: false,
  workspaces: [{ id: 'ws-1', name: 'One' }, { id: 'ws-2', name: 'Two' }],
  activeWorkspaceId: 'ws-1',
  capabilityContext: { workspaceId: 'ws-1' },
  refreshPluginState: async () => {},
  ...overrides,
}) as unknown as AppShellContextType

function render(node: React.ReactElement, value: AppShellContextType | null): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      {value ? <AppShellProvider value={value}>{node}</AppShellProvider> : node}
    </I18nextProvider>,
  )
}

/** The opening tag of the menu item whose text holds `text` — its `disabled` is the item's state. */
function itemHolding(html: string, text: string): string {
  const at = html.indexOf(text)
  expect(at, text).toBeGreaterThan(-1)
  const start = html.lastIndexOf('<button', at)
  return html.slice(start, html.indexOf('>', start) + 1)
}

const stubActions = (): SkillActions & { deleted: string[] } => {
  const deleted: string[] = []
  return { deleted, reveal: async () => {}, deleteSkill: async (key) => { deleted.push(key); return true } }
}

describe('UB12.80 — positive: a native workspace skill', () => {
  it('renders the named "⋯" trigger inside the app shell', () => {
    const html = render(<SkillDetailMenu skill={skill()} />, shell())
    expect(html).toContain('aria-label="common.more"')
    expect(html).toContain('aria-haspopup="menu"')
  })

  it('Delete is live, labelled Delete, offers Send to workspace, and deletes through the shared action, then leaves the page', async () => {
    const actions = stubActions()
    let left = 0
    const props = skillMenuProps(skill(), {
      actions, t, hasOtherWorkspaces: true, onSendToWorkspace: () => {}, onDeleted: () => { left += 1 },
    })
    expect(props.canDelete).toBe(true)
    expect(props.deleteLabel).toBe('skillsList.deleteSkill')
    expect(props.onSendToWorkspace).toBeDefined()
    expect(props.canShowInFinder).toBe(true)

    const items = render(<SkillMenu {...props} />, null)
    expect(itemHolding(items, 'skillsList.deleteSkill')).toBe('<button type="button">')
    expect(itemHolding(items, 'sessionMenu.sendToWorkspace')).toBe('<button type="button">')

    props.onDelete!()
    await Promise.resolve()
    await Promise.resolve()
    expect(actions.deleted).toEqual(['skill:release-notes'])
    expect(left).toBe(1)
  })

  it('the shared delete reads the detail, deletes the WORKSPACE skill by its id, refreshes, and answers true', async () => {
    const calls: string[] = []
    const detail = {
      resources: [{ ref: { scope: 'skill', tier: 'workspace', skillId: 'release-notes', file: 'instructions' } }],
    } as unknown as SafeCapabilityDetail
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        capabilities: { getDetail: async (_ctx: unknown, key: string) => { calls.push(`getDetail ${key}`); return detail } },
        deleteSkill: async (ws: string, id: string) => { calls.push(`deleteSkill ${ws} ${id}`) },
      },
    }
    let captured: SkillActions | null = null
    function Probe() { captured = useSkillActions(); return null }
    render(<Probe />, shell({ refreshPluginState: async () => { calls.push('refresh') } }))
    expect(captured).not.toBeNull()
    expect(await captured!.deleteSkill('skill:release-notes')).toBe(true)
    expect(calls).toEqual(['getDetail skill:release-notes', 'deleteSkill ws-1 release-notes', 'refresh'])
  })
})

describe('UB12.80 — negative: a plugin-tier skill, and outside the app shell', () => {
  it('Delete is greyed and names its owning tier; no Send to workspace even with another workspace', () => {
    const props = skillMenuProps(pluginSkill(), {
      actions: stubActions(), t, hasOtherWorkspaces: true, onSendToWorkspace: () => {},
    })
    expect(props.canDelete).toBe(false)
    expect(props.onDelete).toBeUndefined()
    expect(props.deleteLabel).toBe('skillsList.managedByPlugin')
    expect(props.onSendToWorkspace).toBeUndefined()

    const items = render(<SkillMenu {...props} />, null)
    expect(itemHolding(items, 'skillsList.managedByPlugin')).toBe('<button type="button" disabled="">')
    expect(items).not.toContain('skillsList.deleteSkill')
    expect(items).not.toContain('sessionMenu.sendToWorkspace')
  })

  it('a catalog-only skill cannot be revealed and says why', () => {
    const props = skillMenuProps(skill({ state: 'unsupported-runtime' }), {
      actions: stubActions(), t, hasOtherWorkspaces: false, onSendToWorkspace: () => {},
    })
    expect(props.canShowInFinder).toBe(false)
    expect(props.showInFinderDisabledReason).toBe('skillsList.revealUnavailable')
  })

  it('the shared delete refuses a skill with no workspace-tier resource and calls no delete', async () => {
    const calls: string[] = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        capabilities: {
          getDetail: async () => ({ resources: [{ ref: { scope: 'skill', tier: 'plugin', pluginInstanceId: 'p', capabilityId: 'lint', file: 'instructions' } }] }),
        },
        deleteSkill: async () => { calls.push('deleteSkill') },
      },
    }
    let captured: SkillActions | null = null
    function Probe() { captured = useSkillActions(); return null }
    render(<Probe />, shell({ refreshPluginState: async () => { calls.push('refresh') } }))
    expect(await captured!.deleteSkill('skill:acme:lint')).toBe(false)
    expect(calls).toEqual([])
  })

  it('outside the app shell no trigger renders — no provider, or a provider with no capability context', () => {
    expect(render(<SkillDetailMenu skill={skill()} />, null)).toBe('')
    expect(render(<SkillDetailMenu skill={skill()} />, shell({ capabilityContext: undefined }))).toBe('')
    let captured: SkillActions | null | undefined
    function Probe() { captured = useSkillActions(); return null }
    render(<Probe />, null)
    expect(captured).toBeNull()
  })
})
