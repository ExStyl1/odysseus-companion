/**
 * C3.244 — the backdrop every dialog the CHAT PANE opens sits in, and the one
 * place its anchor is decided.
 *
 * Owner request 2026-09-11, from a screenshot of packaged 1.36.0: with the
 * session list open the Rewind dialog sat off-centre and its left third slid
 * under the sidebar. The cause was not the rewind menu. `RewindMenuPanel` says
 * in its own docblock that it has "no portal of its own"; `ChatDisplay` wrapped
 * it — and three siblings (agents, context, usage) — in a hand-rolled
 * `fixed inset-0 …` backdrop, copy-pasted four times in one file. `fixed`
 * resolves against the VIEWPORT, i.e. the whole window, so the centre of that
 * backdrop is the centre of the window and not the centre of the chat: with a
 * 320px sidebar the dialog is 160px too far left, which is exactly the overlap
 * the screenshot shows.
 *
 * THE FIX IS THE CONTAINING BLOCK, not an offset. `CHAT_PANE_ANCHOR_CLASS` on
 * the pane root makes it a containing block for absolutely positioned
 * descendants; `absolute inset-0` then resolves the backdrop to exactly the
 * pane's padding box, and `items-center justify-center` centres the panel in
 * it. That is width-independent by construction — sidebar open, sidebar closed,
 * a dragged sash, a narrow window and compact mode are all the same case — so
 * there is no sidebar width to read, no resize listener to keep in step, and
 * nothing to go stale. It is also why no measurement can be wrong here: there
 * is no measurement.
 *
 * WHAT THIS DOES NOT COVER, said plainly rather than left to be discovered:
 *
 * - `components/ui/dialog.tsx` (radix) portals to `document.body` and is
 *   app-level — the workspace dialogs, settings, onboarding. Those are not
 *   dialogs the chat pane opens, and window-centring is right for them.
 * - `CodePreviewOverlay` / `DocumentFormattedMarkdownOverlay` are mounted by
 *   `App.tsx` as well as by `ChatDisplay`, so they are app-level too and keep
 *   window anchoring. Moving them would change a surface outside this pane.
 *
 * A POSTURE, stated because it is a real change and not a side effect: a
 * pane-anchored backdrop no longer covers the sidebar, so a click on the
 * session list while a chat dialog is open reaches the list instead of being
 * swallowed. That is the normal shape of a panel-scoped modal and it is what
 * "centred on the chat" means — the dialog belongs to the chat, and the rest of
 * the window keeps working. `aria-modal` stays: within the pane it is modal,
 * and `overlay-detection` still finds it by `role="dialog"` for the Escape key.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  getDismissibleLayerBridge,
  type DismissibleLayerRegistration,
} from '@/lib/dismissible-layer-bridge'

/**
 * The class the CHAT PANE ROOT must carry. Exported rather than written inline
 * so the pairing is one thing in one place: `inset-0` below is meaningless
 * without a containing block, and a future edit that drops a bare `relative`
 * from a long className would silently restore the window-centred bug with
 * nothing to fail.
 */
export const CHAT_PANE_ANCHOR_CLASS = 'relative'

/**
 * The backdrop. `absolute`, never `fixed` — that single word is the whole of
 * C3.244. The rest is the shape the four hand-rolled copies already had, kept
 * byte-for-byte so this is an anchor change and not a restyle.
 */
export const CHAT_PANE_OVERLAY_CLASS =
  'absolute inset-0 z-modal flex items-center justify-center bg-black/45 px-4'

export interface ChatPaneOverlayProps {
  /** The dialog's accessible name. */
  label: string
  /** Backdrop click — the "never mind" exit every one of these overlays has. */
  onClose: () => void
  children: ReactNode
  className?: string
}

/**
 * C3.358 — Escape closes every dialog the chat pane opens, through the registry
 * the app already has.
 *
 * ## What was measured
 *
 * R5's RS-34 drove all four on the packaged 1.36.0 and Escape closed exactly
 * one: the rewind menu, whose `RewindMenuPanel` carries an `onKeyDown` of its
 * own (`rewind-menu.tsx` symbol `rewindMenuKeyAction`, the `Escape` branch).
 * The three siblings — agents, context, usage — carried no handler anywhere,
 * and `hasOpenOverlay` is not one: it only stops Escape INTERRUPTING the turn
 * (`AppShell.tsx`'s `enabled` callback, and `FreeFormInput`'s guard), which is
 * the correct half and leaves the dialog on screen with nothing to dismiss it
 * but the backdrop click.
 *
 * ## Native-first: the row's recipe is NOT what landed, and why
 *
 * The row asked for "one `keydown` listener in `chat-pane-overlay.tsx` calling
 * the `onClose` it already owns". This app already HAS that listener, once, in
 * `DismissibleLayerProvider` — a window-level bubble-phase Escape handler over
 * a priority-ordered registry with a back-before-close rule, mounted at all
 * four `App.tsx` entry points and tested in
 * `context/__tests__/dismissible-layer-context.test.ts`. A second listener
 * beside it would be a second stacking order for the same key, which is the
 * shape that produces "Escape closed the wrong thing". So the overlay
 * REGISTERS instead, and gets the ordering for free: with a popover open on top
 * of a dialog, the popover closes first.
 *
 * The BRIDGE (`lib/dismissible-layer-bridge.ts`) rather than the context hook,
 * for one measured reason: `useDismissibleLayerRegistry` throws when no
 * provider is above it, and this component is rendered standalone by
 * `renderToStaticMarkup` in its own test — hooks run during that render, so the
 * context form would turn a passing suite red for a reason that has nothing to
 * do with the app. The bridge is a no-op when nothing is mounted, which is
 * exactly the right answer outside the app.
 *
 * `onClose` is read through a ref so the registration is made ONCE per mounted
 * dialog: `ChatDisplay` passes an inline `handleCloseOverlay`, and a dependency
 * on it would re-register on every render and churn the registry's order seed,
 * which is the tiebreak that decides which layer is on top.
 */
function useDismissOnEscape(onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const id = useId()
  useEffect(() => {
    // Mounted means open: `ChatDisplay` renders each overlay only while its
    // own state selects it, so there is no `isOpen` to keep in step — the
    // unmount IS the close, and the returned unregister is the whole cleanup.
    return getDismissibleLayerBridge()?.registerLayer(
      chatPaneOverlayLayer(id, () => onCloseRef.current()),
    )
  }, [id])
}

/**
 * The registration this overlay makes, as a value rather than an object literal
 * buried in an effect — so a test can put the REAL registry behind the bridge
 * and prove that `handleEscape` closes it, instead of matching the source text
 * of a hook no harness in this tree can run.
 *
 * `type: 'modal'` and no explicit priority: a chat-pane dialog is an ordinary
 * modal and must not outrank a popover opened on top of it. With equal
 * priorities the registry falls back to registration order, newest first, which
 * is the stacking a user sees.
 */
export function chatPaneOverlayLayer(id: string, close: () => void): DismissibleLayerRegistration {
  return { id: `chat-pane-overlay:${id}`, type: 'modal', close }
}

export function ChatPaneOverlay({ label, onClose, children, className }: ChatPaneOverlayProps) {
  useDismissOnEscape(onClose)
  return (
    <div
      className={cn(CHAT_PANE_OVERLAY_CLASS, className)}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      {children}
    </div>
  )
}
