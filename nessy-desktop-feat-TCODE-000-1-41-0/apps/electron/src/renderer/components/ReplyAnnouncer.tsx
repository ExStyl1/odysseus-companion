/**
 * ReplyAnnouncer — the assistant's reply, spoken once, to a screen reader (P6.48).
 *
 * Mounted once at the app root, next to `WindowCloseHandler`. It renders a
 * single, permanently-present `aria-live` region and nothing visible.
 *
 * Two mechanics matter and are easy to get wrong:
 *
 * 1. **The region must already exist when its text changes.** A live region
 *    that is mounted at the same moment it gains text is frequently missed by
 *    VoiceOver and NVDA, because the observer is attached after the mutation.
 *    So this component always renders the element and only ever swaps its
 *    text — it never conditionally renders the region itself.
 *
 * 2. **It must not re-render per token.** Subscribing a component to the
 *    session atom would re-render it on every streaming delta. Instead it
 *    subscribes through the Jotai store directly (`store.sub`), reads the
 *    session in the callback, and calls `setState` only on the one render
 *    where a turn actually finished.
 *
 * The decision of *when* and *what* to speak lives in `lib/reply-announcement`,
 * which is React-free and carries the citation to Claude's own contract for
 * this surface (`vs-code.md#use-a-screen-reader`).
 *
 * Runtime coverage: this observes `session.isProcessing` and `session.messages`
 * in the renderer's atoms. Every runtime — Pi, claude and codex — reaches those
 * atoms through the same backend-agnostic event processor, so there is exactly
 * one code path here and no per-runtime branch.
 */

import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { activeSessionIdAtom, sessionAtomFamily } from '@/atoms/sessions'
import { stripMarkdown } from '@/utils/text'
import {
  buildReplyAnnouncement,
  initialReplyAnnouncerState,
  selectAnnouncableReply,
  stepReplyAnnouncer,
  type ReplyAnnouncerState,
} from '@/lib/reply-announcement'

export function ReplyAnnouncer() {
  const store = useStore()
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const [announcement, setAnnouncement] = React.useState('')

  const stateRef = React.useRef<ReplyAnnouncerState>(initialReplyAnnouncerState)

  // `t` is kept in a ref rather than in the effect's deps on purpose: a
  // language change must not re-run the subscription, because re-running it
  // re-observes the session and could speak a turn that already ended.
  const tRef = React.useRef(t)
  tRef.current = t

  React.useEffect(() => {
    const observe = () => {
      const session = activeSessionId ? store.get(sessionAtomFamily(activeSessionId)) : null

      const { state, announce } = stepReplyAnnouncer(stateRef.current, {
        sessionId: activeSessionId,
        isProcessing: session?.isProcessing === true,
      })
      stateRef.current = state
      if (!announce || !session) return

      // Hidden sessions are the mini-agent ones. They are excluded from OS
      // notifications for the same reason: the user never asked for them.
      if (session.hidden) return

      const translate = tRef.current
      const reply = selectAnnouncableReply(session.messages)
      const text = buildReplyAnnouncement(
        reply?.content,
        {
          codeBlock: (lines: number) => translate('a11y.reply.codeBlock', { count: lines }),
          truncated: translate('a11y.reply.truncated'),
        },
        stripMarkdown,
      )

      // A turn can finish with nothing sayable — a tool-only turn, or one whose
      // whole reply was a code block the user will read in the transcript.
      // Falling silent there is the worst outcome of all: the user is left
      // waiting on a turn that already ended. Say that it ended instead.
      setAnnouncement(text || translate('a11y.reply.ready'))
    }

    // Baseline immediately, without speaking: `stepReplyAnnouncer` treats the
    // session change this represents as silent, which is what makes reopening
    // or switching a session announce nothing.
    observe()

    if (!activeSessionId) return
    return store.sub(sessionAtomFamily(activeSessionId), observe)
  }, [store, activeSessionId])

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  )
}
