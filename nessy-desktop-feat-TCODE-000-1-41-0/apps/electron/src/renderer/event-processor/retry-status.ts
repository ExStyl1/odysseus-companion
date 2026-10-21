/**
 * P6.274 (b) / P6.916 — the attempt number, the specific reason and a countdown
 * that actually counts down.
 *
 * ## The facts are a FIELD now; this parse is the fallback
 *
 * (b) landed when the internal `AgentEvent` `status` branch was
 * `{ required: ['message'], optional: [] }`, so all three producers said the
 * attempt, the cause and the wait in ONE string and this module read them back
 * out with a regex. P6.916 gave that branch an optional `retry` field:
 * `retryStatusEvent` in `@nessy-agent/core/types` mints the payload AND the
 * sentence from one vocabulary, `SessionManager` stamps `statusType: 'retrying'`
 * off the field rather than off three `startsWith` calls, and the wire carries
 * `retry` beside `message`.
 *
 * So {@link parseRetryStatus} is no longer the route — it is the FALLBACK, and
 * it is kept for two reasons rather than out of caution: a status replayed from
 * a persisted transcript carries only its text, and a client (or a session
 * opened against an older server) may deliver a retry line with no field. Both
 * of those still deserve the chip. {@link RETRY_STATUS_PREFIXES} is re-exported
 * from core so the grammar this parse reads and the grammar the producers write
 * are literally the same constant.
 *
 * ## The vocabulary, and where each part of it is produced
 *
 * - `Rate limited by the provider` / `Provider error` / `Retry succeeded` —
 *   the three heads. Pi produces the first two from `auto_retry_start` and the
 *   third from `auto_retry_end`
 *   (`shared/src/agent/backend/pi/event-adapter.ts`); claude's
 *   `buildRetryFacts` produces the first two from `api_retry`; codex's
 *   `codexRetryFacts` produces them from `ErrorNotification`.
 *   Since P6.917 all THREE runtimes produce the third: neither vendor publishes
 *   a retry-resolution event (measured against the vendored `sdk.d.ts` and
 *   codex's `ErrorNotification`), so claude and codex infer it from the first
 *   assistant delta after a retry and say the same words Pi says.
 * - `(<cause>)` — the runtime's OWN word for the cause, when it gave one.
 *   Never a taxonomy of ours: claude passes the SDK's `error` code, pi passes
 *   the first clause of the provider's own message. A runtime that names no
 *   cause gets no parenthesis rather than a guess.
 * - `retry <n>[/<max>]` and `in <s>s` — the attempt and the wait. codex's
 *   `ErrorNotification` is `{ error, willRetry, threadId, turnId }` and carries
 *   neither, so P6.274 (b) gives a codex retry an attempt this host COUNTED for
 *   the turn in flight — with no `/max`, because no budget was published — and
 *   still no countdown. That is the line: a number we observed may be shown, a
 *   number nobody published is one the user could check and find wrong.
 */

import {
  RETRY_STATUS_PREFIXES,
  type AgentRetryFacts,
  type RetryStatusKind,
} from '@nessy-agent/core/types'

export { RETRY_STATUS_PREFIXES }
export type { RetryStatusKind }

/**
 * The renderer's name for the shape the wire carries. One declaration, in core,
 * so a field cannot be added to the event and missed here.
 */
export type RetryStatusFacts = AgentRetryFacts

/**
 * `<prefix>[ (<cause>)][ — retry <n>[/<max>]][ in <s>s]`, and nothing else is
 * accepted: a status that is not one of the three is not a retry, and reading
 * an attempt out of an arbitrary line is how a chip states a false fact.
 *
 * The FALLBACK route — prefer the event's own `retry` field; see this module's
 * header for when this one still runs.
 */
const ATTEMPT_PATTERN = /\bretry (\d+)(?:\/(\d+))?/
const DELAY_PATTERN = /\bin (\d+)s\b/
const CAUSE_PATTERN = /^\s*\(([^)]{1,120})\)/

export function parseRetryStatus(message: string): RetryStatusFacts | null {
  for (const kind of Object.keys(RETRY_STATUS_PREFIXES) as RetryStatusKind[]) {
    const prefix = RETRY_STATUS_PREFIXES[kind]
    if (!message.startsWith(prefix)) continue
    const rest = message.slice(prefix.length)
    const cause = CAUSE_PATTERN.exec(rest)?.[1]?.trim()
    const attemptMatch = ATTEMPT_PATTERN.exec(rest)
    const delayMatch = DELAY_PATTERN.exec(rest)
    const attempt = attemptMatch ? Number(attemptMatch[1]) : undefined
    const maxAttempts = attemptMatch?.[2] ? Number(attemptMatch[2]) : undefined
    const delaySeconds = delayMatch ? Number(delayMatch[1]) : undefined
    return {
      kind,
      ...(cause ? { cause } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    }
  }
  return null
}

/**
 * The facts for a status, preferring the ones the producer sent.
 *
 * `statusType === 'retrying'` and a `retry` field always arrive together since
 * P6.916 — `SessionManager` stamps the one off the other — so the parse runs
 * only for a replayed or field-less line.
 */
export function retryFactsFor(
  statusType: string | undefined,
  message: string | undefined,
  retry: RetryStatusFacts | undefined,
): RetryStatusFacts | null {
  if (retry) return retry
  if (statusType !== 'retrying' || !message) return null
  return parseRetryStatus(message)
}

/**
 * The seconds still to wait, or `null` when the runtime announced no wait.
 *
 * Anchored on when the status ARRIVED rather than on the turn's start: the
 * ladder is 15/30/60/60/60s and each rung republishes its own line, so the
 * anchor moves with the message and a stale rung can never keep counting.
 */
export function retryCountdownSeconds(
  facts: RetryStatusFacts,
  arrivedAt: number,
  now: number,
): number | null {
  if (facts.delaySeconds === undefined) return null
  const spent = Math.floor(Math.max(0, now - arrivedAt) / 1000)
  return Math.max(0, facts.delaySeconds - spent)
}

/**
 * The chip's label, assembled from the parts rather than echoed.
 *
 * The head stays the producer's own English — it is the runtime speaking, and
 * translating it here would put a word in the provider's mouth — while the
 * attempt and the countdown are the renderer's own sentence and are localised.
 * `remainingSeconds === null` means the runtime announced no wait (codex today),
 * and the label then stops after the attempt clause instead of showing a zero
 * that never moves.
 */
export function formatRetryStatus(
  facts: RetryStatusFacts,
  remainingSeconds: number | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const reason = RETRY_STATUS_PREFIXES[facts.kind]
  const head = facts.cause ? `${reason} (${facts.cause})` : reason
  if (facts.kind === 'succeeded') return head
  const parts: string[] = []
  if (facts.attempt !== undefined && facts.maxAttempts !== undefined) {
    parts.push(t('chat.retryStatus.attempt', { attempt: facts.attempt, max: facts.maxAttempts }))
  } else if (facts.attempt !== undefined) {
    parts.push(t('chat.retryStatus.attemptOnly', { attempt: facts.attempt }))
  }
  if (remainingSeconds !== null) {
    parts.push(
      remainingSeconds > 0
        ? t('chat.retryStatus.countdown', { seconds: remainingSeconds })
        : t('chat.retryStatus.imminent'),
    )
  }
  return parts.length > 0 ? `${head} — ${parts.join(' ')}` : head
}
