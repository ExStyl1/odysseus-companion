/**
 * P6.451 — safe mode existed on all three runtimes and could be entered only
 * from a shell.
 *
 * The posture was complete: one gate before every capability read, both accepted
 * spellings, and a banner that names the posture on the window it applies to.
 * The capability the sweep found missing was the ENTRY — `git grep` finds no
 * setter of either variable anywhere in `apps/electron` — so the user who most
 * needs safe mode, the one whose configuration is broken, is the one asked to
 * find a terminal.
 *
 * ## Both directions, and the second one is the reason this is a section
 *
 * Entering is only half. A relaunch inherits the environment it was started
 * with, so before this row a session started with the variable set could not get
 * back out of safe mode from inside the app either. The section therefore shows
 * whichever direction applies: the current posture is read from the same
 * function the banner reads, and the button is the OTHER state.
 *
 * ## Why the copy insists on two things
 *
 * *Nothing is deleted or disabled* — because a switch that unloads every plugin,
 * skill and MCP server reads like a destructive action, and a user who thinks it
 * might be will not press it when they need it.
 *
 * *Managed policy still applies* — the half that makes safe mode a security
 * posture rather than a debug flag (`env-vars.md:318`). An entry point that
 * omitted it would read as an escape hatch from the organization's rules, which
 * is the opposite of what it is.
 *
 * ## UB15.8 — on v0.15.1's settings material
 *
 * The posture is one `SettingsRow` whose action is the shared `Button` at v0.15.1's row-action shape (secondary,
 * md — upstream's Workspace "Edit" and AI "Save key" rows), and the policy note is its own block of the raised card
 * (`settingsUI.cardPadding` + the row description ink) instead of a hand-padded muted line. `SafeModeSectionView`
 * is the section for one posture, so the playground shows both without stubbing the preload; the default export
 * reads the posture and relaunches. Nothing it shows or does changed.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection, SettingsCard, SettingsRow } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * UB15.8 — the section for one posture. `onRestart` receives the posture to relaunch INTO, always named: the
 * button is the other state, never "leave it alone".
 */
export function SafeModeSectionView({
  inSafeMode,
  onRestart,
}: { inSafeMode: boolean; onRestart: (safeMode: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <SettingsSection
      title={t('settings.safeMode.title')}
      description={`${t('settings.safeMode.description')} ${t('settings.safeMode.scopeNote')}`}
    >
      <SettingsCard>
        <SettingsRow
          label={inSafeMode ? t('settings.safeMode.activeLabel') : t('settings.safeMode.enterLabel')}
          description={inSafeMode ? t('settings.safeMode.activeDesc') : t('settings.safeMode.enterDesc')}
          action={
            <Button variant="secondary" size="md" onClick={() => onRestart(!inSafeMode)}>
              {inSafeMode ? t('settings.safeMode.leaveButton') : t('settings.safeMode.enterButton')}
            </Button>
          }
        />
        <p className={cn(settingsUI.cardPadding, settingsUI.description)}>
          {t('settings.safeMode.policyNote')}
        </p>
      </SettingsCard>
    </SettingsSection>
  )
}

export default function SettingsSafeModeSection() {
  // Optional on the API so a thin-client/legacy preload stays valid; absent
  // reads as "not safe mode", which is the non-alarming default and matches
  // `SafeModeBanner`'s own guard.
  const inSafeMode = window.electronAPI?.isSafeModeSession?.() ?? false

  const restart = useCallback((safeMode: boolean) => {
    void window.electronAPI?.relaunchApp({ safeMode })
  }, [])

  return <SafeModeSectionView inSafeMode={inSafeMode} onRestart={restart} />
}
