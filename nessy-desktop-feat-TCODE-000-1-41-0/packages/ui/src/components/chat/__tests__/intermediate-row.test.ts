/**
 * P4.4 · what a reasoning row actually PAINTS.
 *
 * These assert values, not presence. The defect this row closes was precisely a
 * row that existed and was empty: `activity.type === 'thinking'` was keyed only
 * to a fallback display NAME inside `ActivityRow`'s TOOL branch, and that branch
 * draws `displayedName` and never `activity.content`. An "a thinking row
 * rendered" assertion would have passed against it.
 *
 * `TurnCard.tsx` cannot be loaded by the bun runner (pdfjs via `Markdown`; see
 * `intermediate-row.ts`'s header for the measurement and the two prior
 * recordings), which is why the decision lives in a module and is checked here
 * rather than through rendered markup.
 */
import { describe, expect, it } from 'bun:test'
import { describeIntermediateRow, stripMarkdown } from '../intermediate-row'

const PLACEHOLDER = 'Thinking...'

function reasoning(overrides: Record<string, unknown> = {}) {
  return { type: 'thinking', status: 'completed', content: 'because the handler is in src/auth', ...overrides }
}

function commentary(overrides: Record<string, unknown> = {}) {
  return { type: 'intermediate', status: 'completed', content: 'let me open the handler', ...overrides }
}

describe('describeIntermediateRow (P4.4)', () => {
  it('paints the reasoning text itself, not a label', () => {
    const row = describeIntermediateRow(reasoning(), PLACEHOLDER)
    expect(row.text).toBe('because the handler is in src/auth')
    // The exact defect: the tool branch would have painted the word "Thinking".
    expect(row.text).not.toBe('Thinking')
  })

  it('classifies reasoning and commentary apart', () => {
    expect(describeIntermediateRow(reasoning(), PLACEHOLDER).kind).toBe('reasoning')
    expect(describeIntermediateRow(commentary(), PLACEHOLDER).kind).toBe('commentary')
  })

  it('gives reasoning the brain icon and commentary the text bubble (UB14.11, v0.15.1)', () => {
    expect(describeIntermediateRow(reasoning(), PLACEHOLDER).icon).toBe('brain')
    expect(describeIntermediateRow(commentary(), PLACEHOLDER).icon).toBe('message-square-text')
  })

  it('de-emphasises reasoning only', () => {
    expect(describeIntermediateRow(reasoning(), PLACEHOLDER).deemphasised).toBe(true)
    expect(describeIntermediateRow(commentary(), PLACEHOLDER).deemphasised).toBe(false)
  })

  it('shows the placeholder and no content while a block is still arriving', () => {
    const row = describeIntermediateRow(reasoning({ status: 'running' }), PLACEHOLDER)
    expect(row.isStreaming).toBe(true)
    expect(row.icon).toBe('spinner')
    expect(row.text).toBe(PLACEHOLDER)
    expect(row.text).not.toContain('src/auth')
  })

  it('never leaks content through the streaming placeholder for either kind', () => {
    for (const activity of [reasoning({ status: 'running' }), commentary({ status: 'running' })]) {
      expect(describeIntermediateRow(activity, PLACEHOLDER).text).toBe(PLACEHOLDER)
    }
  })

  it('strips markdown from the painted reasoning', () => {
    const row = describeIntermediateRow(
      reasoning({ content: '## Plan\n\nRead **auth.ts** first, see [docs](http://x)' }),
      PLACEHOLDER,
    )
    expect(row.text).toBe('Plan Read auth.ts first, see docs')
  })

  it('prefers a MessageDisplay hook replacement over the original content (R32)', () => {
    const row = describeIntermediateRow(
      reasoning({ content: 'ORIGINAL', displayContent: 'REPLACED' }),
      PLACEHOLDER,
    )
    expect(row.text).toBe('REPLACED')
    expect(row.text).not.toContain('ORIGINAL')
  })

  it('paints an empty string rather than throwing on a contentless completed row', () => {
    const row = describeIntermediateRow({ type: 'thinking', status: 'completed' }, PLACEHOLDER)
    expect(row.text).toBe('')
    expect(row.isComplete).toBe(true)
  })

  it('marks only completed rows as clickable', () => {
    expect(describeIntermediateRow(reasoning({ status: 'completed' }), PLACEHOLDER).isComplete).toBe(true)
    expect(describeIntermediateRow(reasoning({ status: 'running' }), PLACEHOLDER).isComplete).toBe(false)
    expect(describeIntermediateRow(reasoning({ status: 'error' }), PLACEHOLDER).isComplete).toBe(false)
  })

  it('keeps stripMarkdown behaviour after the move out of TurnCard', () => {
    // The function moved modules in this row; this pins the behaviour so the
    // move cannot have silently changed it.
    expect(stripMarkdown('```ts\nconst a = 1\n```')).toBe('const a = 1')
    expect(stripMarkdown('> quoted\n\n---\n\n*em* and __strong__')).toBe('quoted em and strong')
  })
})
