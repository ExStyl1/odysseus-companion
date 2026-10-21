import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Download,
  ExternalLink,
  Loader2,
  Package,
  Power,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { ExtensionMarketplaceItem } from '../../../shared/types'

const PAGE_SIZE = 15

export interface ExtensionMarketplacePanelProps {
  workspaceId?: string
  workingDirectory?: string
  selectedExtensionId?: string | null
  onExtensionSelect?: (extensionId: string) => void
  installingExtensionIds?: ReadonlySet<string>
  onInstallStart?: (extensionId: string) => void
  onInstallFinish?: (extensionId: string) => void
  className?: string
}

function sourceHost(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).host
  } catch {
    return sourceUrl
  }
}

// Capability entries are loosely typed (`unknown`) — a string or an array of
// strings. Normalize to a string list so callers can `.join`/index them safely.
function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function formatCapabilities(capabilities: Record<string, unknown>): string {
  const parts: string[] = []

  // MCP servers
  const mcpServers = capabilities.mcpServers
  if (mcpServers) {
    const items = asStringList(mcpServers)
    if (items.length > 0) {
      const display = items.length > 2 
        ? `${items.slice(0, 2).join(', ')} +${items.length - 2}` 
        : items.join(', ')
      parts.push(`MCP: ${display}`)
    }
  }
  
  // Settings
  const settings = capabilities.settings
  if (settings) {
    const items = asStringList(settings)
    if (items.length > 0) {
      const display = items.length > 2 
        ? `${items[0]} +${items.length - 1}` 
        : items.join(', ')
      parts.push(`Settings: ${display}`)
    }
  }
  
  // Context files
  const contextFiles = capabilities.contextFiles
  if (contextFiles) {
    const items = asStringList(contextFiles)
    if (items.length > 0) {
      const display = items.length > 1 
        ? `${items[0]} +${items.length - 1}` 
        : items.join(', ')
      parts.push(`Context: ${display}`)
    }
  }
  
  // Commands
  const commands = capabilities.commands
  if (commands) {
    const items = asStringList(commands)
    if (items.length > 0) {
      const display = items.length > 2 
        ? `${items.slice(0, 2).join(', ')} +${items.length - 2}` 
        : items.join(', ')
      parts.push(`Commands: ${display}`)
    }
  }
  
  // Skills
  const skills = capabilities.skills
  if (skills) {
    const items = asStringList(skills)
    if (items.length > 0) {
      const display = items.length > 2 
        ? `${items.slice(0, 2).join(', ')} +${items.length - 2}` 
        : items.join(', ')
      parts.push(`Skills: ${display}`)
    }
  }
  
  // Agents
  const agents = capabilities.agents
  if (agents) {
    const items = asStringList(agents)
    if (items.length > 0) {
      const display = items.length > 2 
        ? `${items.slice(0, 2).join(', ')} +${items.length - 2}` 
        : items.join(', ')
      parts.push(`Agents: ${display}`)
    }
  }
  
  return parts.join(' · ')
}

// [nessy-fork] desktop-extension-management
// The install source (e.g. "@scope/pkg" or a git URL) is the token after
// "install" in the marketplace install command. The CLI `uninstall` accepts a
// name OR source, so this is enough to remove an installed extension.
function installSource(installCommand: string): string | undefined {
  const parts = installCommand.trim().split(/\s+/).filter(Boolean)
  const index = parts.indexOf('install')
  return index >= 0 ? parts[index + 1] : undefined
}

