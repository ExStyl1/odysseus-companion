/**
 * Source: v0.15.1:apps/electron/src/renderer/components/chat/AuthRequestCard.tsx (UB14.26; the decision material
 * and `AuthOutcome` ADDED in v0.15.0, `startOAuth(restart)` in v0.15.1). Per-hunk merge (Apache-2.0). TAKEN: the
 * `AuthOutcome` tones for a finished request, every pending card on the decision anatomy (`DecisionCard` standalone,
 * header tile, details, actions, the encrypted-at-rest foot), the field chrome with a named reveal toggle, the
 * translated titles and statuses (`chat.authCard.*`) and the provider name on the sign-in button. OURS re-applied:
 * the dp (Developer Platform / Nestor) login card — `resolveDpAuthUi`, `routeDpAuthStatus`, `runDpAuthAttempt`, the
 * `auth-url:` status into `GatewayAuthUrlHint`, its title `chat.authCard.titleDp`, and a retryable failure that keeps
 * its actions on a danger-toned card (upstream's failures are final); plugin-server OAuth (`buildOAuthCardRequest`);
 * OAuth cancel beside the restart, `resolveOAuthUi`, `shouldAbortOAuthOperation` and the transient codes (their
 * messages are keys now); our `auth.enterField` placeholders; Save the ONE submit path and Cancel `type="button"`
 * (UB1.15). No Slack or Microsoft arm: our `AuthRequestType` has neither.
 */
import * as React from 'react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Key, KeyRound, User, Lock, Eye, EyeOff, CheckCircle2, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react'
// The `@nessy-agent/ui` BARREL is not importable under `bun test`: its module
// graph reaches the Vite-only `pdfjs-dist/...?url` specifier bun cannot resolve,
// so every suite that reached this card had to amputate the whole package with a
// spreadless `mock.module` (P6.844). The primitive's own subpath has a graph of
// react + clsx/tailwind-merge and loads everywhere.
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { Message, CredentialResponse } from '../../../shared/types'
import type { AuthRequestType, AuthStatus } from '@nessy-agent/core/types'
import { DpAuthError } from '@nessy-agent/shared/auth/dp/errors'
import type { DpAuthRequestArgs, DpAuthResult, DpAuthStatusEvent } from '@nessy-agent/shared/protocol'
import {
  pluginServerAuthKind,
  type SafeInstalledPluginSummary,
} from '@nessy-agent/shared/protocol/capabilities'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { parseGatewayAuthUrlStatus } from '@/hooks/useNessyGatewayAuth'
import { GatewayAuthUrlHint } from '@/components/apisetup/GatewayAuthUrlHint'
import { validateBasicAuthCredentials, getPasswordValue, getPasswordLabel, getPasswordPlaceholder } from '@/utils/auth-validation'
import {
  DECISION_ACTION,
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionFoot,
  DecisionHeader,
  type DecisionTone,
} from '@/components/app-shell/input/structured/DecisionCard'

// ============================================================================
// Primitives
// ============================================================================

type DpSessionStatus = DpAuthStatusEvent['status']
type PerformDpAuth = (
  args: DpAuthRequestArgs,
  onStatus?: (status: DpSessionStatus) => void,
) => Promise<DpAuthResult>

const DP_AUTH_ERROR_CODES = new Set<string>(Object.values(DpAuthError))

export function dpAuthStatusForResult(result: DpAuthResult): DpSessionStatus {
  return result.ok ? 'ready' : `error:${result.code}`
}

type DpAuthUiState =
  | 'pending'
  | 'checking'
  | 'waiting-browser'
  | 'connected'
  | 'cancelled'
  | 'failed'

export function resolveDpAuthUi(
  authStatus: AuthStatus | undefined,
  dpStatus: DpSessionStatus | undefined,
  isEnsuring: boolean,
  isCancelling: boolean,
  authError?: string,
): {
  state: DpAuthUiState
  errorCode?: DpAuthError
  showActions: boolean
  primaryDisabled: boolean
  cancelDisabled: boolean
} {
  const errorValue = dpStatus?.startsWith('error:')
    ? dpStatus.slice('error:'.length)
    : authError
  const errorCode = DP_AUTH_ERROR_CODES.has(errorValue ?? '')
    ? errorValue as DpAuthError
    : authStatus === 'failed'
      ? DpAuthError.ExecFailed
      : undefined

  const state: DpAuthUiState =
    authStatus === 'completed' ? 'connected' :
    authStatus === 'cancelled' ? 'cancelled' :
    dpStatus === 'ready' ? 'connected' :
    errorCode === DpAuthError.Cancelled ? 'cancelled' :
    dpStatus?.startsWith('error:') ? 'failed' :
    dpStatus === 'waiting-browser' ? 'waiting-browser' :
    dpStatus === 'checking' || isEnsuring ? 'checking' :
    authStatus === 'failed' ? 'failed' :
    'pending'

  return {
    state,
    errorCode,
    showActions: state === 'pending'
      || state === 'checking'
      || state === 'waiting-browser'
      || state === 'failed',
    primaryDisabled: isEnsuring || isCancelling,
    cancelDisabled: isCancelling,
  }
}

