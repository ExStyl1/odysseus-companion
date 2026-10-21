import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Webhook } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { EntityIcon } from '@/components/ui/entity-icon'
import { EntityStatusDot } from '@/components/ui/source-avatar'
import { SourceCardRowLines, sourceCardSlots } from '@/components/app-shell/SourceCardBadges'
import { cn } from '@/lib/utils'
import { CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE } from '@nessy-agent/shared/capabilities/views'
import type {
  SafeCapabilityContextRef,
  SafeCapabilityDiagnostic,
  SafeCapabilitySummary,
  SafeGrantTrustRequest,
  SafeProjectCapabilityContextRef,
} from '@nessy-agent/shared/protocol/capabilities'

export interface ProjectHooksPanelProps {
  context: SafeCapabilityContextRef
  className?: string
  onChanged?: () => void
}

export function isProjectHookCapability(item: SafeCapabilitySummary): boolean {
  return item.kind === 'hook'
    && item.origin === 'native'
    && item.scope.kind === 'project'
}

export function projectHookCapabilities(items: readonly SafeCapabilitySummary[]): SafeCapabilitySummary[] {
  return items.filter(isProjectHookCapability)
}

export function isProjectHooksContext(
  context: SafeCapabilityContextRef | undefined,
): context is SafeProjectCapabilityContextRef {
  return Boolean(context && ('sessionId' in context || 'projectHandleId' in context))
}

export function projectHookMutationRequest(
  item: Pick<SafeCapabilitySummary, 'key'>,
  context: SafeCapabilityContextRef,
): SafeGrantTrustRequest {
  return { capabilityKey: item.key, context }
}

type ProjectHooksCatalog = {
  capabilities: SafeCapabilitySummary[]
  diagnostics?: SafeCapabilityDiagnostic[]
}
type ProjectHooksLoadResult =
  | { status: 'ready'; hooks: SafeCapabilitySummary[]; projectionNotice?: true }
  | { status: 'error' }
  | { status: 'stale' }

/**
 * Whether THIS context's runtime under-fills its own hook table (P2.428, the UI
 * half of P2.414's consequence (2)).
 *
 * Read off the catalog's own diagnostics rather than re-derived from a runtime
 * the renderer would have to be told separately: the provider is resolved from
 * the LIVE session server-side (`handlers/rpc/capabilities.ts`'s
 * `resolveSessionProvider` — "a renderer must not be able to choose which
 * runtime the catalog answers for"), so the catalog is the only place this
 * panel can learn it without opening a second, spoofable channel.
 */
export function hasCodexHookProjectionNotice(
  diagnostics: readonly SafeCapabilityDiagnostic[] | undefined,
): boolean {
  return Boolean(diagnostics?.some(d => d.code === CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE))
}

function projectHooksContextKey(context: SafeCapabilityContextRef): string {
  if ('sessionId' in context) return `session:${context.workspaceId}:${context.sessionId}`
  if ('projectHandleId' in context) return `project:${context.workspaceId}:${context.projectHandleId}`
  return `workspace:${context.workspaceId}`
}

export function createProjectHooksLoader(
  getCatalog: (context: SafeCapabilityContextRef) => Promise<ProjectHooksCatalog>,
) {
  let activeContextKey: string | null = null
  let requestEpoch = 0

  return {
    activate(context: SafeCapabilityContextRef) {
      activeContextKey = projectHooksContextKey(context)
      requestEpoch += 1
    },
    invalidate(context: SafeCapabilityContextRef) {
      if (activeContextKey !== projectHooksContextKey(context)) return
      activeContextKey = null
      requestEpoch += 1
    },
    isActive(context: SafeCapabilityContextRef) {
      return activeContextKey === projectHooksContextKey(context)
    },
    async load(context: SafeCapabilityContextRef): Promise<ProjectHooksLoadResult> {
      const contextKey = projectHooksContextKey(context)
      if (activeContextKey !== contextKey) return { status: 'stale' }
      const epoch = ++requestEpoch
      try {
        const catalog = await getCatalog(context)
        if (activeContextKey !== contextKey || requestEpoch !== epoch) return { status: 'stale' }
        return {
          status: 'ready',
          hooks: projectHookCapabilities(catalog.capabilities),
          // Omit-when-absent, matching every other additive field on these
          // payloads: a Pi/claude context's result stays byte-identical.
          ...(hasCodexHookProjectionNotice(catalog.diagnostics) ? { projectionNotice: true as const } : {}),
        }
      } catch {
        return activeContextKey === contextKey && requestEpoch === epoch
          ? { status: 'error' }
          : { status: 'stale' }
      }
    },
  }
}

