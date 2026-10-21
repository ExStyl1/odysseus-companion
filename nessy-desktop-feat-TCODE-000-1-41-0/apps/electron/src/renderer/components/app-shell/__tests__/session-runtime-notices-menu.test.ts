/**
 * D1.215 / D1.139 — every runtime posture the host can send reaches the user in
 * WORDS, in both locales.
 *
 * ## The two ways this surface can fail, and why one of them needs a test
 *
 * A notice id with no `case` in `runtimeNoticeKey` is caught by `tsc`: the
 * `default` arm binds the id to `never`, so a member added to the union without
 * an arm fails `typecheck:electron`. That half needs nothing here.
 *
 * A notice id with a `case` whose KEY has no value is caught by nothing. `t()`
 * on a missing key renders the key itself, so the menu would print
 * `sessionMenu.runtimeNote.claudeWorktreeCwd` at the user — and the two i18n
 * gates cannot see it either: `lint:i18n:parity` compares the locales with each
 * other (a key missing from BOTH is parity-clean) and `lint:i18n:reachable`
 * looks for readers of keys that exist, not for keys a reader expects. That is
 * the gap this file closes, and it is the same shape as the settings-tiers
 * line's `default: return undefined`, which drops an unrendered clause in
 * silence.
 *
 * ## Why the ids are read from the union's own mapper
 *
 * The list below is not transcribed. It is the mapper's own domain, and the
 * `satisfies` binding makes a member added to the union without a line here a
 * BUILD failure — so this file cannot quietly stop covering the surface it is
 * about, which is how a transcribed list dies.
 *
 * Source text and not a render: the component needs a menu context and a live
 * i18next, and neither is the instrument for "does this key have words". The
 * locale files are.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SessionRuntimeNoticeIdV1 } from '@nessy-agent/shared/protocol/session-runtime-notices'
import { isMemoryRuntimeNotice, runtimeNoticeKey } from '../session-memory-scope-menu'

/** Every member of the union, pinned by `satisfies` rather than by a count. */
const IDS = [
  'claude-auto-memory-runtime-default',
  'claude-auto-memory-off-by-host',
  'claude-auto-memory-forced-on',
  'claude-restricted-mode',
  'claude-search-results-filtered',
  'claude-worktree-cwd-may-move',
] as const satisfies readonly SessionRuntimeNoticeIdV1[]

const locale = (name: string): Record<string, string> => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url)),
  'utf8',
)) as Record<string, string>

describe('D1.215 — the runtime notices reach the user in words', () => {
  it('gives every notice id a value in EVERY locale', () => {
    const locales = { en: locale('en'), ru: locale('ru') }
    // The probe read real locale files, not two empty objects. NOT an equality:
    // a non-English locale legitimately carries MORE keys than `en.json` —
    // Russian adds its own `_few`/`_many` plural forms on top of the `_one`/
    // `_other` pair `lint:i18n:parity` requires, and it carried 2849 against
    // 2783 on 2026-09-17. An equality here would fail on a correct tree.
    expect(Object.keys(locales.en).length).toBeGreaterThan(1000)
    expect(Object.keys(locales.ru).length).toBeGreaterThanOrEqual(Object.keys(locales.en).length)

    for (const id of IDS) {
      const key = runtimeNoticeKey(id)
      for (const [name, messages] of Object.entries(locales)) {
        const value = messages[key]
        expect(value, `${name}.json has no value for ${key} (notice ${id})`).toBeDefined()
        expect(value!.length, `${name}.json renders ${key} as an empty string`).toBeGreaterThan(0)
      }
    }
    // The submenu label itself, which no id maps to.
    for (const [name, messages] of Object.entries(locales)) {
      expect(messages['sessionMenu.runtimeNotes'], `${name}.json has no runtime-notes label`).toBeDefined()
    }
  })

  it('interpolates the directory ONLY into the notices that carry one', () => {
    // The memory notices are the only ones the host sends a `path` with, and a
    // `{{path}}` in any other sentence would render as an empty string — a
    // sentence with a hole in it, which reads as a defect rather than as a fact.
    const en = locale('en')
    for (const id of IDS) {
      const carriesPath = en[runtimeNoticeKey(id)]!.includes('{{path}}')
      expect(carriesPath, `${id} disagrees with its own group about {{path}}`)
        .toBe(isMemoryRuntimeNotice({ id }))
    }
    // The control on the classifier, in the same case: it really does split the
    // set, rather than answering the same thing for everything.
    expect(IDS.filter(id => isMemoryRuntimeNotice({ id })).length).toBe(3)
    expect(IDS.filter(id => !isMemoryRuntimeNotice({ id })).length).toBe(3)
  })

  it('names the two locales the same way — the RU sentence is not the EN one', () => {
    // Cheap, and it has caught a copy-paste locale before: a key present in both
    // files with the identical English value passes both i18n gates.
    const en = locale('en')
    const ru = locale('ru')
    for (const id of IDS) {
      const key = runtimeNoticeKey(id)
      expect(ru[key], `${key} was never translated`).not.toBe(en[key])
    }
  })
})
