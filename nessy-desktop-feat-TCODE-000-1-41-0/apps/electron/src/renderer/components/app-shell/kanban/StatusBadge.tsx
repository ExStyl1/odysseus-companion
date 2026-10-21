/* Copied verbatim from v0.15.1:apps/electron/src/renderer/components/app-shell/kanban/StatusBadge.tsx
   (craft-agents-oss, Apache-2.0; changed in v0.15.0) by UB14.60 (R2-16), 2026-10-16, over UA2.4's v0.13.4 copy: the
   neutral chip with the status icon in its configured colour; the `live` ping is gone (the tile's Working line carries
   the live state, gated by the same live-pulse preference). */
import { cn } from '@/lib/utils'
import { type SessionStatus, getStatusIconStyle } from '@/config/session-status-config'

interface StatusBadgeProps {
  status: SessionStatus
  className?: string
}

/**
 * Read-only workflow-status chip (design spec §2.4): a neutral chip with the user's status icon in
 * its configured color, plus the label — status is never carried by color alone. Independent from
 * the board column (a `needs-review` badge can sit in the In Progress column).
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-xs bg-fill-hover pl-1 pr-1.5 text-label-sm text-secondary',
        className
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center" style={getStatusIconStyle(status)} aria-hidden>
        {status.icon}
      </span>
      {status.label}
    </span>
  )
}
