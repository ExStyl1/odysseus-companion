import { cn } from "@/lib/utils"
import { WelcomeStep } from "./WelcomeStep"
import type { ApiSetupMethod } from "./APISetupStep"
import { ProviderSelectStep, type ProviderChoice } from "./ProviderSelectStep"
import { CredentialsStep, type CredentialStatus } from "./CredentialsStep"
import { GatewayConnectStep } from "./GatewayConnectStep"
import { LocalModelStep, type LocalModelSubmitData } from "./LocalModelStep"
import { ByoRuntimeStep, type ByoRuntimeSubmitData, type ByoRuntimeInitialValues } from "./ByoRuntimeStep"
import type { MergedEndpointArm } from "@/components/apisetup/byo-runtime"
import type { ByoRuntimeProviderType } from "../apisetup/byo-runtime"
import { CompletionStep } from "./CompletionStep"
import { GitBashWarning, type GitBashStatus } from "./GitBashWarning"
import type { ApiKeyInitialValues, ApiKeySubmitData } from "../apisetup"
import type { GatewayKind } from "../apisetup/gateway-one-click"

export type OnboardingStep =
  | 'welcome'
  | 'git-bash'
  | 'provider-select'
  | 'local-model'
  | 'byo-runtime'
  | 'credentials'
  | 'gateway-connect'
  | 'complete'

export type LoginStatus = 'idle' | 'waiting' | 'success' | 'error'

export interface OnboardingState {
  step: OnboardingStep
  loginStatus: LoginStatus
  credentialStatus: CredentialStatus
  completionStatus: 'saving' | 'complete'
  apiSetupMethod: ApiSetupMethod | null
  isExistingUser: boolean
  errorMessage?: string
  gitBashStatus?: GitBashStatus
  isRecheckingGitBash?: boolean
  isCheckingGitBash?: boolean
  apiKeyInitialValues?: ApiKeyInitialValues
  /** Which gateway integration the zero-form connect step should create. */
  gatewayKind?: GatewayKind
  /** BYO endpoint form: fixed runtime on the Edit path (undefined = user picks). */
  /**
   * The arm the Edit path locked. Widened to `MergedEndpointArm` when the form
   * grew its Pi arm — an edited `pi`/`pi_compat`/`anthropic` connection locks
   * to `'pi'`, which is an arm id and not a providerType.
   */
  byoRuntimeProviderType?: MergedEndpointArm
  /** BYO endpoint form: prefilled endpoint/key/models when editing. */
  byoRuntimeInitialValues?: ByoRuntimeInitialValues
  /** BYO endpoint form: editing an existing connection (blank key keeps it). */
  byoRuntimeIsEditing?: boolean
  /**
   * BYO endpoint form: the slug being edited. The form sends it to the catalog
   * RPC so the STORED credential is resolved server-side — the key field holds
   * only the mask on that path.
   */
  byoRuntimeEditingSlug?: string | null
}

interface OnboardingWizardProps {
  /** Current state of the wizard */
  state: OnboardingState

  // Event handlers
  onContinue: () => void
  onBack: () => void
  onSelectApiSetupMethod: (method: ApiSetupMethod) => void
  onSubmitCredential: (data: ApiKeySubmitData) => void
  onStartOAuth?: (methodOverride?: ApiSetupMethod) => void
  onFinish: () => void

  // Claude OAuth (two-step flow)
  isWaitingForCode?: boolean
  onSubmitAuthCode?: (code: string) => void
  onCancelOAuth?: () => void

  // Git Bash (Windows)
  onBrowseGitBash?: () => Promise<string | null>
  onUseGitBashPath?: (path: string) => void
  onRecheckGitBash?: () => void
  onClearError?: () => void

  // Provider select (new flow)
  onSelectProvider?: (choice: ProviderChoice) => void
  /** Called when user chooses "Setup later" on provider select */
  onSkipSetup?: () => void

  // Local model
  onSubmitLocalModel?: (data: LocalModelSubmitData) => void

  // BYO runtime endpoint (codex-runtime / claude-runtime)
  onSubmitByoRuntime?: (data: ByoRuntimeSubmitData) => void

  // Edit mode (pre-fill existing connection values)
  editInitialValues?: ApiKeyInitialValues

  className?: string
}

