import * as React from 'react'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import * as sessionStatusConfig from '@/config/session-status-config'
import type { SessionMeta } from '@/atoms/sessions'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// F1.462 (F1.134's recipe): the menu-context stub SPREADS this snapshot, taken
// before it, and the afterAll below restores it.
const realMenuContext = { ...(await import('@/components/ui/menu-context')) }
mock.module('@/components/ui/menu-context', () => {
  const Item = ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>
  const Block = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  return {
    ...realMenuContext,
    useMenuComponents: () => ({
      MenuItem: Item,
      Separator: () => <hr />,
      Sub: Block,
      SubTrigger: Item,
      SubContent: Block,
    }),
  }
})

function StatusIcon(_props: { bare?: boolean }) {
  return <span>status</span>
}

/**
 * The status-config stub SPREADS the real module and `afterAll` puts the real
 * module back from a snapshot taken BEFORE the mock — never from the live
 * namespace, which `mock.module` mutates in place.
 *
 * Measured 2026-09-20 (D1.442). This stub used to be a hand-listed member set of
 * exactly three names, which REPLACES the namespace rather than overriding part
 * of it. `SessionStatusIcon.tsx` imports a fourth, `getStateIconStyle`, so for
 * every later file in the process that module had no such export and bun refused
 * the link: `SessionStatusIcon.test.tsx` is 3 pass / 0 fail ALONE and dies with
 * `SyntaxError: Export named 'getStateIconStyle' not found` the moment this file
 * joins the run. It cost the whole `app-shell/__tests__` chunk of the CI test job
 * — the child exited 1 with ZERO failing tests and one file that never ran.
 *
 * The two stubs below stay hand-listed ON PURPOSE, and that is a measurement and
 * not an oversight: the real `@/context/ThemeContext` runs Vite's
 * `import.meta.glob` at module scope, which bun cannot evaluate, so spreading it
 * would trade this defect for a hard import error (`capability-info-pages.test.tsx`
 * records the same constraint). `@/components/ui/menu-context` is replaced whole
 * on purpose — the test's subject is what the menu renders, and its only export
 * here is the hook being replaced. Neither is imported by anything else in this
 * directory today; if that changes, they need this same spread, not a wider list.
 */
const realStatusConfig = { ...sessionStatusConfig }

const statusConfigMock = {
  ...realStatusConfig,
  getStateColor: () => 'var(--foreground)',
  getStateIcon: () => <StatusIcon />,
  getStatusIconStyle: () => undefined,
}

const STATUS_CONFIG_PATH = new URL('../../../config/session-status-config.tsx', import.meta.url).pathname

mock.module('@/config/session-status-config', () => statusConfigMock)
mock.module(STATUS_CONFIG_PATH, () => statusConfigMock)

afterAll(() => {
  mock.module('@/components/ui/menu-context', () => realMenuContext)
  mock.module('@/config/session-status-config', () => realStatusConfig)
  mock.module(STATUS_CONFIG_PATH, () => realStatusConfig)
})

const themeContextMock = {
  useTheme: () => ({
    isDark: false,
    resolvedMode: 'light',
    mode: 'light',
    setMode: () => {},
  }),
}

mock.module('@/context/ThemeContext', () => themeContextMock)
mock.module(new URL('../../../context/ThemeContext.tsx', import.meta.url).pathname, () => themeContextMock)

const translations = {
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'sessionMenu.archive': 'Archive',
  'sessionMenu.copyPath': 'Copy Path',
  'sessionMenu.flag': 'Flag',
  'sessionMenu.openInNewPanel': 'Open in New Panel',
  'sessionMenu.openInNewWindow': 'Open in New Window',
  'sessionMenu.regenerateTitle': 'Regenerate Title',
  'sessionMenu.revertLastFileEdit': 'Revert Last File Edit',
  'sessionMenu.share': 'Share',
  'sessionMenu.showInFileManager': 'Show in Finder',
  'sessionMenu.status': 'Status',
}

let testI18n: I18nInstance
let SessionMenu: typeof import('../SessionMenu').SessionMenu

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translations } },
      interpolation: { escapeValue: false },
    })

  SessionMenu = (await import('../SessionMenu')).SessionMenu
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const item: SessionMeta = {
  id: 'session-1',
  workspaceId: 'workspace-1',
  messageCount: 1,
  lastFinalMessageId: 'message-1',
  lastReadMessageId: 'message-1',
}

const statuses = [{
  id: 'todo',
  label: 'Todo',
  resolvedColor: 'var(--foreground)',
  icon: <StatusIcon />,
  iconColorable: true,
  isDefault: true,
}]

describe('SessionMenu', () => {
  it('renders the file checkpoint revert action', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <SessionMenu
          item={item}
          sessionStatuses={statuses as never}
          onRename={() => {}}
          onFlag={() => {}}
          onUnflag={() => {}}
          onArchive={() => {}}
          onUnarchive={() => {}}
          onMarkUnread={() => {}}
          onSessionStatusChange={() => {}}
          onOpenInNewWindow={() => {}}
          onDelete={() => {}}
        />
      </I18nextProvider>
    )

    expect(html).toContain('Revert Last File Edit')
  })
})
