/**
 * The composer's context indicator, in the state where there is no context
 * window to draw a share of.
 *
 * P3.32 fixed the first of two silences on an unresolvable window: a session
 * that will never auto-compact now says so once, at session start, in the
 * honest-degradation register — it names the model, says compaction is OFF, and
 * says what to do about it. The composer was the second silence and the one the
 * user actually looks at: `resolveContextMeterState` returns `null` there, so
 * the toolbar showed empty space for the remaining hours of the session, which
 * reads as "nothing to report".
 *
 * This is the same refusal-to-pretend one surface further on. It renders only
 * when {@link isContextWindowUnknown} — an occupancy is being counted and no
 * window bounds it — and it renders an INDETERMINATE indicator: a broken ring
 * with a `?`, never a zero-filled donut (reads as "plenty of room", the exact
 * opposite of what is true) and never a full one (claims a measurement nobody
 * made).
 *
 * Accessibility, because this is a status indicator rather than decoration:
 * - the shape carries the state (broken ring + glyph), so it survives a
 *   monochrome or colour-blind reading — no arc is recoloured to mean anything;
 * - the whole sentence is the accessible name, so a screen reader gets it
 *   without hovering anything;
 * - the trigger is focusable, so the explanation is reachable from the keyboard
 *   and not by pointer hover alone.
 *
 * The decision lives in the pure `context-meter-state` module, where it is
 * tested directly. UB14.28 moved the tooltip import to the barrel-free subpath
 * (`@nessy-agent/ui/ui/tooltip`; the `@nessy-agent/ui` barrel resolves a pdfjs
 * worker URL `bun test` cannot), so this file now RENDERS under `bun test` as
 * well as being asserted at source level; its glyph is `ContextUsageChip`'s
 * {@link UnknownUsageRing}, on the same geometry as the drawn ring, and the
 * trigger wears the quiet ring's material (v0.15.1's `text-tertiary`, 28px).
 */
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@nessy-agent/ui/ui/tooltip'
import { UnknownUsageRing } from './ContextUsageChip'
import { isContextWindowUnknown, type ContextMeterInput } from './context-meter-state'

export function ContextMeterUnknownWindow({ input }: { input: ContextMeterInput }) {
  const { t } = useTranslation()
  if (!isContextWindowUnknown(input)) return null

  const label = t('chat.contextUsage.unknownWindow')
  const detail = t('chat.contextUsage.unknownWindowDetail')

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span
          role="img"
          // Both halves, because the tooltip is pointer-only and this is the
          // channel that is not.
          aria-label={`${label} ${detail}`}
          tabIndex={0}
          data-state="unknown"
          className="inline-flex h-control shrink-0 items-center justify-center rounded-full px-1.5 text-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
        >
          <UnknownUsageRing />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px]">
        <div className="space-y-0.5">
          <div>{label}</div>
          <div className="text-tertiary">{detail}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
