/**
 * Trusted-chrome reconnect banner: when a source this page holds grants on
 * needs authentication, offer the fix right here instead of a dead button.
 *
 * Strictly state-driven — rows derive from the workspace's source summaries
 * (`capabilitySummaryConnectionStatus`), never from anything the sandboxed page
 * says, so a page cannot trigger, spoof, or spam an auth prompt. Rows clear
 * automatically when reauthentication lands (the sources push → props).
 *
 * UA9.3 — copied from craft-agents-oss `v0.13.4:apps/electron/src/renderer/components/pages/PageSourceAuthBanner.tsx`
 * (Apache-2.0), adapted (spec §15 "`PageSourceAuthBanner`", manifest G12):
 * - **The OAuth path is upstream's:** "Reconnect" runs `window.electronAPI.performOAuth` inline for the source.
 *   Upstream picked it from the source config's `authType`; our renderer's source rows are path-free summaries that
 *   carry no auth type, so the row offers it exactly when the host's pending-auth summary says the one-click flow
 *   applies (`canSignIn`, with the plugin-server target of a connector source) — the same gate and the same
 *   `performOAuth` argument as the chat's `PendingAuthNotice`. A failed flow says so on the row
 *   (`pendingAuth.error`), a running one shows `pendingAuth.connecting` (the notice's own strings).
 * - **No credential input.** Upstream's inline `ReconnectCredentialDialog` (a password field saved through
 *   `sources:saveCredentials`) is dropped under reason (b): nothing on this surface takes a secret. A key or a
 *   multi-field credential goes to the agent hand-off ("Reconnect in chat": a new session with upstream's prompt),
 *   which upstream already used for its multi-field case and which is offered on every row.
 * - **No Sources route.** UA9.3 first sent "Reconnect" to `routes.view.sources`, which takes a capability KEY (a bare
 *   source name lands on "failed to load"), and whose detail page has no reconnect for a workspace source — so it is
 *   not a fallback here (UA9.3 follow-up, 2026-10-02).
 * - The granted sources come from the host-approvals ledger's grants (`pages:listGrants`, passed in by PageView),
 *   never from `page.json` (reason (b)).
 *
 * UB14.53, 2026-10-17 — v0.15.1's material (the v0.15.0 container/Button hunks of the same file): the needs-you
 * banner on the info tint with its `--info-border` hairline, the row text `text-label` in the foreground, and ONE
 * primary action per source. Upstream's row has one button whose label follows the source's flavor; ours has the
 * inline Reconnect only where the host's one-click flow applies, so that one is the primary and "Reconnect in chat"
 * the secondary beside it — and where it is the row's only action, "Reconnect in chat" is the primary, as upstream's
 * agent-flavor button is.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { capabilitySummaryConnectionStatus } from '@/components/ui/source-status-indicator'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import type { PageActionDescriptor } from '@nessy-agent/shared/pages/types'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { SafeWorkspacePendingAuth } from '@nessy-agent/shared/protocol'

interface PageSourceAuthBannerProps {
  workspaceId: string
  /** The page's grants as the host read them from the ledger (stale ones included — the page will re-request). */
  grants: ReadonlyArray<{ action: PageActionDescriptor }>
  /** Live workspace sources (AppShellContext.enabledSources — actually ALL sources) */
  sources: readonly SafeCapabilitySummary[]
  className?: string
}

/** One source the host's one-click OAuth flow can sign in, as the pending-auth summary names it. */
export interface PageSourceSignInTarget {
  sourceSlug: string
  pluginServer?: { pluginKey: string; serverName: string }
}

/** Sources this page's grants depend on (stale grants included — the page will re-request them). */
export function grantedSourceSlugs(grants: ReadonlyArray<{ action: PageActionDescriptor }>): Set<string> {
  const slugs = new Set<string>()
  for (const grant of grants) {
    if (grant.action.kind === 'api' || grant.action.kind === 'mcp') {
      slugs.add(grant.action.sourceSlug)
    }
  }
  return slugs
}

/** The granted sources that need authentication now (a disabled source is the user's choice, not an auth problem). */
export function sourcesNeedingReconnect(
  grants: ReadonlyArray<{ action: PageActionDescriptor }>,
  sources: readonly SafeCapabilitySummary[],
): SafeCapabilitySummary[] {
  const granted = grantedSourceSlugs(grants)
  if (granted.size === 0) return []
  return sources.filter(
    source =>
      source.kind === 'source' &&
      granted.has(source.logicalName) &&
      source.state !== 'disabled' &&
      capabilitySummaryConnectionStatus(source) === 'needs_auth',
  )
}

/** The sources "Reconnect" can sign in inline, by slug: the host's `canSignIn` rows, nothing else. */
export function pageSourceSignInTargets(
  summary: SafeWorkspacePendingAuth | null | undefined,
): Map<string, PageSourceSignInTarget> {
  const targets = new Map<string, PageSourceSignInTarget>()
  for (const row of summary?.sources ?? []) {
    if (!row.canSignIn) continue
    targets.set(row.sourceSlug, {
      sourceSlug: row.sourceSlug,
      ...(row.pluginServer ? { pluginServer: row.pluginServer } : {}),
    })
  }
  return targets
}

