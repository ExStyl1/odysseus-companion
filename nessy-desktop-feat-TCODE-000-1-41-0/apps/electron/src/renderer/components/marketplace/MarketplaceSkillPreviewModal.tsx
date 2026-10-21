/**
 * MarketplaceSkillPreviewModal (U5)
 *
 * Codex-style SKILL preview MODAL for the marketplace flow (owner request
 * 2026-07-19). Marketplace-only surface: a not-yet-installed plugin's skill
 * has no routed capability page, so the preview opens in a Dialog — installed
 * skills keep our routed Info_Page canon.
 *
 * Body reuses the U1 CapabilityContentPanel (full markdown, maxHeight +
 * fullscreen, file-ref chips with relative-path tooltips). Footer follows the
 * spec'd Codex pattern adapted to ours: primary CTA right, quiet close left.
 *
 * IPC-free + callback-driven; display strings arrive via props. The one
 * default it supplies itself, the kind label, reads `plugins.kind.skill`
 * (UB12.86: it was the English literal "Skill" under every locale).
 *
 * UB14.39 (R6-10) — on v0.15.1's dialog vocabulary: the quiet Close is the
 * ghost beside a primary CTA (the secondary when it stands alone), the kind
 * label the tertiary text role, and the SKILL.md body on the raised card
 * `Info_Section` draws; DialogContent's own 16px rhythm, no margin overrides.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  CapabilityContentPanel,
  type CapabilityContentPanelProps,
} from '@/components/info/CapabilityContentPanel'

export interface MarketplaceSkillPreviewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Skill display name (modal title). */
  name: string
  /**
   * Kind label shown DIMMED right after the name (Codex: "Review Follow-up
   * Skill"). Defaults to `plugins.kind.skill` ("Skill"); an empty string hides it.
   */
  kindLabel?: string
  /** One-line skill description under the title. */
  description?: string
  /** SKILL.md body + states — the U1 content-panel contract. */
  content: CapabilityContentPanelProps
  /**
   * Optional primary CTA (e.g. "Install plugin"). Codex's own skill modal has
   * only a Close button, so this is OPT-IN — omit for the Codex-faithful
   * single-Close footer.
   */
  primaryLabel?: string
  onPrimary?: () => void
  /** Quiet close label. */
  closeLabel: string
}

/**
 * Modal BODY extracted for direct testing (Radix portals don't render in
 * static markup).
 */
export function MarketplaceSkillPreviewBody({
  name,
  kindLabel,
  description,
  content,
  primaryLabel,
  onPrimary,
  closeLabel,
  onClose,
}: Omit<MarketplaceSkillPreviewModalProps, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const { t } = useTranslation()
  const shownKind = kindLabel ?? t('plugins.kind.skill')
  return (
    <div data-testid="marketplace-skill-preview" className="grid gap-4">
      <DialogHeader>
        {/* Codex: "<Name> <Kind>" with the kind label dimmed inline. */}
        <DialogTitle>
          {name}
          {shownKind && <span className="ml-2 font-normal text-tertiary">{shownKind}</span>}
        </DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {/* Single surface for the body — the panel draws no own chrome. */}
      <div className="overflow-hidden rounded-lg bg-raised shadow-elev-1">
        <CapabilityContentPanel {...content} maxHeight={content.maxHeight ?? 360} />
      </div>
      {/* Codex footer: a single quiet Close on the right. A primary CTA is
          opt-in (marketplace pre-install variant only). */}
      <DialogFooter>
        {primaryLabel && (
          <Button variant="ghost" onClick={onClose} data-testid="skill-preview-close">
            {closeLabel}
          </Button>
        )}
        {primaryLabel ? (
          <Button variant="primary" onClick={onPrimary} data-testid="skill-preview-primary">
            {primaryLabel}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onClose} data-testid="skill-preview-close">
            {closeLabel}
          </Button>
        )}
      </DialogFooter>
    </div>
  )
}

export function MarketplaceSkillPreviewModal({
  open,
  onOpenChange,
  ...body
}: MarketplaceSkillPreviewModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <MarketplaceSkillPreviewBody {...body} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
