import { useTranslation } from 'react-i18next'
import { FileWarning, Lightbulb } from 'lucide-react'
// The concrete module, not the `@/components/info` barrel: the barrel drags in
// heavy viewer dependencies this overlay section never uses.
import { Info_GroupedList } from '../info/Info_GroupedList'
import type { SafeCapabilityDiagnostic } from '@nessy-agent/shared/protocol/capabilities'
import type {
  ContextUsageLoadedFile,
  ContextUsageSnapshot,
  ContextUsageSuggestion,
  Session,
} from '../../../shared/types'
import { formatUsageNumber, resolveContextTokens } from './ChatDisplay.usage-format'

/**
 * `/context` overlay breakdown — the per-category dimension of the context
 * window (R11), rendered from the wire snapshot the Pi subprocess measured.
 * `categories`/`loadedFiles` are OPTIONAL wire fields: a legacy snapshot (an
 * old subprocess, an adjacent provider) renders exactly today's
 * tokenUsage-derived totals view.
 */

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  system_prompt: 'context.category.systemPrompt',
  system_tools: 'context.category.systemTools',
  mcp_tools: 'context.category.mcpTools',
  custom_subagents: 'context.category.subagents',
  memory_files: 'context.category.memoryFiles',
  skills: 'context.category.skills',
  conversation_messages: 'context.category.conversationMessages',
}

/**
 * `context-window.md:1616` — `/context` is "a live breakdown by category with
 * optimization suggestions". Each id names one control that exists here, and
 * the copy names it: deferred MCP tool loading and the `alwaysLoad` pin,
 * `/memory` plus the `instructionExcludes` setting, and a skill's
 * `disable-model-invocation` frontmatter.
 */
const SUGGESTION_LABEL_KEYS: Record<string, string> = {
  defer_mcp_tools: 'context.suggestion.deferMcpTools',
  trim_memory_files: 'context.suggestion.trimMemoryFiles',
  gate_skill_listing: 'context.suggestion.gateSkillListing',
}

/** A suggestion the overlay knows how to phrase; an unknown id renders nothing. */
export function knownContextSuggestions(
  suggestions: readonly ContextUsageSuggestion[] | undefined,
): ContextUsageSuggestion[] {
  return (suggestions ?? []).filter(suggestion => SUGGESTION_LABEL_KEYS[suggestion.id] !== undefined)
}

/** Capability scope kind (the 2nd `::` segment of a qualified layer key) → badge label. */
const LOADED_FILE_SCOPE_KEYS: Record<string, string> = {
  builtin: 'context.loadedFileScope.builtin',
  global: 'context.loadedFileScope.user',
  workspace: 'context.loadedFileScope.workspace',
  project: 'context.loadedFileScope.project',
}

/**
 * Humanize a loaded-file entry whose `name` is a raw qualified capability layer
 * key (`kind::scopeKind::workspaceId::projectKey::discriminator::logicalName`,
 * CDP pass 9): show the file name plus a scope badge (project/user/memory)
 * instead of the raw key. Names that are not qualified keys (legacy snapshots)
 * render unchanged with today's kind badge.
 */
export function humanizeLoadedFile(file: ContextUsageLoadedFile): { label: string; badgeKey: string } {
  const fallback = { label: file.name, badgeKey: `context.loadedFileKind.${file.kind}` }
  const segments = file.name.split('::')
  if (segments.length < 6) return fallback
  const label = segments[segments.length - 1]
  if (!label) return fallback
  if (file.kind === 'memory') return { label, badgeKey: 'context.loadedFileScope.memory' }
  return { label, badgeKey: LOADED_FILE_SCOPE_KEYS[segments[1]] ?? fallback.badgeKey }
}