/** Exactly the `performOAuth` argument "Reconnect" sends (the same shape `PendingAuthNotice` sends). */
export function pageSourceOAuthRequest(workspaceId: string, target: PageSourceSignInTarget) {
  return {
    workspaceId,
    sourceSlug: target.sourceSlug,
    ...(target.pluginServer ? { pluginServer: target.pluginServer } : {}),
  }
}

export function PageSourceAuthBanner({ workspaceId, grants, sources, className }: PageSourceAuthBannerProps) {
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const needing = React.useMemo(() => sourcesNeedingReconnect(grants, sources), [grants, sources])
  const needingKey = needing.map(source => source.logicalName).join('\n')
  const [pendingAuth, setPendingAuth] = React.useState<SafeWorkspacePendingAuth | null>(null)
  const [busySlug, setBusySlug] = React.useState<string | null>(null)
  const [errorSlug, setErrorSlug] = React.useState<string | null>(null)

  // Ask the host which rows its OAuth flow can sign in, whenever the set of rows changes. Fail-soft: no answer
  // leaves every row with the chat hand-off only.
  React.useEffect(() => {
    if (!needingKey) {
      setPendingAuth(null)
      return
    }
    let live = true
    Promise.resolve(window.electronAPI.getWorkspacePendingAuth?.(workspaceId)).then(
      next => { if (live) setPendingAuth(next ?? null) },
      () => { if (live) setPendingAuth(null) },
    )
    return () => { live = false }
  }, [workspaceId, needingKey])

  const signInTargets = React.useMemo(() => pageSourceSignInTargets(pendingAuth), [pendingAuth])

  const handleReconnect = React.useCallback(async (source: SafeCapabilitySummary) => {
    const target = signInTargets.get(source.logicalName)
    if (!target) return
    setBusySlug(source.logicalName)
    setErrorSlug(null)
    try {
      const result = await window.electronAPI.performOAuth(pageSourceOAuthRequest(workspaceId, target))
      if (!result.success) setErrorSlug(source.logicalName)
    } catch {
      setErrorSlug(source.logicalName)
    } finally {
      setBusySlug(null)
    }
  }, [signInTargets, workspaceId])

  const handleFixWithAgent = React.useCallback((source: SafeCapabilitySummary) => {
    navigate(routes.action.newSession({
      input: t('pages.auth.fixWithAgentPrompt', { name: source.displayName ?? source.logicalName }),
    }))
  }, [navigate, t])

  return (
    <PageSourceAuthBannerView
      needing={needing}
      signInTargets={signInTargets}
      busySlug={busySlug}
      errorSlug={errorSlug}
      onReconnect={source => { void handleReconnect(source) }}
      onFixWithAgent={handleFixWithAgent}
      t={t}
      className={className}
    />
  )
}

/** The banner's rows; hook-free, so `bun test` (no DOM) renders it and drives its buttons with plain handlers. */
export function PageSourceAuthBannerView({
  needing,
  signInTargets,
  busySlug,
  errorSlug,
  onReconnect,
  onFixWithAgent,
  t,
  className,
}: {
  needing: readonly SafeCapabilitySummary[]
  /** Rows "Reconnect" can sign in inline ({@link pageSourceSignInTargets}); every other row gets the chat hand-off only. */
  signInTargets: ReadonlyMap<string, PageSourceSignInTarget>
  busySlug: string | null
  errorSlug: string | null
  onReconnect: (source: SafeCapabilitySummary) => void
  onFixWithAgent: (source: SafeCapabilitySummary) => void
  t: (key: string, opts?: Record<string, unknown>) => string
  className?: string
}) {
  if (needing.length === 0) return null

  return (
    // Needs-you banner: info tint + hairline in the info role (amber), one primary action per source
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-[color:var(--info-border)] bg-info-tint px-3 py-2.5',
        className,
      )}
    >
      {needing.map(source => {
        const name = source.displayName ?? source.logicalName
        const busy = busySlug === source.logicalName
        const canSignIn = signInTargets.has(source.logicalName)
        return (
          <div key={source.logicalName} data-reconnect-source={source.logicalName} className="flex items-center gap-2.5">
            <SourceAvatar source={source} size="sm" />
            <span className="min-w-0 flex-1 text-label text-foreground">
              {t('pages.auth.sourceNeedsReconnect', { name })}
            </span>
            {errorSlug === source.logicalName && (
              <span className="shrink-0 text-label-sm text-destructive">{t('pendingAuth.error')}</span>
            )}
            <Button variant={canSignIn ? 'secondary' : 'primary'} size="sm" className="shrink-0" onClick={() => onFixWithAgent(source)}>
              {t('pages.auth.fixWithAgent')}
            </Button>
            {canSignIn && (
              <Button
                variant="primary"
                size="sm"
                className="shrink-0"
                disabled={busySlug !== null}
                onClick={() => onReconnect(source)}
              >
                {busy ? t('pendingAuth.connecting') : t('pages.auth.reconnect')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
