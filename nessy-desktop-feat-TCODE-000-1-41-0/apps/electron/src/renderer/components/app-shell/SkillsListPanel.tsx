/* UB14.57 (R2-13): v0.15.1 `SkillsListPanel.tsx`'s row anatomy re-applied on our capability-catalog rows — "project"
   as the title meta (keyed on OUR capability scope, `scope.kind === 'project'`; upstream keys `skill.source`), the
   description as line 2, and the empty state's Add Skill on `<Button variant="secondary">`. Kept ours: the P2.439
   tier sentence on a greyed Delete, the catalog-only reveal gate, and send-to-workspace for workspace skills.
   UB12.80: the row's menu props and its reveal/delete come from `hooks/useSkillActions.ts`
   (`skillMenuProps`, `useSkillActions`), which the skill detail page's header "⋯" shares. */
import { skillRussianDescription } from '@/lib/odysseus-skills'
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { skillSelection } from '@/hooks/useEntitySelection'
import { SkillMenu } from './SkillMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { EditPopover, getAddSkillEditConfig } from '@/components/ui/EditPopover'
import { useAppShellContext } from '@/context/AppShellContext'
import { skillMenuProps, useSkillActions } from '@/hooks/useSkillActions'
import { capabilityDisplayName, capabilityRouteId, type SafeSkillRow } from '@/lib/capability-catalog'

export interface SkillsListPanelProps {
  skills: SafeSkillRow[]
  onSkillClick: (skill: SafeSkillRow) => void
  selectedSkillSlug?: string | null
  workspaceId?: string
  className?: string
}

export function SkillsListPanel({
  skills,
  onSkillClick,
  selectedSkillSlug,
  workspaceId,
  className,
}: SkillsListPanelProps) {
  const { t } = useTranslation()
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId
  const hasOtherWorkspaces = workspaces.length > 1
  const actions = useSkillActions()
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  return (
    <>
      <EntityPanel<SafeSkillRow>
        items={skills}
        getId={skill => capabilityRouteId(skill.key)}
        selection={skillSelection}
        selectedId={selectedSkillSlug}
        onItemClick={onSkillClick}
        className={className}
        containerProps={{ 'data-list-role': 'skills' }}
        emptyState={
          <EntityListEmptyScreen
            icon={<Zap />}
            title={t('skillsList.noSkillsConfigured')}
            description={t('skillsList.emptyDescription')}
            docKey="skills"
          >
            {resolvedWorkspaceId && (
              <EditPopover
                align="center"
                trigger={<Button variant="secondary">{t('skillsList.addSkill')}</Button>}
                {...getAddSkillEditConfig(resolvedWorkspaceId)}
              />
            )}
          </EntityListEmptyScreen>
        }
        mapItem={(skill) => {
          const displayName = capabilityDisplayName(skill)
          return {
            icon: <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />,
            title: displayName,
            // v0.15.1's anatomy: every row here is a skill, so the title meta
            // names the one thing that tells two skills apart — a project skill
            // says so — and the description is line 2. (The Sources list, whose
            // rows are mixed, carries the category there instead: the ONE card's
            // `sourceCardSlots`.)
            titleTrailing: skill.scope.kind === 'project' ? t('skillsList.projectBadge') : undefined,
            subtitle: skillRussianDescription(skill) || undefined,
            // Which items are live, what a greyed Delete says (the owning tier, P2.439) and what
            // each item does: the SAME builder and actions the skill detail page's "⋯" uses.
            menu: (
              <SkillMenu
                {...skillMenuProps(skill, {
                  actions,
                  t,
                  hasOtherWorkspaces,
                  onSendToWorkspace: () => {
                    setSendResourceSlug(skill.logicalName)
                    setSendResourceLabel(displayName)
                    setSendDialogOpen(true)
                  },
                })}
              />
            ),
          }
        }}
      />
      {sendResourceSlug && (
        <SendResourceToWorkspaceDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType="skill"
          resourceIds={[sendResourceSlug]}
          resourceLabel={sendResourceLabel}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
    </>
  )
}
