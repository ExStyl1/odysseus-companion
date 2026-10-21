/**
 * P6.712 — how an `info` notice lays itself out, as a decision rather than a
 * string of classes buried in a 3 500-line component.
 *
 * The `info` row is the transcript's one general-purpose notice line, and since
 * P3.158 it is also where every HOST-ANSWERED seam command lands: `/help`,
 * `/config` (P6.410), `/mcp` (P6.352) and `/diff` (P6.278) all reach the chat as
 * an `info` message. Those answers are LISTS. The row rendered them inside a
 * `flex items-center` line whose text span carried no `whitespace-pre-wrap`, so
 * every newline collapsed to a space and a four-server `/mcp` inventory arrived
 * as one unreadable paragraph. `/diff` is why it was measured: W8-q could only
 * ship a SUMMARY, because a patch through this renderer is a single line.
 *
 * The decision is conditional on purpose, not unconditional. Single-line
 * notices are the overwhelming majority — a compaction notice, a terminal
 * verdict, a plan-approved line — and they must keep their exact current
 * vertical centring against the icon. Turning `whitespace-pre-wrap` on for
 * everything would also make a trailing newline in some future notice open a
 * blank line under it. So: a notice that contains a newline gets pre-wrapped
 * text, top-aligned against an icon nudged down onto the first line's baseline;
 * everything else is byte-for-byte what it was.
 *
 * P6.731 added the second half of the same partition: the row was also
 * `select-none`, so those lists could be read and not copied. A one-line
 * notice is chrome and stays unselectable; a list is content and says
 * `select-text`. Same condition, one decision, no new branch at the call site.
 *
 * It lives in its own module because `ChatDisplay.tsx` cannot be imported by a
 * test — `bun test` has no DOM and the component pulls a UI barrel bun cannot
 * resolve — and a layout rule nobody can test is a layout rule that silently
 * regresses. Same reason `ChatDisplay.usage-format.ts` and
 * `ChatDisplay.follow-ups.ts` sit beside it.
 *
 * UB14.14 — the row moved with v0.15.1's message renderer into
 * `chat-display/MessageBubble.tsx` and takes that file's look: a 28px
 * (`min-h-7`) `text-label` line with a 16px icon slot. The single-line arm IS
 * v0.15.1's row (its `items-center`, `select-none`, `size-4` slot and `min-w-0`
 * text); the multi-line arm is ours on that grid — top-aligned with the 5px the
 * centred line gets (28px row, 18px line), the slot nudged 1px onto the first
 * line's centre.
 */

export interface InfoNoticeLayout {
  /** Alignment class for the notice row; joined onto the row's other classes. */
  readonly rowAlignClassName: string
  /** Classes for the icon box, which needs a nudge only when the row is top-aligned. */
  readonly iconClassName: string
  /**
   * Class for the text span: v0.15.1's `min-w-0`, plus `whitespace-pre-wrap`
   * when the notice is a list.
   */
  readonly textClassName: string
  /**
   * P6.731 — whether the row's text can be selected with the mouse.
   *
   * The row carried `select-none` unconditionally, which is right for a
   * one-line notice: it is chrome, and a stray drag across the transcript
   * should not highlight it. It is wrong for the seam answers, because a
   * `/mcp` inventory or a `/diff` patch a user cannot copy into a bug report
   * is a list they retype. The partition is already here, so the select rule
   * rides on it rather than becoming a second condition at the call site.
   *
   * `select-text` and not merely the ABSENCE of `select-none`: the notice sits
   * inside the transcript's own chrome, so the multi-line row has to say yes
   * rather than only stop saying no. The assistant copy in
   * `chat-display/MessageBubble.tsx` opts in the same way.
   */
  readonly rowSelectClassName: string
}

const SINGLE_LINE: InfoNoticeLayout = {
  rowAlignClassName: 'items-center',
  iconClassName: 'flex size-4 shrink-0 items-center justify-center',
  textClassName: 'min-w-0',
  rowSelectClassName: 'select-none',
}

const MULTI_LINE: InfoNoticeLayout = {
  rowAlignClassName: 'items-start py-[5px]',
  iconClassName: 'flex size-4 shrink-0 items-center justify-center mt-px',
  textClassName: 'min-w-0 whitespace-pre-wrap',
  rowSelectClassName: 'select-text',
}

/**
 * Whether a notice's text is a list rather than a sentence.
 *
 * Only a real newline counts. A long single-line notice that WRAPS is still a
 * sentence and keeps centring; the question is whether the author put line
 * breaks in, not whether the viewport happened to break it.
 */
export function isMultiLineNotice(content: string): boolean {
  return content.includes('\n')
}

/** {@link isMultiLineNotice}, resolved to the classes the row renders. */
export function infoNoticeLayout(content: string): InfoNoticeLayout {
  return isMultiLineNotice(content) ? MULTI_LINE : SINGLE_LINE
}
