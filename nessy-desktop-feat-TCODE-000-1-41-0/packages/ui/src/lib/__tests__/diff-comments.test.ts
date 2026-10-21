/**
 * P6.306 — the batch's wire shape, which is the half of this row that
 * `done_means` is actually about: *"comments on three lines of one file,
 * submitted as one batch, reach the next turn as anchored text and the reply
 * changes exactly those three lines"*.
 *
 * It is pinned here rather than in a component test because it is the same
 * text on all three runtimes by construction — the formatter is host-side and
 * knows nothing about which backend produced the diff. A component test would
 * assert that a button exists; this asserts what the model receives.
 */
import { describe, expect, test } from 'bun:test'

import {
  DIFF_COMMENT_BATCH_HEADING,
  diffCommentKey,
  formatDiffCommentBatch,
  type DiffLineComment,
} from '../diff-comments'

const comment = (over: Partial<DiffLineComment> = {}): DiffLineComment => ({
  filePath: 'src/a.ts',
  lineNumber: 12,
  side: 'additions',
  body: 'rename this',
  ...over,
})

describe('formatDiffCommentBatch', () => {
  test('an empty batch is the empty string, not an empty turn', () => {
    // The caller must be able to tell "nothing to send" from "send this".
    expect(formatDiffCommentBatch([])).toBe('')
  })

  test('a batch of blank bodies is also empty', () => {
    // The boundary: comments EXIST but none of them says anything, which is
    // what an abandoned draft box leaves behind.
    expect(formatDiffCommentBatch([comment({ body: '   ' }), comment({ lineNumber: 13, body: '\n' })])).toBe('')
  })

  test('three comments on one file anchor by path and line', () => {
    const text = formatDiffCommentBatch([
      comment({ lineNumber: 30, body: 'third' }),
      comment({ lineNumber: 12, body: 'first' }),
      comment({ lineNumber: 21, body: 'second' }),
    ])
    expect(text).toContain(`${DIFF_COMMENT_BATCH_HEADING} (3 comments):`)
    expect(text).toContain('src/a.ts:12 (+)')
    expect(text).toContain('src/a.ts:21 (+)')
    expect(text).toContain('src/a.ts:30 (+)')
    // Ordered as a reviewer reads, not as they clicked.
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'))
    // The instruction that makes "changes exactly those three lines" a request
    // rather than a hope.
    expect(text).toContain('change nothing else')
  })

  test('the file name is printed once per file, not once per comment', () => {
    const text = formatDiffCommentBatch([
      comment({ lineNumber: 1 }), comment({ lineNumber: 2 }), comment({ filePath: 'src/b.ts', lineNumber: 1 }),
    ])
    // Two heading lines: one per file. The anchors below them repeat the path
    // on purpose — a model that scrolled past the heading still has it.
    const headings = text.split('\n').filter(line => line === 'src/a.ts' || line === 'src/b.ts')
    expect(headings).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('a deletion-side comment carries the minus marker', () => {
    const text = formatDiffCommentBatch([comment({ side: 'deletions', lineText: 'const old = 1' })])
    expect(text).toContain('src/a.ts:12 (-)')
    expect(text).toContain('- const old = 1')
  })

  test('a deletion sorts before an addition on the same line', () => {
    // The removed line is what WAS there, so it reads before its replacement.
    const text = formatDiffCommentBatch([
      comment({ side: 'additions', body: 'after' }),
      comment({ side: 'deletions', body: 'before' }),
    ])
    expect(text.indexOf('before')).toBeLessThan(text.indexOf('after'))
  })

  test('the line text is optional and its absence loses nothing else', () => {
    const withText = formatDiffCommentBatch([comment({ lineText: 'const x = 1' })])
    const without = formatDiffCommentBatch([comment()])
    expect(withText).toContain('+ const x = 1')
    expect(without).not.toContain('+ const x = 1')
    expect(without).toContain('src/a.ts:12 (+)')
    expect(without).toContain('rename this')
  })

  test('a multi-line body keeps its own line breaks, indented under the anchor', () => {
    const text = formatDiffCommentBatch([comment({ body: 'one\ntwo' })])
    expect(text).toContain('    one\n    two')
  })

  test('one comment is singular', () => {
    expect(formatDiffCommentBatch([comment()])).toContain('(1 comment):')
  })

  test('the same batch formats byte-identically twice', () => {
    // The ordering is total, so the text is a function of the batch and not of
    // the order the reader happened to click in.
    const batch = [comment({ lineNumber: 9 }), comment({ filePath: 'src/b.ts' }), comment({ lineNumber: 3 })]
    expect(formatDiffCommentBatch(batch)).toBe(formatDiffCommentBatch([...batch].reverse()))
  })
})

describe('diffCommentKey', () => {
  test('the anchor is the identity — path, side and line together', () => {
    const base = { filePath: 'src/a.ts', lineNumber: 12, side: 'additions' as const }
    expect(diffCommentKey(base)).toBe(diffCommentKey({ ...base }))
    expect(diffCommentKey(base)).not.toBe(diffCommentKey({ ...base, lineNumber: 13 }))
    expect(diffCommentKey(base)).not.toBe(diffCommentKey({ ...base, side: 'deletions' }))
    expect(diffCommentKey(base)).not.toBe(diffCommentKey({ ...base, filePath: 'src/b.ts' }))
  })
})
