/**
 * Share dialog: publish / republish / unpublish a page on the internal artifact service (t-artifacts).
 *
 * UA6.7 — copied from craft-agents-oss `v0.13.4:apps/electron/src/renderer/components/pages/SharePageDialog.tsx`
 * (Apache-2.0), adapted to t-artifacts (OQ-18, resolved 2026-09-23):
 * - dropped (reason (a), the Craft share service): `usePageShareCapabilities` and its feature flag (nothing is gated,
 *   spec §6), the password fields and `setPagePublicationPassword` (the service has no passwords), the
 *   `disabledNote` and `lastPublishError` rows (there is no flag and no stored error).
 * - kept: the include-data switch with the secret-looking-keys warning, the script-approval block with inline
 *   removal, the view-only acknowledgment, the content-drift line with "Publish latest", the link with Copy, the
 *   two-step Unpublish, and the toasts.
 * - ours — the CARD: before anything is sent the dialog shows the host's review of exactly the bytes a publish would
 *   send (`pages:getShareDataScan` → `ArtifactPublishDetails`, the very component the session's publish card uses:
 *   the access line, the owner, the absolute expiry, size and sha256, the scan sentence, the scripts and external
 *   hosts, a script-free preview and the first source lines). Publish sends the card's sha256 back; the host refuses
 *   bytes that moved since (`pages:publish`). A review that refuses shows its sentence instead and Publish stays off.
 * - ours — the state comes from `LoadedPage.publication` (the artifact registry) and the ledger's grants
 *   (`pages:listGrants`), never `config.share` / `config.grants` (`share-page-state.ts`).
 *
 * UB14.53, 2026-10-17 — v0.15.1's material on the rows we share with upstream (the v0.15.0 Input/Button and text-role
 * hunks of the same file; none of its password hunks, which we have no rows for): labels `text-label font-medium`,
 * hints on `text-label-sm` tertiary/secondary, every warning in the info role (`text-info`; the ack row on the info
 * tint with its `--info-border` hairline), the link in the mono role with Copy a `lg` secondary beside it, the drift
 * row on a `border-subtle` hairline with Publish latest primary when the page moved, the script block on the
 * destructive tint with its rows on the floating surface, Cancel ghost / Publish primary, and the two-step
 * Unpublish: `danger` to arm, `danger-solid` to confirm. Ours on the same roles: the expiry line, the deletion-pending
 * line and the reviewing line.
 */
