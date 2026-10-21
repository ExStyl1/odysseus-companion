/**
 * ts-comment-scan — split TypeScript/JavaScript source into comment and
 * non-comment spans, so a gate can ask "is this inside a comment?" instead of
 * grepping and guessing.
 *
 * P2.492. Two gates need the same answer and neither can get it from `grep`:
 *
 *   - `check-comment-globs` looks for a path pattern that CLOSES the block
 *     comment it was written into. The same character sequence is legal and
 *     deliberate inside a string — `check-exports-map.ts` holds exactly such
 *     patterns in a constant — so a grep would fire on the constant and miss
 *     nothing else.
 *   - `check-i18n-reachable` counts a quoted locale key as a reader. A key
 *     QUOTED IN PROSE inside a docblock is not a reader, and this tree's habit
 *     of quoting exact tokens verbatim makes that collision common rather than
 *     rare: it was measured deciding one namespace's verdict.
 *
 * ## What it handles, and the one thing it does not
 *
 * Line comments, block comments, both quote styles with backslash escapes, and
 * template literals including nested interpolation (a template inside a
 * `${...}` inside a template is tracked with a stack, because this tree has
 * them).
 *
 * Regular-expression literals are recognised too, and skipping them was not
 * optional — the first version of this module left them out and the very first
 * run over this repo proved why. `check-exports-map.ts` line 313 holds
 * `target.replace(/^\\.\\//, '')`: the escaped slash inside that pattern is
 * followed by the pattern's own closing slash, so a scanner without regex
 * support reads two adjacent slashes, opens a line comment that is not there,
 * and loses its place for the next sixty lines. It then reported an unterminated
 * block comment sixty lines later — a confident finding, in the wrong file
 * region, against the exact gate this module was written to support.
 *
 * Whether a slash opens a regex or divides depends on the previous token, which
 * is why this is a heuristic and not a parser: a slash after a value (an
 * identifier, a number, a closing bracket) divides; anywhere else, and after the
 * keywords in `REGEX_PRECEDING_KEYWORDS`, it opens a pattern. `unterminatedSpans`
 * is the alarm for the residue — a misparse almost always runs off the end of
 * the file, and this module's test asserts zero across every tracked source
 * file, so a shape the heuristic cannot see goes RED rather than quiet.
 */

export type SpanKind = 'code' | 'line-comment' | 'block-comment' | 'string' | 'template'

export interface Span {
  readonly kind: SpanKind
  /** Inclusive start offset. */
  readonly start: number
  /** Exclusive end offset. For an unterminated span this is `text.length`. */
  readonly end: number
  /** True when the span ran off the end of the file without its closer. */
  readonly unterminated: boolean
}

const isQuote = (c: string): boolean => c === "'" || c === '"'

/** After one of these a slash opens a pattern, even though they end in a letter. */
export const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
])

const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

/**
 * Does the slash at `at` open a regular-expression literal rather than divide?
 *
 * The value/operator distinction is the standard heuristic: after an identifier,
 * a number, or a closing bracket the slash is division; after an operator, a
 * comma, an opening bracket or nothing at all it starts a pattern. The keyword
 * set exists because `return /x/.test(s)` reads as a value position by the
 * character test alone.
 */
export function slashStartsRegex(text: string, at: number): boolean {
  let j = at - 1
  while (j >= 0 && /\s/.test(text[j] as string)) j -= 1
  if (j < 0) return true

  const prev = text[j] as string
  if (prev === ')' || prev === ']') return false
  if (!isWordChar(prev)) return true

  let start = j
  while (start >= 0 && isWordChar(text[start] as string)) start -= 1
  return REGEX_PRECEDING_KEYWORDS.has(text.slice(start + 1, j + 1))
}

/** End offset (exclusive) of the regex literal opening at `at`, flags included. */
function endOfRegex(text: string, at: number): number {
  let j = at + 1
  let inClass = false
  while (j < text.length) {
    const c = text[j] as string
    if (c === '\\') { j += 2; continue }
    if (c === '\n') return j
    if (inClass) { if (c === ']') inClass = false }
    else if (c === '[') inClass = true
    else if (c === '/') {
      j += 1
      while (j < text.length && isWordChar(text[j] as string)) j += 1
      return j
    }
    j += 1
  }
  return text.length
}

/**
 * Classify every character of `text`. Spans are contiguous and in order, so
 * concatenating them reproduces the input exactly.
 */
