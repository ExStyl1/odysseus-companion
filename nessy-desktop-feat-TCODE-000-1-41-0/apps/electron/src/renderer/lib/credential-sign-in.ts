/**
 * D1.194 — ONE sign-in affordance for an expired credential, whichever runtime
 * reported it.
 *
 * ## What the three runtimes did instead, measured at HEAD
 *
 *  - **claude** yields a `typed_error` whose only action is
 *    `{ label: 'Update credentials', command: '/settings', action: 'settings' }`,
 *    and `handleErrorMessageAction`'s `settings` branch navigates to the BARE
 *    settings route. So the user lands on a settings navigator and has to find
 *    the connection that failed — and the label is backend English in every
 *    locale.
 *  - **Pi** hands `onBackendAuthRequired(reason)` to `SessionManager`, which
 *    sent `{ type: 'info', level: 'error' }` — a transcript LINE, with no action
 *    at all. CLOSED by D1.194's Pi half: `announceBackendAuthRequired` sends a
 *    `typed_error` carrying `invalid_credentials`, so this card reaches that
 *    runtime too. (Described in the past tense on purpose — a comment asserting
 *    what a DIFFERENT module does today is the class P6.551 measured, and this
 *    one had already become false the commit after it was written.)
 *  - **the corporate credential** gets the real thing: `AuthRequestCard`'s dp
 *    variant, with the reason and one sign-in button (DP-1 / DA1.4).
 *
 * Three surfaces for one fact is the silent-divergence class AGENTS.md names,
 * and it is the row's complaint rather than an accident of implementation.
 *
 * ## The choice, made once and made HERE
 *
 * The card is selected by the ERROR CODE and by nothing else, so every runtime
 * that reports a credential failure gets the identical affordance the moment it
 * reports one — there is no per-runtime branch to keep in step, which is what
 * `capability variance is DATA, never renderer branches` means for this surface.
 * The four codes are the credential-shaped members of the wire union
 * (`ErrorCode` in `packages/core/src/types/message.ts`), read from it rather than
 * invented: a fifth spelling is a change to that union and will fail to compile
 * against this list's own test instead of silently rendering nothing.
 *
 * ## Why a route and not a handler
 *
 * The button opens the CONNECTION'S OWN setup, which D1.254 made expressible:
 * `routes.view.settings('ai', slug)`. `AiSettingsPage` then dispatches the same
 * two paths its own buttons use — the one-click dp flow for a gateway-backed
 * connection, the setup overlay (which starts OAuth by itself for an OAuth row)
 * for everything else. So this module decides WHICH connection and nothing
 * about HOW, and the "how" stays in the one place that already knows.
 *
 * The REASON is not restated here: it is the error's own title and message,
 * which is the only text in this exchange that says what actually failed. A
 * localised sentence in its place would have to be generic enough to cover four
 * codes and three runtimes, which is how a card ends up saying less than the
 * line it replaced.
 */

import { routes, type Route } from '@/lib/navigate'

/**
 * The credential-shaped members of the `ErrorCode` wire union.
 *
 * `token_expired` and `invalid_credentials` are what `runErrorDiagnostics`
 * produces today (its own union has no OAuth-specific member — the comment in
 * `claude-agent.ts` records `tsc` saying so); `expired_oauth_token` and
 * `invalid_api_key` are the two other credential codes the wire declares, and
 * they are included because the card must not depend on which producer learns
 * to send them first.
 */
export const CREDENTIAL_ERROR_CODES = [
  'invalid_api_key',
  'invalid_credentials',
  'expired_oauth_token',
  'token_expired',
] as const

export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number]

export interface CredentialSignInView {
  /** The i18n key of the ONE button. A key, never a sentence: the backend's own label is English in every locale. */
  labelKey: 'chat.credentialSignIn'
  /** The connection's own setup when the session names a connection; the AI settings page when it does not. */
  route: Route
}

function isCredentialErrorCode(code: string | undefined): code is CredentialErrorCode {
  return !!code && (CREDENTIAL_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * WHERE a credential is repaired, decided once.
 *
 * D1.272 gave this rule a second caller — `handleErrorMessageAction`'s `reauth`
 * branch — and two copies of "which connection does this error belong to" is
 * exactly how the card and the button start disagreeing. A session with no
 * connection slug lands on the AI settings page, which is where the backend's
 * own `settings` action landed before either of these rows.
 */
export function credentialSetupRoute(connectionSlug: string | undefined): Route {
  return connectionSlug
    ? routes.view.settings('ai', connectionSlug)
    : routes.view.settings('ai')
}

/**
 * The sign-in affordance for an error message, or `null` when the error is not
 * about a credential.
 *
 * A session with no connection slug still gets the button — it lands on the AI
 * settings page, which is exactly what the claude action did before this row.
 * Dropping the button in that case would make a rarely-reachable state strictly
 * worse than the behaviour it replaced.
 */
export function resolveCredentialSignIn(
  errorCode: string | undefined,
  connectionSlug: string | undefined,
): CredentialSignInView | null {
  if (!isCredentialErrorCode(errorCode)) return null
  return {
    labelKey: 'chat.credentialSignIn',
    route: credentialSetupRoute(connectionSlug),
  }
}

/**
 * Whether the backend's own action is the one this card replaces.
 *
 * The row asks for ONE sign-in button. The claude arm sends a `settings` action
 * that now says the same thing less precisely and in English, so it is dropped
 * while the card is shown — and only then: an error with no card keeps every
 * action it arrived with, including on a runtime that never learns to send a
 * credential code.
 */
export function isReplacedByCredentialSignIn(action: { action?: string }): boolean {
  return action.action === 'settings'
}
