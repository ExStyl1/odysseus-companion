import { foldModelUsageKeys, resolveCostDisplay, type CostDisplay } from "@nessy-agent/shared/telemetry/cost-reporting"
import {
  managedModelPricing,
  priceUsageWithManagedTable,
  type ManagedModelPricing,
} from "@config/managed-model-prices"
import { describeCacheUsage, type CacheUsageSnapshot } from "@nessy-agent/core/types"
import type { Session } from "../../../shared/types"

/**
 * What the usage overlay's cost row renders.
 *
 * The overlay used to gate on `costUsd > 0`, so a backend that reports no cost
 * — Codex, the Nessy Gateway, Nestor Cloud — got no row at all. A missing row is
 * the same lie as a `$0.00` row in a quieter voice: both let a user conclude the
 * turn was free. `unavailable` is the honest third state, and it is a string the
 * caller supplies so the wording stays translated.
 */
export function formatUsageCostRow(
  tokenUsage: Session['tokenUsage'] | undefined,
  locale: string,
  labels: { unavailable: string; partialSuffix: string },
  /** P6.537 · the operator's table; defaulted from the process registry. */
  pricing: ManagedModelPricing | undefined = managedModelPricing(),
): { visible: boolean; value: string } {
  // P6.537 · THE SESSION TOTAL, when an operator's table priced any of it.
  //
  // `done_means`: "`sessionCostUsd` moves off zero for a model the bundled
  // table cannot price". The per-model rows are where the table is applied, so
  // the total is their sum rather than a second, independently-derived figure —
  // two derivations of one number is how a breakdown comes to disagree with the
  // headline it sits under. Only taken when at least one row is `managed`;
  // otherwise the runtime's own reporting decides, exactly as before, including
  // its `unsupported` and `partial` states.
  const managedRows = modelCostRows(tokenUsage?.modelUsage, pricing)
  if (managedRows.some(row => row.basis === 'managed')) {
    const total = managedRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
    const anyUnpriced = managedRows.some(row => row.basis === 'unknown')
    return {
      visible: true,
      value: anyUnpriced
        ? `${formatUsageCost(total, locale)} ${labels.partialSuffix}`
        : formatUsageCost(total, locale),
    }
  }

  const display: CostDisplay = resolveCostDisplay(tokenUsage)
  switch (display.kind) {
    case 'hidden':
      return { visible: false, value: '' }
    case 'unsupported':
      return { visible: true, value: labels.unavailable }
    case 'amount':
      return {
        visible: true,
        value: display.partial
          ? `${formatUsageCost(display.costUsd, locale)} ${labels.partialSuffix}`
          : formatUsageCost(display.costUsd, locale),
      }
  }
}

export function formatUsageCost(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 6 : 2,
  }).format(value)
}

type ContextWindowSource = NonNullable<NonNullable<Session['contextUsage']>['contextWindowSource']>

/**
 * The i18n key each `contextWindowSource` renders as.
 *
 * A TABLE rather than a switch, and `Record<ContextWindowSource, string>` rather
 * than a partial: adding a member to the wire union without a label here is a
 * type error, where the switch's `default` used to swallow it and render
 * "Unavailable" — a new source silently reported as no source at all.
 */
export const CONTEXT_WINDOW_SOURCE_KEYS: Record<ContextWindowSource, string> = {
  runtime: 'context.source.runtime',
  fallback: 'context.source.fallback',
  provider_catalog: 'context.source.providerCatalog',
  connection_override: 'context.source.connectionOverride',
  static_registry: 'context.source.staticRegistry',
  preset: 'context.source.preset',
  remote_reported: 'context.source.remoteReported',
  unavailable: 'common.unavailable',
}

export function formatContextWindowSource(
  source: ContextWindowSource | undefined,
  t: (key: string) => string,
): string {
  return t((source && CONTEXT_WINDOW_SOURCE_KEYS[source]) ?? 'common.unavailable')
}

