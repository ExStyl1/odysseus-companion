/**
 * OnboardingFlowDemo — Interactive walkthrough of the new onboarding flow.
 *
 * Manages its own state so you can click through the entire sequence
 * in the playground without needing real IPC or OAuth.
 *
 * Flow: WelcomeStep → ProviderSelectStep → CredentialsStep / LocalModelStep → CompletionStep
 */
import { useState, useCallback, useEffect } from 'react'
import { ensureMockElectronAPI } from '../mock-utils'
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { ProviderSelectStep, type ProviderChoice } from '@/components/onboarding/ProviderSelectStep'
import { ByoRuntimeStep } from '@/components/onboarding/ByoRuntimeStep'
import { CredentialsStep } from '@/components/onboarding/CredentialsStep'
import { LocalModelStep } from '@/components/onboarding/LocalModelStep'
import { CompletionStep } from '@/components/onboarding/CompletionStep'
import type { ApiKeyInitialValues } from '@/components/apisetup/ApiKeyInput'
import {
  NESSY_GATEWAY_BASE_URL,
  NESSY_GATEWAY_MODEL_IDS,
  NESSY_GATEWAY_PRESET_KEY,
} from '@/components/apisetup/nessy-gateway'
import type { ApiSetupMethod } from '@/components/onboarding/APISetupStep'
import type { CredentialStatus } from '@/components/onboarding/CredentialsStep'

type DemoStep = 'welcome' | 'provider-select' | 'credentials' | 'local-model' | 'byo-runtime' | 'complete'

/** Map ProviderChoice → ApiSetupMethod for the credentials step */
const CHOICE_TO_METHOD: Record<Exclude<ProviderChoice, 'nessy' | 'nessy_cloud' | 'nessy_codex' | 'nessy_claude' | 'local' | 'custom_runtime'>, ApiSetupMethod> = {
  claude: 'claude_oauth',
  chatgpt: 'pi_chatgpt_oauth',
  chatgpt_codex: 'codex_chatgpt_oauth',
  api_key: 'pi_api_key',
}

const nessyGatewayInitialValues: ApiKeyInitialValues = {
  activePreset: NESSY_GATEWAY_PRESET_KEY,
  baseUrl: NESSY_GATEWAY_BASE_URL,
  connectionDefaultModel: NESSY_GATEWAY_MODEL_IDS.join(', '),
  models: [...NESSY_GATEWAY_MODEL_IDS],
  customApi: 'openai-completions',
}