/**
 * F1.2 — the broker's `auth-url:<url>` status rides the same stream as the
 * card's phases but is NOT a phase: set as `dpStatus` it would knock the card
 * out of its waiting-browser view at the very moment the link arrives. It goes
 * to the URL slot instead (http(s) only); every other status is a phase.
 */
export function routeDpAuthStatus(
  status: DpSessionStatus,
  onStatus: (status: DpSessionStatus) => void,
  onAuthUrl: (url: string) => void,
): void {
  if (status.startsWith('auth-url:')) {
    const url = parseGatewayAuthUrlStatus(status)
    if (url) onAuthUrl(url)
    return
  }
  onStatus(status)
}

export function runDpAuthAttempt(
  performDpAuth: PerformDpAuth,
  sessionId: string,
  requestId: string,
  onStatus?: (status: DpSessionStatus) => void,
): Promise<DpAuthResult> {
  return performDpAuth({ sessionId, requestId }, onStatus).then(result => {
    onStatus?.(dpAuthStatusForResult(result))
    return result
  })
}

/** The two local OAuth outcomes the card shows in place of its description; the keys hold the words (UB14.26). */
export const OAUTH_CANCEL_FAILURE_MESSAGE_KEY = 'chat.authCard.cancelFailed'
export const OAUTH_SETTLEMENT_FAILURE_MESSAGE_KEY = 'chat.authCard.settlementFailed'

type OAuthTransientCode = 'cancel-failed' | 'settlement-failed'

export function resolveOAuthUi(
  authStatus: AuthStatus | undefined,
  isSubmitting: boolean,
  isCancelling: boolean,
  transientCode?: OAuthTransientCode,
): {
  showActions: boolean
  primaryDisabled: boolean
  cancelDisabled: boolean
  transientMessageKey?: string
} {
  return {
    showActions: authStatus === 'pending',
    primaryDisabled: isSubmitting || isCancelling,
    cancelDisabled: isCancelling,
    transientMessageKey: transientCode === 'cancel-failed'
      ? OAUTH_CANCEL_FAILURE_MESSAGE_KEY
      : transientCode === 'settlement-failed'
        ? OAUTH_SETTLEMENT_FAILURE_MESSAGE_KEY
        : undefined,
  }
}

export function shouldAbortOAuthOperation(
  authStatus: AuthStatus | undefined,
  isOAuth: boolean | undefined,
  isSubmitting: boolean,
): boolean {
  return Boolean(isOAuth && isSubmitting && authStatus !== 'pending')
}

/** The one plugin fact this card joins on: which servers a plugin signs into. */
export type PluginServerAuthOwner =
  Pick<SafeInstalledPluginSummary, 'pluginKey' | 'authRequirements'>

/** Exactly the `performOAuth` argument the in-chat card sends. */
export interface OAuthCardRequest {
  sourceSlug: string
  sessionId: string
  authRequestId: string
  pluginServer?: { pluginKey: string; serverName: string }
}

/**
 * The `performOAuth` argument for one in-chat OAuth card — the same
 * `pluginServer` target `PendingAuthNotice` and `McpServersPanel` already send.
 *
 * WHY THE CARD HAS TO RESOLVE THIS AT ALL. The producer knows the target
 * exactly: `session-tools-core/handlers/source-oauth.ts` puts
 * `pluginServer: { pluginKey, serverName }` on the `McpOAuthAuthRequest` and
 * sets `sourceSlug` to the serverName as DISPLAY identity only. But
 * `SessionManager.beginAuthRequest` copies only `sourceSlug`/`sourceName` onto
 * the chat `Message`, and the renderer's `handleAuthRequest` keeps only
 * `event.message` and drops `event.request` — so the target does not reach this
 * component and has to be re-derived. Without it the card sent a bare
 * `sourceSlug: 'figma'`, `oauth:start` took the Source branch, and there is no
 * Source named `figma` — "Unable to start OAuth authentication", live, 2026-08-01.
 *
 * WHY THE JOIN IS `authRequirements` AND NOT THE PENDING-AUTH SUMMARY. Both
 * carry the target, but `getWorkspacePendingAuth`'s row exists only while the
 * server's credential slot is still empty (`pending-auth-summary.ts` skips a
 * `state === 'ready'` requirement), and nothing stops the model triggering this
 * card for an already-connected server — the re-auth case would fall straight
 * back into the bug. `SafeInstalledPluginSummary.authRequirements` is the
 * MANIFEST fact instead: state-independent, already in the shell's catalog, no
 * second RPC. It is the same join `McpServersPanel`'s Connect button makes.
 *
 * The `oauth` filter is load-bearing: `bearer`/`environment`/`dp` servers are
 * signed into elsewhere, and routing one here would swap a wrong target for a
 * wrong flow. A plain Source matches no plugin's declared server names, so it
 * keeps the bare-`sourceSlug` shape and the Source branch, unchanged.
 *
 * `sourceSlug` rides along in BOTH shapes on purpose — the preload keys its
 * in-flight operation registry on it and sends it as the auth-request binding,
 * and it substitutes the RPC's single target only when `pluginServer` is absent
 * (`preload/oauth-orchestration.ts`).
 */
