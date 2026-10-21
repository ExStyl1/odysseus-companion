/**
 * C3.331 — the RENDERER half of the shared warning seam.
 *
 * The row names four host sentences and misses this one: `App.tsx` mints a
 * `role: 'warning'` message when an attachment cannot be stored, and
 * `ChatDisplay.tsx` renders it in a bubble whose heading was the hard-coded
 * English word `Warning` — one untranslated word of OUR OWN chrome, in a
 * component that translates the row above it, in a bilingual app.
 *
 * Asserted from the source text rather than by rendering `ChatDisplay`: that
 * component's module graph is the expensive kind AGENTS.md §Traps measures in
 * minutes, and the question here is only whether the two strings go through
 * `t()` and whether both locales carry them.
 *
 * UB14.14 — the bubble moved with v0.15.1's message renderer into
 * `chat-display/MessageBubble.tsx`, and its heading takes v0.15.1's key name
 * `chat.warning`, which retired our `chat.warningBubble.heading` (same words).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const chatDisplay = readFileSync(join(here, '..', 'chat-display', 'MessageBubble.tsx'), 'utf8')
const app = readFileSync(join(here, '..', '..', '..', 'App.tsx'), 'utf8')
const locales = join(here, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')

function copy(file: string, key: string): string | undefined {
  const table = JSON.parse(readFileSync(join(locales, file), 'utf8')) as Record<string, string>
  return table[key]
}

describe('C3.331 — the warning bubble speaks the UI language', () => {
  it('the two files were read (the control for every assertion below)', () => {
    expect(chatDisplay).toContain("if (message.role === 'warning') {")
    expect(app).toContain("role: 'warning' as const,")
  })

  it('the heading is a key, not the English literal it was', () => {
    expect(chatDisplay).toContain("{t('chat.warning')}")
    // The retired name has no reader left, so it left both locales (below). The CALL is
    // guarded, not the name: the bubble's comment names the key it replaced.
    expect(chatDisplay).not.toContain("t('chat.warningBubble.heading')")
    // The literal, in the shape it had: a bare `Warning` line of JSX text.
    expect(chatDisplay).not.toContain('font-semibold">\n            Warning\n')
  })

  it('the sentence that mints the bubble is a key too, with its two values', () => {
    expect(app).toContain("t('chat.warningBubble.attachmentsNotStored', {")
    expect(app).toContain('failed: failedCount,')
    expect(app).toContain('names: failedNames,')
    // NEGATIVE: the template literal it replaced is gone rather than shadowed.
    expect(app).not.toContain('attachment(s) could not be stored and will not be sent')
  })

  it('both locales carry both keys, and both keep their interpolations', () => {
    for (const file of ['en.json', 'ru.json']) {
      expect(copy(file, 'chat.warning'), `${file} heading`).toBeTruthy()
      expect(copy(file, 'chat.warningBubble.heading'), `${file} retired heading`).toBeUndefined()
      const sentence = copy(file, 'chat.warningBubble.attachmentsNotStored')
      expect(sentence, `${file} sentence`).toBeTruthy()
      // A sentence that lost either value would announce a failure it cannot
      // name, which is the state this row is about in miniature.
      expect(sentence).toContain('{{failed}}')
      expect(sentence).toContain('{{names}}')
    }
  })
})
