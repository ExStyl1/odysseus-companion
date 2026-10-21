/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/KanbanProjectFilter.tsx
   (craft-agents-oss, Apache-2.0) by UA5.10, 2026-10-02. Adapted (spec §9, "the project filter gets a
   'No project' bucket"): the wrapper passes `unassignedId={KANBAN_UNASSIGNED_PROJECT}`, so the board offers
   "No project" the way upstream's own Pages filter does (`PagesHome.tsx`); upstream's board left it unset and
   hid every unbound tile while a filter was active. The rule the option selects is `filterTasksByProject`
   (`project-columns.ts`). */
import * as React from 'react'
import { KANBAN_UNASSIGNED_PROJECT } from '@/atoms/kanban'
import {
  ProjectMultiSelectFilter,
  type ProjectFilterOption,
} from '../ProjectMultiSelectFilter'

/** A selectable project in the board filter. `color` is optional (plain dot when absent). */
export type KanbanProjectFilterOption = ProjectFilterOption

interface KanbanProjectFilterProps {
  projects: KanbanProjectFilterOption[]
  /** Selected project ids; empty = all projects. May carry `KANBAN_UNASSIGNED_PROJECT` ("No project"). */
  value: string[]
  onChange: (next: string[]) => void
  className?: string
}

/**
 * Thin Kanban wrapper over the generic controlled ProjectMultiSelectFilter, with the
 * "No project" option (NESSY, header).
 */
export function KanbanProjectFilter(props: KanbanProjectFilterProps) {
  return <ProjectMultiSelectFilter {...props} unassignedId={KANBAN_UNASSIGNED_PROJECT} />
}
