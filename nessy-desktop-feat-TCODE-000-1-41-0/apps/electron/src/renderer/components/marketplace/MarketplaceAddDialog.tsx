/**
 * MarketplaceAddDialog (U5 design; INTEGRATION = 1.10.0 ADDENDUM)
 *
 * Codex-style "Add plugin marketplace" dialog (owner reference screenshot
 * 2026-07-19): add a whole plugin registry from a GitHub repo / Git URL /
 * local folder. Three fields — Source, Git ref (default "main"), Sparse
 * paths — plus Cancel / Add marketplace footer (primary disabled until Source
 * is non-empty).
 *
 * DESIGN-ONLY in 1.9.0: this is the visual surface, reviewable in the
 * playground. The registry backend (fetch/parse a catalog manifest, store the
 * registry list, upgrade/remove) is the 1.10.0 MARKETPLACE REGISTRIES
 * candidate — this dialog is callback-driven and does NOTHING on its own.
 *
 * Codex → our tokens: their radius-2xl modal → our DialogContent; labeled
 * fields → Label + Input/Textarea; full-radius CTA → Button. Strings via
 * props. // i18n at integration
 *
 * UB14.39 (R6-10) — on v0.15.1's dialog vocabulary (recipe: v0.15.1
 * `ui/rename-dialog.tsx`): Cancel is the ghost, Add the forward primary; the
 * body keeps DialogContent's own 16px rhythm (one grid, no margin overrides).
 */

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'

/** The registry the dialog would add (integration maps this to the git fetch). */
export interface MarketplaceAddSubmit {
  /** GitHub `org/repo`, a git URL, or a local folder path. */
  source: string
  /** Git ref (branch/tag/sha); defaults to "main". */
  gitRef: string
  /** Newline-separated sparse-checkout paths (empty = whole repo). */
  sparsePaths: string[]
}

export interface MarketplaceAddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // i18n at integration
  title: string
  description?: React.ReactNode
  sourceLabel: string
  sourcePlaceholder: string
  gitRefLabel: string
  sparsePathsLabel: string
  sparsePathsPlaceholder: string
  cancelLabel: string
  submitLabel: string
  /** Fires with the trimmed fields when the user confirms (integration wires). */
  onSubmit?: (value: MarketplaceAddSubmit) => void
}

/** Dialog BODY, extracted for static-markup testing (Radix portals don't render there). */
export function MarketplaceAddBody({
  title,
  description,
  sourceLabel,
  sourcePlaceholder,
  gitRefLabel,
  sparsePathsLabel,
  sparsePathsPlaceholder,
  cancelLabel,
  submitLabel,
  onCancel,
  onSubmit,
}: Omit<MarketplaceAddDialogProps, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
  const [source, setSource] = React.useState('')
  const [gitRef, setGitRef] = React.useState('main')
  const [sparsePaths, setSparsePaths] = React.useState('')

  const canSubmit = source.trim().length > 0

  const submit = () => {
    if (!canSubmit) return
    onSubmit?.({
      source: source.trim(),
      gitRef: gitRef.trim() || 'main',
      sparsePaths: sparsePaths
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    })
  }

  return (
    <div data-testid="marketplace-add-dialog" className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mkt-add-source">{sourceLabel}</Label>
          <Input
            id="mkt-add-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={sourcePlaceholder}
            autoFocus
            data-testid="marketplace-add-source"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mkt-add-ref">{gitRefLabel}</Label>
          <Input
            id="mkt-add-ref"
            value={gitRef}
            onChange={(e) => setGitRef(e.target.value)}
            data-testid="marketplace-add-ref"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mkt-add-sparse">{sparsePathsLabel}</Label>
          <Textarea
            id="mkt-add-sparse"
            value={sparsePaths}
            onChange={(e) => setSparsePaths(e.target.value)}
            placeholder={sparsePathsPlaceholder}
            rows={3}
            data-testid="marketplace-add-sparse"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} data-testid="marketplace-add-cancel">
          {cancelLabel}
        </Button>
        <Button variant="primary" onClick={submit} disabled={!canSubmit} data-testid="marketplace-add-submit">
          {submitLabel}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function MarketplaceAddDialog({ open, onOpenChange, ...body }: MarketplaceAddDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <MarketplaceAddBody {...body} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
