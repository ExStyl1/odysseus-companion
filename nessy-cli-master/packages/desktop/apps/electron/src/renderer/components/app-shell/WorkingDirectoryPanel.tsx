import { FolderTree, X } from 'lucide-react'
import { SessionFilesSection } from '../right-sidebar/SessionFilesSection'

// [nessy-fork] desktop-workspace-file-control
interface WorkingDirectoryPanelProps {
  sessionId: string
  rootPath: string
  onClose: () => void
}

export function WorkingDirectoryPanel({
  sessionId,
  rootPath,
  onClose,
}: WorkingDirectoryPanelProps) {
  const directoryName = rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath

  return (
    <div
      className="h-full w-[280px] shrink-0 border-l border-border/60 bg-background flex flex-col min-h-0"
      data-testid="working-directory-panel"
    >
      <div className="h-11 shrink-0 flex items-center gap-2 border-b border-border/50 px-3">
        <FolderTree className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {directoryName}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          aria-label="Close working directory"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* Each client has one server-side file watcher, already used by session artifacts. */}
      <SessionFilesSection
        sessionId={sessionId}
        rootPath={rootPath}
        watchFiles={false}
        hideHeader
        className="flex-1 min-h-0"
      />
    </div>
  )
}
