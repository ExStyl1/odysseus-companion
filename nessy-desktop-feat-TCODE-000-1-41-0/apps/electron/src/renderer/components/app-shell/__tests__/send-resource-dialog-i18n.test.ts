/**
 * F1.606 — the Send-to-workspace dialog for sources, skills and automations speaks the UI language.
 *
 * Before: `SendResourceToWorkspaceDialog` wrote its own text in English: the title, the
 * description, the empty list, Cancel / Send / Sending..., the loading toast, every result
 * toast, "Failed to send …" and the older-remote-version message. Only F1.577's toast
 * description went through `t()`. So a Russian UI showed an English dialog, while its session
 * twin, `SendToWorkspaceDialog`, was already translated.
 *
 * After: every string goes through `t()`, in every locale. The title reuses the twin's
 * `sendToWorkspace.title`. A phrase that names the resource type is a whole key per type,
 * not an English noun spliced into a sentence, because Russian inflects the noun by count
 * and by case.
 *
 * The dialog cannot be rendered here: its content sits in a Radix portal, which renders
 * nothing outside a DOM. So the wiring is read from the source, and the words are read
 * through a real i18next instance built from the real locale bundles, the way
 * `browser-window-i18n.test.ts` does it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { createInstance, type InitOptions } from 'i18next'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../SendResourceToWorkspaceDialog.tsx', import.meta.url)),
  'utf8',
)

/** The dialog's code with its comments removed, so a docblock that quotes a string is not read as code. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

const LOCALES = Object.keys(LOCALE_REGISTRY)
const MESSAGES = Object.fromEntries(
  Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [code, entry.messages as Record<string, string>]),
)

function instanceFor(lng: string) {
  const i18n = createInstance()
  i18n.init({
    lng,
    fallbackLng: false,
    resources: Object.fromEntries(
      Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [code, { translation: entry.messages }]),
    ),
    interpolation: { escapeValue: false },
    initImmediate: false, // synchronous init, the same cast `setupI18n` uses
  } as InitOptions)
  return i18n
}

/** Every key the dialog names: the first argument of each `t(...)` and each quoted key in a lookup table. */
function dialogKeys(): string[] {
  const keys = new Set<string>()
  for (const match of CODE.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) keys.add(match[1]!)
  for (const match of CODE.matchAll(/'((?:sendToWorkspace|common|toast)\.[A-Za-z0-9_.]+)'/g)) keys.add(match[1]!)
  return [...keys].sort()
}

/** The forms a key has in one locale: the key itself, or its plural family. */
function formsOf(messages: Record<string, string>, key: string): string[] {
  if (typeof messages[key] === 'string') return [messages[key]!]
  return ['few', 'many', 'one', 'other']
    .map(form => messages[`${key}_${form}`])
    .filter((value): value is string => typeof value === 'string')
}

function variablesOf(values: string[]): string[] {
  const names = new Set<string>()
  for (const value of values) for (const match of value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) names.add(match[1]!)
  return [...names].sort()
}

const CYRILLIC = /[А-Яа-яЁё]/