export function scanSpans(text: string): Span[] {
  const spans: Span[] = []
  /** Open template literals, innermost last; each counts its `${` nesting. */
  const templates: { start: number; braceDepth: number }[] = []
  let codeStart = 0
  let i = 0

  const closeCode = (at: number): void => {
    if (at > codeStart) spans.push({ kind: 'code', start: codeStart, end: at, unterminated: false })
  }

  while (i < text.length) {
    const c = text[i] as string
    const next = text[i + 1]

    if (c === '/' && next !== '/' && next !== '*' && slashStartsRegex(text, i)) {
      // Consumed as CODE, not as its own span: callers ask about comments, and a
      // pattern is not one. What matters is that its slashes never reach the two
      // checks below.
      i = endOfRegex(text, i)
      continue
    }

    if (c === '/' && next === '/') {
      closeCode(i)
      let end = text.indexOf('\n', i)
      if (end < 0) end = text.length
      spans.push({ kind: 'line-comment', start: i, end, unterminated: false })
      i = end
      codeStart = i
      continue
    }

    if (c === '/' && next === '*') {
      closeCode(i)
      const closer = text.indexOf('*/', i + 2)
      const end = closer < 0 ? text.length : closer + 2
      spans.push({ kind: 'block-comment', start: i, end, unterminated: closer < 0 })
      i = end
      codeStart = i
      continue
    }

    if (isQuote(c)) {
      let j = i + 1
      let closed = false
      let hitNewline = false
      while (j < text.length) {
        const d = text[j] as string
        if (d === '\\') { j += 2; continue }   // a backslash-newline continuation too
        if (d === c) { j += 1; closed = true; break }
        if (d === '\n') { hitNewline = true; break }
        j += 1
      }

      // A quote that reaches a raw newline is NOT a string: no JS string literal
      // may contain one. It is an apostrophe in JSX TEXT — `I'll explore the
      // codebase` in a playground fixture, and a second such site in the API-key
      // panel, were the only two files in this repo the scanner could not read
      // before this branch existed. Recovering here rather than parsing JSX keeps
      // the whole apostrophe class out of the misparse alarm, and costs one
      // character of lookahead.
      if (hitNewline) { i += 1; continue }

      closeCode(i)
      spans.push({ kind: 'string', start: i, end: j, unterminated: !closed })
      i = j
      codeStart = i
      continue
    }

    if (c === '`') {
      closeCode(i)
      templates.push({ start: i, braceDepth: 0 })
      // The body up to the first `${` is template text; interpolations are code
      // and are scanned by this same loop, so nothing below needs a second pass.
      // The span starts at the backtick so spans stay contiguous.
      i = scanTemplateBody(text, i + 1, spans, templates, i)
      codeStart = i
      continue
    }

    if (templates.length > 0) {
      const top = templates[templates.length - 1] as { start: number; braceDepth: number }
      if (c === '{') top.braceDepth += 1
      else if (c === '}') {
        if (top.braceDepth === 0) {
          closeCode(i)
          i = scanTemplateBody(text, i + 1, spans, templates, i)
          codeStart = i
          continue
        }
        top.braceDepth -= 1
      }
    }

    i += 1
  }

  closeCode(text.length)
  for (const open of templates) {
    spans.push({ kind: 'template', start: open.start, end: text.length, unterminated: true })
  }
  return spans.sort((a, b) => a.start - b.start)
}

/**
 * Consume template text from `from` until the template closes or an
 * interpolation opens. Returns the offset the main loop should resume at.
 */
function scanTemplateBody(
  text: string,
  from: number,
  spans: Span[],
  templates: { start: number; braceDepth: number }[],
  spanStart: number,
): number {
  let j = from
  while (j < text.length) {
    const d = text[j] as string
    if (d === '\\') { j += 2; continue }
    if (d === '`') {
      spans.push({ kind: 'template', start: spanStart, end: j + 1, unterminated: false })
      templates.pop()
      return j + 1
    }
    if (d === '$' && text[j + 1] === '{') {
      spans.push({ kind: 'template', start: spanStart, end: j + 2, unterminated: false })
      return j + 2
    }
    j += 1
  }
  spans.push({ kind: 'template', start: spanStart, end: text.length, unterminated: true })
  templates.pop()
  return text.length
}

/** Spans that ran off the end of the file — the misparse alarm. */
export function unterminatedSpans(text: string): Span[] {
  return scanSpans(text).filter((s) => s.unterminated)
}

/**
 * `text` with every comment character replaced by a space, newlines kept. Same
 * length and same line numbers as the input, so a caller can run its own
 * regexes over the result and report positions that still mean something.
 */
export function blankComments(text: string): string {
  const out = [...text]
  for (const span of scanSpans(text)) {
    if (span.kind !== 'line-comment' && span.kind !== 'block-comment') continue
    for (let i = span.start; i < span.end; i += 1) {
      if (out[i] !== '\n') out[i] = ' '
    }
  }
  return out.join('')
}

export function blockComments(text: string): Span[] {
  return scanSpans(text).filter((s) => s.kind === 'block-comment')
}
