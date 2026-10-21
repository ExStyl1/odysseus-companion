/**
 * C3.244 — the chat pane's dialogs are anchored to the PANE, not to the window.
 *
 * Owner screenshot, packaged 1.36.0, 2026-09-11: with the session list open the
 * Rewind dialog sat off-centre and its left third slid under the sidebar. The
 * cause was a `fixed inset-0` backdrop copy-pasted four times in `ChatDisplay`;
 * `fixed` resolves against the viewport, so "centred" meant centred on the
 * WINDOW.
 *
 * WHAT INSTRUMENT IS AVAILABLE, said plainly. There is no React DOM harness in
 * this tree — the established pattern here is static markup plus a source read
 * (`rewind-menu.test.tsx` does exactly this) — and no DOM shim in reach has a
 * layout engine, so every `getBoundingClientRect` would be zeros and a
 * literally geometric assertion would measure nothing. What makes the geometry
 * TRUE is a CSS rule, and the rule is what these tests pin: an absolutely
 * positioned box with `inset: 0` and no width or height of its own resolves to
 * exactly its containing block's padding box (CSS 2.1 §10.3.7, §10.6.4), and
 * the containing block is the nearest positioned ancestor — here the pane root,
 * because of `CHAT_PANE_ANCHOR_CLASS`. So the overlay box IS the pane box, and
 * a child centred inside it with a 16px gutter (`px-4`) is inside the pane box
 * at every pane width there is.
 *
 * That is why the two "states" the row asks for — sidebar open, sidebar closed
 * — are asserted as the SAME construction at two different pane widths: the
 * anchor cannot depend on the width, and a fix that had to know the sidebar's
 * width would be the bug in a second form. The pixel proof belongs to a live
 * CDP case, proposed rather than written here.
 *
 * Mutation probe: changing `absolute` back to `fixed` in
 * `CHAT_PANE_OVERLAY_CLASS` turns three cases red; dropping
 * `CHAT_PANE_ANCHOR_CLASS` from `ChatDisplay`'s pane root turns the source read
 * red.
 */
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { cn } from '@/lib/utils'
import { createDismissibleLayerRegistry } from '@/context/DismissibleLayerContext'
import {
  CHAT_PANE_ANCHOR_CLASS,
  CHAT_PANE_OVERLAY_CLASS,
  ChatPaneOverlay,
  chatPaneOverlayLayer,
} from '../chat-pane-overlay'

/**
 * The pane as `ChatDisplay` builds it, at a given width. The width is an inline
 * style rather than a class so the two states differ in ONE attribute and the
 * rest of the markup can be compared byte for byte.
 */
function renderPane(paneWidthPx: number): string {
  return renderToStaticMarkup(
    <div
      className={cn('flex h-full flex-col min-w-0', CHAT_PANE_ANCHOR_CLASS)}
      data-focus-zone="chat"
      style={{ width: paneWidthPx }}
    >
      <ChatPaneOverlay label="Rewind" onClose={() => {}}>
        <div data-testid="dialog" className="w-full max-w-xl">
          rewind
        </div>
      </ChatPaneOverlay>
    </div>,
  )
}

/** Sidebar open: the pane starts after the session list and is narrower. */
const PANE_WITH_SIDEBAR = 880
/** Sidebar closed (focus mode): the pane is the whole window. */
const PANE_WITHOUT_SIDEBAR = 1200

function overlayMarkup(pane: string): string {
  const start = pane.indexOf('<div class="' + CHAT_PANE_OVERLAY_CLASS)
  expect(start).toBeGreaterThan(-1)
  return pane.slice(start)
}

describe('the chat pane is the dialog\'s containing block (C3.244)', () => {
  it('anchors the dialog inside the pane box with the sidebar OPEN', () => {
    const pane = renderPane(PANE_WITH_SIDEBAR)

    // The pane root is positioned, so it — and not the viewport — is what
    // `inset-0` below resolves against.
    expect(pane).toContain(CHAT_PANE_ANCHOR_CLASS)
    expect(pane).toContain('data-focus-zone="chat"')
    // The backdrop is a DESCENDANT of that pane, sized to it, and the dialog is
    // a descendant of the backdrop: three nested boxes, the outer two identical.
    const overlay = overlayMarkup(pane)
    expect(overlay).toContain('absolute inset-0')
    expect(overlay).not.toContain('fixed')
    expect(overlay).toContain('data-testid="dialog"')
    expect(overlay).toContain('items-center justify-center')
    // The gutter that keeps a max-width panel off the pane's own edges.
    expect(overlay).toContain('px-4')
  })

  it('anchors the dialog inside the pane box with the sidebar CLOSED', () => {
    const pane = renderPane(PANE_WITHOUT_SIDEBAR)

    expect(pane).toContain(CHAT_PANE_ANCHOR_CLASS)
    const overlay = overlayMarkup(pane)
    expect(overlay).toContain('absolute inset-0')
    expect(overlay).not.toContain('fixed')
    expect(overlay).toContain('data-testid="dialog"')
  })

  it('resolves the anchor identically at both pane widths — the width is not read', () => {
    // The boundary this row exists for: the previous behaviour was width-aware
    // by accident (the window, not the pane). A fix that READ the sidebar width
    // would be the same defect with a number in it, and would drift the moment
    // the sash moved. The two markups may differ only in the pane's own width.
    const open = renderPane(PANE_WITH_SIDEBAR).replace(`width:${PANE_WITH_SIDEBAR}px`, 'W')
    const closed = renderPane(PANE_WITHOUT_SIDEBAR).replace(`width:${PANE_WITHOUT_SIDEBAR}px`, 'W')
    expect(open).toBe(closed)
  })

  it('never falls back to viewport positioning', () => {
    expect(CHAT_PANE_OVERLAY_CLASS).toContain('absolute inset-0')
    expect(CHAT_PANE_OVERLAY_CLASS).not.toContain('fixed')
  })
})

