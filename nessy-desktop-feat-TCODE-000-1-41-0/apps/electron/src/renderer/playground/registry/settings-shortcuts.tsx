/**
 * Playground registry for the settings SHORTCUTS page — UB15.4 (v0.15.1 `pages/settings/ShortcutsPage.tsx`: the
 * `SettingsPage` column with its lede, every key a shared `Kbd` inside a `KbdGroup`, 44px shortcut rows).
 *
 * Upstream v0.15.1 has no shortcuts entry, so this file is ours (Extensions log, UB15.4 ADDED). It renders the
 * SHIPPED page under its own `ActionRegistryProvider` (the playground root has none; `App.tsx` mounts the real one)
 * inside a panel card that is a `@container/panel`, so the column's compact padding (`@max-mobile/panel:px-4`)
 * answers to the panel width as it does in the app. The states worth reviewing, in dark theme too:
 *
 *  - **full panel** — the 680px column: title, lede, the search row first, then the registry tables and the three
 *    fixed component tables with their note;
 *  - **compact panel** — under the 768px breakpoint the column's sides drop to 16px and long labels wrap.
 *
 * Rebinding, the keystroke lookup and the filter are keyboard states: press a row's chips, "Find by keystroke", or
 * type in the filter here to see them. A rebind persists through the playground's `writePreferences` mock (it logs
 * and stores nothing), so the page resets on reload.
 */

import * as React from 'react'
import { ActionRegistryProvider } from '@/actions'
import ShortcutsPage from '@/pages/settings/ShortcutsPage'
import type { ComponentEntry } from './types'

type PanelWidth = 'full' | 'compact'

/** A detail panel wider than the column (680px + sides), and one under the 768px compact breakpoint. */
const PANEL_WIDTHS: Record<PanelWidth, number> = { full: 760, compact: 420 }
const PANEL_HEIGHT = 640

function SettingsShortcutsPreview({ width = 'full' }: { width?: PanelWidth }) {
  return (
    <div
      className="@container/panel flex flex-col overflow-hidden rounded-[12px] bg-background shadow-elev-1"
      style={{ width: PANEL_WIDTHS[width], height: PANEL_HEIGHT }}
    >
      <ActionRegistryProvider>
        <ShortcutsPage />
      </ActionRegistryProvider>
    </div>
  )
}

export const settingsShortcutsComponents: ComponentEntry[] = [
  {
    id: 'settings-shortcuts',
    name: 'Settings · Shortcuts',
    category: 'Settings',
    description: 'UB15.4 (v0.15.1): the Shortcuts page on the SettingsPage column — shared keycaps in key groups, 44px rows, our rebind controls and the search row first',
    component: SettingsShortcutsPreview,
    layout: 'top',
    props: [
      {
        name: 'width',
        description: 'The detail panel width (compact is under the 768px breakpoint)',
        control: { type: 'select', options: [{ label: 'Full panel', value: 'full' }, { label: 'Compact panel', value: 'compact' }] },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'Full panel', props: { width: 'full' } },
      { name: 'Compact panel', props: { width: 'compact' } },
    ],
  },
]
