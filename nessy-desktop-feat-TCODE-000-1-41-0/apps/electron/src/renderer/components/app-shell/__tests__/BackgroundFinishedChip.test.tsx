/**
 * UA1.15 — the chip itself, its mount, the App-level wiring and the Appearance
 * toggle. The selection rule and the detector are unit-tested in
 * `atoms/__tests__/background-finished.test.ts`; this file renders the chip
 * (`renderToStaticMarkup`, no DOM in this repo's `bun test`) and pins from
 * source what a render cannot reach: the click path, the mounts, and that the
 * OS notification call is untouched.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { BackgroundFinishedChip } from '../BackgroundFinishedChip'
import { queueBackgroundFinished, showBackgroundFinishedChipAtom } from '@/atoms/background-finished'
import { focusedPanelIdAtom, panelStackAtom } from '@/atoms/panel-stack'
import { routes } from '../../../../shared/routes'

const RENDERER_DIR = join(import.meta.dir, '..', '..', '..')
const LOCALES_DIR = join(RENDERER_DIR, '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf8')) as Record<string, string>
const read = (rel: string) => readFileSync(join(RENDERER_DIR, rel), 'utf8')

const FOREGROUND = 'session-on-screen'
const BACKGROUND = 'session-in-background'

let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

function render(opts: { enabled: boolean; finished?: string }) {
  const store = createStore()
  store.set(panelStackAtom, [
    { id: 'panel-1', route: routes.view.allSessions(FOREGROUND), proportion: 1, panelType: 'session', laneId: 'main' },
  ])
  store.set(focusedPanelIdAtom, 'panel-1')
  // Queue while ON so the queue is populated, then set the preference under test:
  // the render gate must hold on its own, not only through the detector.
  store.set(showBackgroundFinishedChipAtom, true)
  if (opts.finished) queueBackgroundFinished(store, opts.finished, { id: opts.finished, name: 'Refactor the importer' })
  store.set(showBackgroundFinishedChipAtom, opts.enabled)
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <Provider store={store}>
        <BackgroundFinishedChip sessionId={FOREGROUND} />
      </Provider>
    </I18nextProvider>,
  )
}

describe('UA1.15 — BackgroundFinishedChip renders', () => {
  it('POSITIVE — preference on + a background completion: ONE chip button, titled, labelled with the localized text', () => {
    const html = render({ enabled: true, finished: BACKGROUND })
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).toContain('Refactor the importer')
    expect(html).toContain(`aria-label="Refactor the importer — ${en['chat.backgroundSessionFinished']}"`)
  })

  it('NEGATIVE — preference off: nothing renders, even with a queued completion', () => {
    expect(render({ enabled: false, finished: BACKGROUND })).toBe('')
  })

  it('NEGATIVE — the row\'s own (foreground) session is never its own announcer', () => {
    expect(render({ enabled: true, finished: FOREGROUND })).toBe('')
  })
})

describe('UB14.27 — v0.15.1 moved the chip ABOVE the composer card, on the floating material', () => {
  it('POSITIVE — the chip sits just above the box, right-aligned (it never covers the draft), with the snap spring', () => {
    const html = render({ enabled: true, finished: BACKGROUND })
    expect(html).toContain('class="absolute right-0 bottom-full mb-2 z-20"')
    expect(html).toContain('bg-floating text-label-sm font-medium text-foreground shadow-elev-2')
    expect(html).toContain('text-accent')
    expect(read('components/app-shell/BackgroundFinishedChip.tsx')).toContain('const chipSpring = SPRING.snap')
  })

  it('NEGATIVE — no longer inside the box\'s top-right corner, and the purple glass is gone', () => {
    const html = render({ enabled: true, finished: BACKGROUND })
    expect(html).not.toContain('right-2 top-2')
    for (const old of ['purple', 'shadow-tinted', 'backdrop-blur-md', '--shadow-color']) {
      expect({ old, inMarkup: html.includes(old) }).toEqual({ old, inMarkup: false })
    }
  })
})

describe('UA1.15 — the click opens that session, and the wiring is real', () => {
  const chip = read('components/app-shell/BackgroundFinishedChip.tsx')

  it('a click dissolves the chip, then dismisses the entry and navigates to the FINISHED session', () => {
    for (const needle of [
      'onClick={() => startDismiss(entry.sessionId)}',
      'onExitComplete={finishDismiss}',
      'dismiss(targetId)',
      'if (nav) nav.navigateToSession(targetId)',
      'else navigate(routes.view.allSessions(targetId))',
    ]) {
      expect({ needle, inSource: chip.includes(needle) }).toEqual({ needle, inSource: true })
    }
  })

  it('is mounted by InputContainer, freeform only, above the composer (the composer itself is not changed)', () => {
    const container = read('components/app-shell/input/InputContainer.tsx')
    expect(container).toContain("{mode === 'freeform' && freeFormProps.sessionId && (")
    expect(container).toContain('<BackgroundFinishedChip sessionId={freeFormProps.sessionId} />')
    expect(read('components/app-shell/input/FreeFormInput.tsx')).not.toContain('BackgroundFinishedChip')
  })

  it('App.tsx queues on the SAME complete branch as the OS notification, which keeps its call unchanged', () => {
    const app = read('App.tsx')
    const call = "showSessionNotification(updatedSession, preview, 'turn-completion')"
    expect(app).toContain(call)
    expect(app).toContain(`${call}; queueBackgroundFinished(store, sessionId, updatedSession)`)
  })

  it('the Appearance page carries the toggle, labelled by both keys, in en AND ru', () => {
    const page = read('pages/settings/AppearanceSettingsPage.tsx')
    expect(page).toContain('t("settings.appearance.backgroundFinishedChip")')
    expect(page).toContain('t("settings.appearance.backgroundFinishedChipDesc")')
    expect(page).toContain('checked={showBackgroundFinishedChip}')
    for (const key of ['chat.backgroundSessionFinished', 'settings.appearance.backgroundFinishedChip', 'settings.appearance.backgroundFinishedChipDesc']) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
    }
  })
})
