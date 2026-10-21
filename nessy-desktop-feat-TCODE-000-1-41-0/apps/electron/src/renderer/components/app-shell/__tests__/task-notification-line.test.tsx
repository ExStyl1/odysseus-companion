/**
 * F1.351 (renderer half) — a between-turns task notification is drawn as a
 * LABELLED SYSTEM LINE, never as the user's own bubble and never hidden.
 *
 * The host marks the entry (`Message.taskNotification`, pinned in
 * `packages/server-core/src/sessions/__tests__/task-notification-entry.test.ts`).
 * `MessageBubble` (`chat-display/MessageBubble.tsx` since UB14.14 extracted it from
 * `ChatDisplay`) reads the mark BEFORE its user branch and hands
 * the entry to `TaskNotificationLine`: the label says what it is and where it came
 * from, and the notification body — without the `<system-reminder>` frame and the
 * `<task-notification>` tags the user used to see printed literally — sits behind
 * a native disclosure. Instrument: `renderToStaticMarkup` (no DOM in this repo);
 * the component imports only React and react-i18next, so no pdfjs stub is needed.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskNotificationLine, taskNotificationBody } from '../task-notification-line'

const DELIVERY = [
  '<system-reminder>The block below is a background task notification delivered by the host: no human input has occurred.</system-reminder>',
  '<task-notification>',
  'Background subagent task t-1 finished (completed).',
  'All three checks passed.',
  '</task-notification>',
].join('\n')

let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en',
    resources: { en: { translation: { 'chat.taskNotification.label': 'chat.taskNotification.label' } } },
    interpolation: { escapeValue: false },
  })
})

describe('F1.351 — a task notification is a labelled system line', () => {
  it('THE ROW: the line carries the label and the body, and neither framing tag reaches the screen', () => {
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}><TaskNotificationLine content={DELIVERY} /></I18nextProvider>,
    )

    expect(markup).toContain('chat.taskNotification.label')
    expect(markup).toContain('Background subagent task t-1 finished (completed).')
    expect(markup).toContain('<details')
    expect(markup).not.toContain('&lt;task-notification&gt;')
    expect(markup).not.toContain('system-reminder')
  })

  it('the body is the text inside the block; a content without one is shown whole, not guessed at', () => {
    expect(taskNotificationBody(DELIVERY)).toBe('Background subagent task t-1 finished (completed).\nAll three checks passed.')
    expect(taskNotificationBody('a legacy row')).toBe('a legacy row')
  })

  it('MessageBubble reads the mark BEFORE its user branch, so a marked entry never becomes a user bubble', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'chat-display', 'MessageBubble.tsx'), 'utf-8')
    const bubble = src.slice(src.indexOf('export function MessageBubble({'))
    const mark = bubble.indexOf('message.taskNotification')
    const userBranch = bubble.indexOf("if (message.role === 'user') {")
    expect(mark).toBeGreaterThan(0)
    expect(userBranch).toBeGreaterThan(mark)
    expect(bubble.slice(mark, userBranch)).toContain('<TaskNotificationLine content={message.content} />')
  })

  it('CONTROL — an unmarked user entry still takes the user branch (the check is on the mark, not the role)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'chat-display', 'MessageBubble.tsx'), 'utf-8')
    const bubble = src.slice(src.indexOf('export function MessageBubble({'))
    const guard = bubble.slice(bubble.indexOf('message.taskNotification') - 40, bubble.indexOf('message.taskNotification') + 40)
    expect(guard).toContain("message.role === 'user' && message.taskNotification")
  })
})