/**
 * Catalog diagnostics the `/context` overlay renders: the NEGATIVE space of the
 * loaded-file list.
 *
 * `debug-your-config.md#see-what-loaded-into-context` makes `/context` the
 * surface for what loaded, and an instruction layer the walk dropped never
 * appears in `loadedFiles` — so without this the user sees a shorter list and
 * no reason for it. Both codes come off the same walk in
 * `capabilities/resolver.ts` (the ancestor-layer cap and the over-size skip),
 * both are one-diagnostic-for-the-set, and both already carry a sentence in
 * every locale; what was missing was a renderer, because nothing renders
 * catalog-LEVEL diagnostics generically (P6.599).
 *
 * A code outside this set renders nothing here — the same rule the suggestion
 * list keeps, so a new diagnostic cannot leak an unlocalized string into the
 * overlay.
 */
const INSTRUCTION_LAYER_NOTICE_CODES: ReadonlySet<string> = new Set([
  'capability.instruction.ancestorLayerCap',
  'capability.instruction.overSizeLimit',
])

export interface ContextOverlayNotice {
  key: string
  params: Record<string, string>
}

/**
 * `messageKey` is what gets translated and `code` is what gets matched:
 * `toSafeDiagnostic` sets them equal today, and reading each for its own job
 * keeps this surface correct on the day the renderer maps them apart.
 */
export function instructionLayerNotices(
  diagnostics: readonly SafeCapabilityDiagnostic[] | undefined,
): ContextOverlayNotice[] {
  return (diagnostics ?? [])
    .filter(diagnostic => INSTRUCTION_LAYER_NOTICE_CODES.has(diagnostic.code))
    .map(diagnostic => ({ key: diagnostic.messageKey, params: diagnostic.safeArgs ?? {} }))
}

/**
 * True when the overlay is about to show a loaded-file list beside a breakdown
 * that carries no category at all.
 *
 * `74542380e` gave claude and codex the loaded-file group, composed by the HOST
 * from the capability walk — every other category stays absent on purpose,
 * because the host cannot price a system prompt it does not build. So those two
 * runtimes render a file list above the legacy totals-only rows and nothing
 * said why. The predicate reads the DATA (files present, categories absent) and
 * never a provider name: the day a runtime starts publishing categories it
 * loses the sentence on its own, and Pi — whose snapshot always carries
 * categories — never sees it.
 */
export function lacksCategoryBreakdown(contextUsage: ContextUsageSnapshot | undefined): boolean {
  return (contextUsage?.loadedFiles?.length ?? 0) > 0
    && (contextUsage?.categories?.length ?? 0) === 0
}

