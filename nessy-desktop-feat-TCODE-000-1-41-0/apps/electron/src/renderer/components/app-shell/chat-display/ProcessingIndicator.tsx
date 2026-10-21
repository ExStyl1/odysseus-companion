/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/chat-display/ProcessingIndicator.tsx
 * (craft-agents-oss, Apache-2.0; ADDED in v0.15.0, identical in v0.15.1). UB14.15 (R2-10): taken, then
 * OUR hunks re-applied from the inline indicator `ChatDisplay.tsx` carried until this row:
 * - P6.274 (b) — the `statusType === 'retrying'` arm: the retry line is assembled from its parts and its
 *   wait TICKS from the arrival of the status, keyed on the status so the countdown never re-fades;
 * - P6.916 — the producer's own `retry` facts, preferred over re-reading `statusMessage`;
 * - P6.424 — the plugin SPINNER TIP, a second line under the label, never in its place.
 */
import * as React from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { Spinner } from "@nessy-agent/ui"
import { TWEEN } from "@nessy-agent/ui/motion"
import { formatRetryStatus, retryCountdownSeconds, retryFactsFor, type RetryStatusFacts } from "@/event-processor/retry-status"
import { PluginSuggestionTip, type PluginSuggestionTipData } from "../plugin-suggestion-tip"

/**
 * Processing status messages - cycles through these randomly
 * Inspired by Claude Code's playful status messages
 */
export const PROCESSING_MESSAGE_KEYS = [
  'chat.processing.thinking',
  'chat.processing.pondering',
  'chat.processing.contemplating',
  'chat.processing.reasoning',
  'chat.processing.processing',
  'chat.processing.computing',
  'chat.processing.considering',
  'chat.processing.reflecting',
  'chat.processing.deliberating',
  'chat.processing.cogitating',
  'chat.processing.ruminating',
  'chat.processing.musing',
  'chat.processing.workingOnIt',
  'chat.processing.onIt',
  'chat.processing.crunching',
  'chat.processing.brewing',
  'chat.processing.connectingDots',
  'chat.processing.mullingItOver',
  'chat.processing.deepInThought',
  'chat.processing.hmm',
  'chat.processing.letMeSee',
  'chat.processing.oneMoment',
  'chat.processing.holdOn',
  'chat.processing.bearWithMe',
  'chat.processing.justASec',
  'chat.processing.hangTight',
  'chat.processing.gettingThere',
  'chat.processing.almost',
  'chat.processing.working',
  'chat.processing.busyBusy',
  'chat.processing.whirring',
  'chat.processing.churning',
  'chat.processing.percolating',
  'chat.processing.simmering',
  'chat.processing.cooking',
  'chat.processing.baking',
  'chat.processing.stirring',
  'chat.processing.spinningUp',
  'chat.processing.warmingUp',
  'chat.processing.revving',
  'chat.processing.buzzing',
  'chat.processing.humming',
  'chat.processing.ticking',
  'chat.processing.clicking',
  'chat.processing.whizzing',
  'chat.processing.zooming',
  'chat.processing.zipping',
  'chat.processing.chugging',
  'chat.processing.trucking',
  'chat.processing.rolling',
]

/**
 * Format elapsed time: "45s" under a minute, "1:02" for 1+ minutes
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export interface ProcessingIndicatorProps {
  /** Start timestamp (persists across remounts) */
  startTime?: number
  /** Override cycling messages with explicit status (e.g., "Compacting...") */
  statusMessage?: string
  /**
   * P6.274 (b) — which KIND of status the line is, so the retry arm can be told
   * from the compacting one without reading the prose. `'retrying'` is the only
   * value this component branches on; every other status keeps rendering the
   * producer's line verbatim.
   */
  statusType?: string
  /**
   * P6.916 — the retry's own facts, when the producer sent them. Preferred over
   * re-reading them out of `statusMessage`, which is now the fallback for a
   * replayed or field-less line.
   */
  retry?: RetryStatusFacts
  /**
   * P6.424 — the plugin SPINNER TIP, the third of the page's three suggestion
   * surfaces.
   *
   * `plugin-relevance.md` § What the user sees: "**Spinner tip**: a "Working
   * with *topic*? Install the *plugin* plugin" message with the `/plugin
   * install` command appears below the spinner while Claude is responding."
   * Below the spinner, not instead of it — which is why this is a second line
   * rather than a `statusMessage`: the cycling label is the session telling the
   * user it is working, and replacing it would trade a live signal for an
   * advertisement.
   *
   * `{ topic, reference }` are `selectPluginSuggestion`'s own output fields
   * (`shared/marketplace/plugin-suggestion.ts`), so the tip and the session-start
   * notice name the same plugin from the same decision. Optional on purpose:
   * with no managed `pluginSuggestionMarketplaces` there is no
   * suggestion-allowed marketplace at all, which is the shipped default.
   */
  suggestion?: PluginSuggestionTipData
}

