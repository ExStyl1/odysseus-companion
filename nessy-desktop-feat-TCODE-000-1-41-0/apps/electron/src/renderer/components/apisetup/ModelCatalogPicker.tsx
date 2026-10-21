/**
 * ModelCatalogPicker — pick models out of what an endpoint PUBLISHES.
 *
 * What the endpoint returns is a CATALOG, not an entitlement list: llm-proxy
 * publishes 383 ids and a real key reaches a fraction of them. The list is
 * therefore never labelled "available" on its own — only a PROBE can say that,
 * and only about the ids it actually probed.
 *
 * TWO PRESENTATIONS, one component (G2). Which one is showing is decided by the
 * data, not by a prop:
 *
 * - NO VERDICTS — today's behaviour, and the one the legacy `ApiKeyInput`
 *   surface still uses: group by family prefix, everything selectable, a manual
 *   "Check access" button for the selection.
 * - VERDICTS PRESENT — the merged form's v2 behaviour: available models first
 *   (still by family), one collapsed «Unavailable» group at the bottom with red
 *   marks, and only available rows selectable.
 *
 * The second grows into the first as verdicts stream in: the form probes the
 * catalog in chunks and hands over partial results, so a row is PENDING until
 * its chunk lands. A pending row keeps its family group and carries a spinner —
 * it must not be pre-emptively sorted into either section, because guessing
 * wrong makes the list jump under the cursor.
 *
 * Deliberately standalone: state comes in through props and selection goes out
 * through `onSelectionChange`, so the component can be lifted into another
 * setup flow without dragging a form along.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CircleSlash, Loader2, MinusCircle, PackageSearch, Route, TriangleAlert } from 'lucide-react'
import type { ModelDefinition } from '@nessy-agent/shared/config'
import type { ArmProbe } from './byo-runtime'
import { Button } from '@/components/ui/button'
import { EntityList } from '@/components/ui/entity-list'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { EntityRow } from '@/components/ui/entity-row'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { modelGroupKey } from './model-catalog'

export interface ModelCatalogPickerProps {
  /** Everything the endpoint published. */
  catalog: ModelDefinition[]
  /** Ids the user has picked, in their chosen order. */
  selectedIds: string[]
  onSelectionChange: (ids: string[]) => void
  /**
   * Verdicts so far, keyed by id, ALREADY PROJECTED ONTO THE ARM
   * (`resolveArmVerdicts`). Partial while a probe is streaming.
   */
  probes?: Record<string, ArmProbe['verdict']>
  /** Runs an entitlement probe over the current selection (legacy surface). */
  onProbeSelected?: () => void
  probing?: boolean
  /** Streaming probe progress, shown instead of the manual button. */
  probeProgress?: { done: number; total: number }
  className?: string
}

/**
 * A verdict that is not `ok` is not automatically the same kind of "no".
 *
 * `no-quota` is about this key; `unsupported-endpoint` is about this endpoint
 * (neither wire serves it); `wrong-runtime` is about the RUNTIME the user
 * picked — the model answers, just not through this harness; `error` is our own
 * failure and claims nothing. All four keep the model out of the selectable
 * set, and each says why in its own words.
 *
 * UB14.40 — the marks sit on v0.15.1's status tints (`bg-success-tint`,
 * `bg-destructive-tint`, the pair its composer and kanban pills use) rather than
 * a ten-per-cent alpha of the ink; a neutral mark (context size, pending) on
 * the neutral fill with secondary ink, SessionItem's badge.
 */
const VERDICT_STYLE: Record<ArmProbe['verdict'], { colorClass: string; icon: React.ReactNode }> = {
  ok: { colorClass: 'bg-success-tint text-success', icon: <Check className="size-3" aria-hidden /> },
  // Red minus-in-circle, per the owner's review: an unavailable row should read
  // as barred at a glance, not as a caution.
  'no-quota': { colorClass: 'bg-destructive-tint text-destructive', icon: <MinusCircle className="size-3" aria-hidden /> },
  'unsupported-endpoint': { colorClass: 'bg-destructive-tint text-destructive', icon: <CircleSlash className="size-3" aria-hidden /> },
  'wrong-runtime': { colorClass: 'bg-destructive-tint text-destructive', icon: <Route className="size-3" aria-hidden /> },
  error: { colorClass: 'bg-destructive-tint text-destructive', icon: <TriangleAlert className="size-3" aria-hidden /> },
}