export function OnboardingFlowDemo() {
  useEffect(() => { ensureMockElectronAPI() }, [])

  const [step, setStep] = useState<DemoStep>('welcome')
  const [method, setMethod] = useState<ApiSetupMethod | null>(null)
  const [credStatus, setCredStatus] = useState<CredentialStatus>('idle')
  const [localStatus, setLocalStatus] = useState<'idle' | 'validating' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | undefined>()

  // Track history for the step indicator
  const [providerChoice, setProviderChoice] = useState<ProviderChoice | null>(null)

  const handleProviderSelect = useCallback((choice: ProviderChoice) => {
    setProviderChoice(choice)
    setCredStatus('idle')
    setLocalStatus('idle')
    setErrorMessage(undefined)

    if (choice === 'nessy' || choice === 'nessy_cloud' || choice === 'nessy_codex' || choice === 'nessy_claude') {
      setMethod('pi_api_key')
      setStep('credentials')
    } else if (choice === 'local') {
      setMethod(null)
      setStep('local-model')
    } else if (choice === 'custom_runtime') {
      setMethod(null)
      setStep('byo-runtime')
    } else {
      setMethod(CHOICE_TO_METHOD[choice])
      setStep('credentials')
    }
  }, [])

  const handleBack = useCallback(() => {
    switch (step) {
      case 'provider-select':
        setStep('welcome')
        break
      case 'credentials':
      case 'local-model':
      case 'byo-runtime':
        setStep('provider-select')
        setCredStatus('idle')
        setLocalStatus('idle')
        setErrorMessage(undefined)
        break
    }
  }, [step])

  const simulateOAuthSuccess = useCallback(() => {
    setCredStatus('validating')
    setTimeout(() => {
      setCredStatus('success')
      setTimeout(() => setStep('complete'), 600)
    }, 1500)
  }, [])

  const simulateApiKeySubmit = useCallback(() => {
    setCredStatus('validating')
    setTimeout(() => {
      setCredStatus('success')
      setTimeout(() => setStep('complete'), 600)
    }, 1200)
  }, [])

  const simulateLocalSubmit = useCallback(() => {
    setLocalStatus('validating')
    setTimeout(() => {
      setLocalStatus('success')
      setTimeout(() => setStep('complete'), 600)
    }, 1200)
  }, [])

  // BYO endpoint form (C3) — same simulated round trip as the local-model step.
  const simulateByoRuntimeSubmit = useCallback(() => {
    setLocalStatus('validating')
    setTimeout(() => {
      setLocalStatus('success')
      setTimeout(() => setStep('complete'), 600)
    }, 1200)
  }, [])

  const handleRestart = useCallback(() => {
    setStep('welcome')
    setMethod(null)
    setProviderChoice(null)
    setCredStatus('idle')
    setLocalStatus('idle')
    setErrorMessage(undefined)
  }, [])

  const handleSkip = useCallback(() => {
    console.log('[Playground] Setup deferred — dismissing onboarding')
    // In the real app this calls onComplete() which dismisses onboarding
    // and shows the main app. In the playground we restart the demo.
    handleRestart()
  }, [handleRestart])

  // Step labels for the breadcrumb
  const activeStepLabel = step === 'local-model'
    ? 'Local Model'
    : step === 'byo-runtime'
      ? 'Custom Runtime'
      : 'Credentials'
  const activeStepKey: DemoStep = step === 'local-model' || step === 'byo-runtime' ? step : 'credentials'
  const STEP_ORDER: { key: DemoStep; label: string }[] = [
    { key: 'welcome', label: 'Welcome' },
    { key: 'provider-select', label: 'Provider' },
    { key: activeStepKey, label: activeStepLabel },
    { key: 'complete', label: 'Done' },
  ]

  const currentIndex = STEP_ORDER.findIndex(s => s.key === step)

  return (
    <div className="flex flex-col h-full">
      {/* Step indicator bar */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-foreground/[0.03] border-b border-border">
        <div className="flex items-center gap-1 text-xs">
          {STEP_ORDER.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/40 mx-1">→</span>}
              <span
                className={
                  i === currentIndex
                    ? 'font-semibold text-foreground'
                    : i < currentIndex
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/40'
                }
              >
                {s.label}
              </span>
            </span>
          ))}
        </div>
        <button
          onClick={handleRestart}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-foreground/5"
        >
          Restart
        </button>
      </div>

      {/* Step content */}
      <div className="flex-1 flex items-center justify-center p-8 bg-foreground-2 overflow-auto">
        {step === 'welcome' && (
          <WelcomeStep
            isExistingUser={false}
            onContinue={() => setStep('provider-select')}
          />
        )}

        {step === 'provider-select' && (
          <ProviderSelectStep onSelect={handleProviderSelect} onSkip={handleSkip} />
        )}

        {step === 'credentials' && method && (
          <CredentialsStep
            apiSetupMethod={method}
            status={credStatus}
            errorMessage={errorMessage}
            onSubmit={simulateApiKeySubmit}
            onStartOAuth={simulateOAuthSuccess}
            onBack={handleBack}
            isWaitingForCode={false}
            onSubmitAuthCode={() => simulateOAuthSuccess()}
            onCancelOAuth={handleBack}
            editInitialValues={providerChoice === 'nessy' ? nessyGatewayInitialValues : undefined}
          />
        )}

        {step === 'byo-runtime' && (
          <ByoRuntimeStep
            onSubmit={simulateByoRuntimeSubmit}
            onBack={handleBack}
            status={localStatus}
            errorMessage={errorMessage}
          />
        )}

        {step === 'local-model' && (
          <LocalModelStep
            onSubmit={simulateLocalSubmit}
            onBack={handleBack}
            status={localStatus}
            errorMessage={errorMessage}
          />
        )}

        {step === 'complete' && (
          <CompletionStep
            status="complete"
            onFinish={handleRestart}
          />
        )}
      </div>
    </div>
  )
}
