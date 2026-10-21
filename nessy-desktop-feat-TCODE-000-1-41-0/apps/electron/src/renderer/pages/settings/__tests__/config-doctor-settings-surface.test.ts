/**
 * P6.576 (D12) — the settings-file tiers had no surface in the app.
 *
 * `buildConfigDoctorReport` existed and its only production consumer was
 * `apps/cli/src/doctor.ts`: theme 2 of the denominator sweep, the host holding a
 * fact and saying nothing. W8-c derived the session-start line and W7-v emitted
 * it; this is the read-only page the line points at.
 *
 * `bun test` has no DOM in this repo, so the wiring is pinned by source match —
 * the instrument its `advisor-settings-surface.test.ts` sibling uses, and for
 * the same reason: importing the component would drag in the `@nessy-agent/ui`
 * barrel for no gain.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol/channels'
import { channelLocality } from '@nessy-agent/shared/protocol/routing'

const section = readFileSync(
  fileURLToPath(new URL('../SettingsConfigDoctorSection.tsx', import.meta.url)),
  'utf8',
)
const page = readFileSync(
  fileURLToPath(new URL('../AppSettingsPage.tsx', import.meta.url)),
  'utf8',
)

const DOCTOR_KEYS = [
  'settings.configDoctor.title',
  'settings.configDoctor.description',
  'settings.configDoctor.scopeNote',
  'settings.configDoctor.cliNote',
  'settings.configDoctor.noFindings',
  'settings.configDoctor.unavailable',
  'settings.configDoctor.workspaceNote',
  'settings.configDoctor.noRepairNote',
] as const

describe('settings diagnosis surface', () => {
  it('reads the report channel and is mounted where the sibling checkup is', () => {
    // The row's own evidence, inverted: `buildConfigDoctorReport`'s only
    // production consumer was the CLI. The positive control is
    // `SettingsProvenanceSection`, the read-only checkup already on this page —
    // if the mount point moved, this guard would be asserting about nothing.
    expect(section).toContain('getConfigDoctorReport(activeWorkspaceId ?? undefined)')
    expect(page).toContain('<SettingsConfigDoctorSection />')
    expect(page).toContain('<SettingsProvenanceSection')
  })

  it('is read-only: it renders the report and never writes one back', () => {
    // Owner decision D12. The negative half is the one worth pinning — the
    // channel group has exactly one member, so there is no setter to call even
    // by accident, and the component must not invent a local edit affordance.
    expect(Object.values(RPC_CHANNELS.settings).filter(c => c.includes('ConfigDoctor')))
      .toEqual([RPC_CHANNELS.settings.GET_CONFIG_DOCTOR])
    expect(section).not.toContain('setConfigDoctor')
    expect(section).not.toContain('onChange')
  })

  it('does not present a narrower report as the whole one', () => {
    // The boundary this row is most likely to be got wrong at, in BOTH
    // directions. A page that stayed silent about a section it never collected
    // would read as "your machine is clean" when it means "I did not look" — so
    // the sentence names the terminal command that does look. P6.775 adds the
    // other direction: the handler calls every collector it can now, so a
    // sentence still claiming the terminal sees more IN GENERAL would send a
    // user to run a command for a report they are already reading.
    //
    // P6.787 makes the disclosure CONDITIONAL, which is the third way to get it
    // wrong: with a workspace open the page really does report every section, so
    // the missing-section sentence would now be false, and without one it is
    // still true. Both branches must exist in the source — a component that
    // rendered only the workspace branch would silently drop the disclosure on
    // the surface that still needs it.
    expect(section).toContain("t('settings.configDoctor.cliNote')")
    expect(section).toContain("t('settings.configDoctor.workspaceNote'")
    const cliNote = (en as Record<string, string>)['settings.configDoctor.cliNote'] ?? ''
    expect(cliNote).toContain('nessy-general-agent doctor')
    expect(cliNote).toContain('instruction files')
    // And the clean-machine line is a separate sentence from the CLI one, so a
    // reader who sees "nothing needs attention" also sees what was not checked.
    expect(section).toContain("t('settings.configDoctor.noFindings')")
    expect(section).toContain('hasFindings')
  })

  it('names the workspace it speaks for, in every locale, and asks the shell without throwing', () => {
    // The row's product decision made mechanical: an app-level page reporting a
    // PROJECT-scoped section has to say which project. A `workspaceNote` that
    // lost its interpolation would render a sentence about "the workspace this
    // window has open" naming none — the exact ambiguity the decision removes —
    // and no type would catch it, because i18next accepts unused variables.
    for (const [name, bundle] of Object.entries({ en, ru } as Record<string, Record<string, string>>)) {
      const note = bundle['settings.configDoctor.workspaceNote'] ?? ''
      expect(`${name}:${note.includes('{{workspace}}')}`).toBe(`${name}:true`)
    }
    // `useOptionalAppShellContext`, never the throwing one: the playground
    // renders this component outside the shell, so the strict hook would turn a
    // design surface into a crash.
    expect(section).toContain('useOptionalAppShellContext')
    expect(section).not.toContain('useAppShellContext()')
  })

  it('carries the block copy in every locale', () => {
    const locales: Record<string, Record<string, string>> = {
      en: en as Record<string, string>,
      ru: ru as Record<string, string>,
    }
    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of DOCTOR_KEYS) {
        expect(`${name}:${key}:${(bundle[key] ?? '').length > 0}`).toBe(`${name}:${key}:true`)
      }
    }
  })

  it('says it never repairs anything, matching the invariant the CLI states in source', () => {
    // C3.212, owner answer QM8=A: the checkup REFUSES to repair, and a refusal
    // nobody can see is indistinguishable from a defect. The invariant has been
    // written down since P6.398 — but in `apps/cli/src/doctor.ts`'s docblock,
    // whose audience is a reader of this fork's source and not the operator
    // holding a list of findings. "Read-only diagnosis" alone is fairly read as
    // "it has not written yet".
    const doctor = readFileSync(
      fileURLToPath(new URL('../../../../../../../apps/cli/src/doctor.ts', import.meta.url)),
      'utf8',
    )
    // Whitespace-collapsed, because the sentence is wrapped inside a docblock
    // and the wrap point is not the claim: a guard that breaks when someone
    // reflows a comment is a guard people delete.
    const unwrapped = doctor.replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ')
    expect(unwrapped).toContain('It never repairs anything')
    expect(section).toContain("t('settings.configDoctor.noRepairNote')")
    for (const [name, bundle] of Object.entries({ en, ru } as Record<string, Record<string, string>>)) {
      const note = bundle['settings.configDoctor.noRepairNote'] ?? ''
      // Not merely present: it must say what the operator does about it, which
      // is the half "read-only" never said.
      expect(`${name}:${note.length > 0}`).toBe(`${name}:true`)
      expect(`${name}:${note !== bundle['settings.configDoctor.description']}`).toBe(`${name}:true`)
    }
  })

  it('routes locally, because the report describes THIS machine', () => {
    // It stats and parses this host's managed policy file, its delivery cache
    // and its `config.json`; answered from another server it would describe the
    // wrong machine. `routing.ts` is total by construction, so `'unclassified'`
    // is as much a failure here as `'workspace'`.
    const channel = RPC_CHANNELS.settings.GET_CONFIG_DOCTOR
    expect(`${channel}:${channelLocality(channel)}`).toBe(`${channel}:local`)
  })
})
