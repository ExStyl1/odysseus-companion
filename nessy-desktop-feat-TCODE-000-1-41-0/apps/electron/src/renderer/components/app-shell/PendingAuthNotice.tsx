/**
 * The session-start pending-auth notice (T4, plugin-install plan § 5).
 *
 * Claude's surfacing model ("a startup notice when servers need
 * authentication"), ours to build: a non-blocking card listing every server
 * in the workspace still awaiting auth — the silently-dropped dp set, sources
 * awaiting OAuth/bearer sign-in, credential-parked capability servers — plus
 * servers whose session-start connect failed (T10).
 *
 * Every sign-in here is NON-INTERRUPTING: the dp row runs the one-click
 * system flow (`ensureGatewayAuth` + a value-only probe), source rows run
 * `performOAuth` directly. Neither touches `interruptForHandoff`; the mid-turn
 * card remains only as the mid-task fallback.
 *
 * WHERE IT MOUNTS (W1, owner decision 2026-08-01 — "вижу это сверху а не в
 * самом чате в виде карточки"). It used to be mounted by `MainContentPanel`'s
 * `wrapWithStoplight`, i.e. as a full-bleed strip above EVERY view, stacked
 * with `SafeModeBanner` and `GatewayAuthBanner`. That is the third time the
 * same shape was rejected (Sources → MCPs lost its strip, a plugin page lost
 * its duplicate Connect), and the settled principle is: sign-in belongs ON the
 * thing that needs it, and in a chat that means IN the conversation.
 *
 * So the ONLY mount is now `ChatDisplay`, in the session's system-card stack —
 * the same place, the same chat width and the same card body as
 * `TaskChecklistPanel` and `AgentPanel`. The MCP-view exclusion this module
 * used to carry (`isMcpServersNavigation` / `PendingAuthNoticeForView`) is
 * gone because it is now unnecessary BY CONSTRUCTION: no view outside the chat
 * renders this component at all.
 *
 * Positive control: with dp ready and every source authed the summary is
 * empty and NOTHING renders.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
// The same look the session panel's own close carries, so the two X buttons a
// user sees on one screen read as one control rather than two that merely do
// the same thing. The style, not the component: importing
// `PanelHeaderCenterButton` here pulls the whole `@nessy-agent/ui` barrel into
// this file's test and took its suite from 12 pass to a load error.
import { PANEL_HEADER_BUTTON_CLASS } from '@/components/ui/panel-header-button-style.ts'
import { SystemCard } from '@/components/ui/system-card'
import type { SafeWorkspacePendingAuth } from '@nessy-agent/shared/protocol'

/**
 * The capability subscription the notice mounts, exported so it can be tested
 * directly: the repo has no renderHook/DOM lib, so a renderer hook's
 * load-bearing logic is exported pure (the established pattern — see
 * `hooks/__tests__/usePluginEnablement.test.ts`).
 *
 * Without it the notice never refetches: `refresh` is keyed on `workspaceId`
 * and the mount effect on `activeSessionId`, and neither changes when a plugin
 * with an OAuth server is installed — so the Connect button, the only sign-in
 * affordance we ship, appeared only after a session switch or a restart.
 * `ProjectHooksPanel`/`SourceInfoPage`/`SkillInfoPage` already use this exact
 * one-liner; the notice was the outlier.
 */
export function subscribePendingAuthRefresh(
  workspaceId: string | null,
  refresh: () => void | Promise<void>,
): () => void {
  return window.electronAPI.capabilities.onChanged((event) => {
    if (event.workspaceId === workspaceId) void refresh()
  })
}

/** True when there is nothing to show — the notice must render null. */
export function isPendingAuthNoticeEmpty(summary: SafeWorkspacePendingAuth | null | undefined): boolean {
  if (!summary) return true
  return !summary.dp
    && summary.sources.length === 0
    && summary.failedServers.length === 0
    // P6.256 — an advance warning alone raises the notice. Without this the
    // summary would carry the one row it exists to deliver and the component
    // would return `null`, which is the shape of the defect the row closes.
    && (summary.expiringSoon?.length ?? 0) === 0
}

export type PendingAuthRowState = 'pending' | 'busy' | 'error'

