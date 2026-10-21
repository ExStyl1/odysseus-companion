/**
 * SideQuestionOverlay — the `/btw` dismissible overlay
 * (interactive-mode.md:359-385) and the `/recap` result surface (`:398-404`).
 *
 * Owner directive (R36 plan, 2026-08-06, binding): NO new design components —
 * this composes EditPopover's INLINE-mode shape: the Radix popover shell
 * (hidden zero-size trigger anchored in the composer, `side="top"`, the same
 * `bg-foreground-2` rounded container) + the compact
 * {@link ChatDisplay} for the Q/A rendering, so Markdown, streaming and the
 * loading affordance are the existing ones, not a fork. The /btw-specific
 * delta is limited to: the renderer-only exchange ring
 * (`side-question-ring.ts` — never a session, never persisted) and the
 * `:378-385` key bindings minus `f` (recorded narrowing — no session-copy
 * substrate).
 *
 * D1.375 — A SIDE QUESTION IS A CHAT THE USER CAN TYPE INTO. R36 read `:369`
 * ("no follow-up turns") as "no composer", and hid one with a `hideInput` prop.
 * The owner met the result in use on 2026-09-18 and ruled the other way: the
 * panel opened as a small box whose only content was the compact chat's own
 * empty state, which asks the user to describe what they want with nowhere to
 * type it. That is a PRODUCT posture and it outranks the page here. So the same
 * mount the agent-driven add-source / add-skill install uses — `EditPopover`'s
 * inline compact {@link ChatDisplay}, composer included — is what this panel
 * carries now; `hideInput` is gone from `ChatDisplay` rather than left as a prop
 * nobody passes. Three consequences, each decided in
 * {@link ./side-question-composer}: the composer's capabilities are the
 * session's own, narrowed to what one `sessionCommand` string can carry; the box
 * is a viewport fraction that grows with content instead of a fixed 440 px; and
 * the composer's control can never become a Stop that no server session would
 * answer (F1.179: the synthetic session now DOES report `isProcessing` while an
 * answer is pending, and `resolveSubmitControl` answers `loading` for its id).
 *
 * KEYS, with a composer in the box (owner, same ruling): typing is never eaten.
 * Escape always dismisses — Radix's own dismissable layer sees it at the
 * document, and the composer below explicitly declines Escape while an overlay
 * is open. Space and Enter still dismiss, but ONLY from the panel body: the
 * handler returns before it reads the key whenever the event came from somewhere
 * the user is typing, and the panel focuses the composer when it opens, so the
 * ordinary path never reaches them.
 *
 * D1.392 — ONE SHELL, TWO USERS (owner, 2026-09-19, two screenshots). R36's
 * directive above said "no new design components, compose EditPopover's inline
 * shape", and what shipped RESEMBLED that shape rather than being it: a 560 px
 * box with a title header, a four-hint footer, and a composer whose placeholder
 * was the main composer's rotating tip ("Press B to toggle the sidebar") because
 * none was ever passed. The owner put the two side by side and ruled them one
 * component. So the card, the grip dots and the content slot are extracted into
 * {@link ../ui/compact-chat-card} and BOTH render through it — `EditPopover`'s
 * own output byte-identically, pinned whole in that module's test, because
 * extracting a shell must not restyle the surface it came from.
 *
 * What this panel does NOT do is mount `EditPopover`: that component mints
 * hidden sessions and builds edit prompts, while a side question rides
 * `sessionCommand({ type: 'sideQuestion' })`. The ring, the synthetic session
 * and `onAsk` are untouched. What changed is only what the user SEES: no title
 * row, no footer in the empty state, the reference card's 400x480, the panel's
 * own rotating placeholder, and the in-flight word moved out of the vanished
 * header into the message list under the question. (F1.179 later replaced that
 * word with the chat's own `ProcessingIndicator` — see the synthetic session.)
 *
 * D1.399 — AND IT IS A THREAD (owner, 2026-09-19, the second screenshot):
 * *"очередь сообщений будто вверху копятся и скроллятся, поведение не такое как
 * в обычном чате"*. R36 rendered the doc's ring literally — ONE exchange in the
 * chat, the older questions as a dimmed truncated list scrolling at the TOP of
 * the card, `←`/`→` to step between them. A panel that is a chat cannot have a
 * second, worse history above its own, so the synthetic session now carries
 * EVERY exchange as messages ({@link sideQuestionThreadMessages}) and the
 * compact `ChatDisplay` renders them the way it renders the main chat: newest
 * at the bottom, its own sticky-bottom auto-scroll. The dimmed list is gone and
 * the stepping went with it — the thread IS the history, which is what R36's
 * `:372`/`:382` decision was standing in for; `c` copies the latest answer and
 * `x` clears the thread. The ring store keeps its shape and its transcript-free
 * contract: nothing enters the real session and the synthetic id never reaches
 * a server.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { usePlatform } from '@nessy-agent/ui'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { CompactChatCard } from '@/components/ui/compact-chat-card'
import type { Message, Session } from '../../../shared/types'
import { ChatDisplay } from './ChatDisplay'
import {
  SIDE_QUESTION_COMPOSER_SELECTOR,
  SIDE_QUESTION_PANEL_WIDTH,
  SIDE_QUESTION_PLACEHOLDER_KEYS,
  isSideQuestionSessionId,
  nestedSideQuestionText,
  sideQuestionComposerCapabilities,
  sideQuestionPanelHeight,
  sideQuestionSessionId,
} from './side-question-composer'

import { sideQuestionErrorDisplay } from './side-question-errors'

import {
  clearThread,
  copyPayload,
  currentExchange,
  getSideQuestionRing,
  hasPendingExchange,
  sideQuestionOverlayKeyAction,
  sideQuestionThreadMessages,
  subscribeSideQuestionRings,
  updateSideQuestionRing,
} from './side-question-ring'

/**
 * Re-exported here so `FreeFormInput` — which mounts this overlay and is ALSO
 * what the overlay's composer renders — can widen its existing import of this
 * module rather than add an import line. That file is cited by ninety
 * line-numbered anchors under `docs/`, and a single added line blanks every one
 * of them below it (AGENTS.md §Traps). D1.384 rode the same line for
 * {@link nestedSideQuestionText}, which that composer's submit path reads.
 */