/**
 * Whether the renderer may stand `tokenUsage` in for a missing context snapshot.
 *
 * It may not, for a session whose provider reports fresh local usage. The two
 * are composed differently — `tokenUsage.inputTokens` is one turn's provider
 * count, `contextUsage.inputTokens` is the whole conversation's occupancy — and
 * `tokenUsage.contextWindow` comes from the STATIC model registry, which holds
 * no id for any Pi or gateway model. So the fallback quietly divided a per-turn
 * counter by a window belonging to a different model, and drew a donut from it.
 *
 * A `fresh-local` provider is going to send a real snapshot within the turn, so
 * the honest thing in the gap is to draw nothing. Providers that never send one
 * keep the fallback: for them it is the only number there is.
 */
export function mayFallBackToTokenUsage(
  composerCapabilities: { contextUsage?: { kind?: string } } | undefined,
): boolean {
  return composerCapabilities?.contextUsage?.kind !== 'fresh-local'
}

export function formatUsageNumber(value: number | null | undefined, locale: string, fallback = '0'): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(locale).format(value)
    : fallback
}

/** A token count someone actually observed, or `null`. */
function observedTokenCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Context occupancy out of `tokenUsage`, or `null` when nothing observed one.
 *
 * `contextTokens` has exactly one writer — `applyContextUsageSnapshot`, which
 * is the Pi path — while `ensureTokenUsage` INITIALISES the field to 0 for
 * every session on every backend. So the `contextTokens ?? inputTokens` this
 * replaces never fell through: `??` saw a number and took it. On
 * claude-runtime and codex-runtime the Context row therefore read zero beside
 * a correct `inputTokens` (measured 2026-08-15 on the real formatter with the
 * run's own DTO: `0 / 240,000 (0%)` where a Pi-shaped DTO gave
 * `132,377 / 240,000 (55%)`) — the donut, which reads `inputTokens`, was
 * right at the same moment.
 *
 * A 0 here is the initialiser, not a reading, so it falls through. A session
 * that genuinely holds no context has a zero `inputTokens` too and yields
 * `null` — rendered as "unknown", not as a confident 0%.
 */
export function resolveContextTokens(tokenUsage: Session['tokenUsage'] | undefined): number | null {
  return observedTokenCount(tokenUsage?.contextTokens) ?? observedTokenCount(tokenUsage?.inputTokens)
}

export function formatContextUsage(tokenUsage: Session['tokenUsage'] | undefined, locale: string, unavailable: string, staleLabel?: string): string {
  const snapshot = tokenUsage?.contextUsage
  // F1.426 — a stale snapshot keeps its count and SAYS it is out of date.
  const staleSuffix = snapshot?.stale === true && staleLabel ? ` (${staleLabel})` : ''
  const contextTokens = snapshot
    ? snapshot.inputTokens
    : resolveContextTokens(tokenUsage)
  const contextWindow = snapshot?.contextWindow ?? tokenUsage?.contextWindow ?? null

  if (contextTokens == null && (!contextWindow || contextWindow <= 0)) {
    return unavailable
  }

  const contextValue = formatUsageNumber(contextTokens, locale, '?')
  if (!contextWindow || contextWindow <= 0) {
    return `${contextValue} / ${unavailable.toLowerCase()}${contextTokens == null ? '' : staleSuffix}`
  }

  if (contextTokens == null) {
    return `? / ${formatUsageNumber(contextWindow, locale)}`
  }

  const percent = Math.round((contextTokens / contextWindow) * 100)
  return `${contextValue} / ${formatUsageNumber(contextWindow, locale)} (${percent}%)${staleSuffix}`
}