interface ProjectHookMutationApi {
  grantTrust(request: SafeGrantTrustRequest): Promise<unknown>
  revokeTrust(request: SafeGrantTrustRequest): Promise<unknown>
}

export async function setProjectHookEnabled(
  api: ProjectHookMutationApi,
  hook: SafeCapabilitySummary,
  context: SafeCapabilityContextRef,
  enabled: boolean,
): Promise<void> {
  const request = projectHookMutationRequest(hook, context)
  if (enabled) await api.grantTrust(request)
  else await api.revokeTrust(request)
}

/**
 * One hook row, on the ONE Sources card (owner report 2026-08-01): the
 * status-bearing icon, the name, the `Hook` category and the description. It
 * used to stack the description UNDER the name with no icon and no category,
 * which is exactly the "each subsection has its own style" the owner drove
 * into.
 *
 * UB12.74 — on v0.15.1's row anatomy, like every other Sources row: the
 * category is the title line's meta and the description line 2, both from the
 * card's own slots (`sourceCardSlots`), drawn by `SourceCardRowLines` — the
 * card's copy of `EntityRow`'s two-line column, which `McpServersPanel`'s row
 * draws too. This row is not `EntityRow` because it is not clickable (no row
 * button to hover or select) and it sits in its own bordered list. The switch
 * stays a SIBLING of the row body, and the body's `pr-16` keeps both lines
 * clear of it (the switch is centred across them).
 *
 * The one thing this row keeps that the others do not is the description
 * FALLBACK: a project hook with no description still says so
 * (`sourcesHooks.noDescription`). That is this panel's placeholder-not-hidden
 * rule, and it adds a description where the others would render none — it does
 * not change the shape.
 */
function ProjectHookRow({
  hook,
  enabled,
  pending,
  onSetEnabled,
}: {
  hook: SafeCapabilitySummary
  enabled: boolean
  pending: boolean
  onSetEnabled: (enabled: boolean) => void
}) {
  const { t } = useTranslation()
  const name = hook.displayName ?? hook.logicalName
  const icon = (
    <span className="relative inline-flex shrink-0">
      <EntityIcon size="sm" fallbackIcon={Webhook} icon={{ kind: 'fallback', colorable: false }} alt={name} />
      <EntityStatusDot active={enabled} label={enabled ? 'active' : 'disabled'} />
    </span>
  )
  const card = sourceCardSlots({ kind: 'hook', description: hook.description ?? t('sourcesHooks.noDescription') }, t)
  return (
    <li
      className={cn('relative select-none', !enabled && 'opacity-60')}
      data-testid="project-hook-row"
    >
      <div className="flex w-full items-start py-[9px] px-gutter pr-16 text-left text-label">
        <SourceCardRowLines icon={icon} title={name} {...card} />
      </div>
      <div className="absolute right-4 inset-y-0 flex items-center">
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={onSetEnabled}
          aria-label={t('sourcesHooks.toggleLabel', { name })}
          data-testid="project-hook-toggle"
        />
      </div>
    </li>
  )
}

/**
 * The residual difference this runtime carries, said out loud (P2.414
 * consequence (2), delivered here by P2.428).
 *
 * ## Panel-level, not per-row — and the empty list is what decides it
 *
 * Three things rule out a per-row reason. (1) The sentence is not ABOUT any one
 * hook: every row in this list is user-authored, so a per-row reason repeats
 * one four-clause paragraph verbatim on every row and is read on none. (2) The
 * rows are not unavailable — `resolver.ts` deliberately never gates a hook row
 * on the provider, because every one of these hooks DOES run, host-side, on the
 * events this runtime emits; hanging an explanation off the row would imply the
 * row is degraded. (3) Decisive: the owner's decision says the session must say
 * why "rather than showing an empty list", and a project with no hooks has no
 * row to hang anything on — the case the notice exists for is exactly the one a
 * per-row shape cannot reach.
 *
 * The known cost of panel-level is being missed, and it is paid down by
 * placement rather than by loudness: directly under the panel description,
 * ABOVE the loading/empty/error states and the list, never collapsed, and
 * rendered whether or not this project has hooks.
 */
