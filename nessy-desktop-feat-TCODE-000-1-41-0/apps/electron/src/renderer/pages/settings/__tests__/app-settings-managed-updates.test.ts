/**
 * P2.10 — the About card's "Managed" indicator for in-app updates.
 *
 * `bun test` has no DOM in this repo, so the RULE is tested as a pure function
 * and the WIRING is pinned by source match — the instrument
 * `ai-settings-reconnect.test.ts` uses in this same directory, for the same
 * reason.
 *
 * What the wiring assertions are really defending: the flag arrives on the
 * update payload from the main process, and the page has three consequences
 * that must all read the SAME flag — the disabled Check Now button, the muted
 * managed line, and the suppressed "Restart to Update" row. A page that
 * disabled the button and still offered the install would offer an install
 * `installUpdate` refuses.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import type { UpdateInfo } from '../../../../shared/types'

// `AppSettingsPage` imports `@nessy-agent/ui`, whose barrel ends at
// `pdfjs-dist/build/pdf.worker.min.mjs?url` — a `?url` import bun's test runner
// cannot load, and the throw kills the module graph for the whole process.
// These stubs and the DOMMatrix shim are verbatim from
// `ai-settings-reconnect.test.ts`, which documents why replacing a THIRD-PARTY
// module in full is outside the `mock.module` amputation trap.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

// Loaded AFTER the stubs — a static import is hoisted above them.
let isUpdatesManagedOff: typeof import('../AppSettingsPage').isUpdatesManagedOff
let updatesManagedSourceKey: typeof import('../AppSettingsPage').updatesManagedSourceKey

/**
 * The budget, with the measurement that forced it (P3.240).
 *
 * `AppSettingsPage`'s module graph reaches `@nessy-agent/ui`, and that import
 * BLOCKS while it resolves — 0.5 s of CPU for tens of seconds of wall clock
 * under parallel-lane load, which is the contention shape x5 recorded on
 * `instruction-excludes-envelope.test.ts` in `bd6eb9915`. Measured here on
 * 2026-08-29 with lanes running: this file's hook took 43.5 s and 46.6 s on two
 * runs, and the untouched sibling `ai-settings-reconnect.test.ts` — the positive
 * control, same import shape, unchanged at HEAD — took 102.8 s on the same rig
 * and failed the same way. So the default hook budget sits BELOW this suite's
 * resting cost under load, which is the narrowing-knob trap: a bound set against
 * an idle machine manufactures its own failure. 240 s is over twice the slowest
 * reading, and the import is a one-off — the 19 assertions after it are pure
 * functions and string matches that run in milliseconds.
 */
const PAGE_IMPORT_BUDGET_MS = 240_000

beforeAll(async () => {
  const page = await import('../AppSettingsPage')
  isUpdatesManagedOff = page.isUpdatesManagedOff
  updatesManagedSourceKey = page.updatesManagedSourceKey
}, PAGE_IMPORT_BUDGET_MS)

/** The payload shape the update channel delivers. */
const payload = (overrides: Partial<UpdateInfo> = {}): UpdateInfo => ({
  available: false,
  currentVersion: '1.31.0',
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
  ...overrides,
})

describe('isUpdatesManagedOff', () => {
  it('is true only on an explicit managed refusal from the main process', () => {
    expect(isUpdatesManagedOff(payload({ managedDisabled: true }))).toBe(true)
  })

  it('is false on an ordinary up-to-date payload — the state a refusal otherwise looks like', () => {
    expect(isUpdatesManagedOff(payload())).toBe(false)
    expect(isUpdatesManagedOff(payload({ managedDisabled: false }))).toBe(false)
  })

  it('is false while the page has not heard from the updater yet', () => {
    // `useUpdateChecker` starts at null, so this is the first render of every
    // launch: an indicator that showed here would accuse an unmanaged install.
    expect(isUpdatesManagedOff(null)).toBe(false)
    expect(isUpdatesManagedOff(undefined)).toBe(false)
  })

  it('does not confuse an available update with a managed one', () => {
    expect(isUpdatesManagedOff(payload({ available: true, latestVersion: '1.32.0', downloadState: 'ready' })))
      .toBe(false)
  })
})

