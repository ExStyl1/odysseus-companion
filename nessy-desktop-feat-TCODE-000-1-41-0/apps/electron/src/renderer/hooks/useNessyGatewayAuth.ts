import { useCallback, useEffect, useState } from 'react'
import { DpAuthError } from '@nessy-agent/shared/auth/dp/errors'
/**
 * Client-side state for the one-click Nessy Gateway auth flow. Driven by the
 * `nessy:gatewayAuthStatus` events the main process forwards from the facade,
 * plus the final result of the `ensureGatewayAuth` invoke. One hook is shared
 * by both onboarding cards and the AI-settings entries.
 */

export type GatewayAuthPhase =
  | 'idle'
  | 'checking'
  | 'waiting-browser'
  | 'exchanging'
  | 'done'
  | 'error'
  | 'login-required'

export interface GatewayAuthState {
  phase: GatewayAuthPhase
  /** DpAuthError code when phase === 'error'. */
  errorCode?: string
  /** dp is below the version floor — advisory hint, does not block the flow. */
  dpOutdated: boolean
  /**
   * DA1.79 — a dp on this machine could not be STARTED, so the ladder set it
   * aside and a different copy answered. Advisory like `dpOutdated` and for the
   * same reason: by the time it arrives the flow has already succeeded, and the
   * user's only loss is not knowing they are on a fallback.
   */
  dpUnrunnable: boolean
}

export const initialGatewayAuthState: GatewayAuthState = {
  phase: 'idle',
  dpOutdated: false,
  dpUnrunnable: false,
}

/**
 * Pure reducer from a status code to the next state. Kept separate from the
 * hook so the transitions are unit-tested without React. User cancellation
 * (`error:Cancelled`) returns to `idle`, not `error` — it is not a failure.
 */
export function reduceGatewayAuthStatus(state: GatewayAuthState, status: string): GatewayAuthState {
  switch (status) {
    case 'dp-outdated':
      return { ...state, dpOutdated: true }
    case 'dp-unrunnable':
      return { ...state, dpUnrunnable: true }
    case 'checking':
      return { ...state, phase: 'checking', errorCode: undefined }
    case 'waiting-browser':
      return { ...state, phase: 'waiting-browser' }
    case 'exchanging':
      return { ...state, phase: 'exchanging' }
    case 'done':
      return { ...state, phase: 'done', errorCode: undefined }
    case 'login-required':
      return { ...state, phase: 'login-required' }
    case 'error:Cancelled':
      return { ...state, phase: 'idle', errorCode: undefined }
    default:
      if (status.startsWith('error:')) {
        return { ...state, phase: 'error', errorCode: status.slice('error:'.length) }
      }
      return state
  }
}

export interface UseNessyGatewayAuth extends GatewayAuthState {
  /** Run the auth flow; resolves to the IPC result (never the JWT value). */
  ensure: () => Promise<{ ok: true; username: string } | { ok: false; code: string } | undefined>
  /** Abort a pending run (kills a waiting `dp auth login`) and return to idle. */
  cancel: () => void
  /** Reset back to the idle state. */
  reset: () => void
  /**
   * F1.2 — the http(s) URL dp handed its browser for the login now in flight,
   * while that login can still use it (`reduceGatewayAuthUrl`).
   */
  authUrl?: string
  /**
   * F1.366 — this run signed in with dp's STORED session because dp itself
   * could not be run (`reduceDpSessionFileUsed`); the surfaces say so.
   */
  dpSessionFileUsed: boolean
}

export function useNessyGatewayAuth(): UseNessyGatewayAuth {
  const [state, setState] = useState<GatewayAuthState>(initialGatewayAuthState)
  const [authUrl, setAuthUrl] = useState<string | undefined>(undefined)
  const [dpSessionFileUsed, setDpSessionFileUsed] = useState(false)

  useEffect(() => {
    const unsubscribe = window.electronAPI.onGatewayAuthStatus?.((status) => {
      setState((prev) => reduceGatewayAuthStatus(prev, status))
      setAuthUrl((prev) => reduceGatewayAuthUrl(prev, status))
      setDpSessionFileUsed((prev) => reduceDpSessionFileUsed(prev, status))
    })
    return () => unsubscribe?.()
  }, [])

  const ensure = useCallback(async () => {
    setState((prev) => ({ ...prev, phase: 'checking', errorCode: undefined }))
    setAuthUrl(undefined)
    const result = await window.electronAPI.ensureGatewayAuth?.()
    // F1.2 — the run is over either way, so its URL is dead.
    setAuthUrl(undefined)
    // Backstop the terminal phase in case the final result arrives without a
    // matching status event. Route it through the SAME reducer as the status
    // stream so special cases are honored — notably error:Cancelled -> idle
    // (a user cancel must not surface as an error).
    if (result) {
      setState((prev) =>
        reduceGatewayAuthStatus(prev, result.ok ? 'done' : `error:${result.code}`),
      )
    }
    return result
  }, [])

  const cancel = useCallback(() => {
    void window.electronAPI.cancelGatewayAuth?.()
    setState((prev) => ({ ...prev, phase: 'idle', errorCode: undefined }))
    setAuthUrl(undefined)
  }, [])

  const reset = useCallback(() => {
    setState(initialGatewayAuthState)
    setAuthUrl(undefined)
    setDpSessionFileUsed(false)
  }, [])

  return { ...state, authUrl, dpSessionFileUsed, ensure, cancel, reset }
}

