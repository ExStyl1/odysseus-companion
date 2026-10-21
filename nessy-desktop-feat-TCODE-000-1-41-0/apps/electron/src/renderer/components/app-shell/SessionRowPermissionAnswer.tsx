/**
 * P6.589 — answering a blocked session from the session list, ONCE.
 *
 * ## What already existed, and what did not
 *
 * The row was born from P6.270's `done_means (b)`: a session waiting on a
 * permission is already MARKED in the list — `sessionAttentionState` returns
 * `'waiting'` and `SessionItem` renders a label naming what is waiting — and
 * the transport is already there too: `onRespondToPermission` sits on the
 * AppShell context and `usePendingPermission(sessionId)` hands any component
 * the pending request. What did not exist was the control, its copy, and the
 * rule below.
 *
 * ## The rule: one-shot only, and the always-allow choice is SUPPRESSED
 *
 * Controller decision under the delegation, and it is the reason this component
 * exists separately rather than as a fourth branch of the chat's own permission
 * card: **a permission answered without seeing the conversation must never
 * widen the session.** The chat card can offer "always allow" because the user
 * answering it is looking at the tool call, its arguments and the turn that
 * produced them. A list row shows a tool NAME. Granting a standing permission
 * from that is granting it blind.
 *
 * So `alwaysAllow` is passed as `false` — a literal, never a prop, never a
 * variable — and the hint says so, because a missing button is an absence and a
 * user cannot tell an absence from an oversight. That is the transparency half:
 * the narrowing is stated where it applies.
 *
 * ## Where it deliberately renders nothing
 *
 * - **`ask_user`.** That prompt is a QUESTION with an answer the user types
 *   (`AskUserPermissionRequest`); approve/deny would answer a question that was
 *   never yes-or-no. The row's label already says "Waiting for you: a question"
 *   and the session is one click away.
 * - **No handler.** `onRespondToPermission` is optional on the context, and a
 *   button that silently does nothing is worse than no button.
 * - **No pending request.** The common case, and the one this must be cheap in:
 *   the list re-renders often and every non-waiting row exits on the first line.
 *
 * ## Why the clicks stop propagating
 *
 * The row itself is a navigation target. Without `stopPropagation` an Allow
 * would also open the session, so the one action the user took would be
 * followed by a second they did not — and on Deny, the session they were sent
 * to is the one they just declined to help.
 *
 * F1.354 — and the row selects on MOUSEDOWN (SessionItem's `handleClick` is
 * EntityRow's `onMouseDown`), which the group used not to stop: a mousedown on
 * Allow bubbled out and opened the session anyway. The group now stops
 * mousedown too. The two controls are `span role="button"` rather than
 * `<button>`: this control renders in EntityRow's `badges` slot, INSIDE the
 * row's own `<button>`, and a button in a button is invalid markup (React warns
 * `validateDOMNesting` on every waiting row). It is the SessionStatusIcon trade
 * — tabIndex, Enter and Space put back by hand.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PermissionRequest } from '../../../shared/types'

/** The context handler's shape, named once so the seam below can be tested. */
export type RespondToPermission = (
  sessionId: string,
  requestId: string,
  allowed: boolean,
  alwaysAllow: boolean,
) => void

/**
 * THE decision, in one named function so it is assertable rather than buried in
 * a JSX closure: an answer given from a list row is one-shot, always.
 *
 * `false` is a literal here and appears nowhere else in this module — not as a
 * prop, not as a variable, not as a default. A future caller cannot widen it
 * without deleting this function, which is the point.
 */
export function answerOnce(
  onRespond: RespondToPermission,
  sessionId: string,
  requestId: string,
  allowed: boolean,
): void {
  onRespond(sessionId, requestId, allowed, false)
}

export interface SessionRowPermissionAnswerProps {
  /** The session the row belongs to. */
  sessionId: string
  /** `usePendingPermission(sessionId)` — the first prompt in that session's queue. */
  request: PermissionRequest | undefined
  /**
   * `AppShellContext.onRespondToPermission`. The fourth argument is the
   * always-allow flag and this component always passes `false`; the signature is
   * accepted whole rather than narrowed so the context value can be handed
   * straight in.
   */
  onRespond?: RespondToPermission
  className?: string
}

export function SessionRowPermissionAnswer({
  sessionId,
  request,
  onRespond,
  className,
}: SessionRowPermissionAnswerProps) {
  const { t } = useTranslation()

  if (!request || !onRespond) return null
  // A question is not a yes-or-no. See the header.
  if (request.type === 'ask_user') return null

  const answer = (event: React.SyntheticEvent, allowed: boolean) => {
    event.preventDefault()
    event.stopPropagation()
    answerOnce(onRespond, sessionId, request.requestId, allowed)
  }
  // F1.1230 — an ask carrying the Claude Agent SDK's `defaultToNo` hint ("a single stray keystroke must not approve
  // this", `agent-sdk/typescript.md#canusetool`) gets Deny only here: allowing it takes the session's own card
  // (F1.1219), one click away, and the hint says so — a missing button must not read as an oversight.
  const denyOnly = request.defaultToNo === true
  // Enter/Space activate a <button> natively; a span has to say so (F1.354).
  const answerByKey = (event: React.KeyboardEvent, allowed: boolean) => {
    if (event.key === 'Enter' || event.key === ' ') answer(event, allowed)
  }

  return (
    <div
      className={cn('flex items-center gap-1 shrink-0', className)}
      title={t(denyOnly ? 'session.answer.defaultToNoHint' : 'session.answer.hint')}
      role="group"
      aria-label={t('session.answer.label')}
      // A pointer-down OR a mousedown on the group must not start the row's
      // selection (the row selects on mousedown); the click handlers below only
      // see the click.
      onPointerDown={event => { event.stopPropagation() }}
      onMouseDown={event => { event.stopPropagation() }}
    >
      {!denyOnly && (
        <span
          role="button"
          tabIndex={0}
          className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] text-success hover:bg-success/10 cursor-pointer"
          onClick={event => { answer(event, true) }}
          onKeyDown={event => { answerByKey(event, true) }}
        >
          <Check className="w-3 h-3" />
          {t('session.answer.allowOnce')}
        </span>
      )}
      <span
        role="button"
        tabIndex={0}
        className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted cursor-pointer"
        onClick={event => { answer(event, false) }}
        onKeyDown={event => { answerByKey(event, false) }}
      >
        <X className="w-3 h-3" />
        {t('session.answer.deny')}
      </span>
    </div>
  )
}
