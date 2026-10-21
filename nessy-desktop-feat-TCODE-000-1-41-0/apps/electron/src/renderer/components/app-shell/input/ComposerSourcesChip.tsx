/**
 * Source: v0.15.0:apps/electron/src/renderer/components/app-shell/input/ComposerSourcesChip.tsx (ADDED in v0.15.0,
 * unchanged at v0.15.1; UB14.31; Apache-2.0). ADAPTED to our rows: a source is a `SafeCapabilitySummary` (upstream:
 * `LoadedSource`), so the stack keys on `source.key`, and what the chip says — the empty affordance, one name, two
 * names on desktop, else a count — comes from {@link resolveComposerSourcesChip}: ONE identity
 * (`sourceSelectionId`: the mention id, else the logical name) for the desktop and the compact chip, and our
 * "never '0 sources'" guard (a stale slug that matches no offered source renders the empty affordance). The look,
 * the selectors and the toggling are upstream's.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DatabaseZap } from 'lucide-react'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { cn } from '@/lib/utils'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { SourceSelectorPopover } from '@/components/ui/SourceSelectorPopover'
import { CompactSourceSelector } from '@/components/ui/CompactSourceSelector'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { resolveComposerSourcesChip, type ComposerSourcesChipLabel } from './composer-sources-chip-state'

interface ComposerSourcesChipProps {
  /** Compact/touch layout: bottom-sheet selector instead of the anchored popover */
  compact: boolean
  sources: SafeCapabilitySummary[]
  /** Optimistic enabled source slugs (owned by FreeFormInput) */
  selectedSlugs: string[]
  onToggleSlug: (slug: string) => void
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  isEmptySession: boolean
  disabled: boolean
  buttonRef: React.RefObject<HTMLButtonElement>
}

/** Up to three source marks on raised tiles with a hairline, then a "+N" tile. */
function SourceStack({ sources }: { sources: SafeCapabilitySummary[] }) {
  const displaySources = sources.slice(0, 3)
  const remainingCount = sources.length - 3
  return (
    <div className="-ml-0.5 flex items-center">
      {displaySources.map((source, index) => (
        <div
          key={source.key}
          className={cn('relative flex size-5 items-center justify-center rounded-xs bg-raised shadow-elev-0', index > 0 && '-ml-1')}
          style={{ zIndex: index + 1 }}
        >
          <SourceAvatar source={source} size="xs" />
        </div>
      ))}
      {remainingCount > 0 && (
        <div
          className="-ml-1 flex size-5 items-center justify-center rounded-xs bg-raised text-caption text-tertiary shadow-elev-0 tabular-nums"
          style={{ zIndex: displaySources.length + 1 }}
        >
          +{remainingCount}
        </div>
      )}
    </div>
  )
}

/**
 * Sources chip in the composer toolbar (mockup "Sources 3" chip). Same labels, selectors and
 * toggling as before; desktop anchors SourceSelectorPopover, compact opens CompactSourceSelector.
 */
export function ComposerSourcesChip({
  compact,
  sources,
  selectedSlugs,
  onToggleSlug,
  open,
  setOpen,
  isEmptySession,
  disabled,
  buttonRef,
}: ComposerSourcesChipProps) {
  const { t } = useTranslation()
  const { enabledSources, hasSelection, label } = resolveComposerSourcesChip(sources, selectedSlugs, compact)

  const icon = hasSelection
    ? <SourceStack sources={enabledSources} />
    : <DatabaseZap className="h-4 w-4" />

  // The empty affordance reads "Sources" on the compact chip and "Choose sources" on desktop (upstream's two keys).
  const text = (chipLabel: ComposerSourcesChipLabel, emptyText: string): string =>
    chipLabel.kind === 'empty'
      ? emptyText
      : chipLabel.kind === 'names'
        ? chipLabel.names.join(', ')
        : t("chat.sourcesCount", { count: chipLabel.count })

  if (compact) {
    return (
      <div className="relative min-w-0 shrink">
        <FreeFormInputContextBadge
          buttonRef={buttonRef}
          icon={icon}
          label={text(label, t("chat.sourcesTooltip"))}
          isExpanded={false}
          hasSelection={hasSelection}
          showChevron={false}
          isOpen={open}
          disabled={disabled}
          onClick={() => setOpen(prev => !prev)}
          tooltip={t("chat.sourcesTooltip")}
        />
        <CompactSourceSelector
          open={open}
          onOpenChange={setOpen}
          sources={sources}
          selectedSlugs={selectedSlugs}
          onToggleSlug={onToggleSlug}
        />
      </div>
    )
  }

  return (
    <div className="relative min-w-0 shrink overflow-hidden">
      <FreeFormInputContextBadge
        buttonRef={buttonRef}
        icon={icon}
        label={text(label, t("chat.chooseSources"))}
        isExpanded={isEmptySession}
        hasSelection={hasSelection}
        showChevron={true}
        isOpen={open}
        disabled={disabled}
        data-tutorial="source-selector-button"
        onClick={() => setOpen(prev => !prev)}
        tooltip={t("chat.sourcesTooltip")}
      />

      <SourceSelectorPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        sources={sources}
        selectedSlugs={selectedSlugs}
        onToggleSlug={onToggleSlug}
      />
    </div>
  )
}
