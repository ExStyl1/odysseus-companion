/**
 * D1.392 — THE SHELL IS SHARED, AND `EditPopover`'S OUTPUT DID NOT MOVE.
 *
 * The owner asked for the `/btw` panel to wear the card the agent-driven add
 * popover wears. Extracting that card is the fix, and the risk it carries is
 * the opposite one: a shared frame that quietly restyles the surface it was
 * extracted FROM. The agent-driven add-source / add-skill install popover is a
 * shipped surface on four call sites; nothing about it was meant to change.
 *
 * So the pin below is a WHOLE-STRING equality against the markup HEAD rendered
 * before the extraction, captured by rendering the pre-extraction JSX verbatim
 * (`renderToStaticMarkup`, the instrument this repo already uses for renderer
 * components — it ships no DOM and no `@testing-library/react`). Not a class
 * list, not a substring: the entire card, grip svg included. A reordered
 * `cn()` argument, a dropped `titlebar-no-drag`, a `cursor-default` leaking
 * into the draggable arm — each of them moves this string.
 *
 * Why a literal rather than a snapshot file: the value IS the evidence, and a
 * snapshot that can be re-recorded with `--update-snapshots` is exactly the
 * instrument this row must not have.
 */

import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompactChatCard, COMPACT_CHAT_CARD_CLASS, COMPACT_CHAT_CARD_RADIUS } from '../compact-chat-card'

/**
 * What `EditPopover`'s inline card rendered at `dd0d031ef`, with the drag offset
 * at rest. Taken from the pre-extraction JSX, not from the frame.
 */
const HEAD_EDIT_POPOVER_CARD =
  '<div class="relative bg-foreground-2 overflow-hidden w-full h-full shadow-modal-small"' +
  ' style="transform:translate(0px, 0px);border-radius:16px">' +
  '<div class="absolute top-0 left-1/2 -translate-x-1/2 z-50 px-4 py-2 cursor-grab rounded' +
  ' pointer-events-auto titlebar-no-drag">' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"' +
  ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
  ' class="lucide lucide-grip-horizontal w-4 h-4 text-muted-foreground/30" aria-hidden="true">' +
  '<circle cx="12" cy="9" r="1"></circle><circle cx="19" cy="9" r="1"></circle>' +
  '<circle cx="5" cy="9" r="1"></circle><circle cx="12" cy="15" r="1"></circle>' +
  '<circle cx="19" cy="15" r="1"></circle><circle cx="5" cy="15" r="1"></circle></svg></div>' +
  '<div class="flex-1 flex flex-col bg-foreground-2" style="height:100%">' +
  '<span data-slot="content"></span></div></div>'

const CONTENT = <span data-slot="content" />

describe('CompactChatCard keeps EditPopover byte-identical (D1.392)', () => {
  it("POSITIVE: the popover's arm renders HEAD's markup, whole", () => {
    const html = renderToStaticMarkup(
      <CompactChatCard
        transform="translate(0px, 0px)"
        onGripMouseDown={() => {}}
        isDragging={false}
      >
        {CONTENT}
      </CompactChatCard>,
    )
    expect(html).toBe(HEAD_EDIT_POPOVER_CARD)
  })

  it('NEGATIVE: the instrument can see a change — the dragging arm differs', () => {
    // Without this the equality above could be passing on a frozen constant.
    // `cn()` drops `cursor-grab` for `cursor-grabbing`, so the string must move.
    const dragging = renderToStaticMarkup(
      <CompactChatCard transform="translate(4px, 8px)" onGripMouseDown={() => {}} isDragging>
        {CONTENT}
      </CompactChatCard>,
    )
    expect(dragging).not.toBe(HEAD_EDIT_POPOVER_CARD)
    expect(dragging).toContain('cursor-grabbing')
    expect(dragging).not.toContain('cursor-grab ')
    expect(dragging).toContain('transform:translate(4px, 8px)')
  })

  it('POSITIVE: the panel arm adds only what it uses, and drops the drag cursor', () => {
    // The `/btw` panel is focusable, named, and cannot be dragged. Everything
    // else about the card — radius, background, shadow, grip — is the same.
    const html = renderToStaticMarkup(
      <CompactChatCard tabIndex={-1} ariaLabel="Side question" testId="side-question-panel">
        {CONTENT}
      </CompactChatCard>,
    )
    expect(html).toContain(COMPACT_CHAT_CARD_CLASS)
    expect(html).toContain('outline-none')
    expect(html).toContain('aria-label="Side question"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('data-testid="side-question-panel"')
    // No drag: no transform in the style, and no grab cursor on the dots.
    expect(html).toContain(`style="border-radius:${COMPACT_CHAT_CARD_RADIUS}px"`)
    expect(html).not.toContain('transform:')
    expect(html).not.toContain('cursor-grab')
    expect(html).toContain('cursor-default')
    // The dots themselves are the reference card's, unchanged.
    expect(html).toContain('lucide-grip-horizontal w-4 h-4 text-muted-foreground/30')
  })

  it("NEGATIVE: the popover's arm carries none of the panel's attributes", () => {
    // `undefined` props must render NOTHING, or the extraction would have added
    // attributes to a shipped surface.
    const html = renderToStaticMarkup(
      <CompactChatCard transform="translate(0px, 0px)" onGripMouseDown={() => {}}>
        {CONTENT}
      </CompactChatCard>,
    )
    expect(html).not.toContain('aria-label')
    expect(html).not.toContain('tabindex')
    expect(html).not.toContain('data-testid')
    expect(html).not.toContain('outline-none')
  })
})
