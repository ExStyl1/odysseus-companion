/* Copied from v0.15.1:apps/electron/src/renderer/components/pages/DeletePageDialog.tsx (craft-agents-oss,
   Apache-2.0) by UB14.53, 2026-10-17 (first copied from v0.13.4 by UA7.3, 2026-10-02); v0.15.0's footer: Cancel
   ghost, the irreversible confirm danger-solid. Nothing else differs: the published-page note (`shared`) is
   upstream's own, restored by UA6.7, 2026-10-02 — a published page's copy is taken down before its folder goes. */
import * as React from 'react'
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

interface DeletePageDialogProps {
  /** Page name shown in the confirmation copy; null = closed */
  pageName: string | null
  /** Published pages get an extra note: the public copy is taken offline too */
  shared?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Destructive confirmation — deleting a page removes its data folder too. */
export function DeletePageDialog({ pageName, shared, onConfirm, onCancel }: DeletePageDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={pageName !== null} onOpenChange={open => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('pages.deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('pages.deleteConfirmDescription', { name: pageName ?? '' })}
            {shared ? ` ${t('pages.deleteSharedNote')}` : ''}
          </DialogDescription>
        </DialogHeader>
        {/* Irreversible: the confirm is the one destructive-solid treatment; Cancel stays ghost */}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger-solid" onClick={onConfirm}>
            {t('pages.deletePage')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
