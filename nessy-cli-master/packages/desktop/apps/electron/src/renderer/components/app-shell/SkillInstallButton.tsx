import * as React from 'react'
import {
  ChevronDown,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  UserRound,
} from 'lucide-react'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import type { SkillScope } from '@craft-agent/shared/protocol'

// [nessy-fork] desktop-skill-scope-management
// [nessy-fork] desktop-skill-marketplace-install-state
interface SkillInstallButtonProps {
  installedScopes: readonly SkillScope[]
  installing: boolean
  workingDirectory?: string
  onWorkingDirectoryChange?: (path: string) => void
  onInstall: (
    scope: SkillScope,
    workingDirectory?: string,
  ) => Promise<void> | void
  onUninstall: (scope: SkillScope) => void
  compact?: boolean
}

export function SkillInstallButton({
  installedScopes,
  installing,
  workingDirectory,
  onWorkingDirectoryChange,
  onInstall,
  onUninstall,
  compact = false,
}: SkillInstallButtonProps) {
  const installedInProject = installedScopes.includes('project')
  const installedForUser = installedScopes.includes('global')
  const installedInBothScopes = installedInProject && installedForUser
  const updatePrimaryScope = React.useCallback(async () => {
    await onInstall('project')
    if (installedInBothScopes) await onInstall('global')
  }, [installedInBothScopes, onInstall])
  const selectProject = React.useCallback(
    (path: string) => {
      onWorkingDirectoryChange?.(path)
      onInstall('project', path)
    },
    [onInstall, onWorkingDirectoryChange],
  )
  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(selectProject)

  return (
    <>
      <div className="flex shrink-0">
        <Button
          size="sm"
          className={
            compact
              ? 'w-[92px] rounded-r-none px-2'
              : 'min-w-[132px] rounded-r-none'
          }
          variant="default"
          disabled={installing || !workingDirectory}
          onClick={() => void updatePrimaryScope()}
          title={
            installedInBothScopes
              ? 'Update in project and for user'
              : installedInProject
              ? 'Update in selected project'
              : 'Install in selected project'
          }
        >
          {installing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : installedInProject ? (
            <RefreshCw className="h-3.5 w-3.5" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {compact
            ? installedInBothScopes
              ? 'Update all'
              : installedInProject
              ? 'Update'
              : 'Project'
            : installedInBothScopes
              ? 'Update both'
              : installedInProject
              ? 'Update project'
              : 'Install in project'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="default"
              className="w-8 rounded-l-none border-l border-current/15 px-0"
              disabled={installing}
              aria-label="Choose install scope"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end">
            {installedInBothScopes && (
              <StyledDropdownMenuItem
                disabled={!workingDirectory}
                onSelect={() => onInstall('project')}
              >
                <RefreshCw className="h-4 w-4" />
                Update project
              </StyledDropdownMenuItem>
            )}
            <StyledDropdownMenuItem
              onSelect={() => onInstall('global')}
            >
              {installedForUser ? (
                <RefreshCw className="h-4 w-4" />
              ) : (
                <UserRound className="h-4 w-4" />
              )}
              {installedForUser
                ? 'Update for user'
                : 'Install for user'}
            </StyledDropdownMenuItem>
            {installedForUser && (
              <StyledDropdownMenuItem onSelect={() => onUninstall('global')}>
                <Trash2 className="h-4 w-4" />
                Uninstall for user
              </StyledDropdownMenuItem>
            )}
            {installedInProject && (
              <StyledDropdownMenuItem
                disabled={!workingDirectory}
                onSelect={() => onUninstall('project')}
              >
                <Trash2 className="h-4 w-4" />
                Uninstall from selected project
              </StyledDropdownMenuItem>
            )}
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onSelect={pickDirectory}>
              <FolderOpen className="h-4 w-4" />
              Choose another project…
            </StyledDropdownMenuItem>
          </StyledDropdownMenuContent>
        </DropdownMenu>
      </div>
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
        initialPath={workingDirectory}
      />
    </>
  )
}
