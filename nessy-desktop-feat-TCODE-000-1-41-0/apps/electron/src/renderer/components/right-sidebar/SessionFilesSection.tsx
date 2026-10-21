import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ExternalLink, File, FileCode, FileText, Folder, FolderOpen, Image } from 'lucide-react'
import type { SessionFileHandle } from '@nessy-agent/shared/protocol'
import type { SessionKey } from '@nessy-agent/shared/sessions'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'
import { getFileManagerName } from '@/lib/platform'
import { restoreSessionFileWatch } from './session-files-watch'

interface SessionFileNode extends SessionFileHandle {
  children: SessionFileNode[]
}

export interface SessionFilesSectionProps {
  session?: SessionKey
  className?: string
  hideHeader?: boolean
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function asTree(handles: SessionFileHandle[]): SessionFileNode[] {
  const nodes = new Map<string, SessionFileNode>(
    handles.map(handle => [handle.displayPath, { ...handle, children: [] }]),
  )
  const roots: SessionFileNode[] = []
  for (const node of nodes.values()) {
    const separator = node.displayPath.lastIndexOf('/')
    const parent = separator < 0 ? undefined : nodes.get(node.displayPath.slice(0, separator))
    if (parent?.kind === 'directory') parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function iconFor(file: SessionFileNode, expanded: boolean) {
  const className = 'h-3.5 w-3.5 text-muted-foreground'
  if (file.kind === 'directory') {
    return expanded ? <FolderOpen className={className} /> : <Folder className={className} />
  }
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'md' || extension === 'markdown') return <FileText className={className} />
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(extension ?? '')) return <Image className={className} />
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'py', 'rb', 'go', 'rs'].includes(extension ?? '')) {
    return <FileCode className={className} />
  }
  return <File className={className} />
}

function FileThumbnail({ session, file }: { session: SessionKey; file: SessionFileNode }) {
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (file.kind !== 'file') return
    let cancelled = false
    window.electronAPI.previewSessionFile({ session, handleId: file.handleId })
      .then(value => {
        if (!cancelled && value?.startsWith('data:image/')) setPreviewUrl(value)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [file.handleId, file.kind, session.sessionId, session.workspaceId])

  return previewUrl
    ? <img src={previewUrl} alt="" className="h-3.5 w-3.5 rounded-[2px] object-cover" />
    : iconFor(file, false)
}

function FileTreeItem({
  session,
  file,
  expanded,
  onToggle,
}: {
  session: SessionKey
  file: SessionFileNode
  expanded: Set<string>
  onToggle: (displayPath: string) => void
}) {
  const { t } = useTranslation()
  const isDirectory = file.kind === 'directory'
  const isExpanded = expanded.has(file.displayPath)
  const hasChildren = isDirectory && file.children.length > 0
  const open = () => {
    if (hasChildren) onToggle(file.displayPath)
    else void window.electronAPI.openSessionFile({ session, handleId: file.handleId })
  }

  return (
    <div className="group/section min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={open}
            className={cn(
              'group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-[6px] px-2 py-[5px] text-left text-[13px]',
              'outline-none transition-colors hover:bg-sidebar-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
            )}
            title={`${file.displayPath}\n${isDirectory ? t('chat.sessionFilesDirectory') : formatFileSize(file.size)}`}
          >
            <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {hasChildren ? (
                <>
                  <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0">
                    {iconFor(file, isExpanded)}
                  </span>
                  <ChevronRight className={cn('h-3.5 w-3.5 opacity-0 group-hover:opacity-100', isExpanded && 'rotate-90')} />
                </>
              ) : <FileThumbnail session={session} file={file} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
          </button>
        </ContextMenuTrigger>
        <StyledContextMenuContent>
          <StyledContextMenuItem onSelect={() => void window.electronAPI.openSessionFile({ session, handleId: file.handleId })}>
            <ExternalLink className="h-3.5 w-3.5" />
            {isDirectory
              ? t('chat.showInFileManager', { fileManager: getFileManagerName() })
              : t('chat.openFile')}
          </StyledContextMenuItem>
        </StyledContextMenuContent>
      </ContextMenu>
      {hasChildren && isExpanded && (
        <div className="ml-[13px] grid gap-0.5 border-l border-foreground/10 pl-[7px]">
          {file.children.map(child => (
            <FileTreeItem
              key={child.displayPath}
              session={session}
              file={child}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function SessionFilesSection({ session, className, hideHeader = false }: SessionFilesSectionProps) {
  const { t } = useTranslation()
  const [files, setFiles] = React.useState<SessionFileNode[]>([])
  const [loading, setLoading] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const mounted = React.useRef(true)
  const sessionId = session?.sessionId

  React.useEffect(() => {
    if (!sessionId) return
    setExpanded(new Set(storage.get<string[]>(storage.KEYS.sessionFilesExpandedFolders, [], sessionId)))
  }, [sessionId])

  const load = React.useCallback(async () => {
    if (!session) {
      setFiles([])
      return
    }
    setLoading(true)
    try {
      const next = asTree(await window.electronAPI.getSessionFiles(session))
      if (mounted.current) setFiles(next)
    } catch {
      if (mounted.current) setFiles([])
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [session?.sessionId, session?.workspaceId])

  React.useEffect(() => {
    mounted.current = true
    void load()
    if (!session) return () => { mounted.current = false }
    void window.electronAPI.watchSessionFiles(session.sessionId)
    const filesChanged = window.electronAPI.onSessionFilesChanged(changed => {
      if (changed === session.sessionId && mounted.current) void load()
    })
    const reconnected = window.electronAPI.onReconnected(() => {
      if (mounted.current) void restoreSessionFileWatch(session.sessionId, load)
    })
    return () => {
      mounted.current = false
      filesChanged()
      reconnected()
      void window.electronAPI.unwatchSessionFiles()
    }
  }, [load, session?.sessionId, session?.workspaceId])

  const toggle = React.useCallback((displayPath: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(displayPath)) next.delete(displayPath)
      else next.add(displayPath)
      if (sessionId) storage.set(storage.KEYS.sessionFilesExpandedFolders, [...next], sessionId)
      return next
    })
  }, [sessionId])

  if (!session) return null

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {!hideHeader && (
        <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
          {/* UB14.59 — v0.15.1's two class swaps (the header label and the reveal link on the role text). */}
          <span className="text-label-sm font-medium text-secondary">{t('chat.sessionFiles')}</span>
          <button
            type="button"
            onClick={() => void window.electronAPI.revealSessionStorage(session)}
            className="text-label-sm text-tertiary hover:text-secondary hover:underline underline-offset-2 transition-colors duration-micro ease-out-subtle hover:duration-instant"
          >
            {t('chat.viewInFileManager', { fileManager: getFileManagerName() })}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
        {files.length === 0 ? (
          <p className="px-4 text-xs text-muted-foreground">
            {loading ? t('chat.sessionFilesLoading') : t('chat.sessionFilesEmpty')}
          </p>
        ) : (
          <nav className="grid gap-0.5 px-2">
            {files.map(file => (
              <FileTreeItem
                key={file.displayPath}
                session={session}
                file={file}
                expanded={expanded}
                onToggle={toggle}
              />
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
