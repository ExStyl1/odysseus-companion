/**
 * UA5.9 — the session menu's Projects submenu: the workspace's projects plus "No project" to clear the binding.
 *
 * Ported from craft-agents-oss v0.13.4 `apps/electron/src/renderer/components/app-shell/SessionMenu.tsx` L47–L51 and
 * L205–L231 (Apache-2.0). It lives in its own module, as `session-memory-scope-menu.tsx` does, because
 * `SessionMenu.tsx` is cited by line in the docs (`SessionMenu.tsx:237`, the "Revert Last File Edit" item): the menu
 * renders it from one rewritten line instead of an insertion above that line.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FolderKanban } from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'

export interface SessionMenuProjectOption {
  id: string
  slug: string
  name: string
}

export interface SessionProjectMenuItemsProps {
  /** The session's current binding (`undefined` = no project). */
  projectId: string | undefined
  projects: SessionMenuProjectOption[]
  /** Bind (`id`) or unbind (`null`). */
  onSetProjectId: (projectId: string | null) => void
}

export function SessionProjectMenuItems({ projectId, projects, onSetProjectId }: SessionProjectMenuItemsProps) {
  const { t } = useTranslation()
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()
  if (projects.length === 0) return null
  return (
    <Sub>
      <SubTrigger className="pr-2">
        <FolderKanban className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.projects")}</span>
      </SubTrigger>
      <SubContent>
        <MenuItem onClick={() => onSetProjectId(null)}>
          {!projectId && <Check className="h-3.5 w-3.5" />}
          <span className={projectId ? 'flex-1 ml-[18px]' : 'flex-1'}>
            {t("sessionMenu.noProject")}
          </span>
        </MenuItem>
        <Separator />
        {projects.map((p) => {
          const isBound = projectId === p.id
          return (
            <MenuItem key={p.id} onClick={() => onSetProjectId(p.id)}>
              {isBound && <Check className="h-3.5 w-3.5" />}
              <span className={isBound ? 'flex-1' : 'flex-1 ml-[18px]'}>{p.name}</span>
            </MenuItem>
          )
        })}
      </SubContent>
    </Sub>
  )
}