import * as React from 'react'
import { AlertTriangle, Check, Copy, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
// The component file, not the `@/components/info` barrel: the barrel reaches `@nessy-agent/ui`, which bun cannot load.
import { Info_Alert } from '@/components/info/Info_Alert'
import { ArtifactPublishDetails } from '@/components/app-shell/input/structured/ArtifactPublishDetails'
import { artifactExpiryLabel } from '@/components/app-shell/input/structured/artifact-publish-card'
import type { LoadedPage, PageActionGrant } from '@nessy-agent/shared/pages'
import type { PageShareReview } from '@nessy-agent/shared/pages/types'
import { describeGrantAction, useGrantRemoval } from './grant-visuals'
import { secretKeysPreview, sharePageState, sharePublishBlocked } from './share-page-state'

interface SharePageDialogProps {
  workspaceId: string
  page: LoadedPage
  /** The page's grants from the host-approvals ledger (PageView reads them). */
  grants: PageActionGrant[]
  /** Whether a data snapshot exists on disk (enables the include-data option) */
  hasSnapshot: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After a grant removal, so PageView re-reads the ledger at once. */
  onGrantsChanged?: () => void
}

type BusyAction = 'publish' | 'unpublish' | null

export function SharePageDialog({
  workspaceId,
  page,
  grants,
  hasSnapshot,
  open,
  onOpenChange,
  onGrantsChanged,
}: SharePageDialogProps) {
  const { t, i18n } = useTranslation()
  const { config, publication } = page
  const state = sharePageState(page, grants, hasSnapshot)
  const { busyGrantId, removeGrant } = useGrantRemoval(workspaceId, config.slug, onGrantsChanged)

  const [busy, setBusy] = React.useState<BusyAction>(null)
  const [includeData, setIncludeData] = React.useState(false)
  const [ackViewOnly, setAckViewOnly] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [confirmingUnpublish, setConfirmingUnpublish] = React.useState(false)
  const [review, setReview] = React.useState<PageShareReview | null>(null)
  const [reviewRound, setReviewRound] = React.useState(0)

  // Reset transient state whenever the dialog (re)opens or the target changes.
  React.useEffect(() => {
    if (!open) return
    setBusy(null)
    setIncludeData(publication?.includesData ?? false)
    setAckViewOnly(false)
    setCopied(false)
    setConfirmingUnpublish(false)
  }, [open, config.slug, publication?.includesData])

  // The review: the host's card for exactly the bytes a publish with these options would send (nothing is sent).
  // Re-read when the options change, the content changes, a grant goes, or a publish attempt needs a fresh one.
  const includeDataSent = includeData && state.offerIncludeData
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setReview(null)
    window.electronAPI
      .getPageShareDataScan(workspaceId, config.slug, { includeData: includeDataSent, viewOnlyAcknowledged: ackViewOnly })
      .then(next => { if (!cancelled) setReview(next) })
      .catch(err => {
        if (!cancelled) {
          setReview({ snapshotBytes: null, secretCandidates: [], review: { ok: false, message: err instanceof Error ? err.message : String(err) } })
        }
      })
    return () => { cancelled = true }
  }, [open, workspaceId, config.slug, config.contentDigest, includeDataSent, ackViewOnly, grants.length, reviewRound])

  const secretCandidates = includeDataSent ? (review?.secretCandidates ?? []) : []
  const card = review?.review.ok ? review.review.card : null
  const publishBlocked = sharePublishBlocked(state, ackViewOnly)

  const runPublish = React.useCallback(async () => {
    if (!card) return
    setBusy('publish')
    try {
      const result = await window.electronAPI.publishPage(workspaceId, config.slug, {
        includeData: includeDataSent,
        viewOnlyAcknowledged: ackViewOnly,
        reviewedSha256: card.sha256,
      })
      if (result.status === 'published' || result.status === 'updated') {
        toast.success(t('toast.pagePublished'), { description: result.url })
      } else {
        toast.error(t('toast.pagePublishFailed'), { description: result.note })
        setReviewRound(n => n + 1)
      }
    } catch (err) {
      toast.error(t('toast.pagePublishFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(null)
    }
  }, [card, workspaceId, config.slug, includeDataSent, ackViewOnly, t])

  const runUnpublish = React.useCallback(async () => {
    setBusy('unpublish')
    try {
      const result = await window.electronAPI.unpublishPage(workspaceId, config.slug)
      if (result.outcome === 'failed') {
        toast.error(t('toast.pageUnpublishFailed'), { description: result.message })
      } else {
        if (result.outcome === 'pending') {
          toast.warning(t('toast.pageUnpublished'), { description: t('toast.pagePublicCopyMayRemain') })
        } else {
          toast.success(t('toast.pageUnpublished'))
        }
        onOpenChange(false)
      }
    } catch (err) {
      toast.error(t('toast.pageUnpublishFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(null)
      setConfirmingUnpublish(false)
    }
  }, [workspaceId, config.slug, t, onOpenChange])

  const copyLink = React.useCallback(async () => {
    if (!publication) return
    try {
      await navigator.clipboard.writeText(publication.url)
      setCopied(true)
      toast.success(t('pages.share.linkCopied'))
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard denied — the URL stays selectable in the input.
    }
  }, [publication, t])

  const expiry = publication ? artifactExpiryLabel(publication.expiresAt, i18n.language) : null
  const publishDisabled = busy !== null || publishBlocked || !card

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('pages.share.title')}</DialogTitle>
          {!state.published && <DialogDescription>{t('pages.share.publishDescription')}</DialogDescription>}
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {state.published && publication && (
            <div className="flex flex-col gap-1.5">
              <span className="text-label font-medium">{t('pages.share.linkLabel')}</span>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={publication.url}
                  onFocus={e => e.currentTarget.select()}
                  className="font-mono text-mono-ui md:text-mono-ui"
                />
                <Button variant="secondary" size="lg" onClick={copyLink} className="shrink-0">
                  {copied ? <Check /> : <Copy />}
                  {t('pages.share.copyLink')}
                </Button>
              </div>
              <span className="text-label-sm text-tertiary">
                {expiry === null ? t('chat.artifactPublish.expiresNever') : t('chat.artifactPublish.expires', { date: expiry })}
              </span>
            </div>
          )}

          {state.deletionPending && (
            <span className="text-label-sm text-info" data-testid="share-deletion-pending">{t('pages.share.deletionPending')}</span>
          )}

          {state.offerIncludeData && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-start justify-between gap-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-label font-medium">{t('pages.share.includeData')}</span>
                  <span className="text-label-sm text-tertiary">{t('pages.share.includeDataHint')}</span>
                </span>
                <Switch checked={includeData} onCheckedChange={setIncludeData} disabled={busy !== null} />
              </label>
              {secretCandidates.length > 0 && (
                <span className="text-label-sm text-info">
                  {t('pages.share.dataSecretWarning', { keys: secretKeysPreview(secretCandidates) })}
                </span>
              )}
            </div>
          )}

          {state.scriptGrants.length > 0 ? (
            <ScriptGrantsBlock grants={state.scriptGrants} busyGrantId={busyGrantId} onRemove={removeGrant} />
          ) : state.needsViewOnlyAck ? (
            <label className="flex items-start justify-between gap-3 rounded-lg border border-[color:var(--info-border)] bg-info-tint p-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-label font-medium">{t('pages.share.actionsAckLabel')}</span>
                <span className="text-label-sm text-secondary">{t('pages.share.actionsAck')}</span>
              </span>
              <Switch checked={ackViewOnly} onCheckedChange={setAckViewOnly} disabled={busy !== null} />
            </label>
          ) : null}

          {state.published && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-subtle p-3">
              <span className="text-label-sm text-secondary">
                {state.contentDrifted ? t('pages.share.contentUpdateAvailable') : t('pages.share.contentUpToDate')}
              </span>
              <Button
                variant={state.contentDrifted ? 'primary' : 'secondary'}
                size="sm"
                onClick={runPublish}
                disabled={publishDisabled}
                className="shrink-0"
              >
                {busy === 'publish' && <Spinner className="text-label-sm" />}
                {t('pages.share.republish')}
              </Button>
            </div>
          )}

          {/* The review: the same card the session's publish shows, for exactly the bytes a publish would send. */}
          {review === null ? (
            <span className="inline-flex items-center gap-2 text-label-sm text-tertiary">
              <Spinner className="text-label-sm" /> {t('pages.share.reviewing')}
            </span>
          ) : review.review.ok ? (
            <ArtifactPublishDetails card={review.review.card} />
          ) : state.scriptGrants.length > 0 ? null : (
            <Info_Alert variant="error" inline icon={<AlertTriangle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('pages.share.reviewFailed')}</Info_Alert.Title>
              <Info_Alert.Description className="break-all">{review.review.message}</Info_Alert.Description>
            </Info_Alert>
          )}
        </div>

        <DialogFooter>
          {state.published ? (
            <>
              <span className="mr-auto hidden self-center text-label-sm text-tertiary sm:block">
                {t('pages.share.unpublishHint')}
              </span>
              {/* Two-step: the first click arms, the confirm is the destructive-solid treatment */}
              {confirmingUnpublish ? (
                <Button variant="danger-solid" onClick={runUnpublish} disabled={busy !== null}>
                  {busy === 'unpublish' && <Spinner className="text-label-sm" />}
                  {t('pages.share.unpublish')}
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setConfirmingUnpublish(true)} disabled={busy !== null}>
                  {t('pages.share.unpublish')}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy !== null}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={runPublish} disabled={publishDisabled}>
                {busy === 'publish' && <Spinner className="text-label-sm" />}
                {t('pages.share.publish')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Publish-blocking notice for script approvals, with inline removal — the
 * server refuses to publish a page holding ANY script grant (even a stale
 * one), so the dialog explains that up front instead of failing on submit.
 */
function ScriptGrantsBlock({
  grants,
  busyGrantId,
  onRemove,
}: {
  grants: PageActionGrant[]
  busyGrantId: string | null
  onRemove: (grantId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  return (
    // Blocked state: destructive tint + hairline (spec §7.7 inline marker), rows on the floating surface
    <div className="flex flex-col gap-2 rounded-lg border border-[color:var(--destructive-border)] bg-destructive-tint p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 text-label">
          <div className="font-medium">{t('pages.share.scriptBlockedTitle')}</div>
          <div className="mt-0.5 text-label-sm text-secondary">{t('pages.share.scriptBlocked')}</div>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {grants.map(grant => (
          <li
            key={grant.id}
            className="flex items-center gap-2 rounded-md bg-floating px-2.5 py-1.5 shadow-elev-0"
          >
            <span className="min-w-0 flex-1 break-words text-label-sm font-medium">
              {describeGrantAction(grant.action, t)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={busyGrantId !== null}
              onClick={() => void onRemove(grant.id)}
            >
              {busyGrantId === grant.id && <Spinner className="text-label-sm" />}
              {t('pages.grants.remove')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
