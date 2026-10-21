/* Copied from v0.13.4:apps/electron/src/renderer/components/ui/SkillSelectorPopover.tsx
   (craft-agents-oss, Apache-2.0) by UA3.6, 2026-10-02. Adapted to OUR skills: the items are the
   capability catalogue's `SafeCapabilitySummary` rows (`skillsAtom`), keyed and selected by the same
   mention id our `SourceSelectorPopover` uses for sources (`mention.id`, else `logicalName`) — upstream's
   `LoadedSkill` (`slug`, `metadata.name`) is not a renderer type here. The chrome strings are upstream's
   English as the en values, through t() (UA12.206), as in our `SourceSelectorPopover`; the empty state too (UA12.194). */
import * as React from 'react'
import { Check } from 'lucide-react'
import { FilterableSelectPopover } from '@nessy-agent/ui'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

/** The id a skill is picked by — the mention id, as `SourceSelectorPopover` keys sources. */
export function skillSelectionId(skill: SafeCapabilitySummary): string {
  return skill.mention?.id ?? skill.logicalName
}

export interface SkillSelectorPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  skills: SafeCapabilitySummary[]
  selectedSlugs: string[]
  onToggleSlug: (slug: string) => void
  /** Workspace id — resolves local skill icons via SkillAvatar. */
  workspaceId?: string
}

/**
 * SkillSelectorPopover — skill multi-select mirroring {@link SourceSelectorPopover}.
 *
 * Same FilterableSelectPopover chrome (filter box, avatar rows, trailing check
 * circle) so the sources and skills pickers stay visually identical; only the
 * avatar (SkillAvatar vs SourceAvatar) and the resolved key/label differ.
 */
export function SkillSelectorPopover({
  open,
  onOpenChange,
  anchorRef,
  skills,
  selectedSlugs,
  onToggleSlug,
  workspaceId,
}: SkillSelectorPopoverProps) {
  const { t } = useTranslation() // UA12.194
  return (
    <FilterableSelectPopover
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      items={skills}
      getKey={(skill) => skill.key}
      getLabel={(skill) => skill.logicalName}
      isSelected={(skill) => selectedSlugs.includes(skillSelectionId(skill))}
      onToggle={(skill) => onToggleSlug(skillSelectionId(skill))}
      filterPlaceholder={t('skillsList.searchPlaceholder')} // UA12.206
      emptyState={(
        <>
          {t('skillsList.noSkillsConfigured')}.
          <br />
          {t('skillsList.addInSettings')}
        </>
      )}
      noResultsState={t('skillsList.noMatchingSkills')}
      minWidth={200}
      maxWidth={320}
      renderItem={(skill, state) => (
        <div
          className={cn(
            'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]',
            state.highlighted && 'bg-foreground/5',
            state.selected && 'bg-foreground/3',
          )}
        >
          <div className="shrink-0 text-muted-foreground flex items-center">
            <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />
          </div>
          <div className="flex-1 min-w-0 truncate">{skill.logicalName}</div>
          <div
            className={cn(
              'shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center',
              !state.selected && 'opacity-0',
            )}
          >
            <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
          </div>
        </div>
      )}
    />
  )
}
