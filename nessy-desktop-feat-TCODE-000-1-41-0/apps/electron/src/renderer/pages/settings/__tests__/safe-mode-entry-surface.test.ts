/**
 * P6.451 — the in-app entry and exit, pinned as a surface.
 *
 * The sweep's evidence was a `git grep`: no setter of either safe-mode variable
 * anywhere in `apps/electron`, so the entry was env/flag only. These cases are
 * that grep inverted, plus the half a first implementation would miss — the way
 * BACK OUT, which needs the banner and not only the settings page, because a
 * user in safe mode is looking at an empty capability list and the banner is the
 * thing on screen that explains it.
 *
 * `bun test` has no DOM here, so the wiring is pinned by source match, as its
 * `advisor-settings-surface.test.ts` sibling does.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

const section = readFileSync(
  fileURLToPath(new URL('../SettingsSafeModeSection.tsx', import.meta.url)),
  'utf8',
)
const page = readFileSync(
  fileURLToPath(new URL('../AppSettingsPage.tsx', import.meta.url)),
  'utf8',
)
const banner = readFileSync(
  fileURLToPath(new URL('../../../components/app-shell/SafeModeBanner.tsx', import.meta.url)),
  'utf8',
)

const SAFE_MODE_KEYS = [
  'settings.safeMode.title',
  'settings.safeMode.description',
  'settings.safeMode.scopeNote',
  'settings.safeMode.enterLabel',
  'settings.safeMode.enterDesc',
  'settings.safeMode.enterButton',
  'settings.safeMode.activeLabel',
  'settings.safeMode.activeDesc',
  'settings.safeMode.leaveButton',
  'settings.safeMode.policyNote',
  'safeMode.bannerLeave',
] as const

describe('safe-mode entry surface', () => {
  it('offers both directions from the settings page, and reads the current one', () => {
    // The entry the row asks for, and the state that decides which button is
    // shown — read from the same function the banner reads, so the two cannot
    // disagree about which posture this window is in.
    expect(section).toContain('isSafeModeSession')
    expect(section).toContain('relaunchApp({ safeMode })')
    expect(page).toContain('<SettingsSafeModeSection />')
  })

  it('puts the way OUT on the banner too, which is where a safe-mode user is looking', () => {
    // The half that makes the round trip possible. A relaunch inherits the
    // environment it was started with, so before this the only exit from a
    // shell-started safe-mode session was another shell. The banner is
    // non-dismissible and always present in that state, which is exactly why the
    // exit belongs on it.
    expect(banner).toContain('relaunchApp({ safeMode: false })')
    expect(banner).toContain("t('safeMode.bannerLeave')")
  })

  it('never leaves the posture ambiguous: the settings call always names it', () => {
    // Negative/boundary. `relaunchApp()` with no argument means "leave the
    // posture alone" — correct for the server-settings restart, and wrong here,
    // where it would restart the app and change nothing while the button
    // promised otherwise.
    expect(section).not.toContain('relaunchApp()')
    expect(banner).not.toContain('relaunchApp()')
  })

  it('says the two things the copy must say, in every locale', () => {
    const locales: Record<string, Record<string, string>> = {
      en: en as Record<string, string>,
      ru: ru as Record<string, string>,
    }
    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of SAFE_MODE_KEYS) {
        expect(`${name}:${key}:${(bundle[key] ?? '').length > 0}`).toBe(`${name}:${key}:true`)
      }
    }
    // Nothing is destroyed, and managed policy still binds. The second is the
    // half that makes safe mode a posture rather than a bypass
    // (`env-vars.md:318`), and the banner already says it — the entry point has
    // to as well, or it reads as a way around the organization's rules.
    const enBundle = en as Record<string, string>
    expect(enBundle['settings.safeMode.enterDesc']).toContain('nothing is deleted or disabled')
    expect(enBundle['settings.safeMode.policyNote']).toContain('policy still applies')
    expect(section).toContain("t('settings.safeMode.policyNote')")
  })
})