export interface PendingAuthNoticeViewProps {
  summary: SafeWorkspacePendingAuth
  dpState: PendingAuthRowState
  /** Slug of the source whose sign-in is currently running, if any. */
  busySourceSlug: string | null
  errorSourceSlug: string | null
  onDpSignIn: () => void
  onSourceSignIn: (sourceSlug: string) => void
  onDismiss: () => void
}

/**
 * The pure, portal-free view — what tests and the playground render. The
 * data-fetching wrapper below owns the RPC and the action plumbing.
 */
export function PendingAuthNoticeView({
  summary,
  dpState,
  busySourceSlug,
  errorSourceSlug,
  onDpSignIn,
  onSourceSignIn,
  onDismiss,
}: PendingAuthNoticeViewProps) {
  const { t } = useTranslation()
  if (isPendingAuthNoticeEmpty(summary)) return null

  const sourceLabel = (row: SafeWorkspacePendingAuth['sources'][number]): string => {
    switch (row.reason) {
      case 'credential-missing':
        return t('pendingAuth.sourceCredentialMissing', { name: row.name })
      case 'credential-expired':
        return t('pendingAuth.sourceCredentialExpired', { name: row.name })
      default:
        return t('pendingAuth.sourceNeedsAuth', { name: row.name })
    }
  }

  return (
    <SystemCard
      className="select-none"
      data-testid="pending-auth-notice"
      title={t('pendingAuth.title')}
      titleClassName="text-foreground"
      // C3.245 — this card now lives inside the bounded, scrolling
      // `ChatNoticeRegion`. Its rows are one per pending source and a workspace
      // with many of them scrolls; the dismiss `x` and the title must not
      // scroll away with them.
      stickyHeader
      meta={
        <button
          type="button"
          className={PANEL_HEADER_BUTTON_CLASS}
          onClick={onDismiss}
          aria-label={t('pendingAuth.dismiss')}
        >
          <X className="h-4 w-4" />
        </button>
      }
    >
      <ul className="space-y-1 text-muted-foreground">
        {summary.dp && (
          <li className="flex items-center justify-between gap-3" data-testid="pending-auth-dp">
            <span className="min-w-0 truncate">
              {t('pendingAuth.dpRow', { count: summary.dp.serverNames.length })}
              {dpState === 'error' && (
                <span className="ml-2 text-destructive">{t('pendingAuth.error')}</span>
              )}
            </span>
            <Button size="sm" disabled={dpState === 'busy'} onClick={onDpSignIn}>
              {dpState === 'busy' ? t('pendingAuth.dpSigningIn') : t('pendingAuth.dpSignIn')}
            </Button>
          </li>
        )}
        {summary.sources.map(row => (
          <li
            key={row.sourceSlug}
            className="flex items-center justify-between gap-3"
            data-testid={`pending-auth-source-${row.sourceSlug}`}
          >
            <span className="min-w-0 truncate">
              {sourceLabel(row)}
              {errorSourceSlug === row.sourceSlug && (
                <span className="ml-2 text-destructive">{t('pendingAuth.error')}</span>
              )}
            </span>
            {row.canSignIn && (
              <Button
                size="sm"
                variant="outline"
                disabled={busySourceSlug === row.sourceSlug}
                onClick={() => onSourceSignIn(row.sourceSlug)}
              >
                {busySourceSlug === row.sourceSlug
                  ? t('pendingAuth.connecting')
                  : t('pendingAuth.connect')}
              </Button>
            )}
          </li>
        ))}
        {/*
          P6.256 — the ADVANCE warning, and the only row here that fires while
          the session still works. It sits AFTER the actionable rows on purpose:
          "sign in now" outranks "sign in this week", and a warning printed above
          a refusal reads as the smaller problem being the urgent one.

          No Connect button. The credential still works, so a sign-in offered
          here would look like the source were broken; the sentence names the
          renewal and the user reaches it from the source's own page — the same
          route `credential-missing` already sends them down.
        */}
        {(summary.expiringSoon ?? []).map(row => (
          <li key={`expiring-${row.sourceSlug}`} data-testid={`pending-auth-expiring-${row.sourceSlug}`}>
            {t('pendingAuth.expiringSoon', { name: row.name, count: row.daysLeft })}
          </li>
        ))}
        {summary.failedServers.length > 0 && (
          <li data-testid="pending-auth-failed">
            {t('pendingAuth.failedServers', { names: summary.failedServers.join(', ') })}
          </li>
        )}
        {summary.failedServers.length > 0 && summary.dpOutdated && (
          <li data-testid="pending-auth-dp-outdated">
            {t('pendingAuth.dpOutdated')}
          </li>
        )}
      </ul>
    </SystemCard>
  )
}

