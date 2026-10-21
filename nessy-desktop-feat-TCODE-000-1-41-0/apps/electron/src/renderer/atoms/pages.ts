/* Copied from v0.13.4:apps/electron/src/renderer/atoms/pages.ts (craft-agents-oss, Apache-2.0) by
   UA7.3, 2026-10-02, rebranded `@craft-agent` → `@nessy-agent`; nothing else differs.
   `pagesProjectFilterAtom` and `PAGES_UNASSIGNED_PROJECT` are read by PagesHome's project filter
   since UA5.9 restored the Pages project ranges, 2026-10-02. */
/**
 * Jotai atoms for workspace Pages (agent-authored mini dashboards).
 *
 * `pagesAtom` is the single source of truth for the loaded page list —
 * `usePages` writes it and every consumer (sidebar count, grid, detail view)
 * reads it. There is deliberately no local-state mirror.
 *
 * `pagesProjectFilterAtom` follows the Kanban board's filter semantics
 * (empty = all), with one addition: the `PAGES_UNASSIGNED_PROJECT` sentinel
 * selects pages that have no project. It survives board remounts within a
 * session but is cleared on workspace switch (PagesHome owns the pruning).
 */

import { atom } from 'jotai'
import type { LoadedPage } from '@nessy-agent/shared/pages/types'

export const pagesAtom = atom<LoadedPage[]>([])

/** Sentinel id representing "pages without a project" in the project filter. */
export const PAGES_UNASSIGNED_PROJECT = '__unassigned__'

/** Selected project ids to filter the pages grid by. Empty array = all pages. */
export const pagesProjectFilterAtom = atom<string[]>([])