export function getFiniteTokenValue(
  tokenUsage: Session['tokenUsage'] | undefined,
  keys: string[],
): number | undefined {
  const usage = tokenUsage as Record<string, unknown> | undefined
  if (!usage) return undefined
  for (const key of keys) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

/**
 * The `/context` overlay's occupancy total when no snapshot exists.
 *
 * Same correction as {@link resolveContextTokens}, which owns the reason: a
 * zero `contextTokens` is `ensureTokenUsage`'s initialiser, not an
 * observation, so it must not win over a real `inputTokens`. This surface
 * needs a number rather than a null (it is a percentage denominator), and 0
 * is what it showed before for a session with nothing observed.
 */
export function getContextTokenTotal(tokenUsage: Session['tokenUsage'] | undefined): number {
  return resolveContextTokens(tokenUsage) ?? 0
}

export function getContextPercent(value: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((value / total) * 100)
}

/** Today's tokenUsage-derived rows — the legacy view a snapshot without categories keeps. */
export function buildContextBreakdownRows(tokenUsage: Session['tokenUsage'] | undefined) {
  const contextTokens = getContextTokenTotal(tokenUsage)
  const rows = [
    { labelKey: 'context.system', value: getFiniteTokenValue(tokenUsage, ['systemTokens', 'systemPromptTokens']) },
    { labelKey: 'context.tools', value: getFiniteTokenValue(tokenUsage, ['toolTokens', 'toolsTokens']) },
    { labelKey: 'context.history', value: getFiniteTokenValue(tokenUsage, ['historyTokens', 'conversationTokens']) },
    { labelKey: 'context.files', value: getFiniteTokenValue(tokenUsage, ['fileTokens', 'filesTokens', 'attachmentTokens']) },
  ].filter((row): row is { labelKey: string; value: number } => row.value !== undefined)

  const categorizedTotal = rows.reduce((sum, row) => sum + row.value, 0)
  const unattributed = Math.max(contextTokens - categorizedTotal, 0)

  if (unattributed > 0 || rows.length === 0) {
    rows.push({ labelKey: 'context.unattributed', value: unattributed })
  }

  return rows.map(row => ({
    ...row,
    percent: getContextPercent(row.value, contextTokens),
  }))
}

export interface ContextOverlayWarning {
  key: string
  params: Record<string, string>
}

/** errors.md's `94k`/`200k` number shape. */
function formatTokensK(value: number): string {
  return `${Math.round(value / 1000)}k`
}

/** Fraction of the window left before auto-compact that triggers the capacity warning. */
const CAPACITY_WARNING_FRACTION = 0.1

/**
 * The documented `/context` warnings (`errors.md`), most severe first:
 *  - over the context window — "run /compact or /clear to continue";
 *  - past a compaction window smaller than the window — "run /compact to
 *    reduce usage";
 *  - both name `/clear` instead of `/compact` when compaction is disabled;
 *  - a capacity warning near the auto-compact threshold.
 */
export function buildContextOverlayWarning(
  contextUsage: ContextUsageSnapshot | undefined,
): ContextOverlayWarning | null {
  if (!contextUsage) return null
  const inputTokens = contextUsage.inputTokens
  if (inputTokens === null || inputTokens === undefined) return null
  const compactionDisabled = contextUsage.autoCompactionEnabled === false
  const contextWindow = contextUsage.contextWindow ?? null

  if (contextWindow !== null && inputTokens > contextWindow) {
    return {
      key: compactionDisabled ? 'context.warning.overLimitClear' : 'context.warning.overLimitCompact',
      params: { limit: formatTokensK(contextWindow), over: formatTokensK(inputTokens - contextWindow) },
    }
  }

  const compactionWindow = contextUsage.autoCompactionThreshold ?? null
  if (compactionWindow !== null && compactionWindow > 0 && inputTokens > compactionWindow) {
    return {
      key: compactionDisabled
        ? 'context.warning.pastCompactionWindowClear'
        : 'context.warning.pastCompactionWindowCompact',
      params: { window: formatTokensK(compactionWindow), over: formatTokensK(inputTokens - compactionWindow) },
    }
  }

  const remainingBeforeAutoCompact = contextUsage.remainingBeforeAutoCompact ?? null
  if (
    !compactionDisabled
    && remainingBeforeAutoCompact !== null
    && contextWindow !== null
    && remainingBeforeAutoCompact <= contextWindow * CAPACITY_WARNING_FRACTION
  ) {
    return {
      key: 'context.warning.capacity',
      params: { remaining: remainingBeforeAutoCompact.toLocaleString('en-US') },
    }
  }

  return null
}

interface ContextOverlayBreakdownProps {
  contextUsage: ContextUsageSnapshot | undefined
  tokenUsage: Session['tokenUsage'] | undefined
  locale: string
  /**
   * `UserCapabilityCatalog.diagnostics`, optional so a caller that has no
   * catalog in scope renders exactly what it rendered before.
   */
  diagnostics?: readonly SafeCapabilityDiagnostic[]
}

/**
 * The breakdown section of the `/context` overlay: the documented warning when
 * one applies, the per-category rows (or the legacy totals rows), and the
 * loaded-file list (memory.md's verification step).
 */
export function ContextOverlayBreakdown({ contextUsage, tokenUsage, locale, diagnostics }: ContextOverlayBreakdownProps) {
  const { t } = useTranslation()
  const categories = contextUsage?.categories
  const warning = buildContextOverlayWarning(contextUsage)
  const total = contextUsage?.inputTokens ?? getContextTokenTotal(tokenUsage)

  const rows = categories && categories.length > 0
    ? [
        ...categories.map(category => ({
          key: category.id,
          label: t(CATEGORY_LABEL_KEYS[category.id] ?? 'context.unattributed'),
          value: category.tokens,
          percent: getContextPercent(category.tokens, total),
          items: category.items,
        })),
        ...((contextUsage?.unattributedTokens ?? 0) > 0
          ? [{
              key: 'unattributed',
              label: t('context.unattributed'),
              value: contextUsage!.unattributedTokens!,
              percent: getContextPercent(contextUsage!.unattributedTokens!, total),
              items: undefined,
            }]
          : []),
      ]
    : buildContextBreakdownRows(tokenUsage).map(row => ({
        key: row.labelKey,
        label: t(row.labelKey),
        value: row.value,
        percent: row.percent,
        items: undefined,
      }))

  const loadedFiles = contextUsage?.loadedFiles ?? []
  const suggestions = knownContextSuggestions(contextUsage?.suggestions)
  const notices = instructionLayerNotices(diagnostics)

  return (
    <>
      {warning && (
        <div
          role="alert"
          className="border-b border-border/40 bg-destructive/10 px-4 py-2 text-xs leading-snug text-destructive"
        >
          {t(warning.key, warning.params)}
        </div>
      )}

      <Info_GroupedList.Group label={t('context.breakdown')} variant="info">
        {rows.map(row => (
          <Info_GroupedList.Item key={row.key}>
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="flex shrink-0 items-baseline gap-2 font-mono text-foreground">
                {formatUsageNumber(row.value, locale)}
                {row.percent !== null && (
                  <span className="text-xs text-muted-foreground">{t('context.percent', { percent: row.percent })}</span>
                )}
              </span>
            </div>
            {row.items && row.items.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {row.items.map(item => (
                  <div key={item.name} className="flex items-center justify-between gap-4 pl-4 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {item.name}
                      {item.source && <span className="ml-1 opacity-70">({item.source})</span>}
                    </span>
                    <span className="shrink-0 font-mono">{formatUsageNumber(item.tokens, locale)}</span>
                  </div>
                ))}
              </div>
            )}
          </Info_GroupedList.Item>
        ))}
      </Info_GroupedList.Group>

      {lacksCategoryBreakdown(contextUsage) && (
        <div className="border-b border-border/40 px-4 py-2 text-xs leading-snug text-muted-foreground">
          {t('context.noCategoryBreakdown')}
        </div>
      )}

      {suggestions.length > 0 && (
        <Info_GroupedList.Group label={t('context.suggestions')} variant="info">
          {suggestions.map(suggestion => (
            <Info_GroupedList.Item key={suggestion.id}>
              <div className="flex items-start gap-2 text-xs leading-snug text-muted-foreground">
                <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
                <span className="min-w-0">
                  {t(SUGGESTION_LABEL_KEYS[suggestion.id]!, {
                    tokens: formatUsageNumber(suggestion.tokens, locale),
                  })}
                </span>
              </div>
            </Info_GroupedList.Item>
          ))}
        </Info_GroupedList.Group>
      )}

      {notices.length > 0 && (
        <Info_GroupedList.Group label={t('context.notLoaded')} variant="warning">
          {notices.map(notice => (
            <Info_GroupedList.Item key={notice.key}>
              <div className="flex items-start gap-2 text-xs leading-snug text-muted-foreground">
                <FileWarning className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
                <span className="min-w-0">{t(notice.key, { defaultValue: notice.key, ...notice.params })}</span>
              </div>
            </Info_GroupedList.Item>
          ))}
        </Info_GroupedList.Group>
      )}

      {loadedFiles.length > 0 && (
        <Info_GroupedList.Group label={t('context.loadedFiles')} variant="info">
          {loadedFiles.map(file => {
            const { label, badgeKey } = humanizeLoadedFile(file)
            return (
              <Info_GroupedList.Item key={`${file.kind}:${file.name}`}>
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {label}
                    <span className="ml-1.5 rounded-[4px] bg-foreground/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {t(badgeKey)}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-foreground">{formatUsageNumber(file.tokens, locale)}</span>
                </div>
              </Info_GroupedList.Item>
            )
          })}
        </Info_GroupedList.Group>
      )}
    </>
  )
}
