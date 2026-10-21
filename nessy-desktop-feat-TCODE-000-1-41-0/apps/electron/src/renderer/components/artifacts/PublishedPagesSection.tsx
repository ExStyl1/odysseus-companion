/**
 * UA1.19 — the Published pages list (Settings → Workspace): the signed-in dp identity's pages on t-artifacts joined
 * to this workspace's registry (`artifacts:list`), with open, copy, extend (its own confirmation, unlimited included)
 * and delete (its own confirmation, with the fixed sentence the plan names). A failed delete is never silent: the host
 * keeps it as a pending deletion, the row shows it, and the next successful list retries it. When dp is signed out the
 * list shows ONE card and opens nothing — no browser, no `dp auth login` (the host client never starts one).
 * UA12.52 — the section also reloads itself when the host pushes `artifacts:changed` for this workspace (a publish or
 * share landed a row), so a row appears without the Retry button.
 *
 * `PublishedPagesView` is pure (props in, callbacks out) so the playground renders every state without IPC; the
 * decisions it reads are values in `published-pages.ts`. Ours — upstream v0.13.4 has no such list.
 *
 * UB12.58 — the list draws on v0.15.1's settings material (it renders inside Settings → Workspace, outside UB15.12's
 * pages/settings + components/settings census). Upstream v0.15.1 has no published-pages list either, so each part takes
 * the recipe of the nearest upstream surface: rows are `MessagingSettingsPage`'s list rows (14px sides, `min-h-14`, the
 * title on `settingsUI.label`, the URL on `settingsUI.description`, the expiry and source line as fine print), the chat
 * badge is `AiSettingsPage`'s neutral "Default" chip, open and copy are `ServerSettingsPage`'s `IconButton size="sm"`
 * with an aria-label (the `title` hover hint is kept: ours), Delete is the list-row removal `danger` sm (`RowActions`),
 * the signed-out card is `Info_Alert` on the info tint (v0.15.1's amber "needs you" role; our `text-warning` /
 * `bg-warning` never resolved, as no `--color-warning` token exists), the loading line is `AppSettingsPage`'s download
 * line, and the empty list is `LabelsSettingsPage`'s in-card empty state. Behaviour is unchanged.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Clock, Copy, ExternalLink, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import type { ArtifactsListStatus, PublishedArtifactDto } from '@nessy-agent/shared/protocol'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { Button, IconButton } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { Info_Alert } from '@/components/info/Info_Alert'
import { cn } from '@/lib/utils'
import {
  EXTEND_RETENTION_CHOICES,
  deleteOutcomeToast,
  extendChoiceLabelKey,
  formatExpiryDate,
  publishedPageActions,
  publishedPageState,
  type PublishedPageState,
} from './published-pages'

export type PublishedPagesStatus = 'loading' | ArtifactsListStatus

export interface PublishedPagesViewProps {
  status: PublishedPagesStatus
  /** The host's sentence for `needs-login` / `unavailable`, or its note about the registry. */
  message?: string
  rows: PublishedArtifactDto[]
  /** Epoch ms the states are computed against (a knob in the playground). */
  now: number
  busyId?: string | null
  onOpen: (row: PublishedArtifactDto) => void
  onCopy: (row: PublishedArtifactDto) => void
  onExtend: (row: PublishedArtifactDto) => void
  onDelete: (row: PublishedArtifactDto) => void
  onRetry: () => void
}

function ExpiryLine({ row, state }: { row: PublishedArtifactDto; state: PublishedPageState }) {
  const { t, i18n } = useTranslation()
  if (state === 'pending-deletion') {
    return <span className="text-info">{t('settings.workspace.publishedPages.pendingDeletion')}</span>
  }
  if (row.expiresAt === null) return <span>{t('settings.workspace.publishedPages.expiresNever')}</span>
  const date = formatExpiryDate(row.expiresAt, i18n.resolvedLanguage)
  if (state === 'expired') return <span className="text-destructive">{t('settings.workspace.publishedPages.expired', { date })}</span>
  return (
    <span className={cn(state === 'expiring-soon' && 'text-info')}>
      {t('settings.workspace.publishedPages.expires', { date })}
      {state === 'expiring-soon' && ` · ${t('settings.workspace.publishedPages.expiresSoon')}`}
    </span>
  )
}

