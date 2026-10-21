/**
 * "Approved actions" — everything the page is allowed to do, with removal.
 * Lists ALL persisted grants (including stale/expired ones, so they are
 * visible and removable). Removal is instant — pure privilege reduction, the
 * page can simply re-request.
 *
 * UA9.3 — copied from craft-agents-oss `v0.13.4:apps/electron/src/renderer/components/pages/PageGrantsDialog.tsx`
 * (Apache-2.0), adapted:
 * - The grants come from the host-approvals ledger (`pages:listGrants`, read by PageView and passed in), never from
 *   `page.json`'s `grants` (reason (b)); after a removal the dialog asks PageView to re-read them (`onChanged`).
 * - Each row also shows the descriptor the grant holds (`describeGrantTarget`: for a script, its pinned sha256).
 * - The status is computed against the digest of the content PageView rendered (`contentDigest`).
 * - `Spinner` comes from `@nessy-agent/ui/ui/LoadingIndicator` (the package barrel does not export it).
 *
 * UB14.53, 2026-10-17 — v0.15.1's material (the v0.15.0 class hunks of the same file): rows on a `border-subtle`
 * hairline with no fill, text on the label roles (`text-label`, `text-label-sm`, `text-secondary`/`text-tertiary`),
 * a script glyph in `text-destructive`, an unusable grant's status in the info role, and Remove `secondary`. Ours
 * on the same roles: the descriptor lines (`describeGrantTarget`) in the mono role, the page's words tertiary.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import type { PageActionGrant } from '@nessy-agent/shared/pages'
import { describeGrantAction, describeGrantStatus, describeGrantTarget, grantKindIcon, useGrantRemoval } from './grant-visuals'

interface PageGrantsDialogProps {
  workspaceId: string
  pageSlug: string
  pageName: string
  /** The digest of the content on screen; a grant bound to another one is listed as stale. */
  contentDigest: string | undefined
  grants: PageActionGrant[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Re-read the ledger's grants (after a removal). */
  onChanged?: () => void
}

export function PageGrantsDialog({ workspaceId, pageSlug, pageName, contentDigest, grants, open, onOpenChange, onChanged }: PageGrantsDialogProps) {
  const { t } = useTranslation()
  const { busyGrantId, removeGrant } = useGrantRemoval(workspaceId, pageSlug, onChanged)

  return (
    <Dialog open={open} onOpenChange={next => { if (busyGrantId === null) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('pages.grants.manage')}</DialogTitle>
          <DialogDescription>{t('pages.grants.manageDescription', { name: pageName })}</DialogDescription>
        </DialogHeader>

        {grants.length === 0 ? (
          <p className="text-label text-tertiary">{t('pages.grants.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {grants.map(grant => {
              const isScript = grant.action.kind === 'script'
              const Icon = grantKindIcon(grant.action.kind)
              const status = describeGrantStatus(grant, contentDigest, t)
              return (
                <li
                  key={grant.id}
                  className="flex items-start gap-2.5 rounded-lg border border-subtle px-3 py-2.5"
                >
                  <Icon
                    className={isScript ? 'mt-0.5 size-4 shrink-0 text-destructive' : 'mt-0.5 size-4 shrink-0 text-tertiary'}
                  />
                  <div className="min-w-0 flex-1 text-label">
                    <div className="break-words font-medium">{describeGrantAction(grant.action, t)}</div>
                    {describeGrantTarget(grant.action, grant.scriptSha256).map(line => (
                      <code key={line} className="mt-0.5 block break-all text-mono-ui text-secondary select-text">{line}</code>
                    ))}
                    {grant.description && (
                      <div className="mt-0.5 break-words text-label-sm text-tertiary">
                        <span className="font-medium">{t('pages.grants.pageSupplied')}</span> {grant.description}
                      </div>
                    )}
                    <div className={status.usable ? 'mt-0.5 text-label-sm text-tertiary' : 'mt-0.5 text-label-sm text-info'}>
                      {status.label}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    disabled={busyGrantId !== null}
                    onClick={() => void removeGrant(grant.id)}
                  >
                    {busyGrantId === grant.id && <Spinner className="text-label-sm" />}
                    {t('pages.grants.remove')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
