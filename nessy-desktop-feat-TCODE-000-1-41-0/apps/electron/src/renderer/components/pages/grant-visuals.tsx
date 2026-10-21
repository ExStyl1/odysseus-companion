/**
 * Shared helpers for grant rows (approval dialog + management surfaces):
 * kind icon, human-readable action label, lifecycle status, and the removal
 * hook. Keeping the phrasing in one place means "what was approved" reads
 * identically in the approval prompt and the Approved-actions list.
 *
 * UA9.3 — copied from craft-agents-oss `v0.13.4:apps/electron/src/renderer/components/pages/grant-visuals.tsx`
 * (Apache-2.0), adapted:
 * - The grant is the one the host reads back from the host-approvals ledger (`pages:listGrants`, UA9.2's
 *   `listPageGrants`), never `page.json`'s `grants` (reason (b)); the status reads its two fields structurally.
 * - Removal does not wait for a `pages:changed` round trip to update the list: the ledger is not page.json, so the
 *   caller re-reads the grants after a removal (`onRemoved`). The revoke handler still pushes `pages:changed`, so
 *   every other surface re-reads too.
 * - `describeGrantTarget` (ours) is the host-validated descriptor in full — source, tool, method and path, script path,
 *   runtime, args and the pinned sha256 — the authority the approval dialog shows (spec §15 "Grant requests").
 * - The Share dialog's publish-blocked notice reads these helpers too (UA6.7, `SharePageDialog.tsx`), as upstream.
 */

import * as React from 'react'
import { Globe2, ShieldAlert, TerminalSquare, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { PageActionDescriptor } from '@nessy-agent/shared/pages/types'
import { isPageGrantUsable } from '@nessy-agent/shared/pages/types'
import { relativeTime } from './page-visuals'

type Translate = (key: string, opts?: Record<string, unknown>) => string

export function grantKindIcon(kind: PageActionDescriptor['kind']): LucideIcon {
  if (kind === 'script') return ShieldAlert
  if (kind === 'mcp') return TerminalSquare
  return Globe2
}

/** One phrasing for "what this approval allows", shared by every grant surface. */
export function describeGrantAction(action: PageActionDescriptor, t: Translate): string {
  if (action.kind === 'mcp') {
    return t('pages.grants.mcpAction', { tool: action.toolName, source: action.sourceSlug })
  }
  if (action.kind === 'script') {
    return t('pages.grants.scriptAction', { script: action.script })
  }
  return t('pages.grants.apiAction', {
    method: action.method,
    path: action.pathPattern,
    source: action.sourceSlug,
  })
}

/**
 * The host-validated descriptor as plain fields (ours): what the grant will allow, read from the descriptor the HOST
 * parsed — never from the page's own words. Technical identifiers, so not translated.
 */
export function describeGrantTarget(action: PageActionDescriptor, scriptSha256?: string): string[] {
  if (action.kind === 'mcp') return [`mcp ${action.sourceSlug} · ${action.toolName}`]
  if (action.kind === 'api') return [`api ${action.sourceSlug} · ${action.method} ${action.pathPattern}`]
  const command = [action.runtime ?? 'bun', action.script, ...(action.args ?? [])].join(' ')
  return scriptSha256 ? [`script ${command}`, `sha256 ${scriptSha256}`] : [`script ${command}`]
}

/** Lifecycle status of a persisted grant relative to the page's current content. */
export function describeGrantStatus(
  grant: { contentDigest: string; expiresAt: number },
  contentDigest: string | undefined,
  t: Translate,
): { label: string; usable: boolean } {
  const now = Date.now()
  if (isPageGrantUsable(grant, contentDigest, now)) {
    return { label: t('pages.grants.statusExpires', { when: relativeTime(grant.expiresAt) }), usable: true }
  }
  if (grant.expiresAt <= now) {
    return { label: t('pages.grants.statusExpired'), usable: false }
  }
  return { label: t('pages.grants.statusStale'), usable: false }
}

/**
 * Grant removal with per-row busy state. `onRemoved` lets the caller re-read the ledger's grants at once; the revoke
 * handler's `pages:changed` push re-reads them everywhere else.
 */
export function useGrantRemoval(workspaceId: string, pageSlug: string, onRemoved?: () => void): {
  busyGrantId: string | null
  removeGrant: (grantId: string) => Promise<void>
} {
  const { t } = useTranslation()
  const [busyGrantId, setBusyGrantId] = React.useState<string | null>(null)

  const removeGrant = React.useCallback(async (grantId: string) => {
    setBusyGrantId(grantId)
    try {
      await window.electronAPI.revokePageGrant(workspaceId, pageSlug, grantId)
      onRemoved?.()
    } catch (err) {
      toast.error(t('toast.pageGrantRemoveFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyGrantId(null)
    }
  }, [workspaceId, pageSlug, onRemoved, t])

  return { busyGrantId, removeGrant }
}