/**
 * P6.445 — WHERE A COST FIGURE CAME FROM.
 *
 * The row's third clause: "each model line names its price basis as list /
 * managed / unknown, so an unpriced gateway model is visibly not a free one".
 *
 * - `list` — a price the RUNTIME applied from its own bundled table. Today that
 *   is the only priced source there is: the claude SDK computes `costUsd` from
 *   the list prices it ships with, which is why `agent-sdk/cost-tracking.md`
 *   opens with a Warning that the figures are estimates.
 * - `managed` — a price an OPERATOR supplied. Declared and **not yet reachable**:
 *   owner decision 2026-09-05 **D11 = A** buys the managed price table, and
 *   **P6.537** builds it. The member is declared here rather than added later on
 *   purpose — this file is where a basis becomes a user-visible word, and a row
 *   that has to invent the vocabulary as well as the table is a row that will
 *   invent it differently.
 *
 * **P7.16, 2026-09-10 — the vendor shipped the same three words.** The lift to
 * `0.3.247` brought `ModelUsage.costBasis?: 'list' | 'managed' | 'unknown'` with
 * a gloss that matches this one clause for clause: *"Which price table the most
 * recent request for this model was priced at: Claude Code's built-in list
 * prices ('list'), the organization's managed-settings modelPricing rates or
 * multiplier ('managed'), or neither ('unknown' — no pricing row and no built-in
 * price matched the model ID, so costUSD is a guess at the default model's
 * rate)."* Three members, same spellings, same order, and the same refusal to
 * render an unpriced model as a priced one — invented here first and then
 * arrived at independently, which is the strongest evidence this vocabulary was
 * the right one.
 *
 * It is NOT read yet, and the reason is a measurement rather than an omission:
 * the field is per-request state on the CHILD (*"Overwritten per request … Absent
 * until this process has priced a request for the model"*), while `managed` on
 * this fork means the HOST's own table, which the child cannot see —
 * `modelPricing` is honored only from managed settings, whose restrictive filter
 * does not copy it, and its documentation ignores the `--settings` tier we ride
 * (`claude-managed-settings.ts`'s `modelPricing` note has the probe). So a claude
 * child would report `list` for a price the operator overrode here, and adopting
 * its verdict would make the label LESS true, not more. Reading it is worth a row
 * the day the host's table can reach the child.
 * - `unknown` — nobody priced this model. The gateway and Nestor Cloud report no
 *   cost at all, and codex reports tokens and never USD, so this is the common
 *   case on this fork and the one the whole row exists for: it must not render
 *   as `$0.00`.
 */
export type CostBasis = 'list' | 'managed' | 'unknown'

/** The i18n key each basis renders as. Exhaustive: a new basis must get a word. */
export const COST_BASIS_KEYS: Record<CostBasis, string> = {
  list: 'usage.costBasis.list',
  managed: 'usage.costBasis.managed',
  unknown: 'usage.costBasis.unknown',
}

/**
 * One model's line in the cost breakdown.
 *
 * `cost` is `null` rather than `0` when nothing priced the model — the same
 * posture `resolveCostDisplay` already takes for the session total, applied per
 * model, because a zero and an absence are the identical lie at either scale.
 */
export interface ModelCostRow {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  basis: CostBasis
}

/**
 * What one model line costs and on whose authority — P6.537, the row that made
 * `managed` reachable.
 *
 * Precedence, and it is the page's own: the OPERATOR'S table outranks the
 * runtime's list price. `settings-reference.md#modelpricing` — *"Report spend
 * at the rates your organization pays instead of list price"* — and its
 * multiplier arm re-bases even a figure the runtime did establish
 * (*"reduces every figure, the Sonnet row included, by 15%"*), which is why the
 * runtime's own number is passed IN rather than used as a fallback.
 *
 * `unknown` stays exactly as honest as it was: a model absent from the table
 * whose runtime reported nothing is unpriced, never `$0.00`.
 */
