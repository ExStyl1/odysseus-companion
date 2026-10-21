/**
 * P6.51 — the queue strip's fourth verb.
 *
 * `learn.chatgpt.com/docs/prompting.md#steering-and-queuing`: "Queued messages
 * appear above the composer, where you can edit, reorder, send, or delete
 * them." The strip
 * shipped edit / steer / delete, and `reorder` was a comment.
 *
 * These are source-level assertions for `BranchSwitcher.test.tsx`'s reason —
 * `bun test` has no DOM and the UI barrel is not resolvable here — and they are
 * deliberately pointed at the thing that made this row dangerous rather than at
 * the buttons: a strip that sorted its own array would look exactly like the row
 * closing while changing nothing about the send order. So the assertion is that
 * the control asks the SERVER, and that no local reordering exists beside it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const strip = readFileSync(
  fileURLToPath(new URL('../QueuedMessageList.tsx', import.meta.url)),
  'utf8',
)
const zone = readFileSync(
  fileURLToPath(new URL('../ChatInputZone.tsx', import.meta.url)),
  'utf8',
)
const locale = (name: string): Record<string, string> => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url)),
  'utf8',
))

describe('the queue strip offers all four documented verbs', () => {
  it('renders a move-up and a move-down control beside edit, steer and delete', () => {
    for (const key of [
      'chat.queue.steer',
      'chat.queue.edit',
      'chat.queue.delete',
      'chat.queue.moveUp',
      'chat.queue.moveDown',
    ]) {
      expect(strip).toContain(`aria-label={t('${key}')}`)
    }
  })

  it('asks to move by one position in each direction', () => {
    expect(strip).toContain('onReorder(m.id, index - 1)')
    expect(strip).toContain('onReorder(m.id, index + 1)')
  })

  it('disables the control at the end it cannot move past, rather than hiding it', () => {
    expect(strip).toContain('disabled={index === 0}')
    expect(strip).toContain('disabled={index === queue.length - 1}')
  })

  it('never sorts the queue locally — the server owns the send order', () => {
    // The refusal this row was blocked on. A `.sort(`, `.reverse(` or a
    // `splice` inside the strip would be the dead-UI implementation.
    for (const forbidden of ['.sort(', '.reverse(', '.splice(']) {
      expect(strip).not.toContain(forbidden)
    }
  })
})

describe('the composer routes the reorder to the server', () => {
  it('calls queueReorder with the session, the entry and the target index', () => {
    expect(zone).toContain('window.electronAPI.queueReorder(sessionId, messageId, toIndex)')
    expect(zone).toContain('onReorder={handleQueueReorder}')
  })
})

describe('both locales carry the two new labels', () => {
  it('has moveUp and moveDown in en and ru', () => {
    for (const name of ['en', 'ru']) {
      const table = locale(name)
      expect(table['chat.queue.moveUp']?.length ?? 0).toBeGreaterThan(0)
      expect(table['chat.queue.moveDown']?.length ?? 0).toBeGreaterThan(0)
    }
    // Distinct strings, in both — a copy-paste that labels both buttons the same
    // makes the pair unusable to a screen reader.
    expect(locale('en')['chat.queue.moveUp']).not.toBe(locale('en')['chat.queue.moveDown'])
    expect(locale('ru')['chat.queue.moveUp']).not.toBe(locale('ru')['chat.queue.moveDown'])
  })
})
