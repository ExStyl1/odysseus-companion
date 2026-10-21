/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/ModelChip.tsx
   (craft-agents-oss, Apache-2.0) by UA2.4, 2026-10-02. One adaptation: our `getProviderIcon`
   (lib/provider-icons.ts) returns a mono component OR a URL, not upstream's URL string, so the
   icon draws through `ProviderIconMark` (exported here; TaskTile uses it too). UA2.5 adds
   the gateway fallback (spec §9): a model id the registry does not know — a gateway alias
   such as `coder`, or a rotated gateway id — takes the icon of the session's connection
   (`resolveModelChipIcon`) instead of upstream's Anthropic default; with no connection
   the upstream default stands.
   UB14.60 (R2-16), 2026-10-16 — v0.15.1's chip (changed in v0.15.0): the neutral 20px chip (`bg-fill-hover`, label-sm,
   secondary ink) and the tertiary no-icon dot, drawn by `ProviderIconMark` so the UA2.5 icon resolution stays. */
import { getModelDisplayName, getModelShortName, getModelProvider } from '@config/models'
import { getProviderIcon, type ProviderIcon } from '@/lib/provider-icons'
import { cn } from '@/lib/utils'
import type { KanbanTaskConnection } from './types'

interface ModelChipProps {
  /** Model id, e.g. 'claude-opus-4-7'. */
  model: string
  /** Show the short name ("Haiku") instead of the full display name ("Haiku 4.5"). */
  short?: boolean
  className?: string
  /** UA2.5 — the session's connection; its icon stands in for a model the registry does not know. */
  connection?: KanbanTaskConnection
}

/**
 * UA2.5 — the chip's icon. A registry model keeps upstream's provider icon; an id the
 * registry does not know (a gateway id) uses the connection's own icon, read the way
 * `ConnectionIcon` reads it; with no connection, upstream's `'anthropic'` default.
 */
export function resolveModelChipIcon(model: string, connection?: KanbanTaskConnection): ProviderIcon | null {
  const provider = getModelProvider(model)
  if (provider) return getProviderIcon(provider)
  if (connection) return getProviderIcon(connection.providerType, connection.baseUrl, connection.piAuthProvider)
  return getProviderIcon('anthropic')
}

/**
 * Read-only neutral chip: provider brand icon + model name. Reuses the centralized
 * model registry (`@config/models`) and provider icon map so it can't drift
 * from the real model metadata.
 */
export function ModelChip({ model, short = false, className, connection }: ModelChipProps) {
  const iconUrl = resolveModelChipIcon(model, connection)
  const label = short ? getModelShortName(model) : getModelDisplayName(model)

  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-0 items-center gap-1 rounded-xs bg-fill-hover px-1.5 text-label-sm text-secondary',
        className
      )}
    >
      <ProviderIconMark icon={iconUrl} className="size-3 shrink-0 rounded-[2px]" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}

/**
 * A provider icon as upstream draws it (a 12px mark, or a neutral dot when there is none),
 * for our `ProviderIcon` union: a mono component inherits `currentColor`, a URL is an image.
 */
export function ProviderIconMark({ icon, className }: { icon: ProviderIcon | null; className?: string }) {
  if (!icon) return <span className="size-1.5 shrink-0 rounded-full bg-current text-tertiary" aria-hidden />
  if (icon.kind === 'component') {
    const Mark = icon.Component
    return (
      <span className="inline-flex shrink-0" aria-hidden>
        <Mark className={className} />
      </span>
    )
  }
  return <img src={icon.url} alt="" className={className} aria-hidden />
}