function resolveModelCost(
  model: string,
  usage: { costReporting?: string; costUsd?: number; inputTokens?: number; outputTokens?: number },
  pricing: ManagedModelPricing | undefined,
): { costUsd: number | null; basis: CostBasis } {
  const listed = usage.costReporting === 'reported'
    && typeof usage.costUsd === 'number'
    && usage.costUsd > 0
    ? usage.costUsd
    : null
  const managed = priceUsageWithManagedTable(
    pricing,
    model,
    { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    listed,
  )
  if (managed !== undefined) return { costUsd: managed, basis: 'managed' }
  if (listed !== null) return { costUsd: listed, basis: 'list' }
  return { costUsd: null, basis: 'unknown' }
}

/**
 * The per-model breakdown, or an empty array when the backend reported none.
 *
 * `modelUsage` has been persisted since the claude adapter learned to difference
 * it, and until this row it reached NO renderer: `grep -arn modelUsage apps
 * packages/ui` scored 1 (the CLI's JSON envelope) against `costUsd` → 9 files.
 * So the app had a per-model split on disk and showed a single number.
 *
 * Ordered by cost descending, then by model name, so the line an operator is
 * looking for is first and the order does not move between renders.
 */
export function modelCostRows(
  modelUsage: Record<string, { inputTokens?: number; outputTokens?: number; costUsd?: number; costReporting?: string }> | undefined,
  /**
   * P6.537 · the operator's table. Defaulted from the process registry so every
   * existing caller — and every existing test — keeps its exact behaviour when
   * no table is deployed, which is the case we ship.
   */
  pricing: ManagedModelPricing | undefined = managedModelPricing(),
): ModelCostRow[] {
  if (!modelUsage) return []
  return Object.entries(foldModelUsageKeys(modelUsage)) // F1.1279: an old record's [1m] key reads as the bare id
    .map(([model, usage]): ModelCostRow => {
      const { costUsd, basis } = resolveModelCost(model, usage, pricing)
      return {
        model,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        costUsd,
        basis,
      }
    })
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.model.localeCompare(b.model))
}

/**
 * P6.616 — the snapshot the `/usage` cache group renders, or `undefined` when
 * the session has no cache reading yet.
 *
 * Prefers the wire member the session layer stamps: it is the only place the
 * host-resolved TTL can come from, since `resolvePromptCacheTtl` reads the
 * operator's environment and host config and the renderer has neither. Falls
 * back to deriving the rest from the counters already beside it, through the
 * SAME `describeCacheUsage` the session layer and the usage tracker call — two
 * copies of one formula is how a breakdown comes to disagree with the headline
 * it sits under, and a session persisted before the member existed still has to
 * render honestly.
 *
 * `undefined` when NEITHER counter is present, and that is deliberate: absence
 * of a reading is not a reading, so a runtime whose adapter reports no cache
 * numbers gets no group rather than a `cold` row, which would be a claim about
 * the provider we cannot make.
 */
export function usageCacheSnapshot(
  tokenUsage: Session['tokenUsage'] | undefined,
): CacheUsageSnapshot | undefined {
  if (!tokenUsage) return undefined
  if (tokenUsage.cache) return tokenUsage.cache
  if (tokenUsage.cacheReadTokens === undefined && tokenUsage.cacheCreationTokens === undefined) {
    return undefined
  }
  // `inputTokens` on this wire already contains both cache halves — the claude
  // adapter sums them before emitting and codex's own input figure includes the
  // cached part — which is the denominator `describeCacheUsage` requires.
  return describeCacheUsage({
    totalInputTokens: tokenUsage.inputTokens,
    cacheReadTokens: tokenUsage.cacheReadTokens,
    cacheCreationTokens: tokenUsage.cacheCreationTokens,
  })
}

/** `0.4237` → `42%`. Whole percent: the third digit of a hit ratio is noise. */
export function formatCacheHitRate(hitRate: number, locale: string): string {
  const safe = Number.isFinite(hitRate) ? Math.min(Math.max(hitRate, 0), 1) : 0
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(safe)
}

/**
 * F1.426 — the count a snapshot may be DRAWN with as current: its own, unless
 * it is stale. A stale snapshot keeps its number (a failed `/context` refresh
 * and, since F1.440, a compaction boundary a later turn superseded both keep
 * it), so the composer's donut treats it like an unknown count and waits for a
 * current one instead of drawing an old reading as today's occupancy.
 */
export function currentSnapshotTokens(snapshot: Session['contextUsage'] | undefined): number | null | undefined {
  return snapshot?.stale === true ? undefined : snapshot?.inputTokens
}

/** F1.426 — the context overlay's "current" row: the count, labelled when the snapshot is stale. */
export function formatSnapshotCount(count: number | null | undefined, stale: boolean, locale: string, staleLabel: string): string {
  const value = formatUsageNumber(count, locale, '?')
  return stale && typeof count === 'number' && Number.isFinite(count) ? `${value} (${staleLabel})` : value
}