/**
 * Data-fetching wrapper: loads the summary when the workspace (or active
 * session) changes and re-loads after each completed sign-in. Dismissal is
 * per workspace and per fetch — a later change that adds NEW pending auth
 * shows the notice again on the next session open.
 */
export function PendingAuthNotice({
  workspaceId,
  activeSessionId,
}: {
  workspaceId: string | null
  activeSessionId?: string | null
}) {
  const [summary, setSummary] = useState<SafeWorkspacePendingAuth | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [dpState, setDpState] = useState<PendingAuthRowState>('pending')
  const [busySourceSlug, setBusySourceSlug] = useState<string | null>(null)
  const [errorSourceSlug, setErrorSourceSlug] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setSummary(null)
      return
    }
    try {
      const next = await window.electronAPI.getWorkspacePendingAuth?.(workspaceId)
      setSummary(next ?? null)
    } catch {
      // Fail-soft: a transport hiccup must not paint an error banner.
      setSummary(null)
    }
  }, [workspaceId])

  useEffect(() => {
    setDismissed(false)
    setDpState('pending')
    setErrorSourceSlug(null)
    void refresh()
  }, [refresh, activeSessionId])

  // Installing a plugin changes the pending-auth set without changing either
  // dependency above, so the summary has to be re-asked for on the capability
  // change itself.
  useEffect(
    () => subscribePendingAuthRefresh(workspaceId, refresh),
    [refresh, workspaceId],
  )

  const signInDp = useCallback(async () => {
    setDpState('busy')
    try {
      const result = await window.electronAPI.ensureGatewayAuth?.()
      if (!result?.ok) {
        setDpState('error')
        return
      }
      // The probe's server-side publish restores the dp-backed servers; the
      // refetch then shows the shrunken (or empty) notice.
      await window.electronAPI.probeDpSession?.()
      setDpState('pending')
      await refresh()
    } catch {
      setDpState('error')
    }
  }, [refresh])

  const signInSource = useCallback(async (sourceSlug: string) => {
    if (!workspaceId) return
    setBusySourceSlug(sourceSlug)
    setErrorSourceSlug(null)
    try {
      // C6 (capability-path): a plugin-server row signs into its GLOBAL plugin
      // credential slot; the target rides `performOAuth` unchanged otherwise.
      const pluginServer = summary?.sources.find(row => row.sourceSlug === sourceSlug)?.pluginServer
      const result = await window.electronAPI.performOAuth({
        workspaceId,
        sourceSlug,
        ...(pluginServer ? { pluginServer } : {}),
      })
      if (!result.success) {
        setErrorSourceSlug(sourceSlug)
        return
      }
      await refresh()
    } catch {
      setErrorSourceSlug(sourceSlug)
    } finally {
      setBusySourceSlug(null)
    }
  }, [refresh, summary, workspaceId])

  if (dismissed || !summary || isPendingAuthNoticeEmpty(summary)) return null

  return (
    <PendingAuthNoticeView
      summary={summary}
      dpState={dpState}
      busySourceSlug={busySourceSlug}
      errorSourceSlug={errorSourceSlug}
      onDpSignIn={() => { void signInDp() }}
      onSourceSignIn={slug => { void signInSource(slug) }}
      onDismiss={() => setDismissed(true)}
    />
  )
}

/**
 * Every OTHER surface keeps its own sign-in, which is why this component can be
 * chat-only without losing an affordance:
 *
 * - Sources → MCPs and a plugin's page: `PluginServerConnectButton` on the
 *   server's own row (`McpServersPanel`) — the reason the strip was removed
 *   there first.
 * - The Nessy Gateway / dp login: `GatewayAuthBanner`, still mounted by
 *   `MainContentPanel` on its own `login-required` trigger.
 *
 * `isMcpServersNavigation` and `PendingAuthNoticeForView` used to live here to
 * keep the strip off the MCP view. Both are deleted: with the shell mount gone
 * there is no view to exclude.
 */