/** The neutral mark: a model's context size, a verdict still pending. */
const NEUTRAL_MARK = 'bg-fill-hover text-secondary'

/**
 * ONE DOM SHAPE IN EVERY STATE, which is what makes the frame's height EQUAL
 * rather than merely close.
 *
 * The obvious version — pass `emptyState` and let EntityList centre it — takes
 * that component's EARLY-RETURN branch, which renders `header + emptyState`
 * while the list branch renders `header + ScrollArea(pt-1 … pb-2)`. Measured:
 * 295px against 310px, a jump the moment models arrived. Matching the totals
 * with a magic number was tried, overshot to 325, and would have broken on the
 * next header change anyway.
 *
 * So the placeholder goes through the LIST branch instead: no `emptyState`
 * prop — its absence is what makes EntityList skip the early return — the copy
 * rides in as `footer`, which lives inside the ScrollArea, and the viewport
 * carries a min-height equal to its cap so it measures the same whether it
 * holds two lines or three hundred rows. Nothing to match, nothing to drift.
 *
 * The two tokens are the SAME NUMBER deliberately. The first attempt paired
 * `min-h-60` with `max-h-64` on the assumption they were both 240px; measured,
 * `min-h-60` is 225px in this config and the frame still moved 15px. Equal
 * tokens cannot disagree.
 */
const LIST_VIEWPORT = 'min-h-64 max-h-64'

/** Group-key prefixes. Namespaced so a family called "unavailable" cannot collide. */
const AVAILABLE_PREFIX = 'avail:'
const UNAVAILABLE_KEY = 'section:unavailable'

