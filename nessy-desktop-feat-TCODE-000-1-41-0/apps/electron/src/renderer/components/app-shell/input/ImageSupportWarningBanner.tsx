/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/ImageSupportWarningBanner.tsx (UB14.22; taken, Apache-2.0).
 * Re-applied: the optional `onEnable` (no action without it), P6.584's `refusalSentence` quoted through
 * `chat.imageWarning.endpointSaid` (one step dimmer, `text-tertiary`, as it was one step dimmer before),
 * and our docblocks.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

export interface ImageSupportWarningBannerProps {
  /** Display name of the active model — interpolated into the message. */
  modelName: string
  /**
   * Click-handler for the inline "Enable image support" action.
   *
   * OPTIONAL, and absent is the meaningful case: the action writes
   * `supportsImages: true` onto the connection's model entry, which only
   * decides anything where the connection catalog is what the send consults.
   * Without a handler the banner is the warning alone.
   *
   * WHICH runtimes those are is `resolveStagedImagePolicy`'s decision and its
   * docblock's subject — read it there rather than here. This paragraph used to
   * name `claude-runtime` as the runtime whose adapter "drops image parts
   * whatever the catalog says"; that stopped being true at `30628c7d0` and the
   * sentence outlived it (P3.136), which is exactly the failure a second copy
   * of a rule invites.
   */
  onEnable?: () => void
  /**
   * P6.584 — the endpoint's own sentence, present only when this model's
   * "no images" was LEARNED from a refused turn.
   *
   * Absent is the ordinary case (declared, or defaulted), and then the banner
   * is exactly what it was. Quoting it is the whole visible half of the owner's
   * Q12 ruling: a flag written by pattern-matching a message must show the
   * message it matched, so a wrong match is legible to the person it affects
   * instead of being inferred from a silent boolean.
   */
  refusalSentence?: string
}

/**
 * Pre-flight banner shown above the chat input when the user has staged image
 * attachments while the active runtime declares it takes no image input.
 *
 * Rendering conditions live in the parent (`FreeFormInput`, via
 * `resolveStagedImagePolicy`); this component just draws the warning and, where
 * one is offered, the inline action. That action calls the same
 * `setModelSupportsImages` flow used by the model picker's per-row toggle, so the
 * two surfaces always agree on the connection's state.
 */
export function ImageSupportWarningBanner({
  modelName,
  onEnable,
  refusalSentence,
}: ImageSupportWarningBannerProps) {
  const { t } = useTranslation()
  return (
    <div className="mx-1.5 mt-1.5 flex items-center gap-2 rounded-lg bg-info-tint px-3 py-2 text-label-sm text-secondary">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-info" />
      <span className="flex-1 min-w-0">
        {t('chat.imageWarning.title', { modelName })}
        {refusalSentence && (
          <span className="mt-0.5 block break-words italic text-tertiary">
            {t('chat.imageWarning.endpointSaid', { sentence: refusalSentence })}
          </span>
        )}
      </span>
      {onEnable && (
        <button
          type="button"
          onClick={onEnable}
          className="min-h-control-sm shrink-0 font-medium text-foreground underline underline-offset-2"
        >
          {t('chat.imageWarning.action')}
        </button>
      )}
    </div>
  )
}
