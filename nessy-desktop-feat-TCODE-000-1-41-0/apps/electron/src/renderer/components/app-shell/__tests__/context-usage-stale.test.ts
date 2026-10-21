/**
 * F1.426 — nothing in the renderer read `ContextUsageSnapshot.stale`.
 *
 * A snapshot is marked stale when a `/context` refresh fails
 * (`SessionManager.refreshContextUsage`'s catch keeps the old count and adds
 * `stale: true`) and, since F1.440, when a later turn's reading supersedes a
 * compaction boundary's. Both KEEP the count, and the donut and the usage
 * overlay drew it as current. Now: the donut omits a stale count (it waits for a
 * current one, as for an unknown one), and both overlays show the count WITH a
 * label saying it is out of date.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import type { Session } from '../../../../shared/types'
import { currentSnapshotTokens, formatContextUsage, formatSnapshotCount } from '../ChatDisplay.usage-format'

type TokenUsage = NonNullable<Session['tokenUsage']>

function usage(snapshot: Record<string, unknown>): TokenUsage {
  return { inputTokens: 38_000, outputTokens: 0, totalTokens: 38_000, contextTokens: 0, costUsd: 0, contextUsage: snapshot } as unknown as TokenUsage
}

describe('F1.426 — a stale snapshot is labelled, never drawn as current', () => {
  const stale = { inputTokens: 14_748, contextWindow: 200_000, source: 'estimated_after_compact', stale: true }
  const fresh = { inputTokens: 14_748, contextWindow: 200_000, source: 'estimated_after_compact' }

  it('positive — the usage overlay keeps the stale count and says it is outdated', () => {
    const line = formatContextUsage(usage(stale), 'en', 'Unavailable', 'outdated')
    expect(line).toContain('14,748')
    expect(line).toContain('outdated')
  })

  it('negative — a current snapshot carries no label, and the null-count control still reads unknown', () => {
    expect(formatContextUsage(usage(fresh), 'en', 'Unavailable', 'outdated')).toBe('14,748 / 200,000 (7%)')
    expect(formatContextUsage(usage({ inputTokens: null, contextWindow: 200_000, source: 'unavailable', stale: true }), 'en', 'Unavailable', 'outdated'))
      .toBe('? / 200,000')
  })

  it('the context overlay\'s current row labels a stale count the same way', () => {
    expect(formatSnapshotCount(14_748, true, 'en', 'outdated')).toBe('14,748 (outdated)')
    expect(formatSnapshotCount(14_748, false, 'en', 'outdated')).toBe('14,748')
    expect(formatSnapshotCount(null, true, 'en', 'outdated')).toBe('?')
  })

  it('the donut omits a stale count and keeps a current one', () => {
    expect(currentSnapshotTokens(stale as never)).toBeUndefined()
    expect(currentSnapshotTokens(fresh as never)).toBe(14_748)
    expect(currentSnapshotTokens(undefined)).toBeUndefined()
  })

  it('ChatDisplay wires all three: the donut, the usage row and the context row', () => {
    const source = readFileSync(fileURLToPath(new URL('../ChatDisplay.tsx', import.meta.url)), 'utf-8')
    expect(source).toContain('inputTokens: currentSnapshotTokens(session.contextUsage)')
    expect(source).toContain("formatContextUsage(tokenUsageWithContext, usageLocale, t('common.unavailable'), t('chat.contextUsage.stale'))")
    expect(source).toContain("formatSnapshotCount(contextTokens, contextUsage?.stale === true, usageLocale, t('chat.contextUsage.stale'))")
  })
})