export function ModelCatalogPicker({
  catalog,
  selectedIds,
  onSelectionChange,
  probes,
  onProbeSelected,
  probing = false,
  probeProgress,
  className,
}: ModelCatalogPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState('')
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set([UNAVAILABLE_KEY]))

  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds])
  const hasVerdicts = !!probes && Object.keys(probes).length > 0

  const matched = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return catalog
    return catalog.filter(m =>
      m.id.toLowerCase().includes(needle) || (m.description ?? '').toLowerCase().includes(needle))
  }, [catalog, query])

  const groups = React.useMemo(() => {
    const collapse = (key: string, items: ModelDefinition[], label: string) => ({
      key,
      label,
      items: collapsedGroups.has(key) ? [] : items,
      collapsible: true,
      ...(collapsedGroups.has(key) ? { collapsedCount: items.length } : {}),
    })

    const byFamily = (models: ModelDefinition[], keyPrefix: string) => {
      const buckets = new Map<string, ModelDefinition[]>()
      for (const model of models) {
        const family = modelGroupKey(model.id)
        const bucket = buckets.get(family)
        if (bucket) bucket.push(model)
        else buckets.set(family, [model])
      }
      return [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([family, items]) => collapse(
          `${keyPrefix}${family || 'other'}`,
          items,
          family || t('apiSetup.modelCatalog.otherGroup'),
        ))
    }

    // No probe has run: the catalog is all we know, so present it as one.
    if (!hasVerdicts) return byFamily(matched, '')

    // A row with no verdict YET is not unavailable — it is pending, and it stays
    // where it already is so the list does not reshuffle mid-probe.
    const unavailable = matched.filter(m => probes![m.id] && probes![m.id] !== 'ok')
    const reachable = matched.filter(m => !probes![m.id] || probes![m.id] === 'ok')

    return [
      ...byFamily(reachable, AVAILABLE_PREFIX),
      ...(unavailable.length
        ? [collapse(UNAVAILABLE_KEY, unavailable, t('apiSetup.modelCatalog.unavailableGroup'))]
        : []),
    ]
  }, [matched, hasVerdicts, probes, collapsedGroups, t])

  const toggle = (id: string) => {
    onSelectionChange(selected.has(id) ? selectedIds.filter(entry => entry !== id) : [...selectedIds, id])
  }

  const visibleCount = groups.reduce((total, group) => total + (group.collapsedCount ?? group.items.length), 0)

  return (
    // The list's frame: v0.15.1's hairline, clipping the full-bleed rows to its corners.
    <div className={cn('overflow-hidden rounded-md border border-border', className)}>
      <EntityList
        groups={groups}
        getKey={(model: ModelDefinition) => model.id}
        collapsedGroups={collapsedGroups}
        onToggleCollapse={(key) => setCollapsedGroups((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })}
        viewportClassName={LIST_VIEWPORT}
        header={
          <div className="space-y-2 p-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('apiSetup.modelCatalog.searchPlaceholder')}
            />
            <div className="flex items-center gap-2 text-label-sm text-tertiary">
              {/* "publishes", never "available" — see the file header. */}
              <span>{t('apiSetup.modelCatalog.publishedCount', { count: visibleCount })}</span>
              <span className="ml-auto tabular-nums">{t('apiSetup.modelCatalog.selectedCount', { count: selectedIds.length })}</span>
              {/* The streaming probe reports progress; it never blocks the list,
                  so there is nothing to disable while it runs. */}
              {probeProgress && probeProgress.done < probeProgress.total && (
                <span className="flex items-center gap-1 tabular-nums">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  {t('apiSetup.modelCatalog.probeProgress', probeProgress)}
                </span>
              )}
              {onProbeSelected && !probeProgress && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={probing || selectedIds.length === 0}
                  onClick={onProbeSelected}
                >
                  {probing ? t('apiSetup.modelCatalog.checking') : t('apiSetup.modelCatalog.checkAccess')}
                </Button>
              )}
            </div>
          </div>
        }
        footer={visibleCount === 0
          ? (
            // TWO different emptinesses, and conflating them would tell a user
            // who has not fetched yet that their search matched nothing.
            <div className="flex flex-1 items-center justify-center">
              <EntityListEmptyScreen
                icon={<PackageSearch className="size-5" aria-hidden />}
                title={catalog.length === 0
                  ? t('apiSetup.modelCatalog.placeholderTitle')
                  : t('apiSetup.modelCatalog.emptyTitle')}
                description={catalog.length === 0
                  ? t('apiSetup.modelCatalog.placeholderDescription')
                  : t('apiSetup.modelCatalog.emptyDescription')}
              />
            </div>
          )
          : undefined}
        renderItem={(model: ModelDefinition) => {
          const verdict = probes?.[model.id]
          const style = verdict ? VERDICT_STYLE[verdict] : null
          // Pending only counts while a probe is actually running — after it
          // finishes, an id with no verdict was simply never probed.
          const pending = !verdict && !!probeProgress && probeProgress.done < probeProgress.total
          const unavailable = !!verdict && verdict !== 'ok'
          return (
            <EntityRow
              title={model.id}
              subtitle={model.description}
              isInMultiSelect={selected.has(model.id)}
              disabled={unavailable}
              onClick={() => toggle(model.id)}
              badges={model.contextWindow
                ? <EntityListBadge colorClass={NEUTRAL_MARK}>
                    {t('apiSetup.modelCatalog.contextTokens', { count: model.contextWindow })}
                  </EntityListBadge>
                : undefined}
              trailing={style
                ? <EntityListBadge variant="icon" colorClass={style.colorClass} tooltip={t(`apiSetup.modelCatalog.verdict.${verdict}`)}>
                    {style.icon}
                  </EntityListBadge>
                : pending
                  ? <EntityListBadge variant="icon" colorClass={NEUTRAL_MARK} tooltip={t('apiSetup.modelCatalog.verdictPending')}>
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                    </EntityListBadge>
                  : undefined}
            />
          )
        }}
      />
    </div>
  )
}
