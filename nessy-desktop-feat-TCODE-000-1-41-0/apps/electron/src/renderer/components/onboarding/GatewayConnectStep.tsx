import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Spinner } from "@nessy-agent/ui/ui/LoadingIndicator"
import { NessySymbol } from "@/components/icons/NessySymbol"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import { DP_SESSION_FILE_TOAST_ID, gatewaySignInFailureView, useNessyGatewayAuth } from "@/hooks/useNessyGatewayAuth"
import { createGatewayConnection, type GatewayKind } from "@/components/apisetup/gateway-one-click"
import { GatewayAuthUrlHint } from "@/components/apisetup/GatewayAuthUrlHint"

interface GatewayConnectStepProps {
  /** Which gateway integration to connect (Pi, Nestor Cloud, Codex, or Claude Code). */
  kind: GatewayKind
  /** Existing connection slugs (for idempotent upsert of the gateway connection). */
  existingSlugs?: Set<string>
  /** Called once the connection is created — advance to completion. */
  onConnected: () => void
  /** Called when the user backs out — return to provider select. */
  onBack: () => void
}

/**
 * Zero-form connect step shared by gateway cards. The user never sees a
 * field: on mount it runs the one-click auth flow (browser SSO only if needed),
 * then creates the connection with the gateway JWT and auto-advances. Errors
 * show a Retry, never a form.
 */
export function GatewayConnectStep({ kind, existingSlugs, onConnected, onBack }: GatewayConnectStepProps) {
  const { t } = useTranslation()
  const { phase, errorCode, dpOutdated, dpUnrunnable, authUrl, dpSessionFileUsed, ensure, cancel, reset } = useNessyGatewayAuth()
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)
  const startedRef = useRef(false)
  const connectedRef = useRef(false)

  // Kick off the auth flow once on mount (the user already clicked the card).
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void ensure()
  }, [ensure])

  // F1.366 rule 6 — signed in with dp's STORED session: say so. A toast, not a
  // hint: the step advances the moment the connection exists.
  useEffect(() => {
    if (dpSessionFileUsed) toast.info(t("onboarding.gatewayConnect.dpSessionFileUsed"), { id: DP_SESSION_FILE_TOAST_ID })
  }, [dpSessionFileUsed, t])

  // On auth success, fetch the JWT and create/upsert the connection.
  useEffect(() => {
    if (phase !== 'done' || connectedRef.current) return
    connectedRef.current = true
    let cancelled = false
    ;(async () => {
      setConnecting(true)
      setConnectError(null)
      try {
        const creds = await window.electronAPI.getNessyGatewayJwt?.()
        if (!creds?.jwt) throw new Error('missing-jwt')
        const result = await createGatewayConnection(kind, creds.jwt, existingSlugs)
        if (cancelled) return
        if (result.success) {
          onConnected()
        } else {
          setConnectError(result.error ?? t("onboarding.gatewayConnect.errorGeneric"))
          connectedRef.current = false
        }
      } catch {
        if (cancelled) return
        setConnectError(t("onboarding.gatewayConnect.errorGeneric"))
        connectedRef.current = false
      } finally {
        if (!cancelled) setConnecting(false)
      }
    })()
    return () => { cancelled = true }
  }, [phase, kind, existingSlugs, onConnected, t])

  const handleRetry = () => {
    setConnectError(null)
    connectedRef.current = false
    reset()
    void ensure()
  }

  // F1.361 — the per-code reason (and its next step, where one exists), not
  // "DpNotFound or generic": the same sentences the in-chat card already shows.
  const failure = phase === 'error' ? gatewaySignInFailureView(errorCode) : null
  const errorMessage = connectError
    ?? (failure
      ? (failure.nextStepKey ? `${t(failure.reasonKey)} ${t(failure.nextStepKey)}` : t(failure.reasonKey))
      : null)

  return (
    <GatewayConnectStepView
      kind={kind}
      errorMessage={errorMessage}
      status={connecting ? 'creating-connection' : phase === 'waiting-browser' ? 'waiting-browser' : 'connecting'}
      authUrl={authUrl}
      dpOutdated={dpOutdated && !hintDismissed}
      dpUnrunnable={dpUnrunnable && !hintDismissed}
      onDismissHints={() => setHintDismissed(true)}
      onBack={onBack}
      onCancel={() => { cancel(); onBack() }}
      onRetry={handleRetry}
    />
  )
}

