/**
 * Playground registry for the settings NAVIGATOR — UB15.2 (v0.15.1 `pages/settings/SettingsNavigator.tsx`: the
 * EntityRow anatomy — icon · title / description, a full-bleed fill on hover and selection, a hairline from the
 * text edge that hides under the selected row, and the named "⋯" revealed on hover or focus).
 *
 * Upstream v0.15.1 has no navigator entry, so this file is ours (Extensions log, UB15.2 ADDED). It renders the
 * SHIPPED navigator with our item list (`import` present, no `messaging`) at the navigator panel's resting width
 * (304 px, the `AppShell.tsx` `storage.KEYS.sessionListWidth` fallback) on the panel card. The states worth
 * reviewing, in dark theme too:
 *
 *  - **a row selected** — the first, a middle and the last row (the hairline under the selected row is gone, the
 *    neighbours' stay);
 *  - **nothing selected** — the bare `settings` route the compact layout opens on;
 *  - **a short panel** — the list scrolls inside the card.
 *
 * Hover and the open "⋯" menu are pointer states: hover a row here to see them. The menu's "Open in new window"
 * is stubbed to record the deep link below the card instead of opening a window.
 */

import * as React from 'react'
import SettingsNavigator from '@/pages/settings/SettingsNavigator'
import type { SettingsSubpage } from '../../../shared/types'
import type { ComponentEntry } from './types'

type Selected = SettingsSubpage | 'none'
type PanelHeight = 'tall' | 'short'

/** The navigator panel's resting width (`AppShell.tsx` sessionListWidth fallback, UB14.4). */
const NAVIGATOR_WIDTH = 304
const PANEL_HEIGHTS: Record<PanelHeight, number> = { tall: 600, short: 280 }

function SettingsNavigatorPreview({ selected = 'workspace', height = 'tall' }: { selected?: Selected; height?: PanelHeight }) {
  const [current, setCurrent] = React.useState<SettingsSubpage | null>(selected === 'none' ? null : selected)
  const [opened, setOpened] = React.useState<string | null>(null)

  React.useEffect(() => {
    setCurrent(selected === 'none' ? null : selected)
  }, [selected])

  React.useEffect(() => {
    const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI
    const previous = api?.openUrl
    if (api) api.openUrl = async (url: string) => { setOpened(url) }
    return () => {
      if (api) api.openUrl = previous
    }
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-col overflow-hidden rounded-[12px] bg-background shadow-elev-1"
        style={{ width: NAVIGATOR_WIDTH, height: PANEL_HEIGHTS[height] }}
      >
        <SettingsNavigator selectedSubpage={current} onSelectSubpage={setCurrent} />
      </div>
      {opened && <p className="text-label-sm text-secondary">Open in new window → {opened}</p>}
    </div>
  )
}

const SELECTED_OPTIONS: Array<{ label: string; value: Selected }> = [
  { label: 'Nothing (compact route)', value: 'none' },
  { label: 'App (first row)', value: 'app' },
  { label: 'Workspace', value: 'workspace' },
  { label: 'Import (ours)', value: 'import' },
  { label: 'Preferences (last row)', value: 'preferences' },
]

export const settingsNavigatorComponents: ComponentEntry[] = [
  {
    id: 'settings-navigator',
    name: 'Settings Navigator',
    category: 'Settings',
    description: 'UB15.2 (v0.15.1): the settings list on the EntityRow anatomy — fill selection, hairlines from the text edge, the named "⋯" on hover/focus',
    component: SettingsNavigatorPreview,
    layout: 'top',
    props: [
      {
        name: 'selected',
        description: 'The current settings page (a fill, never weight)',
        control: { type: 'select', options: SELECTED_OPTIONS },
        defaultValue: 'workspace',
      },
      {
        name: 'height',
        description: 'The panel height (short scrolls the list)',
        control: { type: 'select', options: [{ label: 'Tall', value: 'tall' }, { label: 'Short', value: 'short' }] },
        defaultValue: 'tall',
      },
    ],
    variants: [
      { name: 'Middle row selected', props: { selected: 'workspace', height: 'tall' } },
      { name: 'First row selected', props: { selected: 'app', height: 'tall' } },
      { name: 'Last row selected', props: { selected: 'preferences', height: 'tall' } },
      { name: 'Nothing selected (compact route)', props: { selected: 'none', height: 'tall' } },
      { name: 'Short panel', props: { selected: 'import', height: 'short' } },
    ],
  },
]