export { isSideQuestionSessionId, nestedSideQuestionText }

/** Pixels per Up/Down keypress when scrolling the answer (`:381`). */
const ANSWER_SCROLL_STEP = 72

export interface SideQuestionPanelProps {
  sessionId: string
  /** Dismiss — the popover's `onOpenChange(false)`, or the playground's no-op. */
  onDismiss: () => void
  /**
   * Ask the next side question. The panel never calls the server itself: the
   * composer's text goes straight to the ONE producer
   * (`FreeFormInput.askSideQuestion`), which appends to the ring and rides
   * `sessionCommand({ type: 'sideQuestion' })` — never `sendMessage`, so a side
   * question still cannot become a transcript entry or a model turn.
   */
  onAsk: (question: string) => void
  /** The REAL session's capabilities; narrowed for the panel before use. */
  composerCapabilities?: ComposerCapabilities
  /** The panel mounts inside a Radix popover in the app, and bare elsewhere. */
  autoFocus?: boolean
}

/**
 * The panel itself, without the popover around it — exported so the playground
 * (the design surface) can render the exact shipped box, empty state included,
 * with no Radix anchor and no session.
 */
export function SideQuestionPanel({
  sessionId,
  onDismiss,
  onAsk,
  composerCapabilities,
  autoFocus = true,
}: SideQuestionPanelProps) {
  const { t } = useTranslation()
  const { onOpenFile, onOpenUrl } = usePlatform()
  const contentRef = React.useRef<HTMLDivElement>(null)

  const ring = React.useSyncExternalStore(
    subscribeSideQuestionRings,
    () => getSideQuestionRing(sessionId),
  )
  const newest = currentExchange(ring)
  const pending = hasPendingExchange(ring)

  // Synthetic session for the compact ChatDisplay — same stub-session pattern
  // EditPopover uses before its hidden session exists. The id is NEVER a real
  // session id, so nothing this display does can touch the real transcript, and
  // the panel's composer keeps its own draft rather than sharing the main one.
  const overlaySession = React.useMemo((): Session => ({
    id: sideQuestionSessionId(sessionId),
    workspaceId: '',
    workspaceName: '',
    lastMessageAt: newest?.timestamp ?? Date.now(),
    // F1.179 — processing exactly while the answer is pending, so the compact
    // chat draws the SAME `ProcessingIndicator` the main chat draws (spinner,
    // cycling word, elapsed time). D1.375 kept this `false` because a Stop here
    // would `cancelProcessing` an id no server knows; that is now closed on the
    // far side of each seam instead — `resolveSubmitControl` answers `loading`,
    // never `stop`, for a renderer-minted id (F1.92), and `ChatDisplay`'s
    // `sessionCommand` chord asks `isHostTurnInFlight`, which is false for it.
    // The thread no longer forks a "thinking" word beside the indicator.
    isProcessing: pending,
    // D1.399 — EVERY exchange, oldest first, so the compact `ChatDisplay`
    // renders a thread exactly as the main chat does: newest at the bottom,
    // its own sticky-bottom auto-scroll. The shape of each message is decided
    // in {@link ./side-question-ring}, which is pure and driven by its own test.
    messages: sideQuestionThreadMessages(ring, {
      failure: error => {
        const display = sideQuestionErrorDisplay(error)
        return display.detail ? `${t(display.key)}\n\n${display.detail}` : t(display.key)
      },
    }),
    composerCapabilities: sideQuestionComposerCapabilities(composerCapabilities),
  }), [composerCapabilities, newest, pending, ring, sessionId, t])

  // Key focus: the composer, so the panel is typed into the moment it opens —
  // which is also what keeps Space and Enter (the `:378` dismiss keys) away from
  // the first word of a question. The container is the fallback for the case
  // where no composer rendered.
  React.useEffect(() => {
    if (!autoFocus) return
    const frame = requestAnimationFrame(() => {
      // NOT a textarea — the composer's editable element is a contentEditable
      // div; see the selector's own note for what the wrong guess costs.
      const composer = contentRef.current?.querySelector<HTMLElement>(SIDE_QUESTION_COMPOSER_SELECTOR)
      if (composer) composer.focus()
      else contentRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [autoFocus])

  // F1.179 — while `isProcessing` is true the compact composer collapses to its
  // toolbar (`InputContainer`, the shape `EditPopover`'s chat has), which
  // UNMOUNTS the editable element and drops focus to the document body. Hand it
  // back when the answer lands, so the next question is typed where the last one
  // was — but ONLY from that dropped state: a user who clicked elsewhere while
  // waiting keeps the focus they chose.
  const wasPending = React.useRef(pending)
  React.useEffect(() => {
    const settled = wasPending.current && !pending
    wasPending.current = pending
    if (!settled || !autoFocus) return
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      contentRef.current?.querySelector<HTMLElement>(SIDE_QUESTION_COMPOSER_SELECTOR)?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [autoFocus, pending])

  const scrollAnswer = React.useCallback((delta: number) => {
    // ChatDisplay's message list scrolls inside a Radix ScrollArea viewport.
    contentRef.current
      ?.querySelector('[data-radix-scroll-area-viewport]')
      ?.scrollBy({ top: delta, behavior: 'smooth' })
  }, [])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    // The guard that makes a composer inside this panel safe: a key the user is
    // typing is never a panel action, so Space never dismisses mid-sentence.
    if (target?.closest('input, textarea, [contenteditable="true"]')) return
    const action = sideQuestionOverlayKeyAction(event.key)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    switch (action) {
      case 'dismiss':
        onDismiss()
        break
      case 'scroll-up':
        scrollAnswer(-ANSWER_SCROLL_STEP)
        break
      case 'scroll-down':
        scrollAnswer(ANSWER_SCROLL_STEP)
        break
      case 'copy': {
        // `:383` — raw Markdown (the stored source text), not the rendered DOM.
        const payload = copyPayload(getSideQuestionRing(sessionId))
        if (payload !== null) {
          void navigator.clipboard?.writeText(payload)
          toast.success(t('common.copied'))
        }
        break
      }
      case 'clear-thread':
        updateSideQuestionRing(sessionId, clearThread)
        break
    }
  }, [onDismiss, scrollAnswer, sessionId, t])

  return (
    /* The ONE compact-chat card, shared with `EditPopover`'s inline mode — the
       popover the Sources "+" opens. No title row and no hint footer: the card's
       grip dots ARE its header, which is what the owner pointed at. */
    <CompactChatCard
      cardRef={contentRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      ariaLabel={t('chat.sideQuestion.title')}
      testId="side-question-panel"
    >
      {/* The thread + the composer — the compact ChatDisplay, whole. D1.399
          deleted the dimmed earlier-answers list that used to sit above this:
          the thread IS the history now, so there is nothing to show separately
          and nothing left for the grip's top padding to clear. */}
      <div className="min-h-0 flex-1">
        <ChatDisplay
          session={overlaySession}
          onSendMessage={onAsk}
          onOpenFile={onOpenFile || (() => {})}
          onOpenUrl={onOpenUrl || (() => {})}
          currentModel=""
          onModelChange={() => {}}
          compactMode
          // D1.392 — the panel's OWN rotating tips. Passing none fell through to
          // the main composer's, which is how a popover with no sidebar in it came
          // to say "Press B to toggle the sidebar".
          placeholder={SIDE_QUESTION_PLACEHOLDER_KEYS.map(key => t(key))}
          // One question at a time: the ring holds one in-flight exchange, so a
          // second send while the first is unanswered would overwrite what the
          // user is waiting for.
          disableSend={pending}
          emptyStateLabel={t('chat.sideQuestion.emptyState')}
        />
      </div>

      {/* The ONE hint line (`:378-385`, minus `f` and minus the stepping —
          D1.399 took `← / →` with the one-at-a-time view, so the line is three
          keys now). It appears once the thread has anything in it: `c` and `x`
          do nothing before that, and the empty card must read like the popover
          it is shaped after. Escape dismisses throughout, hint or no hint. */}
      {ring.exchanges.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 px-4 pb-1.5 text-[11px] text-foreground/40">
          <span>{t('chat.sideQuestion.copyHint')}</span>
          <span>{t('chat.sideQuestion.clearHint')}</span>
          <span>{t('chat.sideQuestion.dismissHint')}</span>
        </div>
      )}
    </CompactChatCard>
  )
}

export interface SideQuestionOverlayProps {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onAsk: (question: string) => void
  composerCapabilities?: ComposerCapabilities
}

export function SideQuestionOverlay({
  sessionId,
  open,
  onOpenChange,
  onAsk,
  composerCapabilities,
}: SideQuestionOverlayProps) {
  const ring = React.useSyncExternalStore(
    subscribeSideQuestionRings,
    () => getSideQuestionRing(sessionId),
  )
  const hasExchange = currentExchange(ring) !== null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* Same hidden zero-size anchor the composer's add-label EditPopover uses. */}
      <PopoverTrigger asChild>
        <span className="absolute top-0 left-0 w-0 h-0 overflow-hidden" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sticky="always"
        className="p-0"
        style={{
          width: SIDE_QUESTION_PANEL_WIDTH,
          height: sideQuestionPanelHeight(hasExchange),
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
        }}
      >
        <SideQuestionPanel
          sessionId={sessionId}
          onDismiss={() => onOpenChange(false)}
          onAsk={onAsk}
          {...(composerCapabilities ? { composerCapabilities } : {})}
        />
      </PopoverContent>
    </Popover>
  )
}