describe('ChatDisplay mounts every chat-pane dialog through the one backdrop (C3.244)', () => {
  // A source read, for the claim static markup cannot make: that the four
  // hand-rolled copies are GONE rather than merely joined by a fifth shape.
  const source = readFileSync(
    join(import.meta.dir, '..', 'ChatDisplay.tsx'),
    'utf8',
  )

  it('has no window-anchored backdrop left in the chat pane', () => {
    expect(source).not.toContain('fixed inset-0 z-modal')
  })

  it('routes the agents, rewind, context and usage dialogs through ChatPaneOverlay', () => {
    const opens = source.match(/<ChatPaneOverlay /g) ?? []
    expect(opens.length).toBe(4)
    for (const label of ['agents.title', 'chat.rewindMenu.title', 'context.title', 'usage.title']) {
      expect(source).toContain(`<ChatPaneOverlay label={t('${label}')}`)
    }
  })

  it('gives the pane root the anchor those overlays resolve against', () => {
    expect(source).toContain("className={cn('flex h-full flex-col min-w-0', CHAT_PANE_ANCHOR_CLASS)}")
  })
})

/**
 * C3.358 — Escape closes every one of the four, not only the rewind menu.
 *
 * R5's RS-34 drove all four on the packaged 1.36.0: Escape closed the rewind
 * dialog (which carries `rewindMenuKeyAction`'s own `Escape` branch) and none
 * of the three siblings. `hasOpenOverlay` was never the missing half — it stops
 * Escape INTERRUPTING the turn and says nothing about dismissing the dialog.
 *
 * The instrument is the REAL registry rather than a source match: the layer the
 * overlay registers is a value (`chatPaneOverlayLayer`), so it can be put into
 * `createDismissibleLayerRegistry` and driven through the same `handleEscape`
 * the window listener calls. What stays a source read is only the wiring no
 * harness in this tree can run — that the component asks the bridge at all.
 */
describe('Escape dismisses a chat-pane dialog through the app\'s own layer registry (C3.358)', () => {
  it('handleEscape closes the layer this overlay registers', () => {
    const registry = createDismissibleLayerRegistry()
    const close = mock(() => {})
    registry.registerLayer(chatPaneOverlayLayer('usage', close))

    expect(registry.handleEscape()).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a dialog does not outrank a layer opened on top of it', () => {
    // Equal priority, so the tiebreak is registration order — the popover a
    // user opened INSIDE the dialog must take the Escape first.
    const registry = createDismissibleLayerRegistry()
    const closeDialog = mock(() => {})
    const closePopover = mock(() => {})
    registry.registerLayer(chatPaneOverlayLayer('context', closeDialog))
    registry.registerLayer({ id: 'popover', type: 'radix-popover', close: closePopover })

    expect(registry.handleEscape()).toBe(true)
    expect(closePopover).toHaveBeenCalledTimes(1)
    expect(closeDialog).not.toHaveBeenCalled()
  })

  it('negative — an unregistered registry reports nothing to close', () => {
    // The control without which the two cases above could pass against a
    // `handleEscape` that returned `true` for everything.
    expect(createDismissibleLayerRegistry().handleEscape()).toBe(false)
  })

  it('two open dialogs get distinct ids, so one cannot evict the other', () => {
    expect(chatPaneOverlayLayer('a', () => {}).id)
      .not.toBe(chatPaneOverlayLayer('b', () => {}).id)
  })
})

describe('the overlay registers with the bridge rather than adding a second Escape listener', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'chat-pane-overlay.tsx'), 'utf8')

  it('registers through the bridge, which is a no-op when no provider is mounted', () => {
    expect(source).toContain('getDismissibleLayerBridge()?.registerLayer(')
    expect(source).toContain('chatPaneOverlayLayer(id, () => onCloseRef.current())')
  })

  it('negative — no keydown listener of its own', () => {
    // A second listener beside `DismissibleLayerProvider`'s would be a second
    // stacking order for one key, which is how Escape closes the wrong thing.
    expect(source).not.toContain("addEventListener('keydown'")
  })

  it('the component calls the hook', () => {
    expect(source).toContain('useDismissOnEscape(onClose)')
  })
})
