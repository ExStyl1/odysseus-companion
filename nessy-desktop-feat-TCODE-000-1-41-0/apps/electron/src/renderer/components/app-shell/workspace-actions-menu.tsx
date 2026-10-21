/**
 * P6.361 — the user-invocable entry point for a project's saved commands.
 *
 * The row's own finding: *"The EXECUTION mechanism exists on all three; the
 * missing piece is a user-invocable entry point."* Claude carries saved project
 * commands whose body runs shell, codex exposes `command/exec` on its
 * app-server, Pi is built to Claude's contract — and **none of the three has a
 * top-bar button, because none of them could.** The entry point is the app's.
 *
 * ## What this component is NOT allowed to be
 *
 * It never carries a command. The menu holds ids and names; the id crosses the
 * wire and the host resolves it against its own store. A renderer that could
 * post a command string would be a second way to run arbitrary shell beside the
 * one that asks for approval, which is precisely the divergence the row forbids.
 *
 * It never executes. `workspaceActions:run` hands the resolved command to
 * `SessionManager.runShellCommand`, the same seam the composer's `!` mode uses:
 * `shouldAllowToolInMode('Bash', …)`, the explore/plan refusal, the default-mode
 * approval card, the auto-mode prompt, and the transcript message that records
 * what ran. Nothing new approves anything.
 *
 * ## Why it renders nothing when the list is empty
 *
 * Two states produce an empty list and the component cannot tell them apart, on
 * purpose: a project with no declared actions, and an install where an operator
 * set `disableSkillShellExecution` — `getUserWorkspaceActions` answers `[]` for
 * both, so a caller that forgets to ask cannot offer a disabled action, and this
 * surface cannot leak the fact that a policy exists. A permanently visible empty
 * button in a header that is already crowded would be worse than absent; the
 * declaration lives in settings, which is where discovery belongs.
 *
 * The list is re-read every time the menu OPENS rather than once on mount, for
 * the same reason the host re-reads it: the kill switch has to be able to win a
 * race with a click.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import type { ResolvedWorkspaceAction } from '@nessy-agent/shared/config'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'

export interface WorkspaceActionsMenuProps {
  sessionId: string
  workspaceId: string
  /** Injected by the playground; the app uses the real bridge. */
  list?: () => Promise<readonly ResolvedWorkspaceAction[]>
  run?: (actionId: string) => Promise<{ executed: boolean; blocked?: boolean; error?: string }>
}

export function WorkspaceActionsMenu({ sessionId, workspaceId, list, run }: WorkspaceActionsMenuProps) {
  const { t } = useTranslation()
  const [actions, setActions] = React.useState<readonly ResolvedWorkspaceAction[]>([])
  // `undefined` until the first read answers: an install with no actions and an
  // install we have not asked yet must not render the same thing, or the button
  // would flash in and out on every open.
  const [loaded, setLoaded] = React.useState(false)

  const read = React.useCallback(async () => {
    const reader = list ?? (() => window.electronAPI.listWorkspaceActions())
    try {
      setActions(await reader())
    } catch {
      // A rejected read is an empty menu, never a broken header. The host
      // already reported the rejected settings layer.
      setActions([])
    } finally {
      setLoaded(true)
    }
  }, [list])

  React.useEffect(() => { void read() }, [read, sessionId])

  const onRun = React.useCallback(async (action: ResolvedWorkspaceAction) => {
    const runner = run ?? ((id: string) => window.electronAPI.runWorkspaceAction(sessionId, workspaceId, id))
    try {
      const result = await runner(action.id)
      // The output lands in the transcript when it RAN — `runShellCommand`
      // persists a message — so the only thing left to say here is the case
      // where it did not, which otherwise happens in silence.
      if (!result.executed) {
        toast.warning(t('chat.workspaceActions.refused', { name: action.name }), {
          ...(result.error ? { description: result.error } : {}),
        })
      }
    } catch (error) {
      toast.warning(t('chat.workspaceActions.refused', { name: action.name }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [run, sessionId, workspaceId, t])

  if (!loaded || actions.length === 0) return null

  return (
    <DropdownMenu onOpenChange={open => { if (open) void read() }}>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={t('chat.workspaceActions.label')}
          data-testid="workspace-actions-trigger"
          icon={<Play className="h-4 w-4" />}
        />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {actions.map(action => (
          <StyledDropdownMenuItem key={action.id} onClick={() => void onRun(action)}>
            <Play className="h-3.5 w-3.5" />
            <span className="flex-1">{action.name}</span>
          </StyledDropdownMenuItem>
        ))}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
