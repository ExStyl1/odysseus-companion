/**
 * The presentation decision for the two "intermediate" activity rows —
 * commentary and, since P4.4, model reasoning.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE TERNARY. P4.4's acceptance asked that
 * the row's rendered VALUE be asserted, and that a row asserted to exist not be
 * allowed to pass while empty or stale. That cannot be done by rendering
 * `TurnCard`: **`TurnCard.tsx` cannot be loaded by the bun runner at all.** It
 * reaches `pdfjs-dist` through `Markdown` → `MarkdownPdfBlock`, so importing it
 * throws `Missing 'default' export in module '…/pdf.worker.min.mjs?url'`, and
 * stubbing that module only moves the failure to `ReferenceError: DOMMatrix is
 * not defined` inside `react-pdf`'s nested `pdfjs-dist`. Measured 2026-08-21 and
 * recorded twice in this tree — `__tests__/turn-preview-label.test.ts:10-14` and
 * `__tests__/inline-execution-tool-name.test.ts:21-25`.
 *
 * Those two files responded by reading `TurnCard.tsx` as TEXT and asserting on
 * the source. That is weaker than it looks: a source assertion cannot tell a
 * painted value from a dropped one, which is precisely the P4.4 defect
 * (`activity.type === 'thinking'` was keyed to a display NAME inside the tool
 * branch, so the reasoning content was dropped while the row still rendered).
 *
 * So the decision moves OUT of the component into a module that loads cleanly —
 * the same containment `run-summary.ts` already uses, including its trick of
 * declaring a minimal structural input rather than importing `ActivityItem`, to
 * keep the dependency one-way. The component keeps only the JSX.
 */

/** Which of the two intermediate row kinds this is. */
export type IntermediateRowKind = 'commentary' | 'reasoning'

/**
 * The minimum a row needs to describe itself. `ActivityItem` (`TurnCard.tsx`)
 * is structurally assignable to this; declared here rather than imported so
 * this module stays loadable under `bun test`.
 */
export interface IntermediateRowActivity {
  type: string
  status: string
  content?: string
  /** R32 · a `MessageDisplay` hook's on-screen replacement, when one ran. */
  displayContent?: string
}

export interface IntermediateRowPresentation {
  kind: IntermediateRowKind
  /** Still arriving: the row shows a spinner and a placeholder, never content. */
  isStreaming: boolean
  /** Exactly the string the row paints. */
  text: string
  /**
   * The icon drawn once the block has landed. Commentary takes v0.15.1's text bubble
   * (`MessageSquareText`, UB14.11): the old dashed circle read as the "Todo" status glyph at 14px.
   */
  icon: 'spinner' | 'message-square-text' | 'brain'
  /**
   * Reasoning is de-emphasised against commentary: it is the model addressing
   * itself, not the user.
   */
  deemphasised: boolean
  /** Completed rows are clickable and can open the details pane. */
  isComplete: boolean
}

/**
 * Simple markdown stripping for preview text.
 * Removes markdown syntax to show plain text preview.
 * Code block content is preserved as plain text.
 */
export function stripMarkdown(text: string): string {
  return text
    // Extract content from fenced code blocks (remove ``` and optional language)
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1')
    // Extract content from inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * `activity.type === 'thinking'` is the ONLY thing separating the two kinds.
 * A streaming block of either kind shows the same spinner and placeholder,
 * because its content has not arrived yet and there is nothing to distinguish.
 */
export function describeIntermediateRow(
  activity: IntermediateRowActivity,
  streamingPlaceholder: string,
): IntermediateRowPresentation {
  const kind: IntermediateRowKind = activity.type === 'thinking' ? 'reasoning' : 'commentary'
  const isStreaming = activity.status === 'running'
  const text = isStreaming
    ? streamingPlaceholder
    // R32 · the hook's replacement wins on screen; `activity.content` keeps the
    // original for the details pane and the markdown export.
    : stripMarkdown(activity.displayContent ?? activity.content ?? '')

  return {
    kind,
    isStreaming,
    text,
    icon: isStreaming ? 'spinner' : kind === 'reasoning' ? 'brain' : 'message-square-text',
    deemphasised: kind === 'reasoning',
    isComplete: activity.status === 'completed',
  }
}
