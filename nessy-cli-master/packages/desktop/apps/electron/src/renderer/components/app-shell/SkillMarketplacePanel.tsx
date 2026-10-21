import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Store,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { rendererLog } from '@/lib/logger'
import { MarketplaceSkillIcon } from './MarketplaceSkillIcon'
import { SkillInstallButton } from './SkillInstallButton'
import type { SkillMarketplaceItem } from '../../../shared/types'
// [nessy-fork] desktop-skill-scope-management
// [nessy-fork] desktop-skill-marketplace-install-state
import type { SkillScope } from '@craft-agent/shared/protocol'

const PAGE_SIZE = 15

export interface SkillMarketplacePanelProps {
  workspaceId?: string
  workingDirectory?: string
  onWorkingDirectoryChange?: (path: string) => void
  activeSessionId?: string | null
  selectedSkillId?: string | null
  onSkillSelect?: (skillId: string) => void
  onInstalled?: (options?: { force?: boolean }) => Promise<void> | void
  installingSkillIds?: ReadonlySet<string>
  onInstallStart?: (skillId: string) => void
  onInstallFinish?: (skillId: string) => void
  className?: string
}

function sourceHost(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).host
  } catch {
    return sourceUrl
  }
}

export function SkillMarketplacePanel({
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  activeSessionId,
  selectedSkillId,
  onSkillSelect,
  onInstalled,
  installingSkillIds,
  onInstallStart,
  onInstallFinish,
  className,
}: SkillMarketplacePanelProps) {
  const { t } = useTranslation()
  const [skills, setSkills] = React.useState<SkillMarketplaceItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [total, setTotal] = React.useState(0)
  const [query, setQuery] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  const pageRef = React.useRef(1)
  const requestIdRef = React.useRef(0)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  const isLoadingRef = React.useRef(false)

  const loadSkills = React.useCallback(
    async (page: number, append = false) => {
      if (!workspaceId) {
        requestIdRef.current += 1
        isLoadingRef.current = false
        setSkills([])
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
        const result = await window.electronAPI.listSkillMarketplace(
          workspaceId,
          workingDirectory,
          activeSessionId ?? undefined,
          page,
          PAGE_SIZE,
          debouncedQuery || undefined,
        )
        if (requestId !== requestIdRef.current) return
        if (append) {
          setSkills((prev) => [...prev, ...result.items])
        } else {
          setSkills(result.items)
        }
        setTotal(result.total)
        pageRef.current = page
      } catch (loadError) {
        if (requestId !== requestIdRef.current) return
        rendererLog.error(
          '[SkillMarketplacePanel] Failed to load skill marketplace:',
          loadError,
        )
        if (!append) {
          setError(
            t('skillMarketplace.loadFailed', 'Could not load the skill market.'),
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
    [activeSessionId, debouncedQuery, t, workingDirectory, workspaceId],
  )

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  React.useEffect(() => {
    pageRef.current = 1
    void loadSkills(1)
  }, [loadSkills])

  // IntersectionObserver for infinite scroll — stable, no deps on loading state
  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry?.isIntersecting) return
        if (isLoadingRef.current) return
        if (skills.length >= total) return

        const nextPage = pageRef.current + 1
        pageRef.current = nextPage
        void loadSkills(nextPage, true)
      },
      { root: viewportRef.current, rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [skills.length, total, loadSkills])

  React.useEffect(() => {
    if (!workspaceId) return
    const cleanup = window.electronAPI.onSkillsChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        pageRef.current = 1
        void loadSkills(1)
      }
    })
    return cleanup
  }, [loadSkills, workspaceId])

  const handleInstall = React.useCallback(
    async (
      skill: SkillMarketplaceItem,
      scope: SkillScope,
      installWorkingDirectory?: string,
    ) => {
      if (!workspaceId) return
      if (installingSkillIds?.has(skill.id)) return

      onInstallStart?.(skill.id)
      try {
        await window.electronAPI.installSkillFromMarketplace(
          workspaceId,
          skill.id,
          installWorkingDirectory ?? workingDirectory,
          activeSessionId ?? undefined,
          scope,
          skill.detailsId,
        )
        setSkills((items) =>
          items.map((item) =>
            item.id === skill.id
              ? {
                  ...item,
                  installed: true,
                  installedScopes: Array.from(
                    new Set([...item.installedScopes, scope]),
                  ),
                }
              : item,
          ),
        )
        await onInstalled?.({ force: true })
        pageRef.current = 1
        await loadSkills(1)
        toast.success(
          t('skillMarketplace.installedToast', {
            name: skill.name,
            defaultValue: '{{name}} installed',
          }),
        )
      } catch (installError) {
        rendererLog.error(
          `[SkillMarketplacePanel] Failed to install marketplace skill ${skill.id} (detailsId: ${skill.detailsId ?? 'none'}):`,
          installError,
        )
        toast.error(
          t('skillMarketplace.installFailed', {
            name: skill.name,
            defaultValue: 'Failed to install {{name}}',
          }),
        )
      } finally {
        onInstallFinish?.(skill.id)
      }
    },
    [
      activeSessionId,
      installingSkillIds,
      loadSkills,
      onInstalled,
      onInstallFinish,
      onInstallStart,
      t,
      workingDirectory,
      workspaceId,
    ],
  )

  const handleUninstall = React.useCallback(
    async (skill: SkillMarketplaceItem, scope: SkillScope) => {
      if (!workspaceId) return
      if (installingSkillIds?.has(skill.id)) return

      onInstallStart?.(skill.id)
      try {
        await window.electronAPI.deleteSkill(
          workspaceId,
          skill.slug,
          workingDirectory,
          activeSessionId ?? undefined,
          scope,
        )
        setSkills((items) =>
          items.map((item) => {
            if (item.id !== skill.id) return item
            const installedScopes = item.installedScopes.filter(
              (installedScope) => installedScope !== scope,
            )
            return {
              ...item,
              installed: installedScopes.length > 0,
              installedScopes,
            }
          }),
        )
        await onInstalled?.({ force: true })
        pageRef.current = 1
        await loadSkills(1)
        toast.success(`${skill.name} uninstalled`)
      } catch (uninstallError) {
        rendererLog.error(
          '[SkillMarketplacePanel] Failed to uninstall marketplace skill:',
          uninstallError,
        )
        toast.error(`Failed to uninstall ${skill.name}`)
      } finally {
        onInstallFinish?.(skill.id)
      }
    },
    [
      activeSessionId,
      installingSkillIds,
      loadSkills,
      onInstalled,
      onInstallFinish,
      onInstallStart,
      workingDirectory,
      workspaceId,
    ],
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
            void loadSkills(1)
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
            {t('skillMarketplace.loading', 'Loading skills...')}
          </div>
        )}

        {!loading && !error && skills.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-muted-foreground">
            <Store className="h-5 w-5" />
            <p className="text-sm">
              {t('skillMarketplace.empty', 'No skills are available yet.')}
            </p>
          </div>
        )}

        {!error &&
          skills.map((skill) => {
            const isInstalling = installingSkillIds?.has(skill.id) ?? false
            const isSelected = selectedSkillId === skill.id
            return (
              <div
                key={skill.id}
                role="button"
                tabIndex={0}
                className={cn(
                  'group flex min-h-[88px] cursor-default items-center gap-3 border-b border-foreground/10 px-3 py-3 outline-none transition-colors',
                  isSelected
                    ? 'bg-foreground/[0.045]'
                    : 'hover:bg-foreground/[0.025]',
                )}
                onClick={() => onSkillSelect?.(skill.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSkillSelect?.(skill.id)
                  }
                }}
              >
                <MarketplaceSkillIcon iconKey={skill.iconKey} />

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1 truncate text-sm font-medium">
                      {skill.name}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={(event) => {
                        event.stopPropagation()
                        void window.electronAPI.openUrl(
                          skill.websiteUrl ?? skill.sourceUrl,
                        )
                      }}
                      title={sourceHost(skill.websiteUrl ?? skill.sourceUrl)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {skill.tagline}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground/70">
                    {sourceHost(skill.sourceUrl)}
                  </div>
                </div>

                <div
                  className="relative shrink-0"
                  onClick={(event) => event.stopPropagation()}
                >
                  {(skill.installedScopes.length > 0 || skill.parseError) && (
                    <div className="absolute bottom-full right-1/2 mb-1 flex translate-x-1/2 items-center gap-1">
                      {skill.installedScopes.includes('project') && (
                        <span
                          className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400"
                          title={t(
                            'skillMarketplace.installedInProject',
                            'Installed in project',
                          )}
                        >
                          P
                        </span>
                      )}
                      {skill.installedScopes.includes('global') && (
                        <span
                          className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-500/10 text-[10px] font-semibold text-sky-700 dark:text-sky-400"
                          title={t(
                            'skillMarketplace.installedForUser',
                            'Installed for user',
                          )}
                        >
                          U
                        </span>
                      )}
                      {/* The installed copy fails validation — shares the row
                          with the scope markers rather than overlapping it. */}
                      {skill.parseError && (
                        <span
                          className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/10 text-[10px] font-semibold text-red-700 dark:text-red-400"
                          title={t('skillsList.parseErrorTooltip', {
                            message: skill.parseError,
                          })}
                        >
                          !
                        </span>
                      )}
                    </div>
                  )}
                  <SkillInstallButton
                    compact
                    installedScopes={skill.installedScopes}
                    installing={isInstalling}
                    workingDirectory={workingDirectory}
                    onWorkingDirectoryChange={onWorkingDirectoryChange}
                    onInstall={(scope, directory) =>
                      handleInstall(skill, scope, directory)
                    }
                    onUninstall={(scope) =>
                      void handleUninstall(skill, scope)
                    }
                  />
                </div>
              </div>
            )
          })}

        {/* Sentinel for infinite scroll */}
        {skills.length < total && (
          <div ref={sentinelRef} className="flex items-center justify-center px-3 py-4 text-sm text-muted-foreground">
            {loadingMore ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('skillMarketplace.loadingMore', 'Loading more...')}
              </div>
            ) : (
              <span className="text-xs">
                {skills.length} / {total}
              </span>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