describe('F1.606 — no English text is written into the dialog', () => {
  it('none of the strings the row names is left in the code', () => {
    for (const english of [
      'Send to Workspace',
      'to another workspace',
      'No other workspaces available.',
      'Sending...',
      "'Send'",
      'Sent ',
      'already exist',
      'Nothing was sent',
      'Failed to send',
      'is running an older version',
      'Unknown error',
    ]) {
      expect({ english, found: CODE.includes(english) }).toEqual({ english, found: false })
    }
  })

  it('no JSX line is bare text: every visible word comes through t()', () => {
    const start = CODE.indexOf('<Dialog open=')
    const end = CODE.lastIndexOf('</Dialog>')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const bareText = CODE.slice(start, end)
      .split('\n')
      .map(line => line.trim())
      .filter(line => /[A-Za-z]/.test(line))
      .filter(line => !/^[{<)}/*]/.test(line))
      .filter(line => !/[=(<>'"]/.test(line))
    expect(bareText).toEqual([])
  })

  it('every toast the send raises takes its title from t()', () => {
    const calls = [...CODE.matchAll(/toast\.(loading|success|info|warning|error)\(\s*([^\n]{0,40})/g)]
    expect(calls.map(call => call[1])).toEqual(['loading', 'success', 'success', 'info', 'warning', 'error'])
    for (const call of calls) expect({ kind: call[1], title: call[2]!.startsWith('t(') }).toEqual({ kind: call[1], title: true })
  })

  it('the title is the session twin\'s key, and the buttons are keys too', () => {
    expect(CODE).toContain("t('sendToWorkspace.title')")
    expect(CODE).toContain("t('common.cancel')")
    expect(CODE).toContain("t('sendToWorkspace.resourceSend')")
    expect(CODE).toContain("t('sendToWorkspace.resourceSendingButton')")
  })

  it('a partial send counts the resources that ARRIVED, not the selection', () => {
    // The old sentence took its noun from the whole selection, so 1 of 2 read "Sent 1 skills".
    expect(CODE).toContain('{ count: imported }')
  })
})

describe('F1.606 — every key the dialog reads exists in every locale', () => {
  it('has more than one locale to check, otherwise this suite proves nothing', () => {
    expect(LOCALES.length).toBeGreaterThan(1)
  })

  it('the dialog reads the keys it is expected to (a floor, so an empty scan cannot pass)', () => {
    const keys = dialogKeys()
    for (const key of [
      'sendToWorkspace.title',
      'sendToWorkspace.resourceDescription',
      'sendToWorkspace.noOtherWorkspaces',
      'common.cancel',
      'sendToWorkspace.resourceSend',
      'sendToWorkspace.resourceSendingButton',
      'sendToWorkspace.resourceSending',
      'sendToWorkspace.resourceSent',
      'sendToWorkspace.resourceSentPartial',
      'sendToWorkspace.resourceAlreadyExists',
      'sendToWorkspace.resourceNothingSent',
      'sendToWorkspace.resourceUnsupportedRemote',
      'toast.unknownError',
      'sendToWorkspace.sourceCount',
      'sendToWorkspace.skillCount',
      'sendToWorkspace.automationCount',
      'sendToWorkspace.failedToSendSource',
      'sendToWorkspace.failedToSendSkill',
      'sendToWorkspace.failedToSendAutomation',
      'sendToWorkspace.resourceNotes',
    ]) {
      expect({ key, read: keys.includes(key) }).toEqual({ key, read: true })
    }
  })

  for (const lng of LOCALES) {
    it(`${lng}: every key resolves, with the same variables as en`, () => {
      for (const key of dialogKeys()) {
        const forms = formsOf(MESSAGES[lng]!, key)
        expect({ key, forms: forms.length > 0 }).toEqual({ key, forms: true })
        expect({ key, variables: variablesOf(forms) }).toEqual({ key, variables: variablesOf(formsOf(MESSAGES.en!, key)) })
      }
    })
  }

  it('ru: every key the dialog reads is written in Russian', () => {
    for (const key of dialogKeys()) {
      for (const value of formsOf(MESSAGES.ru!, key)) {
        expect({ key, value, russian: CYRILLIC.test(value) }).toEqual({ key, value, russian: true })
      }
    }
  })
})

describe('F1.606 — CONTROL: a Russian UI sending a skill', () => {
  const ru = instanceFor('ru')
  const en = instanceFor('en')

  it('shows a Russian title and Russian buttons', () => {
    expect(ru.t('sendToWorkspace.title')).toBe('Отправить в рабочее пространство')
    expect(ru.t('common.cancel')).toBe('Отмена')
    expect(ru.t('sendToWorkspace.resourceSend')).toBe('Отправить')
    expect(ru.t('sendToWorkspace.resourceSendingButton')).toBe('Отправка...')
  })

  it('inflects the skill count, where English only adds an s', () => {
    expect([1, 2, 5, 21].map(count => ru.t('sendToWorkspace.skillCount', { count })))
      .toEqual(['1 навык', '2 навыка', '5 навыков', '21 навык'])
    expect([1, 2].map(count => en.t('sendToWorkspace.skillCount', { count }))).toEqual(['1 skill', '2 skills'])
  })

  it('a partial send and a failed one read as whole Russian sentences', () => {
    const sent = ru.t('sendToWorkspace.skillCount', { count: 2 })
    expect(ru.t('sendToWorkspace.resourceSentPartial', { sent, skipped: 1 })).toBe('Отправлено: 2 навыка, уже существовали: 1')
    expect(ru.t('sendToWorkspace.failedToSendSkill', { count: 1 })).toBe('Не удалось отправить навык')
    expect(ru.t('sendToWorkspace.failedToSendSkill', { count: 3 })).toBe('Не удалось отправить навыки')
    expect(en.t('sendToWorkspace.resourceSentPartial', { sent: en.t('sendToWorkspace.skillCount', { count: 1 }), skipped: 1 }))
      .toBe('Sent 1 skill, 1 already existed')
  })

  it('English keeps the sentences the dialog showed before', () => {
    expect(en.t('sendToWorkspace.title')).toBe('Send to Workspace')
    expect(en.t('sendToWorkspace.resourceDescription', { resource: 'my-skill' })).toBe('Send my-skill to another workspace.')
    expect(en.t('sendToWorkspace.resourceSending', { resource: 'my-skill', target: 'Work' })).toBe('Sending my-skill to Work...')
    expect(en.t('sendToWorkspace.resourceSent', { resource: 'my-skill', target: 'Work' })).toBe('Sent my-skill to Work')
    expect(en.t('sendToWorkspace.resourceAlreadyExists', { resource: 'my-skill', target: 'Work' })).toBe('my-skill already exists in Work')
    expect(en.t('sendToWorkspace.resourceNothingSent', { target: 'Work' })).toBe('Nothing was sent to Work')
    expect(en.t('sendToWorkspace.failedToSendSkill', { count: 2 })).toBe('Failed to send skills')
    expect(en.t('sendToWorkspace.resourceUnsupportedRemote', { target: 'Work' }))
      .toBe("Work is running an older version that doesn't support resource import. Update the remote server and try again.")
  })
})

/** The code of a sibling file with its comments removed, the way {@link CODE} is read. */
function codeOf(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

// F1.626 (origin WJ-bx P-WJbx-1) — the multi-select "Send to workspace" from a sources/skills/automations list built
// its resource label in English (`${count} ${type}s`), so a Russian dialog read "Отправить 3 skills в …". The label
// now comes from F1.606's per-type count families.
describe('F1.626 — the multi-select label is a count key, not an English plural', () => {
  const PANEL = codeOf('../MainContentPanel.tsx')

  it('openSendDialog takes the label from the per-type count key and no longer splices the type', () => {
    expect(PANEL).toContain('setSendResourceLabel(t(RESOURCE_TYPE_KEYS[type].count, { count }))')
    expect(PANEL).not.toContain('${count} ${type}')
    expect(CODE).toContain('export const RESOURCE_TYPE_KEYS')
  })

  it('CONTROL: a Russian UI selecting 3 skills reads one Russian sentence', () => {
    const ru = instanceFor('ru')
    const resource = ru.t('sendToWorkspace.skillCount', { count: 3 })
    expect(ru.t('sendToWorkspace.resourceDescription', { resource })).toBe('Отправить 3 навыка в другое рабочее пространство.')
  })
})

// F1.627 (origin WJ-bx P-WJbx-2) — the session twin `SendToWorkspaceDialog.tsx`. Its Cancel / Send / Sending...
// went through t() since UA12.194 (0d58f2f47) and UA12.209 (6dd6b8033); the 'Unknown error' fallback and the
// `useCallback` dependency list that left out `t` were still open.
describe('F1.627 — the session send dialog has no English fallback and re-binds on a language change', () => {
  const TWIN = codeOf('../SendToWorkspaceDialog.tsx')

  it('the failure toast falls back to toast.unknownError, and handleTransfer depends on t', () => {
    expect(TWIN).not.toContain("'Unknown error'")
    expect(TWIN).toContain("t('toast.unknownError')")
    expect(TWIN).toMatch(/\}, \[selectedWorkspaceId, sessionIds, workspaces, onOpenChange, onTransferComplete, t\]\)/)
  })

  it('CONTROL: the buttons are still keys (UA12.194 / UA12.209), and the fallback is Russian in ru', () => {
    expect(TWIN).toContain("t('common.cancel')")
    expect(TWIN).toContain("t('sendToWorkspace.resourceSend')")
    expect(instanceFor('ru').t('toast.unknownError')).toBe('Неизвестная ошибка')
  })
})
