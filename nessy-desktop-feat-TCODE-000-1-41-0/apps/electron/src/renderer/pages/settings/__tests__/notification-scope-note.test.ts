/**
 * P6.467 — the honest recording, pinned so it cannot quietly become a build.
 *
 * The row asked for four claude notification categories and a channel selector.
 * W7-t measured the native clause against the shipped
 * `claude-agent-sdk-darwin-arm64/claude` and the vendored `sdk.d.ts` and refuted
 * it: the channel is a TERMINAL selector and our SDK child is headless inside
 * Electron; the two `*NotifEnabled` keys are Anthropic-hosted mobile push,
 * unreachable from the gateway card; `awaySummaryEnabled` is in the binary and
 * in no settings schema at all. So the deliverable is a sentence to the user,
 * not three settings that do nothing.
 *
 * Two things are asserted, because either one alone can rot:
 *  1. the sentence is on the surface, in both locales;
 *  2. the three refuted keys are still written NOWHERE — the moment one appears,
 *     someone has built to the refuted clause and this note is a lie.
 *
 * Read as SOURCE rather than rendered: `AppSettingsPage`'s module graph reaches
 * `@nessy-agent/ui`, which the sibling `app-settings-managed-updates.test.ts`
 * already records as unrenderable here, and it uses the same technique.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PAGE = fileURLToPath(new URL('../AppSettingsPage.tsx', import.meta.url))
const REPO = fileURLToPath(new URL('../../../../../../../', import.meta.url))

/** The three keys the measurement refuted. Never a fourth: see the header. */
const REFUTED_CLAUDE_KEYS = [
  'preferredNotifChannel',
  'agentPushNotifEnabled',
  'inputNeededNotifEnabled',
] as const

describe('P6.467 — the notification surface says whose notifications these are', () => {
  const source = readFileSync(PAGE, 'utf8')

  it('the section carries the scope note', () => {
    expect(source).toContain('settings.notifications.scopeNote')
  })

  it('the note exists in every locale, not just English', () => {
    const locales = ['en', 'ru']
    for (const locale of locales) {
      const path = fileURLToPath(new URL(
        `../../../../../../../packages/shared/src/i18n/locales/${locale}.json`,
        import.meta.url,
      ))
      const table = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
      expect(table['settings.notifications.scopeNote']).toBeTruthy()
    }
  })

  it('the refutation is recorded beside the surface, not only in a lane report', () => {
    // A measurement that lives only in a report is one refactor away from being
    // rebuilt against; the numbers and the reason sit at the site.
    expect(source).toContain('P6.467')
    expect(source).toContain('preferredNotifChannel')
    expect(source).toContain('awaySummaryEnabled')
  })

  it('none of the refuted claude keys is written anywhere in first-party code', () => {
    // The tripwire. `git grep -l` over tracked files only, so a stray build
    // artifact cannot fail it and a real write cannot hide from it.
    for (const key of REFUTED_CLAUDE_KEYS) {
      // `git grep` exits 1 on NO match, which is the passing case here, so the
      // throw is the empty result rather than a failure.
      let output = ''
      try {
        output = execFileSync(
          'git',
          ['grep', '-alI', '-e', key, '--', ':(glob)packages/**', ':(glob)apps/**'],
          { cwd: REPO, encoding: 'utf8' },
        )
      } catch {
        output = ''
      }
      const hits = output.split('\n').filter(Boolean)
      // The files allowed to NAME them are the ones explaining why they are not
      // used: this test, the settings page's own comment, the switch-cost row,
      // and — since `590e4b122` (C3.270/C3.275) — the Notification e2e, whose
      // docblock names `preferredNotifChannel` to record that the setting and the
      // dispatcher are the same call. A bare-substring absence guard cannot tell
      // code from the prose beside it; this list is how that is kept honest, and
      // the entry is added rather than the guard widened. Found by C3.380's lift
      // gate (2026-09-13) as a red already standing at HEAD.
      const unexpected = hits.filter(path =>
        !path.endsWith('pages/settings/AppSettingsPage.tsx')
        && !path.endsWith('__tests__/notification-scope-note.test.ts')
        && !path.endsWith('__tests__/claude-notification-e2e.test.ts')
        && !path.endsWith('input/runtime-switch-costs.ts'))
      expect(unexpected).toEqual([])
      // POSITIVE CONTROL on the same rig: an absence finding needs one, and a
      // grep run from the wrong cwd returns nothing and looks like a pass. This
      // file itself names every key, so a working probe always finds it.
      expect(hits).toContain('apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx')
    }
  })
})
