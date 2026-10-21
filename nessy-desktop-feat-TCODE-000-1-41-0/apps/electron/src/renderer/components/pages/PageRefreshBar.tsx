/**
 * UA8.3 — a page's scheduled refresh in PageView: its schedule, where its script stands against the host ledger,
 * the review of the script the person approves, and "Run now" for an approved refresh. Ours — upstream v0.13.4 has
 * no approval or run-now surface (spec §15 "Scheduled refresh"): a refresh is INERT until the person approves the
 * digest of the script the host wrote, and the approval names the digest, args and runtime the review showed (the
 * command line `<runtime> <path> <args…>` above the text), so a script or args swapped after the review are refused
 * (`pages:approveRefresh`). Every state is text + icon, never colour only.
 *
 * `PageRefreshStatusView` is the pure half (rendered by the tests); `PageRefreshBar` fetches and acts.
 *
 * UA12.97 — `pages:runRefreshNow` answers `{ started }` while the run continues in the background, so the bar
 * ARMS a running state from the `lastRefresh.at` it observed at the click and keeps "running…" until the same
 * stamp moves: the run's outcome is written to page.json LAST (`recordPageRefresh`) and that write pokes the
 * watcher's `pages:changed` push, which re-renders the bar with the new `config.lastRefresh.at`. Residue: a run
 * that dies before stamping page.json keeps the label until the bar remounts — there is no other completion
 * signal to listen to.
 *
 * UB14.53, 2026-10-17 — onto v0.15.1's material with the rest of PageView (upstream has no refresh bar, so this is
 * ours on its vocabulary, not a port): v0.15.0's page header lost its bottom border, so the bar is an inset row on
 * a `border-subtle` hairline like the auth banner and the refresh-failed alert beside it (`mx-3 mt-2`), text on
 * `text-label-sm`, each state on its role (approved `text-success`, needs approval `text-info` — the needs-you
 * role —, broken `text-destructive`, otherwise `text-tertiary`/`text-secondary`), Review / Run now `secondary` and
 * Approve `primary` `sm` Buttons, and the review in the mono role with the script on a sunken well.
 */