export function ExtensionMarketplacePanel({
  workspaceId,
  workingDirectory,
  selectedExtensionId,
  onExtensionSelect,
  installingExtensionIds,
  onInstallStart,
  onInstallFinish,
  className,
}: ExtensionMarketplacePanelProps) {
  const { t } = useTranslation()
  const [extensions, setExtensions] = React.useState<
    ExtensionMarketplaceItem[]
  >([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [total, setTotal] = React.useState(0)
  const [query, setQuery] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  // [nessy-fork] desktop-extension-management
  const [uninstallingIds, setUninstallingIds] = React.useState<Set<string>>(
    () => new Set(),
  )
  const [togglingIds, setTogglingIds] = React.useState<Set<string>>(
    () => new Set(),
  )
  const pageRef = React.useRef(1)
  const requestIdRef = React.useRef(0)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  const isLoadingRef = React.useRef(false)

  const loadExtensions = React.useCallback(
    async (page: number, append = false) => {
      if (!workspaceId) {
        requestIdRef.current += 1
        isLoadingRef.current = false
        setExtensions([])
        setTotal(0)
        return
      }
      if (append && isLoadingRef.current) return
      const requestId = append
        ? requestIdRef.current
        : requestIdRef.current + 1
      if (!append) requestIdRef.current = requestId
      isLoadingRef.current = true

      if (append) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      setError(null)
      try {
        const result = await window.electronAPI.listExtensionMarketplace(
          workspaceId,
          workingDirectory,
          page,
          PAGE_SIZE,
          debouncedQuery || undefined,
        )
        if (requestId !== requestIdRef.current) return
        if (append) {
          setExtensions((prev) => [...prev, ...result.items])
        } else {
          setExtensions(result.items)
        }
        setTotal(result.total)
        pageRef.current = page
      } catch (loadError) {
        if (requestId !== requestIdRef.current) return
        console.error(
          '[ExtensionMarketplacePanel] Failed to load extension marketplace:',
          loadError,
        )
        if (!append) {
          setError(
            t(
              'extensionMarketplace.loadFailed',
              'Could not load the extension market.',
            ),
          )
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false)
          setLoadingMore(false)
          isLoadingRef.current = false
        }
      }
    },
    [debouncedQuery, t, workingDirectory, workspaceId],
  )

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  React.useEffect(() => {
    pageRef.current = 1
    void loadExtensions(1)
  }, [loadExtensions])

  // IntersectionObserver for infinite scroll — stable, no deps on loading state
  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry?.isIntersecting) return
        if (isLoadingRef.current) return
        if (extensions.length >= total) return

        const nextPage = pageRef.current + 1
        pageRef.current = nextPage
        void loadExtensions(nextPage, true)
      },
      { root: viewportRef.current, rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [extensions.length, total, loadExtensions])

  const handleInstall = React.useCallback(
    async (extension: ExtensionMarketplaceItem) => {
      if (!workspaceId) return
      if (installingExtensionIds?.has(extension.id)) return

      onInstallStart?.(extension.id)
      try {
        await window.electronAPI.installExtensionFromMarketplace(
          workspaceId,
          extension.id,
          workingDirectory,
        )
        setExtensions((items) =>
          items.map((item) =>
            item.id === extension.id ? { ...item, installed: true } : item,
          ),
        )
        pageRef.current = 1
        await loadExtensions(1)
        toast.success(
          t('extensionMarketplace.installedToast', {
            name: extension.name,
            defaultValue: '{{name}} installed',
          }),
        )
      } catch (installError) {
        console.error(
          '[ExtensionMarketplacePanel] Failed to install marketplace extension:',
          installError,
        )
        toast.error(
          t('extensionMarketplace.installFailed', {
            name: extension.name,
            defaultValue: 'Failed to install {{name}}',
          }),
        )
      } finally {
        onInstallFinish?.(extension.id)
      }
    },
    [
      installingExtensionIds,
      loadExtensions,
      onInstallFinish,
      onInstallStart,
      t,
      workingDirectory,
      workspaceId,
    ],
  )

  const handleUninstall = React.useCallback(
    async (extension: ExtensionMarketplaceItem) => {
      if (uninstallingIds.has(extension.id)) return
      const identifier = installSource(extension.installCommand) ?? extension.name
      setUninstallingIds((ids) => new Set(ids).add(extension.id))
      try {
        await window.electronAPI.uninstallExtension(
          workspaceId,
          identifier,
          workingDirectory,
        )
        setExtensions((items) =>
          items.map((item) =>
            item.id === extension.id ? { ...item, installed: false } : item,
          ),
        )
        pageRef.current = 1
        await loadExtensions(1)
        toast.success(
          t('extensionMarketplace.uninstalledToast', {
            name: extension.name,
            defaultValue: '{{name}} uninstalled',
          }),
        )
      } catch (uninstallError) {
        console.error(
          '[ExtensionMarketplacePanel] Failed to uninstall marketplace extension:',
          uninstallError,
        )
        toast.error(
          t('extensionMarketplace.uninstallFailed', {
            name: extension.name,
            defaultValue: 'Failed to uninstall {{name}}',
          }),
        )
      } finally {
        setUninstallingIds((ids) => {
          const next = new Set(ids)
          next.delete(extension.id)
          return next
        })
      }
    },
    [loadExtensions, t, uninstallingIds, workingDirectory, workspaceId],
  )

  const handleToggleEnabled = React.useCallback(
    async (extension: ExtensionMarketplaceItem) => {
      if (togglingIds.has(extension.id)) return
      const enabled = extension.enabled !== false
      setTogglingIds((ids) => new Set(ids).add(extension.id))
      try {
        await window.electronAPI.setExtensionEnabled(
          workspaceId,
          extension.installedExtensionName ?? extension.name,
          !enabled,
          'user',
          workingDirectory,
        )
        setExtensions((items) =>
          items.map((item) =>
            item.id === extension.id ? { ...item, enabled: !enabled } : item,
          ),
        )
        await loadExtensions(1)
        toast.success(
          enabled
            ? t('settings.nessy.extensions.disabledToast', {
                name: extension.name,
              })
            : t('settings.nessy.extensions.enabledToast', {
                name: extension.name,
              }),
        )
      } catch (toggleError) {
        console.error(
          '[ExtensionMarketplacePanel] Failed to toggle marketplace extension:',
          toggleError,
        )
        toast.error(
          t('settings.nessy.extensions.actionFailed', {
            message:
              toggleError instanceof Error
                ? toggleError.message
                : String(toggleError),
          }),
        )
      } finally {
        setTogglingIds((ids) => {
          const next = new Set(ids)
          next.delete(extension.id)
          return next
        })
      }
    },
    [loadExtensions, t, togglingIds, workingDirectory, workspaceId],
  )

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('common.search', 'Search...')}
            className="h-7 w-full rounded-md border border-foreground/10 bg-muted/40 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-foreground/20 focus:bg-background"
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          disabled={loading || !workspaceId}
          onClick={() => {
            pageRef.current = 1
            void loadExtensions(1)
          }}
          title={t('common.refresh', 'Refresh')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        {error && (
          <div className="mx-3 mt-3 rounded-[8px] border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && !error && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('extensionMarketplace.loading', 'Loading extensions...')}
          </div>
        )}

        {!loading && !error && extensions.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-muted-foreground">
            <Package className="h-5 w-5" />
            <p className="text-sm">
              {t(
                'extensionMarketplace.empty',
                'No extensions are available yet.',
              )}
            </p>
          </div>
        )}

        {!error &&
          extensions.map((extension) => {
            const isInstalling =
              installingExtensionIds?.has(extension.id) ?? false
            const isUninstalling = uninstallingIds.has(extension.id)
            const isToggling = togglingIds.has(extension.id)
            const isSelected = selectedExtensionId === extension.id
            return (
              <div
                key={extension.id}
                role="button"
                tabIndex={0}
                className={cn(
                  'group flex min-h-[92px] cursor-default items-center gap-3 border-b border-foreground/10 px-3 py-3 outline-none transition-colors',
                  isSelected
                    ? 'bg-foreground/[0.045]'
                    : 'hover:bg-foreground/[0.025]',
                )}
                onClick={() => onExtensionSelect?.(extension.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onExtensionSelect?.(extension.id)
                  }
                }}
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-foreground/10 bg-foreground/[0.04]">
                  <Package className="h-5 w-5 text-muted-foreground" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-medium">
                      {extension.name}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={(event) => {
                        event.stopPropagation()
                        void window.electronAPI.openUrl(
                          extension.marketUrl ?? extension.sourceUrl,
                        )
                      }}
                      title={sourceHost(
                        extension.marketUrl ?? extension.sourceUrl,
                      )}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {extension.tagline}
                  </div>
                  {extension.capabilities && Object.keys(extension.capabilities).length > 0 && (
                    <div className="mt-1 text-[11px] text-muted-foreground/70">
                      {formatCapabilities(extension.capabilities)}
                    </div>
                  )}
                </div>

                {extension.installed ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="icon"
                      className="h-8 w-8"
                      variant="ghost"
                      disabled={isToggling || isUninstalling}
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleToggleEnabled(extension)
                      }}
                      title={
                        extension.enabled !== false
                          ? t('settings.nessy.extensions.disable')
                          : t('settings.nessy.extensions.enable')
                      }
                    >
                      {isToggling ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Power
                          className={cn(
                            'h-3.5 w-3.5',
                            extension.enabled !== false
                              ? 'text-emerald-500'
                              : 'text-muted-foreground',
                          )}
                        />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      className="w-[104px]"
                      variant="secondary"
                      disabled={isUninstalling || isToggling}
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleUninstall(extension)
                      }}
                      title={t('extensionMarketplace.uninstall', 'Uninstall')}
                    >
                      {isUninstalling ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      {t('extensionMarketplace.uninstall', 'Uninstall')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    className="w-[104px] shrink-0"
                    variant="default"
                    disabled={isInstalling || !extension.installCommand}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleInstall(extension)
                    }}
                    title={
                      !extension.installCommand
                        ? t('extensionMarketplace.installNotAvailable', 'Installation not available')
                        : undefined
                    }
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {t('extensionMarketplace.install', 'Install')}
                  </Button>
                )}
              </div>
            )
          })}

        {/* Sentinel for infinite scroll */}
        {extensions.length < total && (
          <div ref={sentinelRef} className="flex items-center justify-center px-3 py-4 text-sm text-muted-foreground">
            {loadingMore ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('extensionMarketplace.loadingMore', 'Loading more...')}
              </div>
            ) : (
              <span className="text-xs">
                {extensions.length} / {total}
              </span>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
