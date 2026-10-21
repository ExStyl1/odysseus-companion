/**
 * UB14.11 (R3-05) — the collapsed work log's text, asserted on VALUES.
 *
 * `turn/work-log-summary.ts` keeps v0.15.1's signature (`{ text?: string }`, `countFailedActivities`)
 * with OUR settled text: the run summary (`run-summary.ts`) where upstream returns `{}` for "N steps
 * completed", and NO error tail — the failed count is the work log's chip now. The priority-order
 * cases moved here from `turn-preview.test.ts` with `getPreviewText` (retired by this row).
 *
 * Arms:
 * - positive (the row's): a settled turn of three reads and one edit reads our run-summary label,
 *   with no error suffix; two errored rows count 2 for the chip;
 * - negative: an explicit intent wins over everything; an empty running turn reads
 *   `turnCard.starting`; a settled turn with no tool call leaves the text to the lead (`{}`), so the
 *   run summary's "Completed N steps" never doubles the lead's "N steps";
 * - the codex bridge row: a running `mcp__sources__w__t` names its TOOL half (`t`), never `w__t`
 *   (upstream's `/^mcp__[^_]+__/` strip), through `turn-preview`'s `getToolDisplayName`.
 *
 * Mutation probes (run 2026-10-16, file restored by hash): re-adding a `turnCard.errorCount` tail to the settled
 * branch, and returning `{}` for every settled turn (upstream), each turn 2 of the 13 cases red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import i18n from 'i18next'

import { setupI18n } from '@nessy-agent/shared/i18n/setupI18n'

import { summarizeTurnRun } from '../../run-summary'
import type { PreviewActivity } from '../../turn-preview'
import { countFailedActivities, getWorkLogPreview } from '../work-log-summary'

setupI18n()
beforeAll(async () => {
  await i18n.changeLanguage('en')
})
afterAll(async () => {
  await i18n.changeLanguage('en')
})

function activity(over: Partial<PreviewActivity>): PreviewActivity {
  return { type: 'tool', status: 'completed', ...over }
}

describe('positive — a settled turn names what it did, and the failures are counted apart', () => {
  const turn = [
    activity({ toolName: 'Read', toolInput: { file_path: '/a.ts' } }),
    activity({ toolName: 'Read', toolInput: { file_path: '/b.ts' }, status: 'error' }),
    activity({ toolName: 'Read', toolInput: { file_path: '/c.ts' } }),
    activity({ toolName: 'Edit', toolInput: { file_path: '/a.ts' }, status: 'error' }),
  ]

  it('three reads and one edit read our run-summary label, not upstream\'s bare count', () => {
    const preview = getWorkLogPreview(turn, undefined, false, true, true)
    expect(preview.text).toBe(summarizeTurnRun(turn))
    expect(preview.text).toBe('Read 3 files, edited 1 file')
  })

  it('the text carries no error tail any more; the chip counts 2', () => {
    const preview = getWorkLogPreview(turn, undefined, false, true, true)
    expect(preview.text).not.toContain('error')
    expect(countFailedActivities(turn)).toBe(2)
    expect(countFailedActivities([activity({ toolName: 'Read' })])).toBe(0)
  })

  it('a Task description wins over the run summary, also without a tail', () => {
    const acts = [
      activity({ toolName: 'Task', toolInput: { description: 'Sweep the keys' } }),
      activity({ toolName: 'Read', status: 'error' }),
    ]
    expect(getWorkLogPreview(acts, undefined, false, false, true)).toEqual({ text: 'Sweep the keys' })
  })
})

describe('negative / boundary — priority order and the lead\'s own text', () => {
  it('an explicit intent wins over everything', () => {
    expect(getWorkLogPreview([activity({ toolName: 'Read', status: 'running' })], 'Fixing the parser', true, true, false))
      .toEqual({ text: 'Fixing the parser' })
  })

  it('an empty running turn reads turnCard.starting', () => {
    expect(getWorkLogPreview([], undefined, true, false, false)).toEqual({ text: i18n.t('turnCard.starting') })
  })

  it('a settled turn with no tool call leaves the text to the lead ("N steps completed")', () => {
    const acts = [activity({ type: 'intermediate', content: 'a' }), activity({ type: 'thinking', content: 'b' })]
    expect(getWorkLogPreview(acts, undefined, false, true, true)).toEqual({})
  })

  it("falls to an activity's own intent next", () => {
    expect(getWorkLogPreview([activity({ intent: 'Reading the config' })])).toEqual({ text: 'Reading the config' })
  })

  it('says responding while streaming with a response', () => {
    expect(getWorkLogPreview([], undefined, true, true, false)).toEqual({ text: i18n.t('turnCard.responding') })
  })

  it('shows a running Task description over the streaming content', () => {
    const acts = [
      activity({ toolName: 'Task', status: 'running', toolInput: { description: 'Audit the locales' } }),
      activity({ type: 'intermediate', content: 'thinking out loud' }),
    ]
    expect(getWorkLogPreview(acts, undefined, true, false, false)).toEqual({ text: 'Audit the locales' })
  })

  it('shows the LATEST intermediate content while streaming', () => {
    const acts = [
      activity({ type: 'intermediate', content: 'first' }),
      activity({ type: 'intermediate', content: 'second' }),
    ]
    expect(getWorkLogPreview(acts, undefined, true, false, false)).toEqual({ text: 'second' })
  })

  it('names at most three running tools', () => {
    const acts = ['Read', 'Write', 'Edit', 'Bash'].map(n => activity({ toolName: n, status: 'running' }))
    expect(getWorkLogPreview(acts)).toEqual({ text: 'Read, Write, Edit...' })
  })
})

describe('the codex bridge row names its tool half (F1.217), through turn-preview', () => {
  it('a running mcp__sources__w__t reads "t", never upstream\'s "w__t"', () => {
    const preview = getWorkLogPreview([activity({ toolName: 'mcp__sources__w__t', status: 'running' })])
    expect(preview.text).toBe('t...')
    expect(preview.text).not.toContain('w__t')
  })

  it('a session tool reads the shared table\'s label', () => {
    expect(getWorkLogPreview([activity({ toolName: 'mcp__session__list_sessions', status: 'running' })]))
      .toEqual({ text: 'List Sessions...' })
  })
})
