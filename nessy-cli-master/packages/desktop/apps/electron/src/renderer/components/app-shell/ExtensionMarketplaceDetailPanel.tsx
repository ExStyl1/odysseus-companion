// [nessy-fork] desktop-internal-extension-marketplace
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Download,
  ExternalLink,
  Loader2,
  Package,
  Power,
  Trash2,
  FileCode,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { rendererLog } from '@/lib/logger'
import { cn } from '@/lib/utils'
import type { ExtensionMarketplaceItem } from '../../../shared/types'

// [nessy-fork] ExtensionMarketplaceItem extension for additional fields from PluginDetailsDto
interface ExtensionMarketplaceItemExtended extends ExtensionMarketplaceItem {
  kind?: string
  manifestUrl?: string
  manifestPath?: string
  manifest?: {
    tenant?: string
    repository?: string
    [key: string]: unknown
  }
}

export interface ExtensionMarketplaceDetailPanelProps {
  workspaceId?: string
  workingDirectory?: string
  selectedExtensionId?: string | null
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

// [nessy-fork] desktop-extension-management
// The install source is the token after "install"; the CLI `uninstall` accepts
// a name OR source, so this is enough to remove an installed extension.
function installSource(installCommand: string): string | undefined {
  const parts = installCommand.trim().split(/\s+/).filter(Boolean)
  const index = parts.indexOf('install')
  return index >= 0 ? parts[index + 1] : undefined
}

export function ExtensionMarketplaceDetailPanel({
  workspaceId,
  workingDirectory,
  selectedExtensionId,
  installingExtensionIds,
  onInstallStart,
  onInstallFinish,
  className,
}: ExtensionMarketplaceDetailPanelProps) {
  const { t } = useTranslation()
  const [extensions, setExtensions] = React.useState<
    ExtensionMarketplaceItem[]
  >([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // [nessy-fork] desktop-extension-management
  const [uninstalling, setUninstalling] = React.useState(false)
  const [toggling, setToggling] = React.useState(false)
  const [detail, setDetail] = React.useState<ExtensionMarketplaceItemExtended | null>(null)

  const loadExtensions = React.useCallback(async () => {
    if (!workspaceId) {
      setExtensions([])
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.listExtensionMarketplace(
        workspaceId,
        workingDirectory,
      )
      setExtensions(result.items)
    } catch (loadError) {
      rendererLog.error(
        '[ExtensionMarketplaceDetailPanel] Failed to load extension marketplace:',
        loadError,
      )
      setError(
        t(
          'extensionMarketplace.loadFailed',
          'Could not load the extension market.',
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [t, workingDirectory, workspaceId])

  React.useEffect(() => {
    void loadExtensions()
  }, [loadExtensions])

  const loadDetail = React.useCallback(async () => {
    if (!selectedExtensionId || !workspaceId) {
      setDetail(null)
      return
    }

    try {
      // Get installCommand from the list (details endpoint doesn't return it)
      const existingExtension = extensions.find(ext => ext.id === selectedExtensionId)
      const installCommand = existingExtension?.installCommand

      const selected = await window.electronAPI.getExtensionDetails(
        workspaceId,
        selectedExtensionId,
        workingDirectory,
      )

      // Merge installCommand from list into details
      const merged = {
        ...selected,
        installCommand: installCommand ?? selected.installCommand,
      } as ExtensionMarketplaceItemExtended

      setDetail(merged)
    } catch (err) {
      rendererLog.error('[ExtensionMarketplaceDetailPanel] Failed to load extension details:', err)
    }
  }, [selectedExtensionId, workspaceId, workingDirectory, extensions])

  React.useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const selectedExtension = detail

  const handleInstall = React.useCallback(
    async (extension: ExtensionMarketplaceItem) => {
      if (!workspaceId) return
      if (installingExtensionIds?.has(extension.id)) return

      // Get installCommand from the list (details endpoint doesn't return it)
      const listExtension = extensions.find(ext => ext.id === extension.id)
      const installCommand = listExtension?.installCommand || extension.installCommand
      
      if (!installCommand) {
        toast.error(
          t('extensionMarketplace.installFailed', {
            name: extension.name,
            defaultValue: 'Failed to install {{name}}: no install command',
          }),
        )
        return
      }

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
        await loadExtensions()
        toast.success(
          t('extensionMarketplace.installedToast', {
            name: extension.name,
            defaultValue: '{{name}} installed',
          }),
        )
      } catch (installError) {
        rendererLog.error(
          '[ExtensionMarketplaceDetailPanel] Failed to install marketplace extension:',
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
      extensions,
    ],
  )

  const handleUninstall = React.useCallback(
    async (extension: ExtensionMarketplaceItem) => {
      if (uninstalling) return
      const identifier =
        installSource(extension.installCommand) ?? extension.name
      setUninstalling(true)
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
        await loadExtensions()
        toast.success(
          t('extensionMarketplace.uninstalledToast', {
            name: extension.name,
            defaultValue: '{{name}} uninstalled',
          }),
        )
      } catch (uninstallError) {
        rendererLog.error(
          '[ExtensionMarketplaceDetailPanel] Failed to uninstall marketplace extension:',
          uninstallError,
        )
        toast.error(
          t('extensionMarketplace.uninstallFailed', {
            name: extension.name,
            defaultValue: 'Failed to uninstall {{name}}',
          }),
        )
      } finally {
        setUninstalling(false)
      }
    },
    [loadExtensions, t, uninstalling, workingDirectory, workspaceId],
  )

  const handleToggleEnabled = React.useCallback(
    async (extension: ExtensionMarketplaceItem) => {
      if (toggling) return
      const enabled = extension.enabled !== false
      setToggling(true)
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
        await loadExtensions()
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
        rendererLog.error(
          '[ExtensionMarketplaceDetailPanel] Failed to toggle marketplace extension:',
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
        setToggling(false)
      }
    },
    [loadExtensions, t, toggling, workingDirectory, workspaceId],
  )

  if (loading && !selectedExtension && !error) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('extensionMarketplace.loading', 'Loading extensions...')}
        </div>
      </div>
    )
  }

  if (error || !selectedExtension) {
    const emptyMessage =
      error ??
      (extensions.length === 0
        ? t('extensionMarketplace.empty', 'No extensions are available yet.')
        : t('extensionMarketplace.title', 'Extension Market'))

    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2 text-center">
          <Package className="h-5 w-5" />
          <p className="max-w-xs text-sm">{emptyMessage}</p>
        </div>
      </div>
    )
  }

  const isInstalling =
    installingExtensionIds?.has(selectedExtension.id) ?? false
  const hasInstallCommand = Boolean(selectedExtension?.installCommand)
  const canInstall = hasInstallCommand && !selectedExtension?.installed
  const capabilities = selectedExtension?.capabilities as Record<string, string[] | string> | undefined

  return (
    <ScrollArea className={cn('h-full', className)}>
      <div className="mx-auto flex w-full max-w-[960px] flex-col px-8 py-9">
        <div className="flex items-start justify-between gap-5">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[8px] border border-foreground/10 bg-foreground/[0.04]">
              <Package className="h-7 w-7 text-muted-foreground" />
            </div>
            <div className="min-w-0 pt-1">
              <div className="flex min-w-0 items-center gap-2 flex-wrap">
                <h1 className="truncate text-3xl font-semibold tracking-normal">
                  {selectedExtension?.name}
                </h1>
                <span className="shrink-0 rounded-[6px] border border-foreground/10 px-2 py-0.5 text-xs text-muted-foreground">
                  v{selectedExtension?.version}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-base leading-6 text-muted-foreground">
                {selectedExtension?.tagline}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              onClick={() =>
                void window.electronAPI.openUrl(
                  selectedExtension.marketUrl ?? selectedExtension.sourceUrl,
                )
              }
              title={sourceHost(
                selectedExtension.marketUrl ?? selectedExtension.sourceUrl,
              )}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            {selectedExtension.installed ? (
              <>
                <Button
                  size="icon"
                  className="h-9 w-9"
                  variant="ghost"
                  disabled={toggling || uninstalling}
                  onClick={() => void handleToggleEnabled(selectedExtension)}
                  title={
                    selectedExtension.enabled !== false
                      ? t('settings.nessy.extensions.disable')
                      : t('settings.nessy.extensions.enable')
                  }
                >
                  {toggling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Power
                      className={cn(
                        'h-4 w-4',
                        selectedExtension.enabled !== false
                          ? 'text-emerald-500'
                          : 'text-muted-foreground',
                      )}
                    />
                  )}
                </Button>
                <Button
                  size="sm"
                  className="min-w-[108px]"
                  variant="secondary"
                  disabled={uninstalling || toggling}
                  onClick={() => void handleUninstall(selectedExtension)}
                >
                  {uninstalling ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  {t('extensionMarketplace.uninstall', 'Uninstall')}
                </Button>
              </>
            ) : canInstall ? (
              <Button
                size="sm"
                className="min-w-[108px]"
                variant="default"
                disabled={isInstalling}
                onClick={() => void handleInstall(selectedExtension)}
              >
                {isInstalling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {t('extensionMarketplace.install', 'Install')}
              </Button>
            ) : (
              <Button
                size="sm"
                className="min-w-[108px]"
                variant="secondary"
                disabled
                title={
                  hasInstallCommand
                    ? undefined
                    : t(
                        'extensionMarketplace.installNotAvailable',
                        'Installation not available for this extension',
                      )
                }
              >
                {t('extensionMarketplace.install', 'Install')}
              </Button>
            )}
          </div>
        </div>

        <div className="mt-8 space-y-8">
          {/* О расширении */}
          <div>
            <h2 className="text-lg font-semibold">
              {t('extensionMarketplace.aboutTitle', 'О расширении')}
            </h2>
            <p className="mt-3 text-[15px] leading-7 text-foreground/86">
              {selectedExtension?.description}
            </p>
          </div>

          {/* Возможности */}
          {capabilities && Object.keys(capabilities).length > 0 && (
            <div>
              <h2 className="text-lg font-semibold">
                {t('extensionMarketplace.capabilitiesTitle', 'Возможности')}
              </h2>
              <div className="mt-3 space-y-4">
                {/* MCP Servers */}
                {capabilities.mcpServers && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">
                      {t('extensionMarketplace.mcpLabel', 'MCP:')}
                    </p>
                    <ul className="grid grid-cols-2 gap-2">
                      {(Array.isArray(capabilities.mcpServers) ? capabilities.mcpServers : capabilities.mcpServers.split(',')).map((tool: string) => (
                        <li
                          key={tool.trim()}
                          className="flex items-center gap-2 text-sm text-foreground"
                        >
                          <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                          {tool.trim()}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {/* Settings */}
                {capabilities.settings && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">
                      {t('extensionMarketplace.settingsLabel', 'Settings:')}
                    </p>
                    <ul className="grid grid-cols-2 gap-2">
                      {(Array.isArray(capabilities.settings) ? capabilities.settings : capabilities.settings.split(',')).map((setting: string) => (
                        <li
                          key={setting.trim()}
                          className="flex items-center gap-2 text-sm text-foreground"
                        >
                          <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                          {setting.trim()}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {/* Commands */}
                {capabilities.commands && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">
                      {t('extensionMarketplace.commandsLabel', 'Commands:')}
                    </p>
                    <ul className="grid grid-cols-2 gap-2">
                      {(Array.isArray(capabilities.commands) ? capabilities.commands : capabilities.commands.split(',')).map((tool: string) => (
                        <li
                          key={tool.trim()}
                          className="flex items-center gap-2 text-sm text-foreground"
                        >
                          <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                          {tool.trim()}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {/* Skills */}
                {capabilities.skills && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">
                      {t('extensionMarketplace.skillsLabel', 'Skills:')}
                    </p>
                    <ul className="grid grid-cols-2 gap-2">
                      {(Array.isArray(capabilities.skills) ? capabilities.skills : capabilities.skills.split(',')).map((tool: string) => (
                        <li
                          key={tool.trim()}
                          className="flex items-center gap-2 text-sm text-foreground"
                        >
                          <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                          {tool.trim()}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {/* Agents */}
                {capabilities.agents && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">
                      {t('extensionMarketplace.agentsLabel', 'Agents:')}
                    </p>
                    <ul className="grid grid-cols-2 gap-2">
                      {(Array.isArray(capabilities.agents) ? capabilities.agents : capabilities.agents.split(',')).map((tool: string) => (
                        <li
                          key={tool.trim()}
                          className="flex items-center gap-2 text-sm text-foreground"
                        >
                          <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                          {tool.trim()}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {/* Context Files */}
                {capabilities.contextFiles && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-2">
                      {t('extensionMarketplace.contextLabel', 'Context:')}
                    </p>
                    <ul className="grid grid-cols-2 gap-2">
                      {(Array.isArray(capabilities.contextFiles) ? capabilities.contextFiles : capabilities.contextFiles.split(',')).map((tool: string) => (
                        <li
                          key={tool.trim()}
                          className="flex items-center gap-2 text-sm text-foreground"
                        >
                          <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
                          {tool.trim()}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Сведения */}
          <div>
            <h2 className="text-lg font-semibold">
              {t('extensionMarketplace.detailsTitle', 'Сведения')}
            </h2>
            <div className="mt-3 space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('extensionMarketplace.version', 'Версия:')}
                </span>
                <span className="text-sm font-medium">
                  v{selectedExtension?.version}
                </span>
              </div>
              
              {selectedExtension?.kind && (
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t('extensionMarketplace.type', 'Тип:')}
                  </span>
                  <span className="text-sm font-medium">
                    {selectedExtension.kind === 'nessy-extension'
                      ? 'Nessy Extension'
                      : selectedExtension.kind}
                  </span>
                </div>
              )}

              {selectedExtension?.manifest?.tenant && (
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t('extensionMarketplace.tenant', 'Тенант:')}
                  </span>
                  <span className="text-sm font-medium">
                    {selectedExtension.manifest.tenant}
                  </span>
                </div>
              )}

              {selectedExtension?.manifest?.repository && (
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t('extensionMarketplace.repository', 'Репозиторий:')}
                  </span>
                  <span className="text-sm font-medium truncate">
                    {selectedExtension.manifest.repository}
                  </span>
                </div>
              )}

              {selectedExtension?.marketUrl && (
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t('extensionMarketplace.skillsMarket', 'Skills Market:')}
                  </span>
                  <button
                    type="button"
                    className="text-sm text-primary hover:underline truncate"
                    onClick={() =>
                      void window.electronAPI.openUrl(selectedExtension.marketUrl ?? '')
                    }
                  >
                    {t('extensionMarketplace.openCard', 'Открыть карточку')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}