describe('the indicator string exists in both locales', () => {
  it('carries the new key', () => {
    const key = 'settings.about.updatesManaged'
    expect({ key, en: typeof (en as Record<string, unknown>)[key] }).toEqual({ key, en: 'string' })
    expect({ key, ru: typeof (ru as Record<string, unknown>)[key] }).toEqual({ key, ru: 'string' })
  })

  /**
   * P3.240 — the three source lines, checked through the FUNCTION that names
   * them rather than against a literal list. A key added to the switch and to
   * one locale only would pass a hand-written list and render a raw key id.
   */
  it('carries every key the source line can ask for', () => {
    for (const managedSource of ['host', 'codex', 'both'] as const) {
      const key = updatesManagedSourceKey(payload({ managedDisabled: true, managedSource }))
      expect({ managedSource, key: typeof key }).toEqual({ managedSource, key: 'string' })
      expect({ managedSource, en: typeof (en as Record<string, unknown>)[key as string] })
        .toEqual({ managedSource, en: 'string' })
      expect({ managedSource, ru: typeof (ru as Record<string, unknown>)[key as string] })
        .toEqual({ managedSource, ru: 'string' })
    }
  })
})

/**
 * P3.240 — the indicator says a policy exists; this says WHOSE.
 *
 * Two documents can set the switch — the host's `managed-policy.json` and a
 * codex deployment's `requirements.toml` — and they are changed by different
 * people in different places, so the sentence P2.10 shipped is true of both and
 * actionable for neither.
 */
describe('updatesManagedSourceKey', () => {
  it('names each tier the main process can report', () => {
    expect(updatesManagedSourceKey(payload({ managedDisabled: true, managedSource: 'host' })))
      .toBe('settings.about.updatesManagedByHost')
    expect(updatesManagedSourceKey(payload({ managedDisabled: true, managedSource: 'codex' })))
      .toBe('settings.about.updatesManagedByCodex')
    expect(updatesManagedSourceKey(payload({ managedDisabled: true, managedSource: 'both' })))
      .toBe('settings.about.updatesManagedByBoth')
  })

  it('says nothing when the payload does not carry a source', () => {
    // A main process older than P3.240, and the state a fresh install is in.
    // The P2.10 sentence stands on its own, which is why this is an extra line.
    expect(updatesManagedSourceKey(payload({ managedDisabled: true }))).toBeUndefined()
  })

  it('says nothing while updates are not managed off', () => {
    // The failure this gate prevents: a managed sentence under a card that is
    // not managed. Includes the contradictory payload, because a renderer must
    // not be the place that decides which half of a bad payload to believe.
    expect(updatesManagedSourceKey(payload())).toBeUndefined()
    expect(updatesManagedSourceKey(payload({ managedSource: 'host' }))).toBeUndefined()
    expect(updatesManagedSourceKey(payload({ managedDisabled: false, managedSource: 'both' })))
      .toBeUndefined()
    expect(updatesManagedSourceKey(null)).toBeUndefined()
    expect(updatesManagedSourceKey(undefined)).toBeUndefined()
  })

  it('says nothing for a source string this build does not know', () => {
    // A newer main process naming a third document. An unknown id would render
    // as the raw key.
    expect(updatesManagedSourceKey(payload({
      managedDisabled: true,
      managedSource: 'mdm' as UpdateInfo['managedSource'],
    }))).toBeUndefined()
  })
})