/**
 * OnboardingWizard - Full-screen onboarding flow container
 *
 * Manages the step-by-step flow for setting up Nessy Desktop:
 * 1. Welcome
 * 2. Provider Select (Nessy Gateway / Claude / ChatGPT / API Key / Local)
 * 3. Credentials (API Key or OAuth) or Local Model
 * 4. Completion
 */
export function OnboardingWizard({
  state,
  onContinue,
  onBack,
  onSelectApiSetupMethod,
  onSubmitCredential,
  onStartOAuth,
  onFinish,
  // Two-step OAuth flow
  isWaitingForCode,
  onSubmitAuthCode,
  onCancelOAuth,
  // Git Bash (Windows)
  onBrowseGitBash,
  onUseGitBashPath,
  onRecheckGitBash,
  onClearError,
  // Provider select (new flow)
  onSelectProvider,
  onSkipSetup,
  // Local model
  onSubmitLocalModel,
  // BYO runtime endpoint
  onSubmitByoRuntime,
  // Edit mode
  editInitialValues,
  className
}: OnboardingWizardProps) {
  const renderStep = () => {
    switch (state.step) {
      case 'welcome':
        return (
          <WelcomeStep
            isExistingUser={state.isExistingUser}
            onContinue={onContinue}
            isLoading={state.isCheckingGitBash}
          />
        )

      case 'git-bash':
        return (
          <GitBashWarning
            status={state.gitBashStatus!}
            onBrowse={onBrowseGitBash!}
            onUsePath={onUseGitBashPath!}
            onRecheck={onRecheckGitBash!}
            onBack={onBack}
            isRechecking={state.isRecheckingGitBash}
            errorMessage={state.errorMessage}
            onClearError={onClearError}
          />
        )

      case 'provider-select':
        return (
          <ProviderSelectStep
            onSelect={onSelectProvider!}
            onSkip={onSkipSetup}
          />
        )

      case 'local-model':
        return (
          <LocalModelStep
            onSubmit={onSubmitLocalModel!}
            onBack={onBack}
            status={state.credentialStatus === 'validating' ? 'validating' : state.credentialStatus === 'error' ? 'error' : 'idle'}
            errorMessage={state.errorMessage}
          />
        )

      case 'byo-runtime':
        return (
          <ByoRuntimeStep
            lockedArm={state.byoRuntimeProviderType}
            initialValues={state.byoRuntimeInitialValues}
            isEditing={state.byoRuntimeIsEditing}
            editingSlug={state.byoRuntimeEditingSlug}
            onSubmit={onSubmitByoRuntime!}
            onBack={onBack}
            status={state.credentialStatus === 'validating' ? 'validating' : state.credentialStatus === 'error' ? 'error' : 'idle'}
            errorMessage={state.errorMessage}
          />
        )

      case 'credentials':
        return (
          <CredentialsStep
            apiSetupMethod={state.apiSetupMethod!}
            status={state.credentialStatus}
            errorMessage={state.errorMessage}
            onSubmit={onSubmitCredential}
            onStartOAuth={onStartOAuth}
            onBack={onBack}
            isWaitingForCode={isWaitingForCode}
            onSubmitAuthCode={onSubmitAuthCode}
            editInitialValues={state.apiKeyInitialValues ?? editInitialValues}
            onCancelOAuth={onCancelOAuth}
          />
        )

      case 'gateway-connect':
        return (
          <GatewayConnectStep
            kind={state.gatewayKind ?? 'pi'}
            onConnected={onContinue}
            onBack={onBack}
          />
        )

      case 'complete':
        return (
          <CompletionStep
            status={state.completionStatus}
            onFinish={onFinish}
          />
        )

      default:
        return null
    }
  }

  return (
    <div
      className={cn(
        // The navigator canvas; each step is a paper card on it (StepFormLayout)
        "bg-navigator overflow-y-auto",
        !className?.includes('h-full') && "h-dvh",
        className
      )}
    >
      {/* Draggable title bar region for transparent window (macOS) */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />

      {/* Main content — min-h-full + flex center means: center when content fits,
          natural flow + scroll when content is taller than the viewport (mobile). */}
      <main className="flex min-h-full items-center justify-center p-4 sm:p-8">
        {renderStep()}
      </main>
    </div>
  )
}
