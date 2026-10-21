import * as React from 'react'
import { Check, ChevronDown, FolderOpen } from 'lucide-react'
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
import {
  addRecentWorkingDir,
  getRecentWorkingDirs,
} from './input/working-directory-history'

// [nessy-fork] desktop-skill-scope-management
interface SkillsProjectSelectorProps {
  workspaceId: string
  workingDirectory?: string
  onChange: (path: string) => void
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function SkillsProjectSelector({
  workspaceId,
  workingDirectory,
  onChange,
}: SkillsProjectSelectorProps) {
  const [recentDirectories, setRecentDirectories] = React.useState<string[]>(
    () => getRecentWorkingDirs(workspaceId),
  )

  React.useEffect(() => {
    setRecentDirectories(getRecentWorkingDirs(workspaceId))
  }, [workspaceId])

  const selectDirectory = React.useCallback(
    (path: string) => {
      setRecentDirectories(addRecentWorkingDir(path, workspaceId))
      onChange(path)
    },
    [onChange, workspaceId],
  )
  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(selectDirectory)

  const choices = React.useMemo(
    () =>
      Array.from(
        new Set(
          [workingDirectory, ...recentDirectories].filter(
            (path): path is string => Boolean(path),
          ),
        ),
      ).slice(0, 8),
    [recentDirectories, workingDirectory],
  )

  return (
    <>
      <div className="flex h-10 items-center gap-2 border-b border-foreground/10 px-3">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Project
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 min-w-0 max-w-full gap-1.5 px-2"
              title={workingDirectory}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {workingDirectory
                  ? folderName(workingDirectory)
                  : 'Choose project'}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="start" className="max-w-[320px]">
            {choices.map((path) => (
              <StyledDropdownMenuItem
                key={path}
                onSelect={() => selectDirectory(path)}
                title={path}
              >
                <Check
                  className={
                    path === workingDirectory ? 'h-4 w-4' : 'h-4 w-4 opacity-0'
                  }
                />
                <span className="truncate">{folderName(path)}</span>
              </StyledDropdownMenuItem>
            ))}
            {choices.length > 0 && <StyledDropdownMenuSeparator />}
            <StyledDropdownMenuItem onSelect={pickDirectory}>
              <FolderOpen className="h-4 w-4" />
              Choose folder…
            </StyledDropdownMenuItem>
          </StyledDropdownMenuContent>
        </DropdownMenu>
        {workingDirectory && (
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70"
            title={workingDirectory}
          >
            {workingDirectory}
          </span>
        )}
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
