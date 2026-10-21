import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'
import type { DirectoryListingResult } from '../../shared/types'
import { FolderIcon, FolderSymlinkIcon, ChevronRightIcon } from 'lucide-react'
import { Spinner } from '@nessy-agent/ui'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'

/**
 * Detect paths that are clearly from the wrong platform.
 * The server directory browser runs against the server's filesystem,
 * so Windows-style paths are invalid when the server is macOS/Linux and vice versa.
 * We infer the server platform from the home directory path.
 */
function isWrongPlatformPath(path: string, serverHomePath: string | null): boolean {
  if (!serverHomePath) return false
  const serverIsUnix = serverHomePath.startsWith('/')
  if (serverIsUnix) {
    return /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  }
  // Server is Windows — reject Unix absolute paths
  return path.startsWith('/')
}

interface ServerDirectoryBrowserProps {
  open: boolean
  mode: 'browse' | 'manual'
  workspaceId: string
  onSelect: (project: IssuedProjectHandle) => void | Promise<void>
  onCancel: () => void
  initialPath?: string
}

export function ServerDirectoryBrowser({
  open,
  mode,
  workspaceId,
  onSelect,
  onCancel,
  initialPath,
}: ServerDirectoryBrowserProps) {
  useRegisterModal(open, onCancel)
  const { t } = useTranslation()

  const [listing, setListing] = useState<DirectoryListingResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null)
  const [serverHomePath, setServerHomePath] = useState<string | null>(null)

  const confirmCandidate = useCallback(async (candidatePath: string) => {
    setConfirming(true)
    setError(null)
    try {
      const project = await window.electronAPI.validateProjectDirectory({
        workspaceId,
        candidatePath,
      })
      await onSelect(project)
    } catch {
      setError(t('projects.invalidFolder', { defaultValue: 'Choose a valid external folder.' }))
    } finally {
      setConfirming(false)
    }
  }, [onSelect, t, workspaceId])

  // Navigate to a directory (for browse mode)
  const navigateTo = useCallback(async (dirPath: string) => {
    setLoading(true)
    setError(null)
    setSelectedEntry(null)
    try {
      const result = await window.electronAPI.listServerDirectory(dirPath)
      setListing(result)
      setPathInput(result.currentPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('projects.serverBrowserListFailed')
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [t])

  // Load initial directory when opened
  useEffect(() => {
    if (!open) {
      // Reset state when closed
      setListing(null)
      setError(null)
      setSelectedEntry(null)
      setPathInput('')
      setServerHomePath(null)
      return
    }

    const init = async () => {
      if (mode === 'browse') {
        setLoading(true)

        // Resolve the start path with cascading fallback for backward compat:
        // 1. initialPath (if provided and valid)
        // 2. getServerHomeDir() — REMOTE_ELIGIBLE, returns server's home (new servers)
        // 3. listServerDirectory('~') — server-side ~ resolution (medium-age servers)
        // 4. listServerDirectory('/') — root directory (old servers)
        const tryNavigate = async (path: string) => {
          const result = await window.electronAPI.listServerDirectory(path)
          setListing(result)
          setPathInput(result.currentPath)
          setServerHomePath(result.currentPath)
        }

        try {
          if (initialPath) {
            await tryNavigate(initialPath)
          } else {
            // Try server home dir API first (REMOTE_ELIGIBLE — correct for remote workspaces)
            try {
              const serverHome = await window.electronAPI.getServerHomeDir()
              await tryNavigate(serverHome)
            } catch {
              // Fallback: ~ resolution (server-side)
              try {
                await tryNavigate('~')
              } catch {
                // Final fallback: root directory
                await tryNavigate('/')
              }
            }
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : t('projects.serverBrowserListFailed'))
        } finally {
          setLoading(false)
        }
      } else {
        // Manual mode — fetch home dir for platform detection
        const homeDir = await window.electronAPI.getServerHomeDir()
        setServerHomePath(homeDir)
      }
    }
    void init()
    // UB12.116: `t` is listed because the list-failure fallback above reads it; it changes only on a language switch.
  }, [open, mode, initialPath, navigateTo, t])

  // Handle path input submission (Enter key or navigate button)
  const handlePathSubmit = useCallback(async () => {
    const trimmed = pathInput.trim()
    if (!trimmed) return

    // Client-side rejection of wrong-platform paths (avoids round-trip)
    if (isWrongPlatformPath(trimmed, serverHomePath)) {
      setError(t('projects.serverBrowserWrongPlatform'))
      return
    }

    if (mode === 'browse') {
      void navigateTo(trimmed)
    } else {
      await confirmCandidate(trimmed)
    }
  }, [pathInput, mode, navigateTo, confirmCandidate, serverHomePath, t])

  // Handle selecting the current directory (or highlighted entry)
  const handleSelect = useCallback(async () => {
    if (mode === 'manual') {
      await handlePathSubmit()
      return
    }

    const selectedPath = selectedEntry ?? listing?.currentPath ?? pathInput.trim()
    if (!selectedPath) return
    await confirmCandidate(selectedPath)
  }, [mode, selectedEntry, listing, pathInput, confirmCandidate, handlePathSubmit])

  // Handle double-click on an entry to navigate into it
  const handleEntryDoubleClick = useCallback((entryPath: string) => {
    void navigateTo(entryPath)
  }, [navigateTo])

  // Handle single-click to select an entry
  const handleEntryClick = useCallback((entryPath: string) => {
    setSelectedEntry(prev => prev === entryPath ? null : entryPath)
  }, [])

  return (
    <ServerDirectoryBrowserView
      open={open}
      mode={mode}
      listing={listing}
      loading={loading}
      confirming={confirming}
      error={error}
      pathInput={pathInput}
      selectedEntry={selectedEntry}
      setPathInput={setPathInput}
      navigateTo={navigateTo}
      handlePathSubmit={handlePathSubmit}
      handleEntryClick={handleEntryClick}
      handleEntryDoubleClick={handleEntryDoubleClick}
      handleSelect={handleSelect}
      onCancel={onCancel}
    />
  )
}

/**
 * UB12.55 — the dialog as a pure view of the browser's state, so the playground entry
 * (`playground/registry/server-directory-browser.tsx`) draws every state on a static render: the
 * container above reaches its states only after an effect runs, which a static render never does
 * (UB15.8 met the same with `SafeModeSectionView`). Ours: v0.15.1 keeps state and markup in one
 * component and ships no playground entry for it. The callback props keep the container's own
 * names, so the markup below is v0.15.1's restyle (UB14.46) and its source pins read it; the one
 * addition is manual mode's error line (UB12.115), which v0.15.1 lacks.
 */
export interface ServerDirectoryBrowserViewProps {
  open: boolean
  mode: 'browse' | 'manual'
  /** The last listing that loaded; it stays while a later navigation fails, as the container keeps it. */
  listing: DirectoryListingResult | null
  loading: boolean
  confirming: boolean
  error: string | null
  pathInput: string
  selectedEntry: string | null
  setPathInput: (value: string) => void
  navigateTo: (dirPath: string) => void | Promise<void>
  handlePathSubmit: () => void | Promise<void>
  handleEntryClick: (entryPath: string) => void
  handleEntryDoubleClick: (entryPath: string) => void
  handleSelect: () => void | Promise<void>
  onCancel: () => void
}

export function ServerDirectoryBrowserView({
  open,
  mode,
  listing,
  loading,
  confirming,
  error,
  pathInput,
  selectedEntry,
  setPathInput,
  navigateTo,
  handlePathSubmit,
  handleEntryClick,
  handleEntryDoubleClick,
  handleSelect,
  onCancel,
}: ServerDirectoryBrowserViewProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)

  // Browse mode content
  const renderBrowseMode = () => (
    <>
      {/* Path input */}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handlePathSubmit()
          }}
          placeholder={t("common.enterPath")}
          className="flex-1 font-mono md:text-mono-ui"
        />
        <Button variant="secondary" size="lg" onClick={handlePathSubmit} disabled={loading}>
          {t('projects.serverBrowserGo')}
        </Button>
      </div>

      {/* Breadcrumbs */}
      {listing && (
        <div className="flex items-center gap-0.5 text-label-sm text-tertiary overflow-x-auto py-1 min-h-6">
          {listing.breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-0.5 shrink-0">
              {i > 0 && <ChevronRightIcon className="size-3 text-tertiary" />}
              <button
                type="button"
                onClick={() => navigateTo(crumb.path)}
                className="hover:text-foreground hover:underline px-0.5"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Directory listing */}
      <div className="border border-subtle rounded-md overflow-hidden flex-1 min-h-0">
        <div className="overflow-y-auto max-h-[300px]">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-label text-secondary">
              <Spinner className="text-label" />
              {t('common.loading')}
            </div>
          )}

          {error && (
            <div className="px-3 py-4 text-label text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && listing?.truncated && (
            <div className="border-b border-subtle px-3 py-2 text-label-sm text-tertiary">
              {t('projects.serverBrowserTruncated', { shown: listing.entries.length, total: listing.totalEntries })}
            </div>
          )}

          {!loading && !error && listing && listing.entries.length === 0 && (
            <div className="px-3 py-4 text-label text-secondary">
              {t('projects.serverBrowserEmpty')}
            </div>
          )}

          {!loading && !error && listing && listing.entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              onClick={() => handleEntryClick(entry.path)}
              onDoubleClick={() => handleEntryDoubleClick(entry.path)}
              className={`w-full flex items-center gap-2 px-3 min-h-row-menu text-label text-left -outline-offset-2 ${
                selectedEntry === entry.path ? 'bg-fill-selected' : 'hover:bg-fill-hover'
              }`}
            >
              {entry.isSymlink
                ? <FolderSymlinkIcon className="size-4 shrink-0 text-tertiary" />
                : <FolderIcon className="size-4 shrink-0 text-tertiary" />
              }
              <span className="truncate">{entry.name}</span>
              {entry.isSymlink && (
                <span className="text-label-sm text-tertiary shrink-0">{t('projects.serverBrowserSymlink')}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  )

  // Manual mode content
  const renderManualMode = () => (
    <>
      <p className="text-label text-secondary">
        {t('projects.serverBrowserManualPrompt')}
      </p>
      <Input
        ref={inputRef}
        value={pathInput}
        onChange={e => setPathInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') void handleSelect()
        }}
        placeholder="/Users/username/projects/my-project"
        className="font-mono md:text-mono-ui"
        autoFocus
      />
      {/*
        UB12.115 — ours: v0.15.1's manual mode draws no error line, so its wrong-platform
        sentence never shows, and our `validateProjectDirectory` refusal
        (`projects.invalidFolder`) would not either; Select would come back to Select with
        nothing said. The same destructive line browse mode draws, under the field.
      */}
      {error && (
        <div className="px-3 py-4 text-label text-destructive">
          {error}
        </div>
      )}
    </>
  )

  return (
    <Dialog open={open} onOpenChange={isOpen => { if (!isOpen) onCancel() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('projects.selectFolder', { defaultValue: 'Select working folder' })}</DialogTitle>
          {/*
            C3.58 — the standing statement that projects are local-only, on the
            one surface where somebody goes looking for a folder on another
            host. P6.499 measured the absence and then CORRECTED ITS OWN
            done-condition: the shipped `codex-app-server` carries no remote-host
            surface at all, and the absence is identical on Pi, claude and codex,
            so there is nothing to lose by switching runtimes and a per-switch
            notice would be noise. A standing line is the honest form, and this
            is where the question is actually asked.
          */}
          <p className="text-label-sm text-tertiary">
            {t('projects.localOnlyNote')}
          </p>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {mode === 'browse' ? renderBrowseMode() : renderManualMode()}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSelect()}
            disabled={confirming || (mode === 'manual' ? !pathInput.trim() : (!listing && !pathInput.trim()))}
          >
            {confirming
              ? t('common.loading', { defaultValue: 'Loading…' })
              : t('common.select', { defaultValue: 'Select' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}