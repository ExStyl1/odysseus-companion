/**
 * Source: OUR file at HEAD (UB13.13 Keep — the SafeCapabilitySummary input and the five-status
 * pip, P6.745/P6.769) + upstream v0.15.1's BRAND_TILE_CLASS only (the row's stated merge: the
 * upstream rewrite of this file rides its LoadedSource/icon-cache model, which is not ours).
 */

import * as React from 'react'
import { Globe, HardDrive, Mail, Plug } from 'lucide-react'
import { EntityIcon, type IconComponent } from '@/components/ui/entity-icon'
import { McpIcon } from '@/components/icons/McpIcon'
import {
  SourceStatusIndicator,
  capabilitySummaryDisplayStatus,
} from '@/components/ui/source-status-indicator'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { IconSize, ResolvedEntityIcon } from '@nessy-agent/shared/icons'
import { cn } from '@/lib/utils'

export type SourceType = 'mcp' | 'api' | 'gmail' | 'local'

/**
 * Upstream v0.15.1's brand-tile treatment (UB13.13, `BRAND_TILE_CLASS`): a real logo sits in a
 * hairline-ringed tile so white-on-white logos stay visible on every surface.
 */
const BRAND_TILE_CLASS = 'rounded-xs ring-1 ring-[var(--border-strong)]'

interface SourceAvatarProps {
  source: SafeCapabilitySummary
  size?: IconSize
  fluid?: boolean
  showStatus?: boolean
  /**
   * P6.769 — the workspace's "Enable stdio subprocess servers" setting, for the
   * one `local_disabled` verdict the summary alone cannot reach.
   *
   * Optional and defaulting to `true`: most callers legitimately do not know it,
   * and telling them a server is off on the strength of not knowing would be a
   * worse answer than the one they had. Only a surface that actually holds the
   * setting passes it — today that is `SourcesListPanel`, which receives it from
   * `AppShell`.
   */
  localMcpEnabled?: boolean
  className?: string
}

const SOURCE_FALLBACKS: Record<string, IconComponent> = {
  mcp: McpIcon,
  api: Globe,
  gmail: Mail,
  local: HardDrive,
}

export function getSourceFallbackIcon(type: SourceType): IconComponent {
  return SOURCE_FALLBACKS[type] ?? Plug
}

/**
 * The BOOLEAN status pip, for rows that genuinely have two states.
 *
 * Exported so the MCP subsection and the project-hooks panel — whose rows are
 * `McpServerRow`s and hook entries, not capability summaries, and therefore
 * cannot go through `SourceAvatar` — wear the SAME pip rather than a second one
 * that drifts. Both of those pass a literal `enabled` boolean, which is all
 * their row knows.
 *
 * **P6.745 moved `SourceAvatar` off this and onto
 * {@link SourceStatusIndicator}.** A capability summary knows more than on/off:
 * it carries `state` and `credentialState`, and collapsing them to
 * `state === 'active'` made a source AWAITING AUTHORISATION look identical to
 * one that is switched off — the surface the needs-auth card had no permanent
 * home on. It also passed the raw state string as the accessible name, so a
 * screen reader read untranslated English.
 */
export function EntityStatusDot({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      aria-label={label}
      className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-background ${active ? 'bg-success' : 'bg-muted-foreground'}`}
    />
  )
}

export function SourceAvatar({ source, size = 'md', fluid, showStatus, localMcpEnabled = true, className }: SourceAvatarProps) {
  const sourceType = source.kind === 'mcp' ? 'mcp' : (source.sourceType ?? 'api')
  const FallbackIcon = SOURCE_FALLBACKS[sourceType] ?? Plug
  const icon: ResolvedEntityIcon = source.iconUrl
    ? { kind: 'file', value: source.iconUrl, colorable: false }
    : { kind: 'fallback', colorable: false }

  return (
    <span className={showStatus ? 'relative inline-flex shrink-0' : undefined}>
      <EntityIcon
        icon={icon}
        size={size}
        fallbackIcon={FallbackIcon}
        alt={source.logicalName}
        className={cn(BRAND_TILE_CLASS, className)}
        containerClassName={fluid ? 'h-full w-full' : undefined}
      />
      {showStatus && (
        // P6.745 — the five-status vocabulary, in the pip's position. `ring`
        // rather than `border` because the ring sits OUTSIDE the dot, so the
        // separation from the icon behind it is identical to the boolean pip's
        // while the dot keeps the size the indicator's own scale gives it.
        // UB14.48 — the stored reason rides the `failed` tooltip (the indicator shows it only
        // for that status), so a failed test's WHY is on the list row as upstream v0.15.1's
        // `source-avatar.tsx` puts `config.connectionError` there.
        // UB12.87 — the DISPLAY status (the verdict plus UB12.75's `disabled`), the one the
        // Sources list's line 2 and the detail pill print, so a source the user switched off
        // is "Disabled" in the pip's tooltip and accessible name too, not "Not Tested".
        <SourceStatusIndicator
          status={capabilitySummaryDisplayStatus(source, localMcpEnabled)}
          errorMessage={source.connectionError}
          size="sm"
          pulse={false}
          className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-background"
        />
      )}
    </span>
  )
}
