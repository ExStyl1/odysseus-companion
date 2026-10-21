/**
 * Source: v0.15.0:apps/electron/src/renderer/components/app-shell/input/ChatInputZone.tsx `PastedCommandChip`
 * (ADDED in v0.15.0, unchanged in v0.15.1; craft-agents-oss, Apache-2.0) — UB14.34 (R4-14). The look is taken 1:1.
 * Ours: its own file (upstream defines it inside `ChatInputZone.tsx`), so the playground and a bare bun test can
 * render it; the zone mounts it only where `pastedCommandRunner` offers a runner (see `pasted-command.ts`).
 */
import { useTranslation } from 'react-i18next'
import { Play, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { COMPOSER_META_CHIP } from './composer-styles'

export interface PastedCommandChipProps {
  /** The command the pasted snippet stands for (prompts removed); its first line is shown, the whole as a tooltip */
  command: string
  onRun: () => void
  onDismiss: () => void
}

/**
 * Offer to run a pasted console snippet as a background command. Running sends the run request
 * (the agent starts it, under the permission mode) and takes the snippet out of the composer.
 */
export function PastedCommandChip({ command, onRun, onDismiss }: PastedCommandChipProps) {
  const { t } = useTranslation()
  const [firstLine] = command.split('\n')
  return (
    <div
      data-pasted-command
      className="mb-2 flex min-w-0 items-center gap-0.5 px-px transition-[opacity,translate] duration-base ease-out starting:translate-y-1 starting:opacity-0"
    >
      <button type="button" onClick={onRun} title={command} className={cn(COMPOSER_META_CHIP, 'min-w-0 cursor-pointer pl-2')}>
        <Play aria-hidden className="size-3.5 shrink-0 text-accent" />
        <span className="shrink-0">{t('chat.runCommandInBackground')}</span>
        <span className="min-w-0 max-w-[320px] truncate font-mono font-normal text-tertiary">
          {firstLine}{command.includes('\n') ? ' …' : ''}
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('common.dismiss')}
        className="inline-grid size-6 shrink-0 place-items-center rounded-full text-tertiary hover:bg-fill-hover hover:text-foreground"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