import * as React from 'react'
import { CheckCircle2, Clock, Loader2, Play, ShieldAlert, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { PageConfig } from '@nessy-agent/shared/pages/types'

export type PageRefreshReviewState = 'none' | 'foreign-script' | 'missing' | 'unapproved' | 'changed' | 'approved'

export interface PageRefreshReviewView {
  state: PageRefreshReviewState
  script?: string
  sha256?: string
  content?: string
  truncated?: boolean
  /** The binding an approval records besides the digest (spec §15 item 3): shown in the review, named by Approve. */
  args?: string[]
  runtime?: string
}

export function PageRefreshStatusView({
  refresh,
  status,
  reviewing,
  busy,
  running,
  onToggleReview,
  onApprove,
  onRunNow,
}: {
  refresh: NonNullable<PageConfig['refresh']>
  status: PageRefreshReviewView | null
  reviewing: boolean
  busy: boolean
  /** UA12.97 — a started run is in flight; shown until lastRefresh.at moves (the completion push). */
  running?: boolean
  onToggleReview?: () => void
  onApprove?: () => void
  onRunNow?: () => void
}) {
  const { t } = useTranslation()
  const state = status?.state
  const paused = refresh.enabled === false
  const needsApproval = state === 'unapproved' || state === 'changed'
  const broken = state === 'missing' || state === 'foreign-script'

  let label: string
  let Icon = Clock
  let tone = 'text-tertiary'
  if (paused) label = t('pages.refresh.statePaused')
  else if (running) { label = t('pages.refresh.stateRunning'); Icon = Loader2; tone = 'text-secondary' }
  else if (state === 'approved') { label = t('pages.refresh.stateApproved'); Icon = ShieldCheck; tone = 'text-success' }
  else if (state === 'changed') { label = t('pages.refresh.stateChanged'); Icon = ShieldAlert; tone = 'text-info' }
  else if (state === 'unapproved') { label = t('pages.refresh.stateUnapproved'); Icon = ShieldAlert; tone = 'text-info' }
  else if (broken) { label = t('pages.refresh.stateBroken'); Icon = ShieldAlert; tone = 'text-destructive' }
  else label = t('common.loading')

  return (
    <div className="mx-3 mt-2 rounded-lg border border-subtle px-3 py-1.5 text-label-sm" data-page-refresh-state={paused ? 'paused' : running ? 'running' : (state ?? 'loading')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-secondary">{t('pages.refresh.schedule', { cron: refresh.cron })}</span>
        <span className={cn('inline-flex items-center gap-1 font-medium', tone)}>
          <Icon className={cn('size-3.5', running && !paused && 'animate-spin')} aria-hidden />
          {label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!paused && needsApproval && (
            <Button type="button" variant="secondary" size="sm" onClick={onToggleReview}>
              {reviewing ? t('pages.refresh.hideReview') : t('pages.refresh.review')}
            </Button>
          )}
          {!paused && state === 'approved' && (
            <Button type="button" variant="secondary" size="sm" disabled={busy || running} onClick={onRunNow}>
              <Play className="size-3.5" aria-hidden />
              {t('pages.refresh.runNow')}
            </Button>
          )}
        </div>
      </div>
      {reviewing && needsApproval && status && (
        <div className="mt-2 space-y-1.5">
          <div className="text-secondary">{t('pages.refresh.reviewHint', { script: status.script ?? '' })}</div>
          <div className="font-mono text-mono-ui text-secondary break-all" data-page-refresh-command>
            {[status.runtime ?? 'bun', status.script ?? '', ...(status.args ?? [])].join(' ')}
          </div>
          <div className="font-mono text-mono-ui text-tertiary">sha256 {status.sha256}</div>
          <pre className="max-h-64 overflow-auto rounded-md bg-sunken p-2 font-mono text-mono-ui leading-snug text-foreground">
            {status.content ?? ''}
          </pre>
          {status.truncated && <div className="text-tertiary">{t('pages.refresh.truncated')}</div>}
          <Button type="button" variant="primary" size="sm" disabled={busy} onClick={onApprove}>
            <CheckCircle2 className="size-3.5" aria-hidden />
            {t('pages.refresh.approve')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function PageRefreshBar({ workspaceId, config }: { workspaceId: string; config: PageConfig }) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<PageRefreshReviewView | null>(null)
  const [reviewing, setReviewing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [reload, setReload] = React.useState(0)
  // UA12.97 — the running arm: null = idle; otherwise the `lastRefresh.at` observed at the click (undefined when
  // the page never ran). It stays armed while the observed stamp is UNCHANGED and clears when the run's own
  // completion push brings a different one (see the module header). Never persisted: a remount starts idle.
  const [armedAt, setArmedAt] = React.useState<number | null | undefined>(null)
  const refresh = config.refresh
  const lastRefreshAt = config.lastRefresh?.at
  const running = armedAt !== null && (lastRefreshAt ?? undefined) === armedAt

  // Re-read whenever page.json is stamped (a new script, a run finishing) or after an approval.
  React.useEffect(() => {
    if (!refresh) return
    let stale = false
    window.electronAPI
      .getPageRefreshStatus(workspaceId, config.slug)
      .then(next => { if (!stale) setStatus(next) })
      .catch(() => { if (!stale) setStatus(null) })
    return () => { stale = true }
  }, [workspaceId, config.slug, config.updatedAt, refresh, reload])

  const approve = React.useCallback(async () => {
    if (!status?.sha256) return
    setBusy(true)
    try {
      await window.electronAPI.approvePageRefresh(workspaceId, config.slug, status.sha256, { args: status.args ?? [], runtime: status.runtime ?? 'bun' })
      toast.success(t('pages.refresh.approved'))
      setReviewing(false)
    } catch (err) {
      toast.error(t('pages.refresh.approveFailed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      setReload(n => n + 1)
    }
  }, [workspaceId, config.slug, status, t])

  const runNow = React.useCallback(async () => {
    const atBefore = lastRefreshAt
    setBusy(true)
    try {
      const result = await window.electronAPI.runPageRefreshNow(workspaceId, config.slug)
      if (result.started) {
        setArmedAt(atBefore ?? undefined)
        toast.success(t('pages.refresh.runStarted'))
      } else {
        toast.error(t('pages.refresh.runRefused'), { description: result.error })
      }
    } catch (err) {
      toast.error(t('pages.refresh.runRefused'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [workspaceId, config.slug, lastRefreshAt, t])

  if (!refresh) return null
  return (
    <PageRefreshStatusView
      refresh={refresh}
      status={status}
      reviewing={reviewing}
      busy={busy}
      running={running}
      onToggleReview={() => setReviewing(open => !open)}
      onApprove={() => void approve()}
      onRunNow={() => void runNow()}
    />
  )
}