export function ProjectHooksProjectionNotice() {
  const { t } = useTranslation()
  return (
    <p
      className="flex items-start gap-2 rounded-[8px] border border-foreground/10 bg-muted/40 p-3 text-xs text-muted-foreground"
      data-testid="project-hooks-projection-notice"
    >
      <Info className="mt-[1px] h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{t('sourcesHooks.codexProjectionNotice')}</span>
    </p>
  )
}

export function ProjectHooksList({
  hooks,
  pendingKeys,
  onSetEnabled,
}: {
  hooks: readonly SafeCapabilitySummary[]
  pendingKeys: ReadonlySet<string>
  onSetEnabled: (hook: SafeCapabilitySummary, enabled: boolean) => void
}) {
  if (hooks.length === 0) return null

  return (
    <ul className="divide-y divide-border/30 overflow-hidden rounded-[8px] border border-foreground/10">
      {hooks.map(hook => (
        <ProjectHookRow
          key={hook.key}
          hook={hook}
          enabled={hook.trustState === 'trusted'}
          pending={pendingKeys.has(hook.key)}
          onSetEnabled={next => onSetEnabled(hook, next)}
        />
      ))}
    </ul>
  )
}

export function ProjectHooksPanel({ context, className, onChanged }: ProjectHooksPanelProps) {
  const { t } = useTranslation()
  const [hooks, setHooks] = React.useState<SafeCapabilitySummary[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [projectionNotice, setProjectionNotice] = React.useState(false)
  const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(() => new Set())
  const loader = React.useMemo(
    () => createProjectHooksLoader(nextContext => window.electronAPI.capabilities.getCatalog(nextContext)),
    [],
  )

  const load = React.useCallback(async () => {
    const result = await loader.load(context)
    if (result.status === 'stale') return
    if (result.status === 'ready') {
      setError(null)
      setHooks(result.hooks)
      setProjectionNotice(result.projectionNotice === true)
    } else {
      setHooks([])
      setError(t('sourcesHooks.errorLoad'))
    }
    setIsLoading(false)
  }, [context, loader, t])

  React.useEffect(() => {
    loader.activate(context)
    setHooks([])
    setIsLoading(true)
    setError(null)
    setProjectionNotice(false)
    setPendingKeys(new Set())
    void load()
    return () => loader.invalidate(context)
  }, [context, load, loader])
  React.useEffect(() => window.electronAPI.capabilities.onChanged(() => { void load() }), [load])

  const setEnabled = React.useCallback(async (hook: SafeCapabilitySummary, enabled: boolean) => {
    if (!isProjectHookCapability(hook)) return
    setPendingKeys(current => {
      if (current.has(hook.key)) return current
      const next = new Set(current)
      next.add(hook.key)
      return next
    })
    setError(null)
    try {
      await setProjectHookEnabled(window.electronAPI.capabilities, hook, context, enabled)
      if (!loader.isActive(context)) return
      await load()
      if (loader.isActive(context)) onChanged?.()
    } catch {
      if (loader.isActive(context)) setError(t('sourcesHooks.errorToggle'))
    } finally {
      if (loader.isActive(context)) {
        setPendingKeys(current => {
          const next = new Set(current)
          next.delete(hook.key)
          return next
        })
      }
    }
  }, [context, load, loader, onChanged, t])

  return (
    <div className={cn('space-y-4', className)} data-testid="project-hooks-panel">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Webhook className="h-4 w-4" />
          {t('sourcesHooks.title')}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('sourcesHooks.description')}</p>
      </div>

      {projectionNotice && <ProjectHooksProjectionNotice />}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {!error && isLoading && (
        <p className="text-xs text-muted-foreground">{t('sourcesHooks.loading')}</p>
      )}
      {!error && !isLoading && hooks.length === 0 && (
        <p className="rounded-[8px] border border-foreground/10 p-3 text-xs text-muted-foreground">
          {t('sourcesHooks.empty')}
        </p>
      )}

      <ProjectHooksList
        hooks={hooks}
        pendingKeys={pendingKeys}
        onSetEnabled={(hook, enabled) => void setEnabled(hook, enabled)}
      />
    </div>
  )
}
