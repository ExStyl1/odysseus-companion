/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/ContextUsageChip.tsx (ADDED in
 * v0.15.0, unchanged in v0.15.1; UB14.28, R4-08). ADAPTED: upstream's chip and ring material, driven by
 * OUR `resolveContextMeterState` (`./context-meter-state`) instead of upstream's `context-display.ts`
 * (which ours does not have).
 *
 * What differs from upstream, each on purpose:
 * - VISIBILITY (owner 2026-08-08, the codex parity wave's Task 1.7): upstream draws the chip only at high
 *   usage. Ours is the composer's ONE context indicator and is always drawn while the runtime reports a
 *   meter (`composerCapabilities.contextMeter`, decided by the caller): below the warning it is the ring
 *   alone, quiet (`text-tertiary`); AT the warning it becomes upstream's info-tint chip 1:1, ring plus
 *   percent, and a press sends `/compact` — disabled rather than hidden while a turn is in flight (the
 *   warning is still true, only the remedy has to wait).
 * - THE NUMBERS: the ring and the printed percent are the share of the WHOLE window
 *   (`windowPercent`, what the donut always drew), so the two can never disagree; the share of the
 *   auto-compaction threshold, which is what arms the warning, is in the accessible name and the tooltip
 *   (`chat.contextUsage.combined`), and so is the fallback-window note (`estimatedWindow`).
 * - THE UNKNOWN WINDOW keeps its own twin, {@link UnknownUsageRing}, drawn by `ContextMeterUnknownWindow`
 *   on this ring's geometry — never `<UsageRing percent={0} />`.
 *
 * The two donuts `composer-parts.tsx` used to draw folded into the two rings here.
 * The tooltip import is the barrel-free subpath, so `bun test` can render this file.
 */
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@nessy-agent/ui/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ContextMeterState } from './context-meter-state'

const RING_RADIUS = 5.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** Ring meter: the arc fills to the usage (capped at a full ring; the label stays truthful). */
export function UsageRing({ percent }: { percent: number }) {
  const filled = Math.min(Math.max(percent, 0), 100) / 100
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="7" cy="7" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${RING_CIRCUMFERENCE * filled} ${RING_CIRCUMFERENCE}`}
      />
    </svg>
  )
}

/**
 * The ring's indeterminate twin: an occupancy with no window to be a share of.
 *
 * Deliberately NOT `<UsageRing percent={0} />`. An empty ring is a reading — it says "plenty of room
 * left" — and this state is the opposite of reassuring: nothing bounds the conversation and nothing
 * will compact it. A full ring would claim the other measurement nobody made. So the ring is BROKEN
 * rather than empty, and a `?` sits where the fill would be.
 *
 * Both cues are shape, not colour, and neither needs hover: the state survives a monochrome,
 * high-contrast or colour-blind reading of the toolbar, where a recoloured arc would not.
 *
 * Same radius, stroke width and box as {@link UsageRing}, so it reads as the same control in a
 * different state. No `-rotate-90`: there is no arc whose start needs moving to twelve o'clock, and
 * the rotation would lay the glyph on its side. The dash period divides the circumference a whole
 * number of times, so the broken ring closes evenly instead of showing one odd segment.
 */
export function UnknownUsageRing({ className }: { className?: string }) {
  const segments = 8
  const dash = RING_CIRCUMFERENCE / segments / 2
  return (
    <svg viewBox="0 0 14 14" className={cn('size-3.5 shrink-0', className)} aria-hidden="true">
      <circle
        cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth={2} strokeLinecap="butt"
        strokeDasharray={`${dash} ${dash}`}
        stroke="currentColor"
      />
      <text
        x="7" y="7" textAnchor="middle" dominantBaseline="central"
        fontSize="6.5" fontWeight="700" fill="currentColor"
      >
        ?
      </text>
    </svg>
  )
}

/** The counted occupancy the tooltip spells out in thousands of tokens. */
export interface ContextUsageDetail {
  inputTokens: number
  contextWindow: number
  /** The window is a fabricated default (`contextWindowSource === 'fallback'`), not reported. */
  estimatedWindow?: boolean
}

interface ContextUsageChipProps {
  /** The resolved meter (`resolveContextMeterState`); the caller draws the unknown twin when it is null. */
  meter: ContextMeterState
  usage: ContextUsageDetail
  /** Show the ring next to the percent at the warning (upstream drops it in its compact toolbar). */
  showMeter?: boolean
  /** Sends /compact (only invoked when the meter says the warning is actionable). */
  onCompact: () => void
}

/**
 * Context usage meter (mockup `.ctx`): the quiet ring at rest, upstream's 28px info-tint chip at the
 * warning, with the same compact-on-click action as before.
 */
export function ContextUsageChip({ meter, usage, showMeter = true, onCompact }: ContextUsageChipProps) {
  const { t } = useTranslation()
  const percent = meter.windowPercent
  const combined = meter.thresholdPercent !== null
    ? t('chat.contextUsage.combined', { percent, threshold: meter.thresholdPercent })
    : null
  const label = combined !== null && meter.warning ? combined : t('chat.contextUsage.label', { percent })

  const detail = (
    <div className="space-y-0.5">
      <div>{combined ?? t('chat.contextUsage.label', { percent })}</div>
      <div className="text-tertiary">
        {t('chat.contextUsage.tooltip', {
          used: Math.round(usage.inputTokens / 1000),
          window: Math.round(usage.contextWindow / 1000),
        })}
      </div>
      {/* The window is a fabricated default, not something the model reported. Saying so is the
          difference between a healthy-looking ring and knowing the real window might be far smaller. */}
      {usage.estimatedWindow && <div className="text-tertiary">{t('chat.contextUsage.estimatedWindow')}</div>}
      {meter.warning && (
        <div>{meter.actionable ? t('chat.contextUsage.clickToCompact') : t('chat.contextUsage.waitForOperation')}</div>
      )}
    </div>
  )

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        {meter.warning ? (
          <button
            type="button"
            onClick={() => {
              if (meter.actionable) onCompact()
            }}
            disabled={!meter.actionable}
            aria-label={label}
            data-state="warning"
            className={cn(
              'input-toolbar-btn motion-press inline-flex h-control shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5',
              showMeter && 'pl-2 @max-[32rem]/panel:pl-2.5',
              'bg-info-tint text-label-sm font-medium tabular-nums text-info select-none',
              meter.actionable ? 'state-overlay' : 'cursor-default',
            )}
          >
            {/* The ring is decoration next to the percent: dropped in narrow panels to save toolbar room */}
            {showMeter && <span className="flex @max-[32rem]/panel:hidden"><UsageRing percent={percent} /></span>}
            {percent}%
          </button>
        ) : (
          <span
            role="img"
            aria-label={label}
            data-state="quiet"
            className="inline-flex h-control shrink-0 items-center justify-center px-1.5 text-tertiary"
          >
            <UsageRing percent={percent} />
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px]">
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}
