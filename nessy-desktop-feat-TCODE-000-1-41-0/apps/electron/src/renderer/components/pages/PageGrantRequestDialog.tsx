/**
 * Approval dialog for page-initiated grant requests (`grant-request` bridge
 * message). The dialog itself IS the user consent: approving calls
 * `pages:issueGrant` per entry, which binds each grant to the page's current
 * content digest. All-or-nothing per request batch — a page that wants
 * separable capabilities should send separate requests.
 *
 * UA9.3 — copied from craft-agents-oss `v0.13.4:apps/electron/src/renderer/components/pages/PageGrantRequestDialog.tsx`
 * (Apache-2.0), adapted (spec §15 "Grant requests", OQ-10):
 * - **The host descriptor is the authority.** Each row shows the descriptor the HOST validated
 *   (`pages:describeGrantRequest`: source; tool, or method and path; script path, runtime, args and the sha256 of
 *   the script's bytes now) as plain fields (`describeGrantTarget`), and the page's own `description` only under a
 *   "written by the page" label — a page cannot word its way past what the grant allows.
 * - The PageFrame that opens it has already required user activation AND frame focus, holds one dialog at a time
 *   and rate-limits further requests (`page-frame-gates.ts`).
 * - Styled as our cards (OQ-10): the shared Dialog primitives, as every other approval surface here.
 *
 * UB14.53, 2026-10-17 — v0.15.1's material (the v0.15.0 class hunks of the same file): the title glyph in the info
 * role, a script row on the destructive tint with its `--destructive-border` hairline, other rows on a
 * `border-subtle` hairline, text on the label roles, Deny ghost and Approve primary. Ours on the same roles: the
 * host descriptor lines in the mono role, the page's own words tertiary under their label.
 */

import * as React from 'react'
import { KeyRound } from 'lucide-react'
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
import type { PendingGrantEntry } from './page-frame-gates'
import { describeGrantAction, describeGrantTarget, grantKindIcon } from './grant-visuals'

interface PageGrantRequestDialogProps {
  pageName: string
  /** Pending, host-validated request entries, or null when no dialog should show */
  requests: PendingGrantEntry[] | null
  busy: boolean
  onApprove: () => void
  onDeny: () => void
}

export function PageGrantRequestDialog({ pageName, requests, busy, onApprove, onDeny }: PageGrantRequestDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={requests !== null} onOpenChange={(open) => { if (!open && !busy) onDeny() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-info" />
            {t('pages.grants.title')}
          </DialogTitle>
          <DialogDescription>{t('pages.grants.description', { name: pageName })}</DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2">
          {(requests ?? []).map((entry) => (
            <PageGrantRequestRow key={entry.key} entry={entry} />
          ))}
        </ul>

        <p className="text-label-sm text-tertiary">{t('pages.grants.expiryNote')}</p>

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onDeny}>
            {t('pages.grants.deny')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={onApprove}>
            {busy ? t('pages.grants.approving') : t('pages.grants.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One requested capability: the host descriptor first, the page's words last and labelled as the page's. */
export function PageGrantRequestRow({ entry }: { entry: PendingGrantEntry }) {
  const { t } = useTranslation()
  const isScript = entry.action.kind === 'script'
  const Icon = grantKindIcon(entry.action.kind)
  return (
    <li
      data-grant-kind={entry.action.kind}
      className={
        isScript
          ? 'flex items-start gap-2.5 rounded-lg border border-[color:var(--destructive-border)] bg-destructive-tint px-3 py-2.5'
          : 'flex items-start gap-2.5 rounded-lg border border-subtle px-3 py-2.5'
      }
    >
      <Icon
        className={isScript ? 'mt-0.5 size-4 shrink-0 text-destructive' : 'mt-0.5 size-4 shrink-0 text-tertiary'}
      />
      <div className="min-w-0 text-label">
        <div className="break-words font-medium">{describeGrantAction(entry.action, t)}</div>
        {describeGrantTarget(entry.action, entry.scriptSha256).map(line => (
          <code key={line} data-grant-authority className="mt-0.5 block break-all text-mono-ui text-secondary select-text">
            {line}
          </code>
        ))}
        {isScript && (
          <div className="mt-0.5 break-words text-label-sm font-medium text-destructive">
            {t('pages.grants.scriptWarning')}
          </div>
        )}
        {entry.description && (
          <div data-page-supplied className="mt-1 break-words text-label-sm text-tertiary">
            <span className="font-medium">{t('pages.grants.pageSupplied')}</span> {entry.description}
          </div>
        )}
      </div>
    </li>
  )
}
