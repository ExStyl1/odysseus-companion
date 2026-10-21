/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/SendButton.tsx (ADDED in v0.15.0,
 * unchanged in v0.15.1; UB14.28, R4-08). ADAPTED: upstream's material and `data-state` morph, over OUR
 * four-state control instead of upstream's Send/Stop pair.
 *
 * Taken from upstream: the round `primary` icon button, the same 28px as the toolbar chips beside it
 * (36px ≤ 768px via the `send-btn` hook, like the chips' `input-toolbar-btn`); neutral while empty
 * (the primary's disabled fill), solid accent when ready, and the SAME solid accent as Stop while a
 * turn runs — the control morphs instead of going grey, so a running turn reads as live and
 * stoppable; press scales to .94 (spec §6.3).
 *
 * Re-applied (ours, named so the next port does not "simplify" them away):
 * - the mode is {@link SubmitMode} from `./submit-control` (codex wave 2.7): Send, Queue, Steer, Stop,
 *   or Loading, each with its own name (`chat.submit.*`; upstream says `chat.stopResponse` /
 *   `shortcuts.sendMessage`, two states only);
 * - `inert`: an explicit Stop that is still in flight stays a Stop and does NOT act on a press (L11;
 *   a second press would re-issue the stop and append the restored prompt twice) — see
 *   {@link resolveSendButtonPress};
 * - the spinner: `loading` (a composer over a session the host does not own, F1.92/D1.397) and a
 *   running `!cmd` shell command;
 * - the tooltip: the blocked reason when the control is disabled; on Queue/Steer the Enter and Esc Esc
 *   keys, plus the one-message override line (P6.946) — hidden while files are staged (F1.331) or a
 *   queued row the host will not steer is waiting (F1.481 (3)). The caller decides that gate and passes
 *   the override's direction from `otherMidStreamBehavior(midStreamDefault)`, the expression its key
 *   handler sends with, so the tooltip and the send cannot disagree;
 * - `data-tutorial="send-button"` on EVERY state, not only Send: the CDP drivers find the Stop by
 *   `button[data-tutorial="send-button"][type="button"]` (`scripts/cdp/lib/mid-stream.ts`).
 *
 * Imports are the barrel-free subpaths (`@nessy-agent/ui/ui/tooltip`, `…/ui/LoadingIndicator`, P6.844)
 * so `bun test` can render this file — the `@nessy-agent/ui` barrel resolves a pdfjs worker URL bun
 * cannot.
 */
import { useTranslation } from 'react-i18next'
import { ArrowUp, Square } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@nessy-agent/ui/ui/tooltip'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import type { MidStreamBehavior } from '@nessy-agent/shared/config/llm-connections'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { SubmitMode } from './submit-control'

const SEND_BASE = 'send-btn shrink-0 rounded-full enabled:active:[transform:scale(calc(1_-_0.06*var(--motion-scale)))]'

/** The one-message override row of the Queue/Steer tooltip (P6.946). */
export interface MidStreamOverrideHint {
  /** The registry's DISPLAY form of `chat.sendWithOtherFollowUp` (never a literal chord). */
  hotkey: string
  /** What the chord does to THIS message: `otherMidStreamBehavior(midStreamDefault)`. */
  behavior: MidStreamBehavior
}

export interface SendButtonProps {
  /** What the control is now, from `resolveSubmitControl`. */
  mode: SubmitMode
  /** The control must not act on a press (a stop in flight, or a stop-disabled composer waiting). */
  inert: boolean
  /** No press is possible: inert, or nothing to send / blocked (the caller's `submitDisabled`). */
  disabled: boolean
  /** A `!cmd` shell command is running: the spinner stands in for the arrow. */
  busy?: boolean
  /** Why a disabled control is disabled; `null` when the reason is the stop in flight. */
  blockReason?: string | null
  /** The override row, or `null` when there is no chord or it would name the wrong effect. */
  midStreamOverride?: MidStreamOverrideHint | null
  onStop: () => void
}

/**
 * The press handler. Only a LIVE Stop acts on a click; an inert Stop has no handler at all (and is
 * disabled), and Send/Queue/Steer reach the form's own submit through `type="submit"`.
 */
export function resolveSendButtonPress(mode: SubmitMode, inert: boolean, onStop: () => void): (() => void) | undefined {
  return mode === 'stop' && !inert ? onStop : undefined
}

/** Upstream's `data-state` hook (`stop` / `idle` / `ready`), plus our `loading`. */
export function sendButtonState(mode: SubmitMode, disabled: boolean): 'stop' | 'loading' | 'idle' | 'ready' {
  if (mode === 'stop') return 'stop'
  if (mode === 'loading') return 'loading'
  return disabled ? 'idle' : 'ready'
}

type Translate = ReturnType<typeof useTranslation>['t']

function sendButtonLabel(mode: SubmitMode, t: Translate): string {
  return mode === 'loading' ? t('chat.processing.thinking') : t(`chat.submit.${mode}`)
}

/** The tooltip's content; exported so a test can render it (the tooltip itself is portalled). */
export function SendButtonTooltipBody({
  mode,
  disabled,
  blockReason = null,
  midStreamOverride = null,
}: Pick<SendButtonProps, 'mode' | 'disabled' | 'blockReason' | 'midStreamOverride'>) {
  const { t } = useTranslation()
  if (disabled && blockReason) return <>{blockReason}</>
  if (mode !== 'queue' && mode !== 'steer') return <>{sendButtonLabel(mode, t)}</>
  return (
    <div className="grid grid-cols-[auto_auto] items-center gap-x-2 gap-y-1">
      <span>{mode === 'queue' ? t('chat.submit.queue') : t('chat.submit.steer')}</span>
      <Kbd className="justify-self-end">Enter</Kbd>
      <span className="text-tertiary">{t('chat.submit.stop')}</span>
      <Kbd className="justify-self-end">Esc Esc</Kbd>
      {midStreamOverride && (
        <>
          {/* P6.946 — the one-message override, named by its EFFECT (the caller's direction). */}
          <span className="text-tertiary">
            {midStreamOverride.behavior === 'steer'
              ? t('chat.midStream.overrideSteer')
              : t('chat.midStream.overrideQueue')}
          </span>
          <Kbd className="justify-self-end">{midStreamOverride.hotkey}</Kbd>
        </>
      )}
    </div>
  )
}

export function SendButton({
  mode,
  inert,
  disabled,
  busy = false,
  blockReason = null,
  midStreamOverride = null,
  onStop,
}: SendButtonProps) {
  const { t } = useTranslation()
  const blocked = disabled && !!blockReason

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        {/* A disabled button fires no pointer events, so the tooltip hangs on this wrapper. */}
        <span className="inline-flex shrink-0">
          <Button
            type={mode === 'stop' || mode === 'loading' ? 'button' : 'submit'}
            variant="primary"
            size="icon"
            aria-label={sendButtonLabel(mode, t)}
            data-state={sendButtonState(mode, disabled)}
            data-mode={mode}
            data-tutorial="send-button"
            className={SEND_BASE}
            disabled={disabled}
            onClick={resolveSendButtonPress(mode, inert, onStop)}
          >
            {mode === 'stop'
              ? <Square className="size-2.5 fill-current" />
              : busy || mode === 'loading'
                ? <Spinner className="size-4" />
                : <ArrowUp className="size-4" />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className={blocked ? 'max-w-36 text-center text-pretty' : undefined}>
        <SendButtonTooltipBody
          mode={mode}
          disabled={disabled}
          blockReason={blockReason}
          midStreamOverride={midStreamOverride}
        />
      </TooltipContent>
    </Tooltip>
  )
}
