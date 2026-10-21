import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_TRANSCRIPT_VERBOSITY,
  TRANSCRIPT_VERBOSITY_MODES,
  cycleTranscriptVerbosity,
  isTranscriptVerbosity,
  resolveTranscriptVerbosity,
  type TranscriptActivity,
} from '../transcript-verbosity'

/**
 * P6.469 — the one transcript verbosity.
 *
 * Asserted on VALUES, not on `TurnCard.tsx`'s source: that component cannot be
 * loaded by the bun runner at all (it reaches `pdfjs-dist` through `Markdown`),
 * and a source assertion cannot tell a painted row from a dropped one — which
 * is the exact class of defect this row exists to prevent.
 */
const A = (over: Partial<TranscriptActivity> & { type: string }): TranscriptActivity => ({ ...over })

const TURN: TranscriptActivity[] = [
  A({ type: 'tool', toolName: 'Read' }),
  A({ type: 'intermediate', displayContent: 'replaced by a hook' }),
  A({ type: 'tool', toolName: 'Edit' }),
  A({ type: 'thinking' }),
  A({ type: 'tool', toolName: 'Bash' }),
  A({ type: 'tool', toolName: 'Write' }),
]

describe('the cycle', () => {
  it('is the page\'s own order and returns to the default', () => {
    expect(TRANSCRIPT_VERBOSITY_MODES).toEqual(['normal', 'verbose', 'summary'])
    expect(DEFAULT_TRANSCRIPT_VERBOSITY).toBe('normal')
    expect(cycleTranscriptVerbosity('normal')).toBe('verbose')
    expect(cycleTranscriptVerbosity('verbose')).toBe('summary')
    expect(cycleTranscriptVerbosity('summary')).toBe('normal')
  })

  it('negative — an unrecognised persisted value falls back rather than throwing', () => {
    expect(isTranscriptVerbosity('chatty')).toBe(false)
    expect(cycleTranscriptVerbosity('chatty')).toBe(DEFAULT_TRANSCRIPT_VERBOSITY)
  })
})

describe('what each mode shows', () => {
  it('Normal is byte-for-byte the list the card always rendered', () => {
    const out = resolveTranscriptVerbosity('normal', TURN)
    expect(out.activities).toEqual(TURN)
    expect(out.hiddenCount).toBe(0)
    expect(out.expandByDefault).toBeUndefined()
    // The hook's on-screen replacement still wins in Normal — only Verbose
    // shows the original (`hooks.md`).
    expect(out.activities[1]!.displayContent).toBe('replaced by a hook')
  })

  it('Verbose keeps every step, opens the section, and shows the original text', () => {
    const out = resolveTranscriptVerbosity('verbose', TURN)
    expect(out.activities).toHaveLength(TURN.length)
    expect(out.hiddenCount).toBe(0)
    expect(out.expandByDefault).toBe(true)
    expect(out.showOriginalContent).toBe(true)
    expect(out.activities[1]!.displayContent).toBeUndefined()
    // The source row is untouched — the strip is a copy, not a mutation.
    expect(TURN[1]!.displayContent).toBe('replaced by a hook')
  })

  it('Summary keeps only the changes, and says how many rows it is holding back', () => {
    const out = resolveTranscriptVerbosity('summary', TURN)
    expect(out.activities.map(a => a.toolName)).toEqual(['Edit', 'Write'])
    expect(out.hiddenCount).toBe(4)
    expect(out.expandByDefault).toBeUndefined()
  })

  it('boundary — a turn of nothing but reads is empty in Summary and still counted', () => {
    const reads = [A({ type: 'tool', toolName: 'Read' }), A({ type: 'tool', toolName: 'Grep' })]
    const out = resolveTranscriptVerbosity('summary', reads)
    expect(out.activities).toEqual([])
    expect(out.hiddenCount).toBe(2)
  })

  /**
   * The row's whole claim: identical on all three runtimes. It holds because
   * the three backend adapters normalise a file change onto ONE canonical tool
   * name before the transcript ever sees it — codex's `item.changes` and Pi's
   * edit tool both surface as `Edit`, which is claude's own spelling. So the
   * same filter run over the same-shaped rows cannot answer differently per
   * runtime; there is no runtime input to this function at all.
   */
  it('is runtime-blind by construction', () => {
    const claude = [A({ type: 'tool', toolName: 'Edit' }), A({ type: 'tool', toolName: 'Read' })]
    const codex = [A({ type: 'tool', toolName: 'Edit' }), A({ type: 'tool', toolName: 'Read' })]
    const pi = [A({ type: 'tool', toolName: 'Edit' }), A({ type: 'tool', toolName: 'Read' })]
    const shown = (rows: TranscriptActivity[]) =>
      resolveTranscriptVerbosity('summary', rows).activities.map(a => a.toolName)
    expect(shown(claude)).toEqual(shown(codex))
    expect(shown(codex)).toEqual(shown(pi))
    expect(shown(pi)).toEqual(['Edit'])
  })
})
