/**
 * P6.712 — a multi-line seam answer renders its lines.
 *
 * The reproduction is a real one: `/help`, `/config`, `/mcp` and `/diff` all
 * reach the transcript as an `info` message whose content is a list, and the
 * row rendered that list inside a span with no `whitespace-pre-wrap`, so every
 * newline collapsed to a space. The control that must not move is the ordinary
 * one-line notice, which is the overwhelming majority of `info` rows.
 *
 * P6.731 rides on the same partition: the row was `select-none`, so those
 * lists could be read and not copied — a `/mcp` inventory or a `/diff` patch a
 * user cannot paste into a bug report is one they retype. Multi-line says
 * `select-text`; the one-line control keeps `select-none`.
 *
 * The rule is asserted through its own module plus the call site, because
 * `bun test` has no DOM and importing the component pulls a UI barrel bun
 * cannot resolve — the same instrument `BranchSwitcher.test.tsx` and
 * `ChatDisplay.usage-format.test.ts` use. UB14.14 moved the call site with
 * v0.15.1's message renderer into `chat-display/MessageBubble.tsx`, and the row
 * took that file's look (the rendered arms are in
 * `chat-display/__tests__/message-bubble.test.tsx`).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { infoNoticeLayout, isMultiLineNotice } from '../ChatDisplay.info-notice'

/** A three-line `/help` answer, the row's own example. */
const HELP_ANSWER = ['/help — this list', '/mcp — MCP servers', '/diff — uncommitted changes'].join('\n')

describe('infoNoticeLayout — a seam answer keeps its lines', () => {
  it('pre-wraps a multi-line answer and top-aligns the icon against its first line', () => {
    expect(isMultiLineNotice(HELP_ANSWER)).toBe(true)
    const layout = infoNoticeLayout(HELP_ANSWER)
    expect(layout.textClassName).toBe('min-w-0 whitespace-pre-wrap')
    expect(layout.rowAlignClassName).toBe('items-start py-[5px]')
    expect(layout.iconClassName).toContain('mt-px')
  })

  it('P6.731 — a multi-line answer can be selected, so a seam answer can be copied', () => {
    expect(infoNoticeLayout(HELP_ANSWER).rowSelectClassName).toBe('select-text')
  })

  it('control — a one-line notice is v0.15.1\'s row: centred, no wrap class, a 16px icon slot', () => {
    const layout = infoNoticeLayout('Conversation compacted.')
    expect(isMultiLineNotice('Conversation compacted.')).toBe(false)
    expect(layout.textClassName).toBe('min-w-0')
    expect(layout.rowAlignClassName).toBe('items-center')
    expect(layout.iconClassName).toBe('flex size-4 shrink-0 items-center justify-center')
    expect(layout.rowSelectClassName).toBe('select-none')
  })

  it('boundary — a long notice that merely WRAPS is still a sentence, not a list', () => {
    const long = 'x'.repeat(400)
    expect(isMultiLineNotice(long)).toBe(false)
    expect(infoNoticeLayout(long).textClassName).not.toContain('whitespace-pre-wrap')
  })

  it('boundary — a trailing newline is a list of one, and pre-wrap is what preserves it', () => {
    expect(isMultiLineNotice('one line\n')).toBe(true)
  })
})

describe('the info branch actually consumes the layout', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../chat-display/MessageBubble.tsx', import.meta.url)),
    'utf8',
  )

  it('renders the row, the icon and the span from it', () => {
    expect(source).toContain('const noticeLayout = infoNoticeLayout(infoContent)')
    expect(source).toContain('noticeLayout.rowAlignClassName')
    expect(source).toContain('<span className={noticeLayout.iconClassName}>')
    expect(source).toContain('<span className={noticeLayout.textClassName}>{infoContent}</span>')
  })

  it('negative — the unconditional `items-center` that caused the bug is gone from that row', () => {
    expect(source).not.toContain("'flex items-center gap-2 px-3 py-1 text-[13px] select-none'")
    // UB14.14 — and v0.15.1's own row literal, which bakes the same two rules in: taking that
    // hunk 1:1 would re-open P6.712 and P6.731 at once.
    expect(source).not.toContain("'flex min-h-7 min-w-0 select-none items-center gap-2 text-label'")
  })

  it('P6.731 — the row takes its select rule from the layout, not from a literal', () => {
    expect(source).toContain('noticeLayout.rowSelectClassName')
    expect(source).not.toContain("'flex gap-2 px-3 py-1 text-[13px] select-none'")
  })
})

/**
 * The playground screen previews this row, and it used to MIRROR the markup —
 * which is how it once composed the same `select-none` literal the row had lost.
 * Since UB14.14 the row is an exported component (`chat-display/MessageBubble`),
 * so the screen mounts it: a rule that partitions in one file and not in the
 * other cannot happen when there is one file.
 */
describe('the playground preview mounts the real row', () => {
  const playgroundSource = readFileSync(
    fileURLToPath(new URL('../../../playground/registry/info-notice.tsx', import.meta.url)),
    'utf8',
  )

  it('renders MessageBubble with an info message', () => {
    expect(playgroundSource).toContain("import { MessageBubble } from '@/components/app-shell/chat-display/MessageBubble'")
    expect(playgroundSource).toContain("role: 'info'")
    expect(playgroundSource).toContain('<MessageBubble message={message}')
  })

  it('negative — it composes no row of its own (no layout call, no select literal)', () => {
    expect(playgroundSource).not.toContain('infoNoticeLayout(')
    expect(playgroundSource).not.toContain("'flex gap-2 px-3 py-1 text-[13px] select-none'")
  })
})
