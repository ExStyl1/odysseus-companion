/**
 * F1.1266 (origin: the final sitting SIT2-f, TRIAGE D-22a) — the Russian composer showed "Work in Folder" and "Low".
 *
 * "Work in Folder" is a result at HEAD: UA12.206 (`c58cb4d8a`) routed the folder fallback through upstream's own
 * `chat.workInFolder`, pinned in `renderer-hardcoded-strings.test.ts`. "Low" is the model chip's effort pill
 * (`r-picker-ru-dontask.png`: "DeepSeek V4 F… Low"): FreeFormInput rendered the raw level id with CSS
 * `capitalize`, so every locale read the English id. It now reads the level's own name key — the same
 * `getThinkingLevelNameKey` the model picker's effort row uses — so ru shows «Низкая».
 *
 * UB14.30 — the pill moved with the trigger into `ComposerModelMenu` (v0.15.1's boundary), so the wiring is read
 * there; `composer-model-menu.test.tsx` renders it. The words come from the shipped locale bundles.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { THINKING_LEVELS, getThinkingLevelNameKey } from '@nessy-agent/shared/agent/thinking-levels'

const SOURCE = readFileSync(fileURLToPath(new URL('../ComposerModelMenu.tsx', import.meta.url)), 'utf8')
const COMPOSER = readFileSync(fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)), 'utf8')

describe('F1.1266 — the composer effort pill speaks the UI language', () => {
  it('the pill reads the level name through t(), never the raw level id', () => {
    const pill = SOURCE.slice(SOURCE.indexOf('data-effort-pill')).slice(0, 300)
    expect(pill).toContain('{t(getThinkingLevelNameKey(thinkingLevel))}')
    // The old child: the bare id on its own line inside the pill span.
    expect(SOURCE).not.toMatch(/^\s*\{thinkingLevel\}\s*$/m)
    // UB14.30 — the composer no longer draws a pill of its own (one trigger, in the menu component).
    expect(COMPOSER).not.toContain('getThinkingLevelNameKey')
  })

  it('every level the pill can show has a name in en and a different one in ru', () => {
    const enMessages = en as Record<string, string>
    const ruMessages = ru as Record<string, string>
    for (const { id } of THINKING_LEVELS) {
      if (id === 'off') continue // the pill is hidden for off
      const key = getThinkingLevelNameKey(id)
      expect({ key, en: typeof enMessages[key], ru: typeof ruMessages[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: enMessages[key] === ruMessages[key] }).toEqual({ key, same: false })
    }
    // CONTROL: the value the sitting saw.
    expect(ruMessages[getThinkingLevelNameKey('low')]).toBe('Низкая')
  })
})