export function buildOAuthCardRequest(input: {
  sourceSlug: string
  sessionId: string
  authRequestId: string
  installedPlugins?: readonly PluginServerAuthOwner[] | undefined
  /**
   * The target the PRODUCER resolved, carried through the auth-request event
   * onto the message. Preferred over the catalog join below: it is the fact
   * rather than a re-derivation, and it survives a server whose credential slot
   * is already filled (a re-auth), where a pending-auth lookup would find
   * nothing. The join stays as the fallback for a message written before this
   * field existed.
   */
  pluginServer?: { pluginKey: string; serverName: string } | undefined
}): OAuthCardRequest {
  const { sourceSlug, sessionId, authRequestId } = input
  if (input.pluginServer) {
    return { sourceSlug, sessionId, authRequestId, pluginServer: input.pluginServer }
  }
  for (const plugin of input.installedPlugins ?? []) {
    if (pluginServerAuthKind(plugin.authRequirements, sourceSlug) !== 'oauth') continue
    return {
      sourceSlug,
      sessionId,
      authRequestId,
      pluginServer: { pluginKey: plugin.pluginKey, serverName: sourceSlug },
    }
  }
  return { sourceSlug, sessionId, authRequestId }
}

/** Outcome tones (spec §2.4): role tint + solved text, plus a distinct icon so it is never color alone. */
type AuthOutcomeTone = 'success' | 'error' | 'muted'

const OUTCOME_STYLES: Record<AuthOutcomeTone, { container: string; icon: string; title: string }> = {
  success: { container: 'bg-success-tint', icon: 'text-success', title: 'text-success' },
  error: { container: 'bg-destructive-tint', icon: 'text-destructive', title: 'text-destructive' },
  muted: { container: 'bg-fill-hover', icon: 'text-tertiary', title: 'text-secondary' },
}

/** Field chrome shared by every credential input: icon inset, reveal toggle on the right. */
const FIELD_LABEL = 'text-label-sm text-secondary'
const FIELD_ICON = 'pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary'
const REVEAL_BUTTON = 'absolute right-3 top-1/2 -translate-y-1/2 text-tertiary transition-colors hover:text-foreground hover:duration-instant'

