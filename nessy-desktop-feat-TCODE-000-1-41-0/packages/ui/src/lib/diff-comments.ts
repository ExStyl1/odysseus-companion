/**
 * P6.306 — line-anchored diff comments, and the shape that carries them into the
 * next turn.
 *
 * ## Why this is host-side and not per runtime
 *
 * The row's verdict is `absent` on all three, and the reason is that the diff
 * view is OURS: Pi, Claude and Codex all render their file changes through
 * `MultiDiffPreviewOverlay`, none of them publishes a review-comment surface,
 * and codex's own path is the ChatGPT desktop app's review pane rather than an
 * app-server method (searched at `rust-v0.148.0`: `ReviewStartParams` /
 * `ReviewDelivery` / `ReviewTarget`, none carrying a line anchor). So the seam is
 * host-side, and building it once here makes the behaviour identical on all
 * three by construction rather than by three separate ports.
 *
 * ## What "native" DID turn out to mean, and it corrects the row
 *
 * The row says the affordance has to be built. The RUNTIME half of that is
 * right; the VIEWER half is not. `@pierre/diffs`, which both viewers already
 * render with, ships the primitives first-class — `lineAnnotations`,
 * `renderAnnotation`, `enableLineSelection` and `onLineSelected` — and we passed
 * none of them. So the affordance is the library's own mechanism turned on,
 * not a hand-rolled overlay poking at its shadow DOM (the way the file-header
 * click in `UnifiedDiffViewer` has to). Nearest documented solution first.
 *
 * ## Why the formatting lives in a module of its own
 *
 * It is the part `done_means` is actually about — *"reach the next turn as
 * anchored text and the reply changes exactly those three lines"* — and it is
 * the part a test can hold still. A comment box whose output is composed inline
 * in a React component is a comment box whose output nobody can pin.
 */

/** Which side of a diff line a comment is anchored to. Pierre's own vocabulary. */
export type DiffCommentSide = 'additions' | 'deletions'

/** One comment, anchored to one line of one file. */
export interface DiffLineComment {
  /** Absolute or repo-relative path, exactly as the diff header shows it. */
  filePath: string
  /** The line number on `side`, 1-based, as pierre reports it. */
  lineNumber: number
  side: DiffCommentSide
  /**
   * The line's own text, when the viewer could read it.
   *
   * Optional and load-bearing when present: a line NUMBER alone is a fragile
   * anchor — the model may have edited the file since — while the line's text
   * lets it find the same line again. Never required, because a comment on a
   * line whose text could not be read is still a comment worth sending.
   */
  lineText?: string
  /** What the person wrote. */
  body: string
}

/** The heading the batch leads with, so the model can recognise the shape. */
export const DIFF_COMMENT_BATCH_HEADING = 'Review comments on the diff you just showed me'

/**
 * Order the batch the way a reviewer reads it: by file, then by line, then by
 * side with deletions first (a comment on a removed line is about what WAS
 * there, and reads before the replacement).
 *
 * Stable and total, so two identical batches format byte-identically — which is
 * what makes the formatter testable at all.
 */
function compareComments(a: DiffLineComment, b: DiffLineComment): number {
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1
  if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber
  if (a.side !== b.side) return a.side === 'deletions' ? -1 : 1
  return 0
}

/** `+` for an added line, `-` for a removed one — the diff's own marker. */
function sideMarker(side: DiffCommentSide): string {
  return side === 'additions' ? '+' : '-'
}

/**
 * Render one batch of line-anchored comments as the text of the next turn.
 *
 * Returns `''` for an empty batch — the caller must not send an empty turn, and
 * an empty string is the one answer that cannot be mistaken for a comment.
 *
 * The shape is deliberately plain: a heading, then one block per file, then one
 * entry per comment carrying `path:line`, the side marker, the line's own text
 * when known, and the comment indented under it. No JSON, no XML: the reply has
 * to be an EDIT, and a model reading a review comment written the way a person
 * writes one is being asked the question it already knows how to answer.
 */
export function formatDiffCommentBatch(comments: readonly DiffLineComment[]): string {
  const kept = comments.filter(comment => comment.body.trim().length > 0)
  if (kept.length === 0) return ''

  const ordered = [...kept].sort(compareComments)
  const lines: string[] = [
    `${DIFF_COMMENT_BATCH_HEADING} (${ordered.length} ${ordered.length === 1 ? 'comment' : 'comments'}):`,
  ]

  let currentFile: string | null = null
  for (const comment of ordered) {
    if (comment.filePath !== currentFile) {
      currentFile = comment.filePath
      lines.push('', `${currentFile}`)
    }
    const anchor = `  ${currentFile}:${comment.lineNumber} (${sideMarker(comment.side)})`
    lines.push(anchor)
    if (comment.lineText !== undefined && comment.lineText.trim().length > 0) {
      lines.push(`    ${sideMarker(comment.side)} ${comment.lineText.trimEnd()}`)
    }
    for (const bodyLine of comment.body.trim().split('\n')) {
      lines.push(`    ${bodyLine}`)
    }
  }

  lines.push(
    '',
    'Address each comment at the line it names and change nothing else.',
  )
  return lines.join('\n')
}

/** The key one comment is stored under, so a second comment on a line replaces the first. */
export function diffCommentKey(anchor: Pick<DiffLineComment, 'filePath' | 'lineNumber' | 'side'>): string {
  // NUL is the separator on purpose — a file path may contain a space or any
  // other printable character, while neither a side nor a line number can
  // contain a NUL, so two different anchors can never collide into one key.
  // Written as the ESCAPE rather than the byte (AGENTS.md §Traps): identical
  // runtime value, and the source stays greppable and `lint:nul-bytes` green.
  return `${anchor.filePath}\u0000${anchor.side}\u0000${anchor.lineNumber}`
}