describe('AppSettingsPage wires all three consequences through this function', () => {
  const source = readFileSync(fileURLToPath(new URL('../AppSettingsPage.tsx', import.meta.url)), 'utf8')
  // `toContain` would print the whole page on failure — report the needle.
  const present = (needle: string) => ({ needle, inSource: source.includes(needle) })
  const found = (needle: string) => ({ needle, inSource: true })

  it('reads the flag once, from the update payload', () => {
    expect(present('const updatesManagedOff = isUpdatesManagedOff(updateChecker.updateInfo)'))
      .toEqual(found('const updatesManagedOff = isUpdatesManagedOff(updateChecker.updateInfo)'))
  })

  it('disables Check Now, shows the managed line, and withdraws the install row', () => {
    for (const needle of [
      'disabled={isCheckingForUpdates || updatesManagedOff}',
      '{isElectron && updatesManagedOff && (',
      '{t("settings.about.updatesManaged")}',
      '{isElectron && !updatesManagedOff && updateChecker.isReadyToInstall',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
  })

  it('renders the source line inside the managed block, under the existing one', () => {
    for (const needle of [
      'const updatesManagedSource = updatesManagedSourceKey(updateChecker.updateInfo)',
      '{updatesManagedSource && <div>{t(updatesManagedSource)}</div>}',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }
  })

  /**
   * UB15.5 — repointed from the class string the block spelled by hand until v0.15.1's material reached this page
   * (that needle pinned a spelling, not the indicator). What it now pins is the indicator itself: WHERE the managed
   * line renders, and that the install row cannot render beside it.
   */
  it('POSITIVE — the managed line renders under Check Now, on the card-note material the retention note shares', () => {
    const checkNow = source.indexOf('t("settings.about.checkNow")')
    const block = managedBlock(source)
    expect({ checkNow: checkNow > -1, block: block !== undefined }).toEqual({ checkNow: true, block: true })
    // Under Check Now: the block opens after the Check Now row in the About card.
    expect(source.indexOf(MANAGED_GUARD)).toBeGreaterThan(checkNow)
    // The indicator's two lines, in order, inside the shared note block.
    expect(inOrder(block!, [
      '<div className={CARD_NOTE_CLASS}>',
      '{t("settings.about.updatesManaged")}',
      '{updatesManagedSource && <div>{t(updatesManagedSource)}</div>}',
    ])).toBe(true)
    // One note material for the page: v0.15.1's in-card padding + prose, and the retention note on the same class,
    // so the two managed indicators still read as one pattern.
    expect(present('const CARD_NOTE_CLASS = cn(settingsUI.cardPadding, settingsUI.prose)'))
      .toEqual(found('const CARD_NOTE_CLASS = cn(settingsUI.cardPadding, settingsUI.prose)'))
    const retention = source.slice(source.indexOf('settings.retention.title'), source.indexOf('settings.retention.managed'))
    expect(retention.includes('<div className={CARD_NOTE_CLASS}>')).toBe(true)
  })

  it('NEGATIVE — no install row when managed-off: every install call sits under a !updatesManagedOff guard', () => {
    expect(unguardedInstallCalls(source)).toEqual({ calls: 1, unguarded: 0 })
    expect(managedBlock(source)!.includes('installUpdate')).toBe(false)
    // And no hand-spelled legacy note block survives anywhere on the page.
    expect(legacyNoteBlocks(source)).toBe(0)
  })

  it('CONTROL — both instruments fire on the shapes they exist to catch', () => {
    const plantedUnguarded = [
      MANAGED_GUARD,
      '  <div className={CARD_NOTE_CLASS}>{t("settings.about.updatesManaged")}</div>',
      ')}',
      '{isElectron && updateChecker.isReadyToInstall && (',
      '  <Button onClick={updateChecker.installUpdate} />',
      ')}',
    ].join('\n')
    expect(unguardedInstallCalls(plantedUnguarded)).toEqual({ calls: 1, unguarded: 1 })
    expect(legacyNoteBlocks('<div className="px-4 py-3.5 text-sm text-muted-foreground space-y-1">')).toBe(1)
    expect(inOrder('a b c', ['c', 'a'])).toBe(false)
  })
})

/** The About card's managed-off branch opener. */
const MANAGED_GUARD = '{isElectron && updatesManagedOff && ('

/** The managed block: from its guard to the install row's guard (undefined when either is missing). */
function managedBlock(src: string): string | undefined {
  const start = src.indexOf(MANAGED_GUARD)
  const end = src.indexOf('{isElectron && !updatesManagedOff && updateChecker.isReadyToInstall', start)
  return start > -1 && end > start ? src.slice(start, end) : undefined
}

/**
 * Every `updateChecker.installUpdate` call, and how many of them are NOT under a branch whose opener (the nearest
 * `{isElectron` before it, read to the end of its line) carries `!updatesManagedOff`.
 */
function unguardedInstallCalls(src: string): { calls: number; unguarded: number } {
  let calls = 0
  let unguarded = 0
  for (let at = src.indexOf('updateChecker.installUpdate'); at > -1; at = src.indexOf('updateChecker.installUpdate', at + 1)) {
    calls++
    const opener = src.lastIndexOf('{isElectron', at)
    const lineEnd = src.indexOf('\n', opener)
    if (opener < 0 || !src.slice(opener, lineEnd < 0 ? undefined : lineEnd).includes('!updatesManagedOff')) unguarded++
  }
  return { calls, unguarded }
}

/** Note blocks still on the pre-v0.15.1 hand-spelled material. */
function legacyNoteBlocks(src: string): number {
  return src.match(/px-4 py-3\.5 text-sm text-muted-foreground/g)?.length ?? 0
}

/** Whether every needle occurs, each after the previous one. */
function inOrder(haystack: string, needles: readonly string[]): boolean {
  let from = 0
  for (const needle of needles) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    from = at + needle.length
  }
  return true
}
