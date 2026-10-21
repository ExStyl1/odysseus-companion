/**
 * UA1.19 — the artifact chip on a completed `publish_artifact` row: open the link, copy it, and the ABSOLUTE expiry
 * date (a date a reader can act on). Rendered by `TurnCard`'s tool row; the decision is `published-artifact.ts`.
 * Opening goes through the platform's `onOpenUrl` (Electron: the system browser), copying through `onCopyToClipboard`
 * or `navigator.clipboard`.
 *
 * UB14.18 — on the work log's language: the link is the row's neutral status chip (`CHIP_NEUTRAL`) made a button,
 * and copy is the transcript's named icon button (`TurnIconButton`, its name repeated as a native `title` as
 * `PreviewBlockAction` does — the chip renders in hosts that mount no TooltipProvider).
 */
import * as React from 'react'
import i18n from 'i18next'
import { Check, Copy, Link2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { usePlatform } from '../../context/PlatformContext'
import { publishedArtifactChipData } from './published-artifact'
import { TurnIconButton } from './turn/TurnIconButton'
import { CHIP_NEUTRAL, SIZE_CONFIG } from './turn/turn-classes'

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(i18n.resolvedLanguage, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : iso
}

export function PublishedArtifactChip({ activity, now = Date.now() }: {
  activity: { toolName?: string; status?: string; content?: string }
  /** Epoch ms the expiry is compared against (a knob in the playground). */
  now?: number
}) {
  const { onOpenUrl, onCopyToClipboard } = usePlatform()
  const [copied, setCopied] = React.useState(false)
  const chip = publishedArtifactChipData(activity)
  if (!chip) return null
  const expired = chip.expiresAt !== null && Date.parse(chip.expiresAt) <= now
  const expiry = chip.expiresAt === null
    ? i18n.t('chat.artifactChip.expiresNever')
    : i18n.t(expired ? 'chat.artifactChip.expired' : 'chat.artifactChip.expires', { date: formatDate(chip.expiresAt) })
  const copy = (event: React.MouseEvent) => {
    event.stopPropagation()
    const write = onCopyToClipboard ?? ((text: string) => navigator.clipboard.writeText(text))
    void write(chip.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <span className="flex shrink-0 items-center gap-0.5 pl-1" data-artifact-chip={expired ? 'expired' : 'live'}>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); if (onOpenUrl) onOpenUrl(chip.url); else window.open(chip.url, '_blank', 'noopener') }}
        disabled={expired}
        title={i18n.t('chat.artifactChip.open')}
        className={cn(
          CHIP_NEUTRAL,
          'transition-colors duration-micro ease-out-subtle hover:bg-fill-pressed hover:text-foreground hover:duration-instant disabled:pointer-events-none disabled:text-disabled',
        )}
      >
        <Link2 aria-hidden className="size-3" />
        <span className={expired ? 'line-through' : undefined}>{expiry}</span>
      </button>
      <TurnIconButton
        aria-label={i18n.t('chat.artifactChip.copy')}
        title={i18n.t(copied ? 'chat.artifactChip.copied' : 'chat.artifactChip.copy')}
        icon={copied ? <Check className={SIZE_CONFIG.iconSize} /> : <Copy className={SIZE_CONFIG.iconSize} />}
        onClick={copy}
        disabled={expired}
      />
    </span>
  )
}
