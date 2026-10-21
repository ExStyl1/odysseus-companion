/**
 * useSkillActions + skillMenuProps — the ONE place a skill's "⋯" menu is decided and acted on,
 * shared by the Skills list row (`SkillsListPanel`) and the skill detail page's header menu
 * (`SkillDetailMenu`, UB12.80; v0.15.1 `pages/SkillInfoPage.tsx` L153-168 mounts `SkillMenu` in
 * `Info_HeaderMenu`).
 *
 * Why a hook and not AppShell props: the list used to take reveal/delete as props from `AppShell`
 * (`handleRevealCapability`, `handleDeleteSkill`), which the detail page — mounted by
 * `MainContentPanel`, not by AppShell — could not reach. Everything those handlers read is already
 * in `AppShellContext` (`capabilityContext`, `activeWorkspaceId`, `refreshPluginState`, which IS
 * AppShell's `refreshCapabilityViews`), so the hook reads it there and both surfaces call the same
 * two functions. The reveal itself is `useCapabilityReveal` (UB12.113), the one the Sources list
 * calls too, so `AppShell` no longer carries a reveal handler at all.
 *
 * Why one props builder: the list and the page must not disagree about which skill can be deleted
 * or what a greyed Delete says (P2.439: the item names the owning tier — `lib/skill-tier.ts` warns
 * that a second spelling of that rule is the failure). `skillMenuProps` is that rule, once.
 *
 * Outside the app shell (the playground, a test, a page mounted without an active workspace) the
 * hook answers `null`: there is no capability context to act in, so no surface offers the menu.
 */

import * as React from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { revealItemProps, useCapabilityReveal, type CapabilityReveal } from '@/hooks/useCapabilityReveal'
import { capabilityDisplayName, capabilityRouteId, type SafeSkillRow } from '@/lib/capability-catalog'
import { skillOwnerLabelKey } from '@/lib/skill-tier'
import type { SkillMenuProps } from '@/components/app-shell/SkillMenu'

/** i18n `t` with interpolation, kept structural so tests can pass a stub. */
type Translate = (key: string, options?: Record<string, unknown>) => string

export interface SkillActions {
  /** Shows the skill's resource in the OS file manager — `useCapabilityReveal`'s one reveal. */
  reveal: CapabilityReveal
  /** Deletes a native workspace skill. Resolves `true` once it is deleted and the views refreshed. */
  deleteSkill: (capabilityKey: string) => Promise<boolean>
}

/** The skill actions of the active workspace, or `null` outside the app shell. */
export function useSkillActions(): SkillActions | null {
  const { t } = useTranslation()
  const app = useOptionalAppShellContext()
  const context = app?.capabilityContext
  const workspaceId = app?.activeWorkspaceId ?? null
  const refresh = app?.refreshPluginState
  const reveal = useCapabilityReveal()

  return React.useMemo<SkillActions | null>(() => {
    if (!context || !workspaceId || !reveal) return null
    return {
      reveal,
      deleteSkill: async (capabilityKey) => {
        try {
          const detail = await window.electronAPI.capabilities.getDetail(context, capabilityKey)
          const ref = detail.resources.find(item => item.ref.scope === 'skill' && item.ref.tier === 'workspace')?.ref
          if (!ref || ref.scope !== 'skill' || ref.tier !== 'workspace') throw new Error('Skill is not mutable')
          await window.electronAPI.deleteSkill(workspaceId, ref.skillId)
          await refresh?.()
          toast.success(t('toast.deletedSkill', { slug: ref.skillId }))
          return true
        } catch (error) {
          console.error('[Skills] Failed to delete skill:', error)
          toast.error(t('toast.failedToDeleteSkill'))
          return false
        }
      },
    }
  }, [context, workspaceId, reveal, refresh, t])
}

/** Only a native skill in the workspace's own folder, and not read-only, can be deleted from the app. */
export function canDeleteSkill(skill: SafeSkillRow): boolean {
  return skill.origin === 'native' && skill.scope.kind === 'workspace' && !skill.readOnly
}

export interface SkillMenuPropsOptions {
  /** `useSkillActions()`; `null` disables Show-in-file-manager and Delete (and so Send to workspace). */
  actions: SkillActions | null
  t: Translate
  /** Send to workspace is offered only when another workspace exists AND the skill is deletable here. */
  hasOtherWorkspaces: boolean
  onSendToWorkspace: () => void
  /** Runs after a successful delete (the detail page leaves the deleted skill's page). */
  onDeleted?: () => void
}

/** `SkillMenu`'s props for one skill — the same answer on the list row and the detail page. */
export function skillMenuProps(skill: SafeSkillRow, options: SkillMenuPropsOptions): SkillMenuProps {
  const { actions, t, hasOtherWorkspaces, onSendToWorkspace, onDeleted } = options
  const routeId = capabilityRouteId(skill.key)
  const deletable = canDeleteSkill(skill)
  // The Sources row's gate, once (UB12.113): a catalog-only/non-file capability has no resource
  // the server's REVEAL RPC can point the file manager at (`lib/runtime-resource-rows.ts`
  // `canRevealCapability`), and outside the app shell there is no reveal at all.
  const { onShowInFinder, showInFinderDisabledReason } = revealItemProps(
    skill, actions?.reveal ?? null, t('skillsList.revealUnavailable'),
  )
  const onDelete = actions && deletable
    ? () => { void actions.deleteSkill(skill.key).then(deleted => { if (deleted) onDeleted?.() }) }
    : undefined
  return {
    skillSlug: routeId,
    skillName: capabilityDisplayName(skill),
    onOpenInNewWindow: () => window.electronAPI.openUrl(`nessy://skills/skill/${routeId}?window=focused`),
    onShowInFinder: onShowInFinder ?? (async () => undefined),
    canShowInFinder: onShowInFinder !== undefined,
    showInFinderDisabledReason,
    onDelete,
    canDelete: onDelete !== undefined,
    // When Delete is greyed out, the item's text becomes the reason. It names the TIER that owns
    // the skill (P2.439) — including the machine-wide administrator one, which is the tier a user
    // cannot edit from inside the app at all. Before P2.439 it said "Managed by project" for every
    // non-plugin skill, which was false for the personal global folder and would have been false
    // for the administrator tier too.
    deleteLabel: deletable ? t('skillsList.deleteSkill') : t(skillOwnerLabelKey(skill)),
    onSendToWorkspace: hasOtherWorkspaces && onDelete ? onSendToWorkspace : undefined,
  }
}