/**
 * F1.361 — what a failed sign-in SAYS, on every surface the facade feeds (the
 * banner, the onboarding step, Settings → Reconnect).
 *
 * Until this row only `DpNotFound` had a sentence of its own there; every other
 * code read 'Sign-in failed. Please try again.' while the in-chat card, fed by
 * the same `DpAuthError` codes, already said which failure it was. So the
 * reason here IS the card's `chat.dpAuth.errors.<code>` sentence — one string
 * per failure across the product — with two deliberate exceptions:
 *
 * - `DpNotFound` keeps `onboarding.gatewayConnect.errorDpNotFound` verbatim
 *   ("dp CLI not found. Contact corp IT."), which already carries its next step.
 * - A code this build does not know (a newer main process, a hand-typed status)
 *   keeps the generic sentence rather than rendering a missing key.
 *
 * `nextStepKey` is set only where a next step exists beyond the reason itself:
 * `NeedsLogin` and `LoginBrowserTimeout` both end with the user starting the
 * sign-in again (F1.2 adds the authorization URL beside it). `Cancelled` never
 * reaches a failure view — the reducer above turns it into `idle`.
 */
export interface GatewaySignInFailureView {
  /** i18n key of the reason sentence. */
  reasonKey: string
  /** i18n key of the next step, when one exists beyond the reason. */
  nextStepKey?: string
}

const GATEWAY_FAILURE_CODES: ReadonlySet<string> = new Set<string>(Object.values(DpAuthError))
const SIGN_IN_AGAIN_CODES: ReadonlySet<string> = new Set<string>([
  DpAuthError.NeedsLogin,
  DpAuthError.LoginBrowserTimeout,
])

export function gatewaySignInFailureView(code: string | undefined): GatewaySignInFailureView {
  if (code === DpAuthError.DpNotFound) return { reasonKey: 'onboarding.gatewayConnect.errorDpNotFound' }
  if (code === undefined || !GATEWAY_FAILURE_CODES.has(code)) {
    return { reasonKey: 'onboarding.gatewayConnect.errorGeneric' }
  }
  return SIGN_IN_AGAIN_CODES.has(code)
    ? { reasonKey: `chat.dpAuth.errors.${code}`, nextStepKey: 'onboarding.gatewayConnect.nextStepSignIn' }
    : { reasonKey: `chat.dpAuth.errors.${code}` }
}

/**
 * F1.361 — the Settings → Reconnect half. It returned SILENTLY on every failure
 * (the row's spinner stopped and nothing said why). `null` means "say nothing":
 * a success, or the user's own cancel. A missing result (the preload bridge is
 * absent) is still a failure the user must see, so it maps to the generic view.
 */
export function gatewayReconnectFailureNotice(
  result: { ok: true; username: string } | { ok: false; code: string } | undefined,
): GatewaySignInFailureView | null {
  if (result?.ok) return null
  if (result && result.code === DpAuthError.Cancelled) return null
  return gatewaySignInFailureView(result?.code)
}

/**
 * F1.2 — the http(s) URL an `auth-url:<url>` status carries, or `undefined`
 * for any other status or any other scheme. The main process only relays what
 * `dp-api.ts` symbol `createBrowserHook` already accepted; this second gate is
 * what a surface renders from, so a `file:` or `javascript:` target can never
 * become a link here whatever the channel carried.
 */
export function parseGatewayAuthUrlStatus(status: string): string | undefined {
  if (!status.startsWith('auth-url:')) return undefined
  const raw = status.slice('auth-url:'.length).trim()
  if (raw.length === 0 || raw.length > 8_192) return undefined
  try {
    const { protocol } = new URL(raw)
    return protocol === 'https:' || protocol === 'http:' ? raw : undefined
  } catch {
    return undefined
  }
}

/** Advisory statuses that do not end the browser wait, so the URL survives them. */
const AUTH_URL_KEEPING_STATUSES: ReadonlySet<string> = new Set(['waiting-browser', 'dp-outdated', 'dp-unrunnable'])

/**
 * F1.2 — the URL is kept ONLY while the login that produced it can still use
 * it: a new `auth-url:` replaces it, the advisory statuses keep it, and every
 * other status (a new run, the exchange, done, any error, a cancel) drops it —
 * a URL whose login was killed has no callback listening any more.
 */
export function reduceGatewayAuthUrl(prev: string | undefined, status: string): string | undefined {
  if (status.startsWith('auth-url:')) return parseGatewayAuthUrlStatus(status)
  return AUTH_URL_KEEPING_STATUSES.has(status) ? prev : undefined
}

/**
 * F1.366 rule 6 — `dp-session-file` means this run signed in with the session
 * dp keeps on disk because dp itself could not be run. It is ADVISORY (the run
 * has succeeded or is about to) and it lasts until the next run starts.
 */
export function reduceDpSessionFileUsed(prev: boolean, status: string): boolean {
  if (status === 'dp-session-file') return true
  if (status === 'checking') return false
  return prev
}

/** One toast id for the stored-session note, so one run shows ONE note whichever surfaces are mounted. */
export const DP_SESSION_FILE_TOAST_ID = 'nessy-dp-session-file-used'