/**
 * ProcessingIndicator - the live line while a turn runs (spec §6.4, visual part): a 28px row
 * with the working spinner on the work log's icon column, the status label in secondary and
 * the elapsed time in tertiary tabular figures. A new label fades in (150ms) in place — no
 * crossfade that waits for the old one to leave.
 */
export function ProcessingIndicator({ startTime, statusMessage, statusType, retry, suggestion }: ProcessingIndicatorProps) {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = React.useState(0)
  const [messageIndex, setMessageIndex] = React.useState(() =>
    Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
  )

  // Update elapsed time every second using provided startTime
  React.useEffect(() => {
    const start = startTime || Date.now()
    // Set initial elapsed immediately
    setElapsed(Math.floor((Date.now() - start) / 1000))

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startTime])

  // Cycle through messages every 10 seconds (only when not showing status)
  React.useEffect(() => {
    if (statusMessage) return  // Don't cycle when showing status
    const interval = setInterval(() => {
      setMessageIndex(prev => {
        // Pick a random different message
        let next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        while (next === prev && PROCESSING_MESSAGE_KEYS.length > 1) {
          next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        }
        return next
      })
    }, 10000)
    return () => clearInterval(interval)
  }, [statusMessage])

  // P6.274 (b) — a retry line is the one status assembled from its parts rather
  // than echoed: the attempt and the reason come from the producer's own words
  // (see `event-processor/retry-status.ts`) and the wait TICKS instead of
  // standing at the figure it was published with, which read as a frozen turn.
  //
  // The anchor is the ARRIVAL of this message. Each rung of the ladder
  // (15/30/60/60/60s) republishes its own line, so a new message resets the
  // clock and a superseded rung can never keep counting; the elapsed timer
  // above already re-renders this component once a second, which is what makes
  // the label move without a second interval.
  const retryFacts = React.useMemo(
    () => retryFactsFor(statusType, statusMessage, retry),
    [statusType, statusMessage, retry],
  )
  const [retryArrivedAt, setRetryArrivedAt] = React.useState<number | null>(() => (retryFacts ? Date.now() : null))
  React.useEffect(() => {
    setRetryArrivedAt(retryFacts ? Date.now() : null)
  }, [statusMessage, retryFacts])

  // Use status message if provided, otherwise cycle through default messages
  const retryLabel = retryFacts && retryArrivedAt !== null
    ? formatRetryStatus(retryFacts, retryCountdownSeconds(retryFacts, retryArrivedAt, Date.now()), t)
    : null
  const displayMessage = retryLabel || statusMessage || t(PROCESSING_MESSAGE_KEYS[messageIndex])

  return (
    <div className="min-w-0" data-testid="processing-indicator">
      <div className="flex min-h-7 min-w-0 items-center gap-2 text-label text-secondary">
        {/* Spinner on the same column as the work log chevron and row icons */}
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Spinner className="text-caption text-accent" />
        </span>
        <motion.span
          // P6.274 (b) — a ticking countdown changes `displayMessage` every second;
          // keyed on the text, the fade would re-run once a second. The retry line
          // is ONE label whose seconds move, so it keys on the status instead.
          key={retryFacts ? `retry:${statusMessage}` : displayMessage}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={TWEEN.fast}
          className="min-w-0 truncate"
        >
          {displayMessage}
        </motion.span>
        {elapsed >= 1 && (
          <span className="shrink-0 text-label-sm tabular-nums text-tertiary">
            {formatElapsed(elapsed)}
          </span>
        )}
      </div>
      {/* P6.424 — the tip sits BELOW the spinner line and never replaces it. */}
      {suggestion && <PluginSuggestionTip topic={suggestion.topic} reference={suggestion.reference} />}
    </div>
  )
}
