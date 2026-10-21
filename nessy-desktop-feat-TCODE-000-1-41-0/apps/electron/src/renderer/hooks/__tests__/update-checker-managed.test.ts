/**
 * P2.7 clause (a) — a managed refusal must not read as "You're up to date".
 *
 * P2.10's gate reports a refusal as `available: false`, which is byte-identical
 * to a genuinely up-to-date app, and `useUpdateChecker` branched on `available`
 * alone. So the single user-visible consequence of an organization forbidding
 * in-app updates was a green success toast — the app answering a question it had
 * refused to ask. The settings page already got this right
 * (`isUpdatesManagedOff`); the toast did not.
 *
 * `bun test` has no DOM here, so the RULE is tested as a pure function and the
 * WIRING is pinned by source match — the instrument
 * `app-settings-managed-updates.test.ts` uses in this repo, for the same reason.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import type { UpdateInfo } from '../../../shared/types'
import { classifyUpdateCheckOutcome } from '../useUpdateChecker'

/** The payload shape the update channel delivers. */
const payload = (overrides: Partial<UpdateInfo> = {}): UpdateInfo => ({
  available: false,
  currentVersion: '1.31.0',
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
  ...overrides,
})

describe('classifyUpdateCheckOutcome', () => {
  it('separates a managed refusal from an up-to-date app, which look identical otherwise', () => {
    const refusal = payload({ managedDisabled: true })
    const upToDate = payload()
    // Everything except the one flag is the same on both payloads — that IS the
    // detector problem, stated as an assertion.
    expect({ ...refusal, managedDisabled: undefined }).toEqual({ ...upToDate, managedDisabled: undefined })
    expect(classifyUpdateCheckOutcome(refusal)).toBe('managed')
    expect(classifyUpdateCheckOutcome(upToDate)).toBe('up-to-date')
  })

  it('reads the managed flag FIRST — a stale available:true cannot outvote it', () => {
    // `getUpdateInfo()` scrubs `available` under policy, but the renderer also
    // holds payloads from before the policy arrived; the flag has to win.
    expect(classifyUpdateCheckOutcome(payload({
      managedDisabled: true,
      available: true,
      latestVersion: '1.32.0',
      downloadState: 'ready',
    }))).toBe('managed')
  })

  it('still recognises a ready update and a download in flight', () => {
    expect(classifyUpdateCheckOutcome(payload({
      available: true, latestVersion: '1.32.0', downloadState: 'ready',
    }))).toBe('ready')
    expect(classifyUpdateCheckOutcome(payload({
      available: true, latestVersion: '1.32.0', downloadState: 'downloading',
    }))).toBe('pending')
    expect(classifyUpdateCheckOutcome(null)).toBe('pending')
  })

  it('is not fooled by managedDisabled: false, which is an ordinary check', () => {
    expect(classifyUpdateCheckOutcome(payload({ managedDisabled: false }))).toBe('up-to-date')
  })
})

describe('the hook branches on it before the success toast', () => {
  const source = readFileSync(fileURLToPath(new URL('../useUpdateChecker.ts', import.meta.url)), 'utf8')
  const present = (needle: string) => ({ needle, inSource: source.includes(needle) })
  const found = (needle: string) => ({ needle, inSource: true })

  it('classifies once, from the payload the check returned', () => {
    expect(present('const outcome = classifyUpdateCheckOutcome(info)'))
      .toEqual(found('const outcome = classifyUpdateCheckOutcome(info)'))
  })

  it('renders the precedent SENTENCE, not a "Managed" label', () => {
    // The settings page renders `settings.about.updatesManaged`; the toast says
    // the same thing, so the two surfaces cannot disagree — and the live case's
    // detector is that sentence.
    expect(present("toast.info(t('settings.about.updatesManaged')"))
      .toEqual(found("toast.info(t('settings.about.updatesManaged')"))
  })

  it('puts the managed branch AHEAD of the up-to-date branch', () => {
    const managed = source.indexOf("if (outcome === 'managed')")
    const upToDate = source.indexOf("else if (outcome === 'up-to-date')")
    expect(managed).toBeGreaterThanOrEqual(0)
    expect(upToDate).toBeGreaterThan(managed)
  })

  it('no longer decides the success toast from `available` alone', () => {
    expect(present('if (!info.available) {\n        toast.success')).toEqual({
      needle: 'if (!info.available) {\n        toast.success',
      inSource: false,
    })
  })
})

describe('the sentence exists in both locales', () => {
  it('carries the key the toast now uses', () => {
    const key = 'settings.about.updatesManaged'
    expect({ key, en: typeof (en as Record<string, unknown>)[key] }).toEqual({ key, en: 'string' })
    expect({ key, ru: typeof (ru as Record<string, unknown>)[key] }).toEqual({ key, ru: 'string' })
  })
})
