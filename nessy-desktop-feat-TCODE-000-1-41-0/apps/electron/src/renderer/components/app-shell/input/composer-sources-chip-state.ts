/**
 * UB14.31 — what the composer's sources chip shows, decided once for the desktop and the compact chip.
 *
 * Upstream v0.15.1 (`ComposerSourcesChip.tsx`) reads the selection straight off the slugs: the empty affordance when no
 * slug is selected, else one name, two names (desktop), or a count. Ours keeps two specifics on top:
 * - identity is {@link sourceSelectionId} (the source's mention id, else its logical name) on BOTH chips — upstream keys
 *   on `LoadedSource.config.slug`, which our `SafeCapabilitySummary` rows do not have;
 * - the "never '0 sources'" guard: a selected slug that matches no offered source (a stale or no longer pickable one)
 *   counts as nothing, so the chip shows the empty affordance — not "0 sources" and not an empty avatar stack.
 *
 * A pure module (no React, no `@nessy-agent/ui` barrel) so `composer-sources-chip.test.tsx` can read the decision
 * without the barrel's pdfjs chain; the chip renders it, and the playground sweep renders the chip.
 */
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { capabilityDisplayName, sourceSelectionId } from '@/lib/capability-catalog'

/** The chip's text, before translation: the empty affordance, the picked source names, or a count. */
export type ComposerSourcesChipLabel =
  | { kind: 'empty' }
  | { kind: 'names'; names: string[] }
  | { kind: 'count'; count: number }

export interface ComposerSourcesChipState {
  /** The offered sources the selection names, in the offered order (the avatar stack draws the first three). */
  enabledSources: SafeCapabilitySummary[]
  /** At least one selected slug names an offered source. */
  hasSelection: boolean
  label: ComposerSourcesChipLabel
}

export function resolveComposerSourcesChip(
  sources: readonly SafeCapabilitySummary[],
  selectedSlugs: readonly string[],
  compact: boolean,
): ComposerSourcesChipState {
  const selected = new Set(selectedSlugs)
  const enabledSources = sources.filter(source => selected.has(sourceSelectionId(source)))
  if (enabledSources.length === 0) return { enabledSources, hasSelection: false, label: { kind: 'empty' } }
  // Desktop names up to two sources ("A, B"); the compact chip names one and counts from two.
  const nameLimit = compact ? 1 : 2
  const label: ComposerSourcesChipLabel = enabledSources.length <= nameLimit
    ? { kind: 'names', names: enabledSources.map(capabilityDisplayName) }
    : { kind: 'count', count: enabledSources.length }
  return { enabledSources, hasSelection: true, label }
}
