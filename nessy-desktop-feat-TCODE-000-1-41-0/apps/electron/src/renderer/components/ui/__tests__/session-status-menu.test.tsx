/**
 * UB14.35 (R6-06; v0.15.1 `ui/session-status-menu.tsx`) — the status menu's display names and its v0.15.1 material.
 *
 * `statusDisplayLabel(state, t)` is the one place a status's name is decided (the menu's rows, the compact session
 * menu, the chat header's status button): a BUILT-IN status (by id) reads its `status.<id>` key, a custom status
 * keeps the label its workspace configured — in every language. The menu itself is driven through the real i18n
 * instance under its own `I18nextProvider` (the singleton's init order across sibling files cannot decide it), and
 * read from a static render, so every assertion is on what a user would see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { setupI18n } from '@nessy-agent/shared/i18n/setupI18n'
import { SessionStatusMenu, statusDisplayLabel, type SessionStatus } from '../session-status-menu'

const LOCALES = join(import.meta.dir, '../../../../../../../packages/shared/src/i18n/locales')
const ru = JSON.parse(readFileSync(join(LOCALES, 'ru.json'), 'utf8')) as Record<string, string>
const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, string>

const i18n = setupI18n()
const previousLanguage = i18n.language

const status = (id: string, label: string): SessionStatus => ({
  id,
  label,
  resolvedColor: 'var(--muted-foreground)',
  icon: '•',
  iconColorable: false,
  category: 'open',
})

const TODO = status('todo', 'Todo')
const CUSTOM = status('blocked-on-review', 'Blocked on review')
/** A custom status that happens to share a built-in's English name: the ID decides, never the label. */
const CUSTOM_NAMED_LIKE_BUILT_IN = status('my-todo', 'Todo')

describe('statusDisplayLabel (UB14.35)', () => {
  it('POSITIVE — a built-in status is translated: `todo` reads its ru key', () => {
    const ruT = i18n.getFixedT('ru')
    expect(ru['status.todo']).toBeTruthy()
    expect(ru['status.todo']).not.toBe(TODO.label)
    expect(statusDisplayLabel(TODO, ruT)).toBe(ru['status.todo']!)
  })

  it('control — the same call in en reads the en key', () => {
    expect(statusDisplayLabel(TODO, i18n.getFixedT('en'))).toBe(en['status.todo']!)
  })

  it('NEGATIVE — a custom status keeps its configured label in ru', () => {
    expect(statusDisplayLabel(CUSTOM, i18n.getFixedT('ru'))).toBe('Blocked on review')
  })

  it('boundary — a custom status named like a built-in is not translated (the id decides)', () => {
    expect(statusDisplayLabel(CUSTOM_NAMED_LIKE_BUILT_IN, i18n.getFixedT('ru'))).toBe('Todo')
  })
})

describe('SessionStatusMenu on the v0.15.1 material (UB14.35)', () => {
  let markup = ''

  beforeAll(async () => {
    await i18n.changeLanguage('ru')
    markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(SessionStatusMenu, {
          states: [TODO, CUSTOM],
          activeState: 'todo',
          onSelect: () => {},
          onClear: () => {},
          onArchive: () => {},
        }),
      ),
    )
  })

  afterAll(async () => {
    await i18n.changeLanguage(previousLanguage)
  })

  it('POSITIVE — the command root is named (cmdk `label`) by the filter placeholder key', () => {
    expect(markup).toMatch(new RegExp(`<label cmdk-label=""[^>]*>${ru['status.filterStatuses']!.replace(/\./g, '\\.')}</label>`))
  })

  it('POSITIVE — floating surface, 30px rows, the active row on the selected fill, hairline separators', () => {
    expect(markup).toContain('popover-styled min-w-[180px] overflow-hidden')
    expect(markup).toContain('min-h-row-menu')
    expect(markup).toContain('bg-fill-selected')
    expect(markup.match(/bg-separator -mx-1 my-1 h-px/g)?.length).toBe(2)
    // Rows read the display names: the built-in translated, the custom one as configured.
    expect(markup).toContain(ru['status.todo']!)
    expect(markup).toContain('Blocked on review')
    expect(markup).toContain(ru['common.clear']!)
    expect(markup).toContain(ru['sessionMenu.archive']!)
  })

  it('NEGATIVE — none of the v0.14 material is left (opacity fills, the modal shadow, bordered separators)', () => {
    for (const old of ['bg-foreground/7', 'bg-foreground/3', 'shadow-modal-small', 'rounded-[8px]', 'border-t border-border/50', 'opacity-60']) {
      expect({ old, present: markup.includes(old) }).toEqual({ old, present: false })
    }
  })
})
