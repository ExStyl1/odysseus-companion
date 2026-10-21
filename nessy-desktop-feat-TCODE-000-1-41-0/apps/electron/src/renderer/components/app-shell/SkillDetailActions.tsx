/**
 * UB12.80 — the skill detail page's header "⋯" (v0.15.1 `pages/SkillInfoPage.tsx` L153-168:
 * `<Info_HeaderMenu><SkillMenu … /></Info_HeaderMenu>` as `Info_Page.Header` actions; the page has
 * had one since v0.14.0's `titleMenu`). Ours had none since the capability-detail rewrite.
 *
 * The items are the list row's own: Open in new window, Show in file manager, Send to workspace,
 * and Delete — or, greyed, the owning tier's label (P2.439). Their props come from the SAME
 * `skillMenuProps` and their effects from the SAME `useSkillActions` the Skills list uses, so a
 * row and its page cannot disagree about what a skill allows.
 *
 * Kept ours, beyond v0.15.1's page: Send to workspace (upstream's page omits it; our list row
 * offers it for a deletable skill when another workspace exists), the catalog-only reveal gate
 * with its reason, and the tier label in place of upstream's single "Managed by project".
 * Upstream's remote-workspace reveal gate (`!activeWorkspace?.remoteServer`) is not taken: our
 * reveal is the server's capability REVEAL RPC, which the list row already calls unconditionally.
 *
 * Renders NOTHING outside the app shell (`useSkillActions()` is `null` there): no dead "⋯".
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Info_HeaderMenu } from '@/components/info/Info_HeaderMenu'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { skillMenuProps, useSkillActions } from '@/hooks/useSkillActions'
import { capabilityDisplayName, type SafeSkillRow } from '@/lib/capability-catalog'
import { navigate, routes } from '@/lib/navigate'
import { SkillMenu } from './SkillMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'

/** The header's "⋯" for one skill, or nothing outside the app shell. */
export function SkillDetailMenu({ skill }: { skill: SafeSkillRow }) {
  const { t } = useTranslation()
  const app = useOptionalAppShellContext()
  const actions = useSkillActions()
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  if (!app || !actions) return null
  const { workspaces, activeWorkspaceId } = app

  const menu = skillMenuProps(skill, {
    actions,
    t,
    hasOtherWorkspaces: workspaces.length > 1,
    onSendToWorkspace: () => setSendDialogOpen(true),
    // v0.15.1 leaves the deleted skill's page for the skills list.
    onDeleted: () => navigate(routes.view.skills()),
  })

  return (
    <>
      <Info_HeaderMenu>
        <SkillMenu {...menu} />
      </Info_HeaderMenu>
      {menu.onSendToWorkspace && (
        <SendResourceToWorkspaceDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType="skill"
          resourceIds={[skill.logicalName]}
          resourceLabel={capabilityDisplayName(skill)}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
    </>
  )
}
