import * as React from 'react'
import type { ComponentEntry } from './types'
import { SafeModeSectionView } from '@/pages/settings/SettingsSafeModeSection'
import { SafeModeBanner } from '@/components/app-shell/SafeModeBanner'

// =============================================================================
// Safe mode entry and exit (Settings → App, and the banner) — P6.451
//
// The two states are the design question, and neither is reachable on a
// developer machine without restarting the whole app from a terminal, which is
// the very thing this row removes.
//
// NORMAL is the state that has to read as safe: a switch that unloads every
// plugin, skill, hook and MCP server looks destructive, and a user whose
// configuration is broken is the one least willing to risk it. IN SAFE MODE is
// the state that has to read as temporary, and it is where the banner belongs on
// screen beside the section, because the banner is what a user in that state is
// actually looking at.
//
// Both preview the REAL components. UB15.8: the section is
// `SafeModeSectionView` with the posture passed in, so each state is a variant
// the static sweep in `registry-render.test.ts` renders (stubbing the preload
// reached the section only after an effect ran, so that sweep saw the normal
// posture twice); its relaunch goes to a local note, so a click here cannot
// restart the app. The banner still reads `isSafeModeSession`, stubbed here.
// =============================================================================

type SafeModeState = 'normal' | 'in-safe-mode'

function SafeModePreview({ state = 'normal' }: { state?: SafeModeState }) {
  const [restarted, setRestarted] = React.useState<string | null>(null)

  // The banner reads the preload itself; its Leave button relaunches through it, so both are stubbed while the
  // entry is open and restored after.
  React.useEffect(() => {
    const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI
    const previousSession = api?.isSafeModeSession
    const previousRelaunch = api?.relaunchApp
    if (api) {
      api.isSafeModeSession = () => state === 'in-safe-mode'
      api.relaunchApp = async (options?: { safeMode?: boolean }) => {
        setRestarted(options?.safeMode === true ? 'on' : options?.safeMode === false ? 'off' : 'unchanged')
      }
    }
    return () => {
      if (api) {
        api.isSafeModeSession = previousSession
        api.relaunchApp = previousRelaunch
      }
    }
  }, [state])

  // The SettingsPage column's content width (680px less its 28px sides).
  return (
    <div className="w-[624px] max-w-full space-y-4" key={state}>
      {state === 'in-safe-mode' && (
        <div className="rounded-md border border-foreground/10 overflow-hidden">
          <SafeModeBanner />
        </div>
      )}
      <SafeModeSectionView
        inSafeMode={state === 'in-safe-mode'}
        onRestart={safeMode => setRestarted(safeMode ? 'on' : 'off')}
      />
      {restarted !== null && (
        <div className="text-label-sm text-tertiary">
          {`playground: a restart with safeMode ${restarted} was requested; the app was not restarted`}
        </div>
      )}
    </div>
  )
}

export const settingsSafeModeComponents: ComponentEntry[] = [
  {
    id: 'settings-safe-mode',
    name: 'Safe mode entry',
    category: 'Settings',
    description:
      'P6.451: the in-app way into safe mode and back out of it — the section reads the current posture and offers the other one, and the non-dismissible banner carries the exit because that is what a safe-mode user is looking at',
    component: SafeModePreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Which posture this window is in',
        control: {
          type: 'select',
          options: [
            { value: 'normal', label: 'Normal session (offers the way in)' },
            { value: 'in-safe-mode', label: 'In safe mode (banner + the way out)' },
          ],
        },
        defaultValue: 'normal',
      },
    ],
    variants: [
      { name: 'normal', props: { state: 'normal' } },
      { name: 'in-safe-mode', props: { state: 'in-safe-mode' } },
    ],
  },
]
