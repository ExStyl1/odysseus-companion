import { navigate, routes, type Route } from '@/lib/navigate'
import { dispatchFocusInputEvent } from '@/components/app-shell/input/focus-input-events'
import { credentialSetupRoute } from '@/lib/credential-sign-in'
import type { Message } from '../../../shared/types'

export type ErrorMessageAction = NonNullable<Message['errorActions']>[number]

export interface HandleErrorMessageActionOptions {
  sessionId?: string
  /**
   * D1.272 — the session's LLM connection, so `reauth` can open THAT
   * connection's own setup (D1.254's route segment) instead of the settings
   * navigator. Absent is a real case and not a defect: a session that names no
   * connection lands on the AI settings page, which is where the backend's own
   * `settings` action landed before either row.
   */
  connectionSlug?: string
  onOpenUrl?: (url: string) => void
  onOpenSettings?: () => void
  onReauth?: (route: Route) => void
  onRetryFocus?: (detail?: { sessionId?: string }) => void
  onRetry?: () => void
  /** Where an action this handler cannot run is reported. Injected so the refusal is testable. */
  onUnhandled?: (action: ErrorMessageAction) => void
}

/**
 * Execute an error-message action using the app's canonical handlers.
 *
 * Retry intentionally routes through the session-scoped focus event system
 * instead of querying the DOM, which is fragile in multi-panel mode and
 * no longer matches the RichTextInput implementation.
 *
 * ## D1.272 — nothing falls through silently any more
 *
 * The wire union (`packages/core/src/types/message.ts`) was five members and
 * this handler ran three of them. `reauth` — declared by `expired_oauth_token`'s
 * `ERROR_DEFINITIONS` entry FIRST, ahead of its settings action, and produced on
 * claude since D1.194 — reached the end of the function and returned, so the
 * card's own sign-in button worked while the button beside it did nothing at
 * all, with no error anywhere.
 *
 * ## D1.293 — the union is FOUR members now, and this handler runs all of them
 *
 * The fifth was declared by the wire and produced by nothing; it is retired
 * rather than given a destination (the reasoning is on the wire type). So the
 * only shape left that cannot be EXECUTED here is an entry with no `action` at
 * all, and it is reported rather than dropped. D1.283 closed its one live
 * example and left this arm standing: `token_expired`'s *Open workspace menu*
 * declared `command: '/workspace'` and no `action`, the wire dropped `command`
 * at the mapper, and `/workspace` turned out to be a command this product does
 * not have. The wire carries `command` now (so this refusal can NAME it) and
 * `ERROR_DEFINITIONS` gives every action an executable `action`, guarded by
 * `errors.test.ts`. A command-only entry is therefore a producer defect, and
 * this reports it as one rather than dispatching a slash command from an error
 * card — which would be a second dispatch path for a case that now has no
 * producer.
 *
 * It reaches `onUnhandled`, whose default writes one console line naming the
 * action. A dead button that says so in the log is what turns the next report of
 * this class into a five-minute read instead of the census this row was.
 */
export function handleErrorMessageAction(
  action: ErrorMessageAction,
  {
    sessionId,
    connectionSlug,
    onOpenUrl,
    onOpenSettings = () => navigate(routes.view.settings()),
    onReauth = route => navigate(route),
    onRetryFocus = dispatchFocusInputEvent,
    onRetry,
    onUnhandled = unhandled => {
      console.error(
        '[error-actions] no handler for error action',
        unhandled.action ?? (unhandled.command ? `(command-only ${unhandled.command})` : '(no action, no command)'),
        unhandled,
      )
    },
  }: HandleErrorMessageActionOptions = {},
): void {
  if (action.action === 'open_url') {
    if (action.url && onOpenUrl) {
      onOpenUrl(action.url)
      return
    }
    // A URL-less `open_url`, or a caller with no opener: the button is dead for
    // a reason this handler cannot fix, and saying so is the row.
    onUnhandled(action)
    return
  }

  if (action.action === 'settings') {
    onOpenSettings()
    return
  }

  if (action.action === 'reauth') {
    onReauth(credentialSetupRoute(connectionSlug))
    return
  }

  if (action.action === 'retry') {
    if (onRetry) {
      onRetry()
    } else {
      onRetryFocus({ sessionId })
    }
    return
  }

  // D1.293 — the compile-time absence pin, and it is the whole reason retiring a
  // wire member is safe to do quietly. Every member of the union has a branch
  // above, so what reaches here is narrowed to `undefined` — the command-only
  // shape. A member added to the wire without a branch here widens this to
  // `'<new member>' | undefined` and the assignment is a type error on this
  // line, which is the same ratchet D1.252 built with a `never` binding (that
  // spelling cannot be used here: `action` is optional, so the residue is
  // `undefined` rather than `never`).
  const unhandledActionCode: undefined = action.action
  void unhandledActionCode
  onUnhandled(action)
}
