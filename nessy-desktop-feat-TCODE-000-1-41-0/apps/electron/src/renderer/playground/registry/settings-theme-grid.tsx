/**
 * Playground registry for Settings › Appearance's new sections — UB15.9 (v0.15.1 `AppearanceSettingsPage.tsx` +
 * `components/settings/ThemeGrid.tsx`, ADDED in v0.15.0): the Mode section, the Color theme grid with live swatches
 * and the Interface card's Font and Motion rows.
 *
 * Upstream v0.15.1 has no entry for them, so this file is ours (Extensions log, UB15.9 ADDED). It cannot render the
 * shipped page: the page counts the bundled presets through Vite's `import.meta.glob`, which the static sweep in
 * `registry-render.test.ts` cannot load. So it composes the SHIPPED parts the page composes — `ThemeGrid`,
 * `SettingsSection`, `SettingsCard`, `SettingsRow`, `SettingsSegmentedControl` — over the REAL bundled presets
 * (`apps/electron/resources/themes`, imported as data), in the SettingsPage column's content width. The states worth
 * reviewing, in dark theme too:
 *
 *  - **dark previews** — every tile solved in dark mode (codex paints its own #101010 navigator, #212121 paper);
 *  - **light previews** — the same tiles in light mode; Haze (dark-only, scenic) keeps its dark preview and carries
 *    the dark-only caption;
 *  - **loading** — the built-in tile plus one inert placeholder per bundled preset, so nothing below shifts when the
 *    presets arrive;
 *  - **Motion** — System, Reduced or Full selected in the Interface card.
 */

import * as React from 'react'
import type { ThemeFile } from '@config/theme'
import type { MotionPreference } from '@nessy-agent/ui/motion'
import { Monitor, Moon, Sun } from 'lucide-react'
import { ThemeGrid, type ThemeGridOption } from '@/components/settings/ThemeGrid'
import { SettingsCard, SettingsRow, SettingsSection, SettingsSegmentedControl } from '@/components/settings'
import { presetTileCount } from '@/pages/settings/appearance-theme-grid'
import type { ComponentEntry } from './types'
import codex from '../../../../resources/themes/codex.json'
import github from '../../../../resources/themes/github.json'
import haze from '../../../../resources/themes/haze.json'
import nord from '../../../../resources/themes/nord.json'
import oneDarkPro from '../../../../resources/themes/one-dark-pro.json'
import paper from '../../../../resources/themes/paper.json'
import vitesse from '../../../../resources/themes/vitesse.json'

/** The bundled presets as the page lists them: id = the file name, label = the theme's name. */
const BUNDLED: { id: string; theme: ThemeFile }[] = [
  { id: 'codex', theme: codex as ThemeFile },
  { id: 'github', theme: github as ThemeFile },
  { id: 'haze', theme: haze as ThemeFile },
  { id: 'nord', theme: nord as ThemeFile },
  { id: 'one-dark-pro', theme: oneDarkPro as ThemeFile },
  { id: 'paper', theme: paper as ThemeFile },
  { id: 'vitesse', theme: vitesse as ThemeFile },
]

const OPTIONS: ThemeGridOption[] = [
  { value: 'default', label: 'Default' },
  ...BUNDLED.map(p => ({ value: p.id, label: p.theme.name || p.id, theme: p.theme })),
]

type PreviewMode = 'light' | 'dark'

interface AppearancePreviewProps {
  mode?: PreviewMode
  selected?: string
  loading?: boolean
  motion?: MotionPreference
}

function AppearanceThemePreview({ mode = 'dark', selected = 'codex', loading = false, motion = 'system' }: AppearancePreviewProps) {
  const [currentMode, setCurrentMode] = React.useState<PreviewMode | 'system'>(mode)
  const [theme, setTheme] = React.useState(selected)
  const [font, setFont] = React.useState<'system' | 'inter'>('system')
  const [currentMotion, setCurrentMotion] = React.useState<MotionPreference>(motion)
  React.useEffect(() => setCurrentMode(mode), [mode])
  React.useEffect(() => setTheme(selected), [selected])
  React.useEffect(() => setCurrentMotion(motion), [motion])
  const previewMode: PreviewMode = currentMode === 'system' ? mode : currentMode

  // The SettingsPage column's content width (680px less its 28px sides), its sections 28px apart.
  return (
    <div className="flex w-[624px] max-w-full flex-col gap-7">
      <SettingsSection title="Mode">
        <SettingsSegmentedControl
          value={currentMode}
          onValueChange={setCurrentMode}
          aria-label="Mode"
          options={[
            { value: 'light', label: 'Light', icon: <Sun /> },
            { value: 'dark', label: 'Dark', icon: <Moon /> },
            { value: 'system', label: 'System', icon: <Monitor /> },
          ]}
        />
      </SettingsSection>
      <SettingsSection title="Color theme">
        <ThemeGrid
          value={theme}
          onValueChange={setTheme}
          options={loading ? OPTIONS.slice(0, 1) : OPTIONS}
          mode={previewMode}
          darkOnlyLabel="Dark"
          aria-label="Color theme"
          placeholderCount={loading ? presetTileCount(BUNDLED.map(p => p.id)) : 0}
        />
      </SettingsSection>
      <SettingsSection title="Interface">
        <SettingsCard>
          <SettingsRow label="Font">
            <SettingsSegmentedControl
              value={font}
              onValueChange={setFont}
              aria-label="Font"
              options={[
                { value: 'system', label: 'System' },
                { value: 'inter', label: 'Inter' },
              ]}
            />
          </SettingsRow>
          <SettingsRow label="Motion" description="System follows your OS setting. Reduced keeps fades but removes movement.">
            <SettingsSegmentedControl
              value={currentMotion}
              onValueChange={setCurrentMotion}
              aria-label="Motion"
              options={[
                { value: 'system', label: 'System' },
                { value: 'reduced', label: 'Reduced' },
                { value: 'full', label: 'Full' },
              ]}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

export const settingsThemeGridComponents: ComponentEntry[] = [
  {
    id: 'settings-theme-grid',
    name: 'Settings · Appearance theme grid',
    category: 'Settings',
    description:
      'UB15.9 (v0.15.1): the Mode section, the Color theme grid (live swatches in the active mode, the dark-only caption, placeholder tiles while presets load) and the Interface card’s Font and Motion rows',
    component: AppearanceThemePreview,
    layout: 'top',
    props: [
      {
        name: 'mode',
        description: 'The resolved mode the swatches are solved in',
        control: { type: 'select', options: [{ label: 'Dark', value: 'dark' }, { label: 'Light', value: 'light' }] },
        defaultValue: 'dark',
      },
      {
        name: 'selected',
        description: 'The selected colour theme',
        control: { type: 'select', options: OPTIONS.map(o => ({ label: o.label, value: o.value })) },
        defaultValue: 'codex',
      },
      {
        name: 'loading',
        description: 'Presets still loading (placeholder tiles)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'motion',
        description: 'The Motion preference',
        control: { type: 'select', options: [{ label: 'System', value: 'system' }, { label: 'Reduced', value: 'reduced' }, { label: 'Full', value: 'full' }] },
        defaultValue: 'system',
      },
    ],
    variants: [
      { name: 'Dark previews', props: { mode: 'dark', selected: 'codex' } },
      { name: 'Light previews', props: { mode: 'light', selected: 'paper' } },
      { name: 'Loading presets', props: { mode: 'dark', selected: 'default', loading: true } },
      { name: 'Motion reduced', props: { mode: 'dark', motion: 'reduced' } },
      { name: 'Motion full', props: { mode: 'dark', motion: 'full' } },
    ],
  },
]
