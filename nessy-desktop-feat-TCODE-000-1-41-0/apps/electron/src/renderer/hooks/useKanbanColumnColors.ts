/* Copied from v0.13.4:apps/electron/src/renderer/hooks/useKanbanColumnColors.ts
   (craft-agents-oss, Apache-2.0) by UA2.3, 2026-10-02. One adaptation: the
   hook's merge is the exported pure `resolveKanbanColumnColors`, which reads the
   stored overrides through `readColumnMap` (atoms/kanban.ts) and accepts only a
   hex colour — so a corrupt stored value (`null`, an array, a number, a
   non-colour string) falls back to the default instead of throwing or painting
   nothing, and `bun test` drives the merge without a DOM. */
/**
 * Resolves each Kanban column's color set, merging the user's localStorage
 * overrides (`kanbanColumnColorsAtom`) over `DEFAULT_KANBAN_COLUMN_COLORS`.
 *
 * Returns a map keyed by column id; each entry carries the `solid` accent, a
 * faint `tint` for the column body / card surfaces (derived via `color-mix`, so
 * it adapts to light/dark), and `onAccent` text for use on the solid header.
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { kanbanColumnColorsAtom, readColumnMap } from '@/atoms/kanban'
import { KANBAN_COLUMNS } from '@/components/app-shell/kanban/status-column'
import { DEFAULT_KANBAN_COLUMN_COLORS } from '@/components/app-shell/kanban/kanban-colors'
import type { BuiltInKanbanColumnId, KanbanColumnId } from '@/components/app-shell/kanban/types'

export interface KanbanColumnColor {
  /** The accent hex (header pill background, dots). */
  solid: string
  /** Faint surface tint for the column body — `color-mix` so it works in light/dark. */
  tint: string
  /** Foreground color for text/icons sitting on the `solid` accent. */
  onAccent: string
}

/**
 * Build a full color set from a single accent hex. Shared by the built-in
 * column hook and by custom (per-project) columns that carry their own
 * `color` — so the tint/onAccent formula never drifts between the two.
 */
export function makeColumnColor(solid: string): KanbanColumnColor {
  return {
    solid,
    tint: `color-mix(in srgb, ${solid} 6%, transparent)`,
    onAccent: '#ffffff',
  }
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` — what the ColorPicker writes. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** The hook's merge, pure (UA2.3): a stored override wins only when it is a hex colour. */
export function resolveKanbanColumnColors(overrides: unknown): Map<KanbanColumnId, KanbanColumnColor> {
  const stored = readColumnMap(overrides)
  const map = new Map<KanbanColumnId, KanbanColumnColor>()
  for (const { id } of KANBAN_COLUMNS) {
    const builtInId = id as BuiltInKanbanColumnId
    const override = stored[builtInId]
    const solid = override && HEX_COLOR.test(override) ? override : DEFAULT_KANBAN_COLUMN_COLORS[builtInId]
    map.set(id, makeColumnColor(solid))
  }
  return map
}

export function useKanbanColumnColors(): Map<KanbanColumnId, KanbanColumnColor> {
  const overrides = useAtomValue(kanbanColumnColorsAtom)
  return React.useMemo(() => resolveKanbanColumnColors(overrides), [overrides])
}
