/**
 * UB14.33 (R4-13) — `ComposerHintLine`, v0.15.1's shortcut hints under the composer card (ADDED in v0.15.0), and the
 * `ChatInputZone` that mounts it.
 *
 * Instruments, without a DOM (this repo ships none):
 * - `renderToStaticMarkup` of the hint line, strings from the shipped `en.json`. A static render runs no effect, so
 *   the Send-message-key setting is never read here: `sendMessageKey` pins it (the component's own seam for this);
 *   the cycle binding comes in as `cycleHotkey`, the value `ChatInputZone` reads from the action registry;
 * - the comment-stripped SOURCE of `ChatInputZone` for the mount, its order under the deep-link notice and the
 *   badge-row mode rule (the composer's module graph reaches Vite-only imports, so it is not rendered here; the dark
 *   playground sweep in `registry-render.test.ts` renders it for real).
 *
 * Before the row there was no hint line at all (`ComposerHintLine.tsx` absent), so every POSITIVE arm fails on it.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import { isMac } from '@/lib/platform'
import { ComposerHintLine, type ComposerHintLineProps } from '../ComposerHintLine'

const EN = LOCALE_REGISTRY.en.messages as Record<string, string>
const SHIFT = isMac ? '⇧' : 'Shift'
const MOD = isMac ? '⌘' : 'Ctrl'
const ENTER = '↵'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    resources: { en: { translation: EN } },
    interpolation: { escapeValue: false },
  })
})

const render = (props: ComposerHintLineProps) =>
  renderToStaticMarkup(<I18nextProvider i18n={testI18n}><ComposerHintLine {...props} /></I18nextProvider>)

/** Each hint as drawn: its keycaps in order and the label after them. */
function hints(markup: string): Array<{ keys: string[]; label: string }> {
  return [...markup.matchAll(/<span class="inline-flex items-center gap-1">(.*?)<\/span>/g)].map(([, body]) => ({
    keys: [...body!.matchAll(/<kbd data-slot="kbd"[^>]*>([^<]*)<\/kbd>/g)].map(([, key]) => key!),
    label: body!.slice(body!.lastIndexOf('</kbd>') + '</kbd>'.length),
  }))
}

describe('the send and new-line keys follow the Send-message-key setting', () => {
  it('POSITIVE — cmd-enter: Send is ⌘↵ (Ctrl+↵ off macOS) and a bare ↵ is the new line', () => {
    const drawn = hints(render({ sendMessageKey: 'cmd-enter' }))
    expect(drawn.slice(0, 2)).toEqual([
      { keys: [MOD, ENTER], label: EN['shortcuts.sendMessage']! },
      { keys: [ENTER], label: EN['shortcuts.newLine']! },
    ])
  })

  it('CONTROL — enter (the default): Send is ↵ and ⇧↵ is the new line, so the arm above can fail', () => {
    const drawn = hints(render({ sendMessageKey: 'enter' }))
    expect(drawn.slice(0, 2)).toEqual([
      { keys: [ENTER], label: EN['shortcuts.sendMessage']! },
      { keys: [SHIFT, ENTER], label: EN['shortcuts.newLine']! },
    ])
  })
})

describe('the reserved line (decision prompts)', () => {
  it('NEGATIVE (control) — empty renders no hint, no keycap and no label, but keeps the h-6 line and its fade', () => {
    const markup = render({ empty: true, sendMessageKey: 'cmd-enter' })
    expect(hints(markup)).toEqual([])
    expect(markup).not.toContain('<kbd')
    expect(markup).not.toContain(EN['shortcuts.sendMessage']!)
    const line = markup.match(/<div[^>]*data-composer-hints[^>]*>/)?.[0] ?? ''
    expect(line).toContain('aria-hidden="true"')
    for (const cls of ['mt-2.5', 'h-6', 'opacity-0', 'peer-focus-within/composer:opacity-100']) {
      expect({ cls, present: line.split('"').some(part => part.split(' ').includes(cls)) }).toEqual({ cls, present: true })
    }
  })

  it('narrow panels drop the new-line hint under 24rem and the mode hint under 32rem; Send always stays', () => {
    const markup = render({ sendMessageKey: 'enter' })
    expect(markup).toContain('<span class="contents @max-[24rem]/panel:hidden"><span class="inline-flex items-center gap-1">')
    expect(markup).toContain('<span class="contents @max-[32rem]/panel:hidden"><span class="inline-flex items-center gap-1">')
    expect(markup.indexOf(EN['shortcuts.sendMessage']!)).toBeLessThan(markup.indexOf('@max-[24rem]/panel:hidden'))
  })
})

describe('the cycle hint names the binding the user has (P6.49)', () => {
  it('POSITIVE — no registry: the shipped ⇧Tab, labelled with chat.permissionMode (F1.358\'s key for upstream\'s mode.permissionMode)', () => {
    expect(hints(render({ sendMessageKey: 'enter' }))[2]).toEqual({ keys: [SHIFT, 'Tab'], label: EN['chat.permissionMode']! })
  })

  it('POSITIVE — a rebinding is drawn as rebound', () => {
    expect(hints(render({ sendMessageKey: 'enter', cycleHotkey: 'mod+shift+m' }))[2]?.keys).toEqual([MOD, SHIFT, 'M'])
  })

  it('NEGATIVE — an unbound action (null) draws no cycle hint, and no empty wrapper for it', () => {
    const markup = render({ sendMessageKey: 'enter', cycleHotkey: null })
    expect(hints(markup).map(h => h.label)).toEqual([EN['shortcuts.sendMessage'], EN['shortcuts.newLine']])
    expect(markup).not.toContain('@max-[32rem]/panel:hidden')
  })
})

describe('ChatInputZone mounts the line (source)', () => {
  const zone = readFileSync(new URL('../ChatInputZone.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('POSITIVE — desktop only, empty during a decision prompt, fed the registry\'s binding, below the deep-link notice', () => {
    const mount = '{!compactMode && <ComposerHintLine empty={!!inputProps.structuredInput} cycleHotkey={cycleHotkey} />}'
    expect(zone).toContain(mount)
    expect(zone).toContain("const cycleHotkey = useOptionalActionRegistry()?.getHotkey('chat.cyclePermissionMode')")
    // Below the card AND the notice (deep-links contract: the notice sits right under the box), outside the error
    // boundary so a crashed composer keeps its reserved line.
    const notice = zone.indexOf('{externalPromptNotice && (')
    const boundaryEnd = zone.indexOf('</InputErrorBoundary>')
    expect({ notice: notice > -1, order: notice < boundaryEnd && boundaryEnd < zone.indexOf(mount) }).toEqual({ notice: true, order: true })
  })

  it('NEGATIVE — the badge row shows the mode only while a decision prompt replaces the toolbar, never by layout', () => {
    expect(zone).toContain('showPermissionMode={!!inputProps.structuredInput}')
    expect(zone).not.toContain('showPermissionMode={compactMode}')
  })

  it('the valued-label editor request goes to the chat header\'s atom; the badge-row auto-open is gone', () => {
    expect(zone).toContain('setPendingLabelValueEdit({ sessionId, panelId, labelId, requestedAt: Date.now() })')
    expect(zone).toContain('if (config?.valueType && !compactMode) {')
    expect(zone).not.toContain('autoOpenLabelId')
  })

  it('upstream\'s bottom padding: the 16px gutter in compact, 14px on desktop (the hint line reserves its own 24px)', () => {
    expect(zone).toContain("compactMode ? 'pb-gutter' : 'pb-3.5'")
    expect(zone).not.toContain("'pb-3' : 'pb-4'")
  })
})