function PublishedPageRow({ row, now, busy, onOpen, onCopy, onExtend, onDelete }: {
  row: PublishedArtifactDto
  now: number
  busy: boolean
} & Pick<PublishedPagesViewProps, 'onOpen' | 'onCopy' | 'onExtend' | 'onDelete'>) {
  const { t } = useTranslation()
  const state = publishedPageState(row, now)
  const actions = publishedPageActions(state)
  return (
    <div className="flex min-h-14 items-center gap-3 px-3.5 py-2.5" data-state={state}>
      <div className="shrink-0 text-lg leading-6" aria-hidden>{row.emoji || '📄'}</div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn(settingsUI.label, 'truncate')}>{row.title || row.url}</span>
          {/* UA1.26 — a shared chat (UA1.25 records it with kind `chat`) is badged; files and pages are not. */}
          {row.source?.kind === 'chat' && (
            <span className="inline-flex h-5 shrink-0 items-center rounded-xs bg-fill-hover px-1.5 text-label-sm font-medium text-secondary" data-testid="published-page-chat-badge">
              {t('settings.workspace.publishedPages.chatBadge')}
            </span>
          )}
        </div>
        <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap, '[overflow-wrap:anywhere]')}>{row.url}</div>
        <div className={cn(settingsUI.descriptionSmall, 'mt-0.5 flex flex-wrap gap-x-2')}>
          <ExpiryLine row={row} state={state} />
          <span>
            {row.source
              ? t('settings.workspace.publishedPages.fromSession', { path: row.source.path })
              : t('settings.workspace.publishedPages.outside')}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {busy && <Spinner className="text-label-sm text-tertiary" />}
        {actions.open && (
          <IconButton
            size="sm"
            aria-label={t('settings.workspace.publishedPages.open')}
            title={t('settings.workspace.publishedPages.open')}
            icon={<ExternalLink className="size-3.5" />}
            onClick={() => onOpen(row)}
          />
        )}
        {actions.copy && (
          <IconButton
            size="sm"
            aria-label={t('settings.workspace.publishedPages.copy')}
            title={t('settings.workspace.publishedPages.copy')}
            icon={<Copy className="size-3.5" />}
            onClick={() => onCopy(row)}
          />
        )}
        {actions.extend && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onExtend(row)}>
            <Clock className="size-3.5" />
            {t('settings.workspace.publishedPages.extend')}
          </Button>
        )}
        {actions.delete && (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => onDelete(row)}>
            <Trash2 className="size-3.5" />
            {t('settings.workspace.publishedPages.delete')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function PublishedPagesView(props: PublishedPagesViewProps) {
  const { t } = useTranslation()
  const { status, message, rows, now, busyId, onRetry } = props
  return (
    <SettingsSection
      title={t('settings.workspace.publishedPages.title')}
      description={t('settings.workspace.publishedPages.description')}
      action={status === 'loading' ? undefined : (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          {t('settings.workspace.publishedPages.retry')}
        </Button>
      )}
    >
      {status === 'loading' && (
        <div className="flex items-center gap-2 text-label-sm text-tertiary"><Spinner />{t('settings.workspace.publishedPages.loading')}</div>
      )}
      {(status === 'needs-login' || status === 'unavailable') && (
        // ONE card for the whole list, whatever the count of rows; it opens nothing.
        <Info_Alert variant="info" icon={<TriangleAlert />} role="status">
          {status === 'needs-login'
            ? t('settings.workspace.publishedPages.needsLogin')
            : t('settings.workspace.publishedPages.unavailable', { message: message ?? '' })}
        </Info_Alert>
      )}
      {status === 'ok' && message && <p className={settingsUI.descriptionSmall}>{message}</p>}
      {status !== 'loading' && rows.length === 0 && status === 'ok' && (
        <SettingsCard>
          <div className="px-6 py-8 text-center">
            <p className="text-label text-secondary">{t('settings.workspace.publishedPages.empty')}</p>
          </div>
        </SettingsCard>
      )}
      {rows.length > 0 && (
        <SettingsCard divided>
          {rows.map(row => (
            <PublishedPageRow
              key={row.id}
              row={row}
              now={now}
              busy={busyId === row.id}
              onOpen={props.onOpen}
              onCopy={props.onCopy}
              onExtend={props.onExtend}
              onDelete={props.onDelete}
            />
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  )
}

/**
 * UB14.39 (R6-10) — the two confirmations on v0.15.1's dialog vocabulary: Cancel is the ghost, Extend the forward
 * primary, the irreversible Delete `danger-solid`. The retention choices are upstream's segmented control (the recipe
 * of v0.15.1 `messaging/LarkConnectDialog.tsx`: a `bg-fill-hover` track, the chosen segment on `bg-floating` with
 * `shadow-elev-1`), keeping our radiogroup semantics (`role="radio"` + `aria-checked`).
 */
export function ExtendPublishedPageDialog({ row, onCancel, onConfirm }: {
  row: PublishedArtifactDto | null
  onCancel: () => void
  onConfirm: (row: PublishedArtifactDto, retentionDays: number) => void
}) {
  const { t } = useTranslation()
  const [days, setDays] = React.useState<number>(30)
  React.useEffect(() => { if (row) setDays(30) }, [row])
  return (
    <Dialog open={row !== null} onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.workspace.publishedPages.extendTitle')}</DialogTitle>
          <DialogDescription>{t('settings.workspace.publishedPages.extendDescription', { title: row?.title ?? '' })}</DialogDescription>
        </DialogHeader>
        <div className="inline-flex flex-wrap justify-self-start rounded-md bg-fill-hover p-0.5" role="radiogroup">
          {EXTEND_RETENTION_CHOICES.map(choice => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={days === choice}
              onClick={() => setDays(choice)}
              className={cn(
                'h-control-sm rounded-sm px-3 text-label font-medium transition-[background-color,color,box-shadow] duration-micro ease-out-subtle disabled:text-disabled',
                days === choice ? 'bg-floating text-foreground shadow-elev-1' : 'text-secondary hover:text-foreground',
              )}
            >
              {t(extendChoiceLabelKey(choice))}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => row && onConfirm(row, days)}>{t('settings.workspace.publishedPages.extendConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeletePublishedPageDialog({ row, onCancel, onConfirm }: {
  row: PublishedArtifactDto | null
  onCancel: () => void
  onConfirm: (row: PublishedArtifactDto) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={row !== null} onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.workspace.publishedPages.deleteTitle', { title: row?.title ?? '' })}</DialogTitle>
          <DialogDescription>{t('settings.workspace.publishedPages.deleteDescription')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="danger-solid" onClick={() => row && onConfirm(row)}>{t('settings.workspace.publishedPages.deleteConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The container: the RPC calls, the two confirmations and the toasts. */
export function PublishedPagesSection({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<PublishedPagesStatus>('loading')
  const [message, setMessage] = React.useState<string | undefined>(undefined)
  const [rows, setRows] = React.useState<PublishedArtifactDto[]>([])
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [extending, setExtending] = React.useState<PublishedArtifactDto | null>(null)
  const [deleting, setDeleting] = React.useState<PublishedArtifactDto | null>(null)

  const load = React.useCallback(async () => {
    setStatus('loading')
    try {
      const result = await window.electronAPI.listPublishedArtifacts(workspaceId)
      setRows(result.artifacts)
      setMessage(result.message)
      setStatus(result.status)
      if (result.retriedDeletes) {
        toast.success(t('settings.workspace.publishedPages.retried', { n: result.retriedDeletes }))
      }
    } catch (error) {
      setRows([])
      setMessage(error instanceof Error ? error.message : String(error))
      setStatus('unavailable')
    }
  }, [workspaceId, t])

  React.useEffect(() => { void load() }, [load])

  // UA12.52 — a publish or share in THIS window (an approved publish_artifact card, the preview's Publish, a chat
  // share, a Pages publish) pushes `artifacts:changed`; an open section reloads itself, so the new row appears
  // without the Retry button. Another workspace's push is ignored — the registry it names is not this list's.
  React.useEffect(() => {
    const off = window.electronAPI.onArtifactsChanged(changedWorkspaceId => {
      if (changedWorkspaceId === workspaceId) void load()
    })
    return () => { off() }
  }, [workspaceId, load])

  const handleCopy = React.useCallback((row: PublishedArtifactDto) => {
    void navigator.clipboard.writeText(row.url).then(() => toast.success(t('settings.workspace.publishedPages.copied')))
  }, [t])

  const confirmExtend = React.useCallback(async (row: PublishedArtifactDto, retentionDays: number) => {
    setExtending(null)
    setBusyId(row.id)
    try {
      const result = await window.electronAPI.setPublishedArtifactRetention(workspaceId, row.id, retentionDays)
      if (result.ok) toast.success(t('settings.workspace.publishedPages.extendDone'))
      else toast.error(t('settings.workspace.publishedPages.extendFailed'), { description: result.message })
    } catch (error) {
      toast.error(t('settings.workspace.publishedPages.extendFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
      void load()
    }
  }, [workspaceId, t, load])

  const confirmDelete = React.useCallback(async (row: PublishedArtifactDto) => {
    setDeleting(null)
    setBusyId(row.id)
    try {
      const result = await window.electronAPI.deletePublishedArtifact(workspaceId, {
        id: row.id, url: row.url, title: row.title, expiresAt: row.expiresAt, retentionDays: row.retentionDays,
      })
      const view = deleteOutcomeToast(result)
      const description = view.description ? { description: view.description } : undefined
      if (view.kind === 'success') toast.success(t(view.key), description)
      else if (view.kind === 'warning') toast.warning(t(view.key), description)
      else toast.error(t(view.key), description)
    } catch (error) {
      toast.error(t('settings.workspace.publishedPages.deleteFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
      void load()
    }
  }, [workspaceId, t, load])

  return (
    <>
      <PublishedPagesView
        status={status}
        message={message}
        rows={rows}
        now={Date.now()}
        busyId={busyId}
        onOpen={row => { void window.electronAPI.openUrl(row.url) }}
        onCopy={handleCopy}
        onExtend={setExtending}
        onDelete={setDeleting}
        onRetry={() => { void load() }}
      />
      <ExtendPublishedPageDialog row={extending} onCancel={() => setExtending(null)} onConfirm={(row, days) => { void confirmExtend(row, days) }} />
      <DeletePublishedPageDialog row={deleting} onCancel={() => setDeleting(null)} onConfirm={row => { void confirmDelete(row) }} />
    </>
  )
}
