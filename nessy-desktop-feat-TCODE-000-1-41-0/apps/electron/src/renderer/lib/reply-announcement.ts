/**
 * Screen-reader announcement of the assistant's reply (P6.48).
 *
 * The renderer streams the reply into `StreamingMarkdown`, which mutates the
 * same DOM subtree token by token. Nothing in that subtree is a live region, so
 * a screen-reader user gets silence for the entire turn and only discovers the
 * answer by navigating the transcript by hand.
 *
 * The contract is Claude's own, for the surface that matches ours — a graphical
 * chat panel, not the terminal. `vs-code.md#use-a-screen-reader`:
 *
 *   "**Claude's replies**: the extension announces each reply once, when it's
 *   complete, and stays silent while text streams in."
 *
 * That single sentence settles both open questions:
 *
 * - **Granularity.** Per-token announcement is not merely noisy, it is worse
 *   than silence: an `aria-live` region re-read on every delta interrupts
 *   itself continuously and never finishes a sentence. So the announcement is
 *   keyed to turn COMPLETION, not to the delta stream.
 * - **Politeness.** "Announces" without interruption, alongside a transcript
 *   the user can still read at their own pace, is `polite` — an assertive
 *   region would cut off whatever the user was reading. The reply is
 *   information, not an alert.
 *
 * The same page also fixes what must NOT speak:
 *
 *   "When you reopen a session or switch to another one, the extension
 *   announces nothing: restored history, pending permission prompts, and
 *   in-progress status stay silent until something new happens."
 *
 * `stepReplyAnnouncer` implements exactly that: a session change re-baselines
 * and never announces, so switching to a session that already holds a finished
 * reply is silent, and so is the first render after a reload.
 *
 * This module is deliberately React-free and i18n-free so the decision can be
 * tested without a DOM: the caller supplies the label formatters.
 */

/** The subset of a rendered message this module needs. */
export interface AnnouncableMessage {
  role: string
  content?: string
  isIntermediate?: boolean
}

/**
 * What the announcer remembers between renders.
 *
 * `wasProcessing` is the only edge we key off: `true -> false` on an unchanged
 * session is "a turn just finished". Message identity is deliberately NOT part
 * of the state — two consecutive identical replies are a real, if rare,
 * possibility, and de-duplicating on content would swallow the second one.
 */
export interface ReplyAnnouncerState {
  sessionId: string | null
  wasProcessing: boolean
}

export const initialReplyAnnouncerState: ReplyAnnouncerState = {
  sessionId: null,
  wasProcessing: false,
}

export interface ReplyAnnouncerInput {
  sessionId: string | null
  isProcessing: boolean
}

export interface ReplyAnnouncerStep {
  state: ReplyAnnouncerState
  /** True on exactly the render where a turn finished on the session we were already watching. */
  announce: boolean
}

/**
 * Advance the announcer by one observation.
 *
 * Silent on: first observation, session switch, streaming start, every render
 * during streaming, and every render after the turn ended. Speaks once, on the
 * falling edge of `isProcessing`.
 */
export function stepReplyAnnouncer(
  prev: ReplyAnnouncerState,
  input: ReplyAnnouncerInput,
): ReplyAnnouncerStep {
  const state: ReplyAnnouncerState = {
    sessionId: input.sessionId,
    wasProcessing: input.isProcessing,
  }

  // A session switch re-baselines without speaking. Restored history is not
  // new activity, and the user asked for it — they are not waiting on it.
  if (prev.sessionId !== input.sessionId) return { state, announce: false }

  return { state, announce: prev.wasProcessing && !input.isProcessing }
}

/**
 * The message a finished turn should announce.
 *
 * Errors count, and deliberately so: this mirrors the OS-notification selector
 * in `App.tsx`, which includes them because after a failed retry the last
 * assistant message is a STALE earlier reply, and announcing it would report a
 * fresh successful answer that never happened (tester finding 2026-07-20). A
 * screen-reader user has strictly less context to catch that than a sighted
 * one, so silence-on-error is the worse failure here.
 */
export function selectAnnouncableReply(
  messages: readonly AnnouncableMessage[] | undefined,
): AnnouncableMessage | null {
  if (!messages || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.isIntermediate) continue
    if (message.role === 'assistant' || message.role === 'plan' || message.role === 'error') {
      return message
    }
  }
  return null
}

/** Longest announcement we will hand a screen reader in one utterance. */
export const REPLY_ANNOUNCEMENT_MAX_CHARS = 600

export interface ReplySpeechLabels {
  /** Stands in for a fenced code block, e.g. `n => "code block, 12 lines"`. */
  codeBlock: (lines: number) => string
  /** Appended when the reply was cut at {@link REPLY_ANNOUNCEMENT_MAX_CHARS}. */
  truncated: string
}

const FENCE = /^\s*```/

/**
 * Replace fenced code blocks with a spoken summary, per the same page:
 *
 *   "Your screen reader reads code blocks as a line-count summary, reads links
 *   by their label, and reads tables cell by cell; the full reply stays
 *   readable in the transcript."
 *
 * Reading a 200-line diff aloud, character by character, is the single fastest
 * way to make the feature useless. The block stays in the transcript.
 */
export function collapseCodeBlocks(markdown: string, label: (lines: number) => string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inFence = false
  let fenced = 0

  for (const line of lines) {
    if (FENCE.test(line)) {
      if (inFence) {
        out.push(label(fenced))
        inFence = false
        fenced = 0
      } else {
        inFence = true
        fenced = 0
      }
      continue
    }
    if (inFence) {
      fenced++
      continue
    }
    out.push(line)
  }

  // An unterminated fence is the normal shape of an interrupted turn, so it
  // must summarize rather than vanish.
  if (inFence) out.push(label(fenced))

  return out.join('\n')
}

/**
 * Build the utterance for a completed reply.
 *
 * `stripInline` is the caller's markdown stripper (the renderer passes the same
 * `stripMarkdown` the OS notification uses, so the two surfaces cannot drift).
 */
export function buildReplyAnnouncement(
  content: string | undefined,
  labels: ReplySpeechLabels,
  stripInline: (text: string) => string,
): string {
  if (!content || !content.trim()) return ''

  const collapsed = collapseCodeBlocks(content, labels.codeBlock)
  const spoken = stripInline(collapsed).trim()
  if (!spoken) return ''

  if (spoken.length <= REPLY_ANNOUNCEMENT_MAX_CHARS) return spoken
  return `${spoken.slice(0, REPLY_ANNOUNCEMENT_MAX_CHARS).trimEnd()} ${labels.truncated}`
}