export interface GatewayConnectStepViewProps {
  kind: GatewayKind
  /** The sign-in or connect failure, already in words; `null` while the run is still going. */
  errorMessage: string | null
  /** Which running sentence the step shows while there is no error. */
  status: 'connecting' | 'waiting-browser' | 'creating-connection'
  /** F1.2 — the link dp handed its browser, while the run waits for it. */
  authUrl?: string
  /** The dp-outdated hint, still undismissed. */
  dpOutdated?: boolean
  /** DA1.79 — the dp-unrunnable hint, still undismissed. */
  dpUnrunnable?: boolean
  onDismissHints: () => void
  onBack: () => void
  /** Cancel the browser wait, then go back. */
  onCancel: () => void
  onRetry: () => void
}

/**
 * The step as drawn, every state a prop (UB14.40), so the playground can show
 * the waiting, hint and failure states the live flow only reaches through dp.
 * `GatewayConnectStep` above owns the run and hands this its state.
 *
 * On v0.15.1's recipe: the running sentence is the step's lede, a failure sits
 * in the destructive tint well v0.15.1's CredentialsStep puts its sign-in error
 * in (the lede then says nothing, so the reason is said once), the spinner is
 * the onboarding `Spinner`, and the dp hints are tertiary fine print.
 */
export function GatewayConnectStepView({
  kind,
  errorMessage,
  status,
  authUrl,
  dpOutdated = false,
  dpUnrunnable = false,
  onDismissHints,
  onBack,
  onCancel,
  onRetry,
}: GatewayConnectStepViewProps) {
  const { t } = useTranslation()
  const title = kind === 'codex'
    ? t("onboarding.gatewayConnect.titleCodex")
    : kind === 'claude'
      ? t("onboarding.gatewayConnect.titleClaude")
      : kind === 'cloud'
        ? t("onboarding.gatewayConnect.titleCloud")
        : t("onboarding.gatewayConnect.titlePi")

  const isWaitingBrowser = status === 'waiting-browser'
  const statusLabel = status === 'creating-connection'
    ? t("onboarding.gatewayConnect.creatingConnection")
    : isWaitingBrowser
      ? t("onboarding.gatewayConnect.waitingBrowser")
      : t("onboarding.gatewayConnect.connecting")

  return (
    <StepFormLayout
      iconElement={
        <div className="flex size-16 items-center justify-center">
          <NessySymbol className="size-10 text-accent" />
        </div>
      }
      title={title}
      description={errorMessage ? undefined : statusLabel}
      actions={
        errorMessage ? (
          <>
            <BackButton onClick={onBack}>{t("common.back")}</BackButton>
            <ContinueButton onClick={onRetry}>{t("onboarding.gatewayConnect.retry")}</ContinueButton>
          </>
        ) : isWaitingBrowser ? (
          <BackButton onClick={onCancel}>{t("common.cancel")}</BackButton>
        ) : undefined
      }
    >
      {errorMessage ? (
        <div data-testid="gateway-connect-error" className="rounded-md bg-destructive-tint text-destructive text-label p-3">
          {errorMessage}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <Spinner className="text-2xl text-tertiary" />
          {/* F1.2 — the link dp handed its browser, for a tab the user cannot see. */}
          {isWaitingBrowser && authUrl && <GatewayAuthUrlHint url={authUrl} />}
          {dpOutdated && (
            <button
              type="button"
              onClick={onDismissHints}
              className="text-label-sm text-tertiary transition-colors duration-micro ease-out-subtle hover:duration-instant hover:text-foreground"
            >
              {t("onboarding.gatewayConnect.dpOutdated")}
            </button>
          )}
          {/*
            DA1.79 · a SECOND hint rather than a branch of the first: the two
            say different things about different binaries (one is the dp we are
            using and it is old; the other is a dp we are NOT using and it is
            broken), and they can both be true at once. Dismissal is shared
            because the control is one "I have read the hints" affordance.
          */}
          {dpUnrunnable && (
            <button
              type="button"
              data-testid="gateway-connect-dp-unrunnable"
              onClick={onDismissHints}
              className="text-label-sm text-tertiary transition-colors duration-micro ease-out-subtle hover:duration-instant hover:text-foreground"
            >
              {t("onboarding.gatewayConnect.dpUnrunnable")}
            </button>
          )}
        </div>
      )}
    </StepFormLayout>
  )
}