/** A finished auth request: quiet tinted card with icon, title and up to two detail lines. */
function AuthOutcome({
  tone,
  icon: Icon,
  title,
  subtitle,
  subtitleSecondary,
  className,
}: {
  tone: AuthOutcomeTone
  icon: LucideIcon
  title: string
  subtitle?: string
  subtitleSecondary?: string
  className?: string
}) {
  const style = OUTCOME_STYLES[tone]
  return (
    <div className={cn('flex gap-2.5 rounded-lg py-2.5 pl-3.5 pr-4 select-none', style.container, className)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', style.icon)} />
      <div className="min-w-0 flex-1">
        <div className={cn('text-label font-medium', style.title)}>{title}</div>
        {subtitle && (
          <div className="mt-0.5 text-label-sm text-secondary">{subtitle}</div>
        )}
        {subtitleSecondary && (
          <div className="mt-0.5 text-label-sm text-secondary">{subtitleSecondary}</div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

interface AuthRequestCardProps {
  message: Message
  /** Callback to respond to credential request */
  onRespondToCredential?: (sessionId: string, requestId: string, response: CredentialResponse) => void
  /** Session ID for this auth request */
  sessionId: string
  /** Whether the card is interactive (last message, no user message after). Default true. */
  isInteractive?: boolean
  /**
   * The in-flight attempt the card MOUNTS in. Production never passes it: a card always mounts idle and its
   * attempt is local state. The playground passes it to draw the waiting states as a static render — the OAuth
   * browser wait with its restart, and dp's checking / waiting-browser with the copy-link hint (UB14.26).
   */
  initialAttempt?: { submitting?: boolean; dpStatus?: DpSessionStatus; dpAuthUrl?: string }
}

/**
 * AuthRequestCard - Inline auth UI displayed in chat history
 *
 * Renders different UIs based on auth type:
 * - credential: Form for API key, bearer token, basic auth
 * - oauth/oauth-google: OAuth flow with browser redirect
 * - dp: the Developer Platform (Nestor) sign-in, run by the dp CLI
 *
 * Status handling:
 * - pending: Show interactive form/button
 * - completed: Show success state
 * - cancelled: Show cancelled state
 * - failed: Show error state
 */
export function AuthRequestCard({ message, onRespondToCredential, sessionId, isInteractive = true, initialAttempt }: AuthRequestCardProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(initialAttempt?.submitting ?? false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [dpStatus, setDpStatus] = useState<DpSessionStatus | undefined>(initialAttempt?.dpStatus)
  const [dpAuthUrl, setDpAuthUrl] = useState<string | undefined>(initialAttempt?.dpAuthUrl)
  const [oauthTransientCode, setOAuthTransientCode] = useState<OAuthTransientCode>()

  const {
    authRequestId,
    authRequestType,
    authSourceSlug,
    authSourceName,
    authStatus,
    authCredentialMode,
    authHeaderName,
    authHeaderNames,
    authLabels,
    authDescription,
    authHint,
    authSourceUrl,
    authPasswordRequired,
    authError,
    authEmail,
    authWorkspace,
  } = message

  // Multi-header state: { "DD-API-KEY": "", "DD-APPLICATION-KEY": "" }
  const [headerValues, setHeaderValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (authHeaderNames) {
      for (const name of authHeaderNames) {
        initial[name] = ''
      }
    }
    return initial
  })

  // Optional on purpose: the playground renders this card outside the shell,
  // and a card with no catalog must still run the plain-source flow.
  const installedPlugins = useOptionalAppShellContext()?.capabilityCatalog?.installedPlugins

  const isBasicAuth = authCredentialMode === 'basic'
  const isMultiHeader = authCredentialMode === 'multi-header'
  const passwordRequired = authPasswordRequired ?? true  // default true for backward compatibility

  // Validation logic
  const isValid = isBasicAuth
    ? validateBasicAuthCredentials(username, password, passwordRequired)
    : isMultiHeader
    ? authHeaderNames?.every(name => headerValues[name]?.trim().length > 0) ?? false
    : value.trim().length > 0

  const handleSubmit = useCallback(() => {
    if (!isValid || !authRequestId || !onRespondToCredential) return

    setIsSubmitting(true)

    if (isBasicAuth) {
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        username: username.trim(),
        password: getPasswordValue(password, passwordRequired),
        cancelled: false
      })
    } else if (isMultiHeader) {
      // Trim all header values
      const trimmedHeaders: Record<string, string> = {}
      for (const [key, val] of Object.entries(headerValues)) {
        trimmedHeaders[key] = val.trim()
      }
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        headers: trimmedHeaders,
        cancelled: false
      })
    } else {
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        value: value.trim(),
        cancelled: false
      })
    }
  }, [isBasicAuth, isMultiHeader, username, password, value, headerValues, isValid, onRespondToCredential, sessionId, authRequestId, passwordRequired])

  const handleCancel = useCallback(() => {
    if (!authRequestId || !onRespondToCredential) return
    onRespondToCredential(sessionId, authRequestId, { type: 'credential', cancelled: true })
  }, [onRespondToCredential, sessionId, authRequestId])

  const handleFormSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    handleSubmit()
  }, [handleSubmit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid) {
      handleSubmit()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }, [isValid, handleSubmit, handleCancel])

  // Restarting supersedes the running attempt; only the latest one may end the spinner
  const oauthAttemptRef = useRef(0)
  const startOAuth = useCallback(async (restart: boolean) => {
    // Client-driven OAuth: callback server runs locally, server owns tokens. If another
    // window or session is already signing in to this source, this waits for that
    // sign-in instead (UB3.10); `restart` replaces it.
    if (!authRequestId || !authSourceSlug) {
      console.warn('[AuthRequestCard] handleOAuthClick bailed: missing', {
        authRequestId: authRequestId ?? 'MISSING',
        authSourceSlug: authSourceSlug ?? 'MISSING',
        sessionId,
      })
      return
    }
    const attempt = ++oauthAttemptRef.current
    setOAuthTransientCode(undefined)
    setIsSubmitting(true)
    try {
      const result = await window.electronAPI.performOAuth({
        ...buildOAuthCardRequest({
          sourceSlug: authSourceSlug,
          sessionId,
          authRequestId,
          installedPlugins,
          ...(message.authPluginServer ? { pluginServer: message.authPluginServer } : {}),
        }),
        restart,
      })
      // A joined flow's own ending reason rides `error` too (UB3.10); only the
      // two local codes are transient card states.
      const transient: OAuthTransientCode | undefined
        = result.error === 'cancel-failed' ? 'cancel-failed'
        : result.error === 'settlement-failed' ? 'settlement-failed'
        : undefined
      if (transient) setOAuthTransientCode(transient)
    } catch {
      setOAuthTransientCode('settlement-failed')
    } finally {
      if (oauthAttemptRef.current === attempt) setIsSubmitting(false)
    }
  }, [sessionId, authRequestId, authSourceSlug, installedPlugins, message.authPluginServer])
  const handleOAuthClick = useCallback(() => startOAuth(false), [startOAuth])
  // The browser sign-in was closed or lost: replace it with a fresh one
  const handleRestartOAuth = useCallback(() => startOAuth(true), [startOAuth])

  const handleOAuthCancel = useCallback(async () => {
    if (!authRequestId || !authSourceSlug) {
      handleCancel()
      return
    }
    setIsCancelling(true)
    setOAuthTransientCode(undefined)
    try {
      const result = await window.electronAPI.cancelOAuth({
        sourceSlug: authSourceSlug,
        sessionId,
        authRequestId,
      })
      if (!result.ok) setOAuthTransientCode(result.code)
    } catch {
      setOAuthTransientCode('cancel-failed')
    } finally {
      setIsCancelling(false)
    }
  }, [authRequestId, authSourceSlug, handleCancel, sessionId])

  const handleDpClick = useCallback(async () => {
    if (!authRequestId) return
    setIsSubmitting(true)
    setDpStatus('checking')
    setDpAuthUrl(undefined)
    await runDpAuthAttempt(
      window.electronAPI.performDpAuth,
      sessionId,
      authRequestId,
      (status) => routeDpAuthStatus(status, setDpStatus, setDpAuthUrl),
    )
    setIsSubmitting(false)
  }, [sessionId, authRequestId])

  const handleDpCancel = useCallback(async () => {
    if (!authRequestId) return
    setIsCancelling(true)
    try {
      const result = await window.electronAPI.cancelDpAuth({
        sessionId,
        requestId: authRequestId,
      })
      setDpStatus(dpAuthStatusForResult(result))
    } catch {
      setDpStatus(`error:${DpAuthError.ExecFailed}`)
    } finally {
      setIsCancelling(false)
    }
  }, [sessionId, authRequestId])

  // Get field labels
  const credentialLabel = authLabels?.credential ||
    (authCredentialMode === 'bearer' ? 'Bearer Token' : 'API Key')
  const usernameLabel = authLabels?.username || 'Username'
  const basePasswordLabel = authLabels?.password || 'Password'
  const passwordLabel = getPasswordLabel(basePasswordLabel, passwordRequired)
  const passwordPlaceholder = getPasswordPlaceholder(basePasswordLabel, passwordRequired)

  // Card title per auth type (each language orders name and type itself)
  const getAuthTitle = (type: AuthRequestType | undefined) => {
    const name = authSourceName ?? ''
    switch (type) {
      case 'oauth':
        return t('chat.authCard.titleOAuth', { name })
      case 'oauth-google':
        return t('chat.authCard.titleGoogle', { name })
      case 'dp':
        return t('chat.authCard.titleDp', { name })
      case 'credential':
      default:
        return t('chat.authCard.titleCredential', { name })
    }
  }

  // Provider shown on the OAuth sign-in button (brand names stay untranslated)
  const getSignInProvider = (type: AuthRequestType | undefined) => {
    switch (type) {
      case 'oauth-google':
        return 'Google'
      default:
        return 'OAuth'
    }
  }

  const isDp = authRequestType === 'dp'
  const isOAuth = authRequestType && authRequestType !== 'credential' && !isDp
  const oauthUi = resolveOAuthUi(
    authStatus,
    isSubmitting,
    isCancelling,
    oauthTransientCode,
  )

  useEffect(() => {
    if (
      !shouldAbortOAuthOperation(authStatus, isOAuth, isSubmitting)
      || !authRequestId
      || !authSourceSlug
    ) return

    // auth_completed is the final UI authority. If it wins a race with the
    // local callback wait, stop that local work without changing card state.
    void window.electronAPI.cancelOAuth({
      sourceSlug: authSourceSlug,
      sessionId,
      authRequestId,
    }).catch(() => undefined)
  }, [
    authRequestId,
    authSourceSlug,
    authStatus,
    isOAuth,
    isSubmitting,
    sessionId,
  ])

  const dpUi = resolveDpAuthUi(
    authStatus,
    dpStatus,
    isSubmitting,
    isCancelling,
    authError,
  )
  const dpErrorCode = dpUi.errorCode ?? DpAuthError.ExecFailed

  // Determine the outcome tone for finished requests. The dp card's own outcome follows its
  // attempt (`dpUi.state`): a local `ready` is Connected before any push event, and its failure
  // is NOT an outcome — it keeps Retry and Cancel on the decision card.
  const outcomeTone: AuthOutcomeTone | null =
    authStatus === 'completed' ? 'success' :
    authStatus === 'cancelled' ? 'muted' :
    authStatus === 'failed' ? 'error' :
    null
  const dpOutcomeTone: AuthOutcomeTone | null =
    dpUi.state === 'connected' ? 'success' :
    dpUi.state === 'cancelled' ? 'muted' :
    null

  // Every pending card has actions: the credential form, the OAuth sign-in button or (while the
  // browser sign-in runs) its restart and cancel, or the dp sign-in with its cancel and retry
  const hasActions = isDp
    ? dpUi.showActions
    : isOAuth
      ? oauthUi.showActions
      : authStatus === 'pending'

  // Compact card view for non-interactive terminal states (after user sends message)
  if (!isInteractive && authStatus !== 'pending' && outcomeTone) {
    const title = isDp
      ? authStatus === 'completed'
        ? t('chat.dpAuth.connected')
        : authStatus === 'cancelled'
          ? t('chat.dpAuth.cancelled')
          : t('chat.dpAuth.failed')
      : authStatus === 'completed' ? t('chat.authCard.connected', { name: authSourceName ?? '' }) :
        authStatus === 'cancelled' ? t('chat.authCard.cancelled', { name: authSourceName ?? '' }) :
        t('chat.authCard.failed', { name: authSourceName ?? '' })
    const subtitle =
      isDp && authStatus === 'failed' ? t(`chat.dpAuth.errors.${dpErrorCode}`) :
      authStatus === 'completed' && authEmail ? t('chat.authCard.signedInAs', { email: authEmail }) :
      authStatus === 'failed' && authError ? authError :
      undefined

    return (
      <AuthOutcome
        tone={outcomeTone}
        icon={authStatus === 'completed' ? CheckCircle2 : XCircle}
        title={title}
        subtitle={subtitle}
        className="w-fit"
      />
    )
  }

  // Finished dp sign-in that is still the latest message: the same outcome card, full width
  if (isDp && dpOutcomeTone) {
    return (
      <AuthOutcome
        tone={dpOutcomeTone}
        icon={dpUi.state === 'connected' ? CheckCircle2 : XCircle}
        title={dpUi.state === 'connected' ? t('chat.dpAuth.connected') : t('chat.dpAuth.cancelled')}
      />
    )
  }

  // Finished request that is still the latest message: same outcome card, full width
  if (!isDp && outcomeTone) {
    return (
      <AuthOutcome
        tone={outcomeTone}
        icon={authStatus === 'completed' ? CheckCircle2 : XCircle}
        title={
          authStatus === 'completed' ? t('chat.authCard.connected', { name: authSourceName ?? '' }) :
          authStatus === 'cancelled' ? t('chat.authCard.cancelled', { name: authSourceName ?? '' }) :
          t('chat.authCard.failed', { name: authSourceName ?? '' })
        }
        subtitle={
          authStatus === 'completed' ? (authEmail ? t('chat.authCard.signedInAs', { email: authEmail }) : undefined) :
          authStatus === 'failed' ? (authError || undefined) :
          undefined
        }
        subtitleSecondary={authStatus === 'completed' && authWorkspace ? t('chat.authCard.workspace', { workspace: authWorkspace }) : undefined}
      />
    )
  }

  // A dp attempt that failed keeps its actions (Retry, Cancel), so it stays a decision card,
  // danger-toned; every other pending card is info
  const cardTone: DecisionTone = isDp && dpUi.state === 'failed' ? 'danger' : 'info'

  // Render the header based on the pending state
  const renderContent = () => {
    if (isDp) {
      if (dpUi.state === 'failed') {
        return (
          <>
            <DecisionHeader tone="danger" icon={<XCircle />} title={t('chat.dpAuth.failed')} />
            <DecisionDetails>
              <p className="text-label text-secondary">{t(`chat.dpAuth.errors.${dpErrorCode}`)}</p>
            </DecisionDetails>
          </>
        )
      }
      if (dpUi.state === 'checking' || dpUi.state === 'waiting-browser') {
        return (
          <>
            <DecisionHeader
              tone="info"
              icon={<Spinner className="text-label-sm" />}
              title={t('chat.dpAuth.checking')}
            />
            {dpUi.state === 'waiting-browser' && (
              <DecisionDetails>
                <p className="text-label text-secondary">{t('chat.dpAuth.waitingBrowser')}</p>
                {/* F1.2 — the link dp handed its browser, for a tab the user cannot see. */}
                {dpAuthUrl && (
                  <GatewayAuthUrlHint url={dpAuthUrl} className="mt-2 items-start" />
                )}
              </DecisionDetails>
            )}
          </>
        )
      }
      // DA1.4 / Target scheme clause 2 — the card names WHY when it was raised
      // by a failed forced re-mint: `resolveDpAuthUi` only returns an
      // `errorCode` for one of the `DpAuthError` members, so a card raised
      // with no reason (every other producer) renders exactly as before. NOT
      // `dpErrorCode`, which defaults to `ExecFailed` — a pending card must
      // never claim a failure it was not told about.
      return (
        <>
          <DecisionHeader tone="info" icon={<KeyRound />} title={getAuthTitle(authRequestType)} />
          {dpUi.errorCode && (
            <DecisionDetails>
              <p className="text-label text-secondary">{t(`chat.dpAuth.errors.${dpUi.errorCode}`)}</p>
            </DecisionDetails>
          )}
        </>
      )
    }

    // OAuth authenticating state (waiting for browser)
    if (isOAuth && isSubmitting) {
      return (
        <>
          <DecisionHeader
            tone="info"
            icon={<Spinner className="text-label-sm" />}
            title={t('chat.authCard.authenticating', { name: authSourceName ?? '' })}
          />
          <DecisionDetails>
            <p className="text-label text-secondary">
              {oauthUi.transientMessageKey ? t(oauthUi.transientMessageKey) : t('chat.authCard.completeInBrowser')}
            </p>
          </DecisionDetails>
        </>
      )
    }

    // OAuth pending state (button) or credential form header. A local OAuth outcome
    // (cancel-failed / settlement-failed) takes the description's place.
    const description = isOAuth && oauthUi.transientMessageKey
      ? t(oauthUi.transientMessageKey)
      : authDescription
    return (
      <>
        <DecisionHeader
          tone="info"
          icon={isOAuth ? <KeyRound /> : <Key />}
          title={getAuthTitle(authRequestType)}
        />
        {description && (
          <DecisionDetails>
            <p className="text-label text-secondary">{description}</p>
          </DecisionDetails>
        )}
      </>
    )
  }

  // Render the credential form fields (separate from header for layout)
  const renderCredentialFields = () => {
    if (authStatus !== 'pending' || isOAuth || isDp) return null

    return (
      <DecisionDetails>
      <div className="mt-2 space-y-3">
        {isBasicAuth ? (
          <>
            {/* Username field */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-username-${authRequestId}`} className={FIELD_LABEL}>
                {usernameLabel}
              </Label>
              <div className="relative">
                <User className={FIELD_ICON} />
                <Input
                  id={`auth-username-${authRequestId}`}
                  name="username"
                  autoComplete="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9"
                  placeholder={t('auth.enterField', { field: usernameLabel.toLowerCase() })}
                  autoFocus
                  disabled={isSubmitting}
                />
              </div>
            </div>
            {/* Password field */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-password-${authRequestId}`} className={FIELD_LABEL}>
                {passwordLabel}
              </Label>
              <div className="relative">
                <Lock className={FIELD_ICON} />
                <Input
                  id={`auth-password-${authRequestId}`}
                  name="password"
                  autoComplete="current-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9 pr-9"
                  placeholder={passwordPlaceholder}
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className={REVEAL_BUTTON}
                  aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </>
        ) : isMultiHeader && authHeaderNames ? (
          /* Multi-header fields (e.g., Datadog DD-API-KEY + DD-APPLICATION-KEY) */
          <>
            {authHeaderNames.map((headerName, index) => (
              <div key={headerName} className="space-y-1.5">
                <Label htmlFor={`auth-header-${authRequestId}-${index}`} className={FIELD_LABEL}>
                  {headerName}
                </Label>
                <div className="relative">
                  <Key className={FIELD_ICON} />
                  <Input
                    id={`auth-header-${authRequestId}-${index}`}
                    name={headerName}
                    autoComplete="off"
                    type={showPassword ? 'text' : 'password'}
                    value={headerValues[headerName] || ''}
                    onChange={(e) => setHeaderValues(prev => ({
                      ...prev,
                      [headerName]: e.target.value
                    }))}
                    onKeyDown={handleKeyDown}
                    className="pl-9 pr-9"
                    placeholder={t('auth.enterField', { field: headerName })}
                    autoFocus={index === 0}
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className={REVEAL_BUTTON}
                    aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : (
          /* Single credential field (API key, bearer token) */
          <div className="space-y-1.5">
            <Label htmlFor={`auth-value-${authRequestId}`} className={FIELD_LABEL}>
              {credentialLabel}
              {authCredentialMode === 'header' && authHeaderName && (
                <span className="ml-1 font-normal text-tertiary">
                  ({authHeaderName})
                </span>
              )}
            </Label>
            <div className="relative">
              <Key className={FIELD_ICON} />
              <Input
                id={`auth-value-${authRequestId}`}
                name="credential"
                autoComplete="current-password"
                type={showPassword ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="pl-9 pr-9"
                placeholder={t('auth.enterField', { field: credentialLabel.toLowerCase() })}
                autoFocus
                disabled={isSubmitting}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={REVEAL_BUTTON}
                aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        {/* Hint */}
        {authHint && (
          <p className="text-label-sm text-tertiary">
            {authHint}
          </p>
        )}
      </div>
      </DecisionDetails>
    )
  }

  // Render action buttons
  const renderActions = () => {
    if (!hasActions) return null

    // dp sign-in (ours): the attempt's primary is disabled while it runs, Cancel never is
    if (isDp) {
      return (
        <DecisionActions>
          <Button
            size="lg"
            variant="primary"
            className={DECISION_ACTION}
            onClick={handleDpClick}
            disabled={dpUi.primaryDisabled}
          >
            {isSubmitting && <Spinner className="text-label-sm" />}
            {dpUi.state === 'failed' ? t('chat.dpAuth.retry') : t('chat.dpAuth.title')}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleDpCancel}
            disabled={dpUi.cancelDisabled}
          >
            {t('chat.dpAuth.cancel')}
          </Button>
        </DecisionActions>
      )
    }

    // OAuth in progress — the browser sign-in may have been closed or lost
    // (UB3.10): offer a restart while one runs, and keep our cancel beside it.
    if (isOAuth && isSubmitting) {
      return (
        <DecisionActions>
          <Button
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleRestartOAuth}
            disabled={isCancelling}
          >
            {t('chat.authCard.restartSignIn')}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleOAuthCancel}
            disabled={oauthUi.cancelDisabled}
          >
            {t('common.cancel')}
          </Button>
        </DecisionActions>
      )
    }

    // OAuth pending - sign in button
    if (isOAuth) {
      return (
        <DecisionActions>
          <Button
            size="lg"
            variant="primary"
            className={DECISION_ACTION}
            onClick={handleOAuthClick}
            disabled={oauthUi.primaryDisabled}
            data-tutorial="oauth-sign-in-button"
          >
            {t('chat.authCard.signInWith', { provider: getSignInProvider(authRequestType) })}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleOAuthCancel}
            disabled={oauthUi.cancelDisabled}
          >
            {t('common.cancel')}
          </Button>
        </DecisionActions>
      )
    }

    // Credential form - Save is the ONE submit path (the form's onSubmit;
    // no onClick here, or a click would answer twice — UB1.15).
    return (
      <>
        <DecisionActions>
          <Button
            type="submit"
            size="lg"
            variant="primary"
            className={DECISION_ACTION}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting && <Spinner className="text-label-sm" />}
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
          <Button
            // The credential form's Cancel must not also submit the typed credential
            type="button"
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </Button>
        </DecisionActions>
        <DecisionFoot icon={<ShieldCheck />}>{t('chat.authCard.encryptedAtRest')}</DecisionFoot>
      </>
    )
  }

  // Whether this is a pending credential form (needs form wrapper for 1Password)
  const isCredentialForm = authStatus === 'pending' && !isOAuth && !isDp

  const cardContent = (
    <>
      <DecisionBody className={cn('overflow-visible', !hasActions && 'pb-3.5')}>
        {renderContent()}
        {renderCredentialFields()}
      </DecisionBody>

      {hasActions && renderActions()}
    </>
  )

  return (
    <DecisionCard tone={cardTone} standalone>
      {/* Form wrapper enables password manager (1Password) detection and autofill.
          action points to the source URL for domain-based credential matching. */}
      {isCredentialForm ? (
        <form
          onSubmit={handleFormSubmit}
          action={authSourceUrl || undefined}
          method="post"
        >
          {cardContent}
        </form>
      ) : (
        cardContent
      )}
    </DecisionCard>
  )
}

/**
 * Memoized version for performance in chat list
 */
export const MemoizedAuthRequestCard = React.memo(AuthRequestCard, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.authStatus === next.message.authStatus &&
    prev.message.authError === next.message.authError &&
    prev.sessionId === next.sessionId &&
    prev.isInteractive === next.isInteractive
  )
})
