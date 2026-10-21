/**
 * P6.616 — the cache group of the `/usage` overlay: warmth, hit ratio, the two
 * counters and the lifetime, with NO cost figure.
 *
 * ## What was missing, and why it is not "the same as `/context`"
 *
 * `/context` has printed the two raw counters for a long time. What no surface
 * could answer is the question a user actually asks — *is caching working?* —
 * which is the WARMTH plus the hit ratio, the derivable half P6.446 built in
 * `UsageTracker.describeCachePerformance()` and nothing read. This is that
 * readout's first reader.
 *
 * ## The three states are three different statements
 *
 * `warm` — this session has read from a cache. `cold` — it has written one and
 * read nothing back. `unknown` — no cache counter has been non-zero at all,
 * which on a runtime whose adapter does not report them is the truth, where
 * `cold` would be a claim about the provider we cannot make. A session with no
 * cache reading at all renders NOTHING here rather than an `unknown` row: a
 * group of empty rows reads as a broken cache, and absence of a reading is not
 * a reading.
 *
 * ## No USD figure, stated rather than omitted
 *
 * The owner ruling on this row is "show the truth, never fake a number", and
 * the two shipped comments recording "no honest value" for the model-switch
 * MONEY fields stay true: a cache read and a cache write are billed at different
 * rates on every provider and this fork has no price for either. (Those comments
 * named three fields until C4.22 and name two now — the lifetime `cache_ttl` is
 * one this host resolves for itself, and it is the `ttl` this group already
 * renders. Nothing about the missing USD figure changed.) So the caveat line is
 * part of the group — an omitted cost row lets a reader conclude the cache is
 * free, which is the same lie as a `$0.00` in a quieter voice.
 *
 * Presentational and IPC-free by construction, like `UsageCostBreakdown` beside
 * it: it takes a `tokenUsage` and a `t`, holds no state and reads no atom, so
 * the playground can draw every state a real session takes days to produce.
 */
import * as React from 'react'
import type { CacheUsageSnapshot } from '@nessy-agent/core/types'
import { Info_GroupedList } from '@/components/info'
import { formatCacheHitRate, formatUsageNumber, usageCacheSnapshot } from './ChatDisplay.usage-format'
import type { Session } from '../../../shared/types'

export interface UsageCacheBreakdownProps {
  tokenUsage: Session['tokenUsage'] | undefined
  locale: string
  t: (key: string) => string
}

const WARMTH_KEYS: Record<CacheUsageSnapshot['warmth'], string> = {
  warm: 'usage.cacheWarmthWarm',
  cold: 'usage.cacheWarmthCold',
  unknown: 'usage.cacheWarmthUnknown',
}

export function UsageCacheBreakdown({ tokenUsage, locale, t }: UsageCacheBreakdownProps): React.ReactElement | null {
  const cache = usageCacheSnapshot(tokenUsage)
  if (!cache) return null

  return (
    <Info_GroupedList.Group label={t('context.cache')} variant="info">
      <Info_GroupedList.Item>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-muted-foreground">{t('usage.cacheWarmth')}</span>
          <span className="font-mono text-foreground">{t(WARMTH_KEYS[cache.warmth])}</span>
        </div>
      </Info_GroupedList.Item>

      <Info_GroupedList.Item>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-muted-foreground">{t('usage.cacheHitRate')}</span>
          <span className="font-mono text-foreground">{formatCacheHitRate(cache.hitRate, locale)}</span>
        </div>
      </Info_GroupedList.Item>

      <Info_GroupedList.Item>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-muted-foreground">{t('context.cacheRead')}</span>
          <span className="font-mono text-foreground">{formatUsageNumber(cache.cacheReadTokens, locale)}</span>
        </div>
      </Info_GroupedList.Item>

      <Info_GroupedList.Item>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-muted-foreground">{t('context.cacheCreation')}</span>
          <span className="font-mono text-foreground">{formatUsageNumber(cache.cacheCreationTokens, locale)}</span>
        </div>
      </Info_GroupedList.Item>

      {/*
        Only when the host resolved one. Absence means "the runtime's own
        default" and printing a guessed `5m` beside it would be an invented
        figure in a row whose whole point is that the figures are real.
      */}
      {cache.ttl !== undefined && (
        <Info_GroupedList.Item>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">{t('usage.cacheTtl')}</span>
            <span className="font-mono text-foreground">{cache.ttl}</span>
          </div>
        </Info_GroupedList.Item>
      )}

      <Info_GroupedList.Item>
        <p className="text-xs text-muted-foreground">{t('usage.cacheNotPriced')}</p>
      </Info_GroupedList.Item>
    </Info_GroupedList.Group>
  )
}
