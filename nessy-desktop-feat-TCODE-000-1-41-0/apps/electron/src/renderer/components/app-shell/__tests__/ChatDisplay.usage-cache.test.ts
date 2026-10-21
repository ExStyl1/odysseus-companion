/**
 * P6.616 — the `/usage` cache breakdown's arithmetic and its gating.
 *
 * The component itself is JSX with no branching beyond `ttl` and the early
 * return, so what is worth pinning is the pair of pure functions it renders:
 * which sessions get a group at all, and what the group says.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeCacheUsage } from '@nessy-agent/core/types'
import { formatCacheHitRate, usageCacheSnapshot } from '../ChatDisplay.usage-format'
import type { Session } from '../../../../shared/types'

const base = {
  outputTokens: 20,
  totalTokens: 120,
  contextTokens: 100,
  costUsd: 0,
} satisfies Omit<NonNullable<Session['tokenUsage']>, 'inputTokens'>

describe('usageCacheSnapshot', () => {
  it('renders NO group when the session has no cache reading at all', () => {
    // Absence of a reading is not a reading: a `cold` row here would be a claim
    // about the provider on a runtime whose adapter reports nothing.
    expect(usageCacheSnapshot(undefined)).toBeUndefined()
    expect(usageCacheSnapshot({ ...base, inputTokens: 100 })).toBeUndefined()
  })

  it('derives warmth and hit ratio from the counters already on the wire', () => {
    // `inputTokens` on this wire ALREADY contains both cache halves, which is
    // the denominator the shared rule requires — 700 of 1000, not 700 of 200.
    const snapshot = usageCacheSnapshot({
      ...base,
      inputTokens: 1000,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    })
    expect(snapshot).toEqual({
      warmth: 'warm',
      hitRate: 0.7,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    })
    // No TTL: the renderer cannot resolve one, and a guessed `5m` in a readout
    // whose point is that its figures are real would be the invented answer.
    expect(snapshot?.ttl).toBeUndefined()
  })

  it('a session that has only WRITTEN a cache is cold, not warm', () => {
    expect(usageCacheSnapshot({
      ...base,
      inputTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 900,
    })?.warmth).toBe('cold')
  })

  it('prefers the session layer\'s stamped snapshot, because only it can carry the TTL', () => {
    const stamped = usageCacheSnapshot({
      ...base,
      inputTokens: 1000,
      cacheReadTokens: 1,
      cacheCreationTokens: 0,
      cache: { warmth: 'warm', hitRate: 0.5, cacheReadTokens: 500, cacheCreationTokens: 10, ttl: '1h' },
    })
    expect(stamped?.ttl).toBe('1h')
    // And it is taken WHOLE — not merged with a second derivation of the same
    // numbers, which is how a breakdown comes to disagree with itself.
    expect(stamped?.cacheReadTokens).toBe(500)
  })

  it('states the same arithmetic as the session layer and the tracker', () => {
    expect(usageCacheSnapshot({
      ...base,
      inputTokens: 1000,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    })).toEqual(describeCacheUsage({
      totalInputTokens: 1000,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    }))
  })
})

describe('formatCacheHitRate', () => {
  it('renders a whole percent', () => {
    expect(formatCacheHitRate(0.4237, 'en-US')).toBe('42%')
  })

  it('clamps a nonsensical ratio rather than printing it', () => {
    expect(formatCacheHitRate(Number.NaN, 'en-US')).toBe('0%')
    expect(formatCacheHitRate(1.5, 'en-US')).toBe('100%')
  })
})

/**
 * P6.616's last line — the group was BUILT, tested and never rendered.
 *
 * `e801eab21` landed the component, the wire member and the arithmetic above;
 * the mount was one line in a file another lane held, so `/usage` kept showing
 * no cache group while every test here passed. That is the exact failure mode a
 * containment arm exists for, and the reason this one is written even though the
 * pure functions are covered: a perfectly tested component nobody renders is
 * indistinguishable, from the user's side, from one that was never written.
 *
 * The overlay is read as SOURCE — the renderer component graph cannot be loaded
 * by the bun runner — which is the same trade `agent-tier.test.ts` and
 * `skill-tier.test.ts` record.
 */
describe('containment — the /usage overlay actually renders the group', () => {
  const overlay = readFileSync(join(import.meta.dir, '..', 'ChatDisplay.tsx'), 'utf8')

  it('mounts UsageCacheBreakdown with the session usage it reads', () => {
    expect(overlay).toContain("from \"./UsageCacheBreakdown\"")
    expect(overlay).toContain('<UsageCacheBreakdown tokenUsage={tokenUsage}')
  })

  it('renders it inside the usage overlay, beside the cost group', () => {
    // Sliced rather than grepped whole: an import plus a mount somewhere in
    // 3 700 lines would satisfy the case above while sitting in a different
    // overlay entirely.
    const start = overlay.indexOf("t('usage.totalTokens')")
    expect(start).toBeGreaterThan(-1)
    const end = overlay.indexOf('</Info_GroupedList>', start)
    expect(end).toBeGreaterThan(start)
    const usageOverlay = overlay.slice(start, end)
    expect(usageOverlay).toContain('<UsageCacheBreakdown')
    expect(usageOverlay).toContain('<UsageCostBreakdown')
  })
})
