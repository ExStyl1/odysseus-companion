/**
 * useOnboarding Hook
 *
 * Manages the state machine for the onboarding wizard.
 * Flow:
 * 1. Welcome
 * 2. Git Bash (Windows only, if not found)
 * 3. API Setup (API Key / Claude OAuth)
 * 4. Credentials (API Key or Claude OAuth)
 * 5. Complete
 */
import { useState, useCallback, useEffect } from 'react'
import i18n from 'i18next'
import type {
  OnboardingState,
  OnboardingStep,
  ApiSetupMethod,
} from '@/components/onboarding'
import type { ProviderChoice } from '@/components/onboarding/ProviderSelectStep'
import type { LocalModelSubmitData } from '@/components/onboarding/LocalModelStep'
import type { ApiKeyInitialValues, ApiKeySubmitData } from '@/components/apisetup/ApiKeyInput'
import type { ByoRuntimeSubmitData, ByoRuntimeInitialValues } from '@/components/onboarding/ByoRuntimeStep'
import {
  buildByoRuntimeSetup,
  byoRuntimeRefusalKey,
  isLoopbackBaseUrl,
  isMaskedCredential,
  promoteModels,
  type MergedEndpointArm,
} from '@/components/apisetup/byo-runtime'
import type { CustomEndpointConfig } from '@config/llm-connections'
import type { SetupNeeds, LlmConnectionSetup, ClaudeOAuthIdentityDto } from '../../shared/types'

interface UseOnboardingOptions {
  /** Called when onboarding is complete */
  onComplete: () => void
  /** Initial setup needs from auth state check */
  initialSetupNeeds?: SetupNeeds
  /** Start the wizard at a specific step (default: 'welcome') */
  initialStep?: OnboardingStep
  /** Pre-select an API setup method (useful when editing an existing connection) */
  initialApiSetupMethod?: ApiSetupMethod
  /** Called when user goes back from the initial step (dismisses the wizard) */
  onDismiss?: () => void
  /** Called immediately after config is saved to disk (before wizard closes).
   *  Use this to propagate billing/model changes to the UI without waiting for onComplete. */
  onConfigSaved?: () => void
  /** Slug of existing connection being edited (null = creating new) */
  editingSlug?: string | null
  /** Set of slugs already in use (for generating unique slugs when creating new) */
  existingSlugs?: Set<string>
}

interface UseOnboardingReturn {
  // State
  state: OnboardingState

  // Wizard actions
  handleContinue: () => void
  handleBack: () => void

  // Provider select (new flow)
  handleSelectProvider: (choice: ProviderChoice) => void

  // API Setup (legacy — kept for direct edit)
  handleSelectApiSetupMethod: (method: ApiSetupMethod) => void

  // Credentials
  handleSubmitCredential: (data: ApiKeySubmitData) => void

  // Local model
  handleSubmitLocalModel: (data: LocalModelSubmitData) => void

  // BYO runtime endpoint (codex-runtime / claude-runtime)
  handleSubmitByoRuntime: (data: ByoRuntimeSubmitData) => void
  handleStartOAuth: (methodOverride?: ApiSetupMethod, connectionSlugOverride?: string) => void

  // Claude OAuth (two-step flow)
  isWaitingForCode: boolean
  handleSubmitAuthCode: (code: string) => void
  handleCancelOAuth: () => void

  // Git Bash (Windows)
  handleBrowseGitBash: () => Promise<string | null>
  handleUseGitBashPath: (path: string) => void
  handleRecheckGitBash: () => void
  handleClearError: () => void

  // Skip setup ("Setup later")
  handleSkipSetup: () => void

  // Completion
  handleFinish: () => void
  handleCancel: () => void

  // Direct edit (skip method selection, jump to credentials)
  jumpToCredentials: (method: ApiSetupMethod) => void

  /** Direct edit for a BYO runtime connection (skips the provider cards). */
  jumpToByoRuntime: (args: {
    /** The ARM to lock — `'pi'` included, since the merged form owns that too. */
    providerType: MergedEndpointArm
    initialValues: ByoRuntimeInitialValues
    /** The slug being edited — see the implementation for why it is passed in. */
    editingSlug?: string | null
  }) => void

  // Reset
  reset: () => void
}

// Base slug for each setup method (used as template key in ipc.ts)
export const BASE_SLUG_FOR_METHOD: Record<ApiSetupMethod, string> = {
  anthropic_api_key: 'anthropic-api',
  claude_oauth: 'claude-max',
  pi_chatgpt_oauth: 'chatgpt-plus',
  codex_chatgpt_oauth: 'chatgpt-codex', // F1.202 — `BUILT_IN_CONNECTION_TEMPLATES['chatgpt-codex']`
  pi_api_key: 'pi-api-key',
}

/**
 * Generate a unique slug for a new connection.
 * If the base slug is taken, appends -2, -3, etc.
 * When editingSlug is provided, reuses that slug (editing existing connection).
 */
export function resolveSlugForMethod(
  method: ApiSetupMethod,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): string {
  // Editing an existing connection — reuse its slug
  if (editingSlug) return editingSlug

  const base = BASE_SLUG_FOR_METHOD[method]
  if (!existingSlugs.has(base)) return base

  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

// Map ApiSetupMethod to LlmConnectionSetup for the new unified connection system
export function apiSetupMethodToConnectionSetup(
  method: ApiSetupMethod,
  options: {
    credential?: string
    baseUrl?: string
    connectionDefaultModel?: string
    models?: ApiKeySubmitData['models']
    /** The utility-model slot (E1) — see the field's comment on ApiKeySubmitData. */
    miniModel?: string
    piAuthProvider?: string
    modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
    customEndpoint?: CustomEndpointConfig
    iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    awsRegion?: string
    bedrockAuthMethod?: 'iam_credentials' | 'environment'
    oauthIdentity?: ClaudeOAuthIdentityDto
  },
  editingSlug: string | null,
  existingSlugs: Set<string>,
): LlmConnectionSetup {
  const slug = resolveSlugForMethod(method, editingSlug, existingSlugs)

  switch (method) {
    case 'anthropic_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        miniModel: options.miniModel,
        customEndpoint: options.customEndpoint,
      }
    case 'claude_oauth':
      return {
        slug,
        credential: options.credential,
        oauthIdentity: options.oauthIdentity,
      }
    case 'pi_chatgpt_oauth':
    case 'codex_chatgpt_oauth':
      return {
        slug,
        credential: options.credential,
      }
    case 'pi_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        miniModel: options.miniModel,
        piAuthProvider: options.piAuthProvider,
        modelSelectionMode: options.modelSelectionMode,
        customEndpoint: options.customEndpoint,
        iamCredentials: options.iamCredentials,
        awsRegion: options.awsRegion,
        bedrockAuthMethod: options.bedrockAuthMethod,
      }
  }
}

/**
 * DA1.64 — the SAVE path's refusal, in the user's language.
 *
 * DA1.60 taught `setupLlmConnection` to refuse a credential aimed at the
 * gateway's own endpoint and to answer with the FORM's own token
 * (`endpointIsGateway`) rather than a sentence, so that the words stay the
 * user's to read in their own language — the same reason P6.498's gateway-only
 * refusal travels as a wire CODE, which `handleSaveConfig` branches on in its
 * own catch. Nothing mapped THIS token on this side, so `result.error` reached
 * `errorMessage` raw and the user read the identifier.
 *
 * `byoRuntimeRefusalKey` is the map the form already has for this exact token
 * (`components/apisetup/byo-runtime.ts`), which is what
 * `GATEWAY_ENDPOINT_REFUSAL`'s docblock asks a renderer to reuse. A string it
 * does not recognise passes through unchanged: a refusal we cannot translate
 * must still be readable, and inventing a sentence for it would be worse than
 * showing the server's own words.
 *
 * Used at BOTH save doors — the wizard's `handleSaveConfig` and the BYO-runtime
 * submit — because a fix that reached one would leave the other on the token,
 * and the two are the same RPC.
 */
function saveFailureMessage(raw: string | null | undefined): string {
  const key = byoRuntimeRefusalKey(raw)
  return key ? i18n.t(key) : (raw || 'Failed to save configuration')
}

export function useOnboarding({
  onComplete,
  initialSetupNeeds,
  initialStep = 'provider-select',
  initialApiSetupMethod,
  onDismiss,
  onConfigSaved,
  editingSlug = null,
  existingSlugs = new Set(),
}: UseOnboardingOptions): UseOnboardingReturn {
  // Main wizard state
  const [state, setState] = useState<OnboardingState>({
    step: initialStep,
    loginStatus: 'idle',
    credentialStatus: 'idle',
    completionStatus: 'saving',
    apiSetupMethod: initialApiSetupMethod ?? null,
    isExistingUser: initialSetupNeeds?.needsBillingConfig ?? false,
    gitBashStatus: undefined,
    isRecheckingGitBash: false,
    isCheckingGitBash: true, // Start as true until check completes
  })

  // Check Git Bash on Windows at mount. If missing, redirect to git-bash step
  // regardless of the initial step (provider-select skips the welcome gate).
  useEffect(() => {
    const checkGitBash = async () => {
      try {
        const status = await window.electronAPI.checkGitBash()
        setState(s => ({
          ...s,
          gitBashStatus: status,
          isCheckingGitBash: false,
          // Redirect to git-bash step when missing on Windows
          ...(status.platform === 'win32' && !status.found ? { step: 'git-bash' as const } : {}),
        }))
      } catch (error) {
        console.error('[Onboarding] Failed to check Git Bash:', error)
        // Even on error, allow continuing (will skip git-bash step)
        setState(s => ({ ...s, isCheckingGitBash: false }))
      }
    }
    checkGitBash()
  }, [])

  // Save configuration using the new unified LLM connection API
  // Returns true on success, false on failure (sets errorMessage on failure)
  // `methodOverride` lets callers pass the method explicitly to avoid stale-closure issues
  // (e.g. when called from an async OAuth flow whose closure predates the state update).
  const handleSaveConfig = useCallback(async (
    credential?: string,
    options?: {
      baseUrl?: string
      connectionDefaultModel?: string
      models?: ApiKeySubmitData['models']
      /** The utility-model slot (E1) — F5's missing link: without it a
       *  miniModel picked on the merged form's Pi arm is dropped here. */
      miniModel?: string
      piAuthProvider?: string
      modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
      customEndpoint?: CustomEndpointConfig
      iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
      awsRegion?: string
      bedrockAuthMethod?: 'iam_credentials' | 'environment'
      oauthIdentity?: ClaudeOAuthIdentityDto
      /**
       * BYO model-metadata sync toggle (C3). Stamps `modelsSyncedAt` so the
       * startup refresh picks the connection up, or clears it to withdraw.
       * Applied at the call site rather than inside
       * `apiSetupMethodToConnectionSetup`, which is a per-method switch this
       * one flag has no business branching through.
       */
      syncModelsFromEndpoint?: boolean
    },
    methodOverride?: ApiSetupMethod,
    connectionSlugOverride?: string,
    updateOnly?: boolean,
  ): Promise<boolean> => {
    const method = methodOverride ?? state.apiSetupMethod
    if (!method) {
      return false
    }

    setState(s => ({ ...s, completionStatus: 'saving' }))

    try {
      // Build connection setup from UI state
      const setup = apiSetupMethodToConnectionSetup(method, {
        credential,
        baseUrl: options?.baseUrl,
        connectionDefaultModel: options?.connectionDefaultModel,
        models: options?.models,
        miniModel: options?.miniModel,
        piAuthProvider: options?.piAuthProvider,
        modelSelectionMode: options?.modelSelectionMode,
        customEndpoint: options?.customEndpoint,
        iamCredentials: options?.iamCredentials,
        awsRegion: options?.awsRegion,
        bedrockAuthMethod: options?.bedrockAuthMethod,
        oauthIdentity: options?.oauthIdentity,
      }, connectionSlugOverride ?? editingSlug, existingSlugs)
      const withSyncMarker = options?.syncModelsFromEndpoint === undefined
        ? setup
        : { ...setup, modelsSyncedAt: options.syncModelsFromEndpoint ? Date.now() : null }
      // Use new unified API
      const result = await window.electronAPI.setupLlmConnection(
        updateOnly ? { ...withSyncMarker, updateOnly: true } : withSyncMarker
      )

      if (result.success) {
        setState(s => ({ ...s, completionStatus: 'complete' }))
        // Notify caller immediately so UI can reflect billing/model changes
        onConfigSaved?.()
        return true
      } else {
        console.error('[Onboarding] Save failed:', result.error)
        setState(s => ({
          ...s,
          completionStatus: 'saving',
          errorMessage: saveFailureMessage(result.error),
        }))
        return false
      }
    } catch (error) {
      console.error('[Onboarding] handleSaveConfig error:', error)
      // P6.498 — the operator's gateway-only refusal arrives as a CODE, because
      // the sentence is the user's to read in their own language. Branch on the
      // wire code (the transport rebuilds a plain Error on this side, so the
      // class is gone) exactly as the connection-delete path does for
      // `CONNECTION_IN_USE`. Every other failure keeps the server's message.
      const code = (error as { code?: unknown } | null)?.code
      setState(s => ({
        ...s,
        errorMessage: code === 'CONNECTION_GATEWAY_ONLY'
          ? i18n.t('settings.ai.gatewayOnly.refusal')
          : error instanceof Error ? error.message : 'Failed to save configuration',
      }))
      return false
    }
  }, [state.apiSetupMethod, onConfigSaved, editingSlug, existingSlugs])

  // Continue to next step
  const handleContinue = useCallback(async () => {
    switch (state.step) {
      case 'provider-select':
        // Handled by handleSelectProvider (card click navigates directly)
        break

      case 'welcome':
        // On Windows, check if Git Bash is needed
        if (state.gitBashStatus?.platform === 'win32' && !state.gitBashStatus?.found) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else {
          setState(s => ({ ...s, step: 'provider-select' }))
        }
        break

      case 'git-bash':
        setState(s => ({ ...s, step: 'provider-select' }))
        break

      case 'local-model':
        // Handled by handleSubmitLocalModel
        break

      case 'byo-runtime':
        // Handled by handleSubmitByoRuntime
        break

      case 'credentials':
        // Handled by handleSubmitCredential
        break

      case 'gateway-connect':
        // Reached when the zero-form connect step created the connection.
        setState(s => ({ ...s, step: 'complete', completionStatus: 'complete', credentialStatus: 'success' }))
        break

      case 'complete':
        onComplete()
        break
    }
  }, [state.step, state.gitBashStatus, state.apiSetupMethod, onComplete])

  // Go back to previous step. If at the initial step, call onDismiss instead.
  const handleBack = useCallback(() => {
    if (state.step === initialStep && onDismiss) {
      onDismiss()
      return
    }
    switch (state.step) {
      case 'git-bash':
        if (onDismiss) {
          onDismiss()
        }
        break
      case 'provider-select':
        // If on Windows and Git Bash was needed, go back to git-bash step
        if (state.gitBashStatus?.platform === 'win32' && state.gitBashStatus?.found === false) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else if (onDismiss) {
          onDismiss()
        }
        break
      case 'credentials':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
      case 'local-model':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
      case 'byo-runtime':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
      case 'gateway-connect':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
    }
  }, [state.step, state.gitBashStatus, initialStep, onDismiss])

  // Select API setup method (legacy — kept for direct edit flows)
  const handleSelectApiSetupMethod = useCallback((method: ApiSetupMethod) => {
    setState(s => ({ ...s, apiSetupMethod: method }))
  }, [])

  // Submit credential (API key + optional endpoint config)
  // Tests the connection first before saving to catch issues early
  const handleSubmitCredential = useCallback(async (
    data: ApiKeySubmitData,
    /**
     * The method to save under, when the caller knows it and the wizard state
     * does not. The merged form's Pi arm is exactly that case: it is mounted as
     * the `byo-runtime` step, so `state.apiSetupMethod` is null while the arm's
     * preset determines whether this is an `anthropic_api_key` or a
     * `pi_api_key` save. Same escape hatch `handleSaveConfig` already has, and
     * for the same stale-state reason.
     */
    methodOverride?: ApiSetupMethod,
  ) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    const effectiveMethod = methodOverride ?? state.apiSetupMethod
    const isPiApiKeyFlow = effectiveMethod === 'pi_api_key'

    try {
      // Bedrock (Pi+amazon-bedrock) — skip API key validation and connection test
      if (data.bedrockAuthMethod) {
        const saved = await handleSaveConfig(undefined, {
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          miniModel: data.miniModel,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          iamCredentials: data.iamCredentials,
          awsRegion: data.awsRegion,
          bedrockAuthMethod: data.bedrockAuthMethod,
        }, effectiveMethod ?? undefined)
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // When editing an existing connection, API key is optional (empty = keep existing credential)
      if (!data.apiKey.trim() && editingSlug) {
        const saved = await handleSaveConfig(undefined, {
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          miniModel: data.miniModel,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          customEndpoint: data.customEndpoint,
          syncModelsFromEndpoint: data.syncModelsFromEndpoint,
        }, effectiveMethod ?? undefined)
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // API key validation differs by endpoint locality:
      // - Local/loopback custom endpoints may be keyless (e.g. Ollama)
      // - Non-local endpoints require an API key
      const isLoopbackCustomEndpoint = isLoopbackBaseUrl(data.baseUrl)
      if (isPiApiKeyFlow) {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      } else {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      }

      // Validate connection by spawning a lightweight subprocess test.
      // Custom endpoint protocol routes through PiAgent at runtime, so test with Pi too.
      const setupTestProvider = data.customEndpoint ? 'pi' : (isPiApiKeyFlow ? 'pi' : 'anthropic')
      const testResult = await window.electronAPI.testLlmConnectionSetup({
        provider: setupTestProvider,
        apiKey: data.apiKey,
        // UB3.4: on the edit path the field may hold the GET_API_KEY mask (or be
        // empty = keep the stored one); the slug lets the server resolve the
        // stored credential, so the test gets a real verdict instead of bullets.
        ...(editingSlug ? { slug: editingSlug } : {}),
        baseUrl: data.baseUrl,
        model: typeof data.models?.[0] === 'string' ? data.models[0] : data.models?.[0]?.id,
        piAuthProvider: data.piAuthProvider,
        customEndpoint: data.customEndpoint,
      })

      if (!testResult.success) {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: testResult.error || 'Connection test failed',
        }))
        return
      }

      const saved = await handleSaveConfig(data.apiKey, {
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.connectionDefaultModel,
        models: data.models,
        miniModel: data.miniModel,
        piAuthProvider: data.piAuthProvider,
        modelSelectionMode: data.modelSelectionMode,
        customEndpoint: data.customEndpoint,
        syncModelsFromEndpoint: data.syncModelsFromEndpoint,
      }, effectiveMethod ?? undefined)

      if (saved) {
        setState(s => ({
          ...s,
          credentialStatus: 'success',
          step: 'complete',
        }))
      } else {
        // Save failed — error is already set by handleSaveConfig, stay on credentials step
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Validation failed',
      }))
    }
  }, [handleSaveConfig, state.apiSetupMethod])

  // Save config, validate the connection, and update state accordingly.
  // Shared by all OAuth flows after tokens are captured.
  // `method` is passed explicitly to break the stale-closure chain — the OAuth
  // await crosses renders, so handleSaveConfig's closure may have an outdated
  // state.apiSetupMethod.
  const saveAndValidateConnection = useCallback(async (connectionSlug: string, method: ApiSetupMethod, credential?: string, updateOnly?: boolean, oauthIdentity?: ClaudeOAuthIdentityDto): Promise<boolean> => {
    const saved = await handleSaveConfig(credential, oauthIdentity ? { oauthIdentity } : undefined, method, connectionSlug, updateOnly)
    if (!saved) {
      setState(s => ({ ...s, credentialStatus: 'error' }))
      return false
    }
    const testResult = await window.electronAPI.testLlmConnection(connectionSlug)
    if (testResult.success) {
      setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      return true
    } else {
      setState(s => ({ ...s, credentialStatus: 'error', errorMessage: testResult.error || 'Connection test failed' }))
      return false
    }
  }, [handleSaveConfig])

  // Two-step OAuth flow state
  const [isWaitingForCode, setIsWaitingForCode] = useState(false)

  // Start OAuth flow (Claude or ChatGPT depending on selected method)
  const handleStartOAuth = useCallback(async (methodOverride?: ApiSetupMethod, connectionSlugOverride?: string) => {
    const effectiveMethod = methodOverride ?? state.apiSetupMethod

    if (methodOverride && methodOverride !== state.apiSetupMethod) {
      setState(s => ({
        ...s,
        apiSetupMethod: methodOverride,
        step: 'credentials',
        credentialStatus: 'validating',
        errorMessage: undefined,
      }))
    } else {
      setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))
    }

    if (!effectiveMethod) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Select an authentication method first.',
      }))
      return
    }

    try {
      // ChatGPT OAuth (single-step flow - opens browser, captures tokens automatically).
      // F1.202 — the codex card signs in through the SAME flow into its own slot.
      if (effectiveMethod === 'pi_chatgpt_oauth' || effectiveMethod === 'codex_chatgpt_oauth') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug
        const result = await window.electronAPI.startChatGptOAuth(connectionSlug)

        if (result.success) {
          await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
        } else {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: result.error || 'ChatGPT authentication failed',
          }))
        }
        return
      }

      // Claude OAuth (two-step flow - opens browser, user copies code)
      // Remaining method must be claude_oauth
      if (effectiveMethod !== 'claude_oauth') {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: 'This connection uses API keys, not OAuth.',
        }))
        return
      }

      const result = await window.electronAPI.startClaudeOAuth()

      if (result.success) {
        // Browser opened successfully, now waiting for user to copy the code
        setIsWaitingForCode(true)
        setState(s => ({ ...s, credentialStatus: 'idle' }))
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to start OAuth',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'OAuth failed',
      }))
    }
  }, [state.apiSetupMethod, saveAndValidateConnection, editingSlug, existingSlugs])

  // Map ProviderChoice → ApiSetupMethod and navigate to the right step
  const handleSelectProvider = useCallback((choice: ProviderChoice) => {
    // `api_key` is EXCLUDED, not mapped: its card is gone and the merged form
    // under `custom_runtime` took its place. The choice remains in the union
    // because `ProviderChoice` is also the shape callers pass around, but
    // nothing can select it here any more.
    const CHOICE_TO_METHOD: Record<Exclude<ProviderChoice, 'nessy' | 'nessy_cloud' | 'nessy_codex' | 'nessy_claude' | 'local' | 'custom_runtime' | 'api_key'>, ApiSetupMethod> = {
      claude: 'claude_oauth',
      chatgpt: 'pi_chatgpt_oauth',
      chatgpt_codex: 'codex_chatgpt_oauth',
    }

    // Gateway cards route to the zero-form connect step (no JWT/URL/model form).
    // The only difference is which connection the step creates.
    if (choice === 'nessy' || choice === 'nessy_cloud' || choice === 'nessy_codex' || choice === 'nessy_claude') {
      setState(s => ({
        ...s,
        gatewayKind: choice === 'nessy_codex'
          ? 'codex'
          : choice === 'nessy_claude'
            ? 'claude'
            : choice === 'nessy_cloud'
              ? 'cloud'
              : 'pi',
        step: 'gateway-connect',
        credentialStatus: 'idle',
        errorMessage: undefined,
      }))
      return
    }

    // BYO endpoint form for the codex/claude runtimes (C3). No locked runtime:
    // the step offers whichever runtimes this build shipped.
    // Both entrances to the merged personal-key form: the card, and the
    // `api_key` choice a caller may still hold from before the merge.
    if (choice === 'custom_runtime' || choice === 'api_key') {
      setState(s => ({
        ...s,
        step: 'byo-runtime',
        byoRuntimeProviderType: undefined,
        byoRuntimeInitialValues: undefined,
        byoRuntimeIsEditing: false,
        // CLEARED, not merely unset. A slug left over from an edit the user
        // backed out of would make the catalog fetch on this CREATE resolve
        // that other connection's stored key server-side — the right catalog
        // for the wrong credential.
        byoRuntimeEditingSlug: null,
        credentialStatus: 'idle',
        errorMessage: undefined,
      }))
      return
    }

    if (choice === 'local') {
      // Local uses anthropic_api_key with custom endpoint (Ollama doesn't need an API key)
      setState(s => ({
        ...s,
        step: 'local-model',
        apiSetupMethod: 'anthropic_api_key',
        apiKeyInitialValues: undefined,
        credentialStatus: 'idle',
        errorMessage: undefined,
      }))
      return
    }

    const method = CHOICE_TO_METHOD[choice]
    setState(s => ({
      ...s,
      apiSetupMethod: method,
      apiKeyInitialValues: undefined,
      step: 'credentials',
      credentialStatus: 'idle',
      errorMessage: undefined,
    }))

    // OAuth methods start immediately
    if (choice === 'claude' || choice === 'chatgpt' || choice === 'chatgpt_codex') {
      // Defer to next tick so state is updated before handleStartOAuth reads it
      setTimeout(() => handleStartOAuth(method), 0)
    }
  }, [handleStartOAuth])

  // Submit authorization code (second step of OAuth flow)
  const handleSubmitAuthCode = useCallback(async (code: string) => {
    if (!code.trim()) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Please enter the authorization code',
      }))
      return
    }

    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      const connectionSlug = apiSetupMethodToConnectionSetup('claude_oauth', {}, editingSlug, existingSlugs).slug
      const result = await window.electronAPI.exchangeClaudeCode(code.trim(), connectionSlug)

      if (result.success && result.token) {
        setIsWaitingForCode(false)
        await saveAndValidateConnection(connectionSlug, 'claude_oauth', result.token, !!editingSlug, result.identity)
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to exchange code',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to exchange code',
      }))
    }
  }, [saveAndValidateConnection, editingSlug, existingSlugs])

  // Submit local model configuration (Ollama or any OpenAI-compatible local server)
  const handleSubmitLocalModel = useCallback(async (data: LocalModelSubmitData) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      // apiSetupMethod was set to 'anthropic_api_key' when entering local-model step
      const saved = await handleSaveConfig(undefined, {
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.model,
        models: data.models,
        customEndpoint: { api: 'openai-completions' },
      })

      if (saved) {
        setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      } else {
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
    }
  }, [handleSaveConfig])

  /**
   * Submit the BYO runtime endpoint form (C3) — codex-runtime / claude-runtime.
   *
   * Deliberately NOT routed through `handleSaveConfig` /
   * `apiSetupMethodToConnectionSetup`: every `ApiSetupMethod` there maps onto a
   * slug whose built-in template produces `anthropic`/`pi`, and the
   * `anthropic_api_key` branch attaches a `customEndpoint` — the one field that
   * makes the SETUP handler rewrite `providerType` to `pi_compat` and leave the
   * local adapter unused. `buildByoRuntimeSetup` builds the payload instead.
   *
   * The connection test carries `runtimeProviderType` so the setup-form Test
   * reaches this runtime's own driver rather than being classified as a
   * `pi_compat` custom endpoint (factory.ts:resolveSetupTestConnectionHint).
   */
  const handleSubmitByoRuntime = useCallback(async (data: ByoRuntimeSubmitData) => {
    // THE PI ARM DELEGATES; IT DOES NOT REIMPLEMENT.
    //
    // Its payload is assembled by the existing `pi_api_key` pipeline —
    // `handleSubmitCredential` → `handleSaveConfig` →
    // `apiSetupMethodToConnectionSetup` — because that pipeline owns three
    // things this function must not duplicate: the official presets' blank
    // baseUrl (the server's reset path keys on it), the `customEndpoint`
    // emission that makes the server pick `pi_compat` for a custom endpoint,
    // and the plain-Anthropic mapping. Reassembling any of those here is how the
    // two shapes drift.
    //
    // The Anthropic PRESET maps through `anthropic_api_key` rather than
    // `pi_api_key`, preserving the byte-level reset semantics at
    // `llm-connections.ts:83-88`; everything else on this arm is `pi_api_key`.
    if (data.arm === 'pi') {
      const custom = data.preset === 'custom'
      // TWO THINGS THIS DELEGATION MUST DO THAT THE FIRST VERSION DID NOT.
      //
      // 1. STRIP THE MASK. On the edit path `data.apiKey` is
      //    `sk-xx••••••••1234` — `GET_API_KEY` masks for every caller — and the
      //    runtime arm below strips it via `buildByoRuntimeSetup`. This arm
      //    forwarded it verbatim, so the pre-save test authenticated with
      //    bullets.
      // 2. CARRY `piAuthProvider`. `validateSetupTestInput`
      //    (`connection-setup-logic.ts:65-69`) refuses `provider: 'pi'` with a
      //    base URL and no preset, so without this EVERY Pi/Custom save —
      //    create and edit alike — was rejected before it reached the server.
      //    It is DERIVED from the protocol rather than asked for, which is the
      //    same mapping `resolveCustomEndpointPayload` already makes:
      //    anthropic-messages → 'anthropic', otherwise → 'openai'.
      const usableKey = isMaskedCredential(data.apiKey) ? '' : data.apiKey
      handleSubmitCredential({
        apiKey: usableKey,
        ...(custom
          ? { piAuthProvider: data.customApi === 'anthropic-messages' ? 'anthropic' : 'openai' }
          : {}),
        // Official presets submit NO baseUrl — the blank is the contract.
        ...(custom ? { baseUrl: data.baseUrl } : {}),
        connectionDefaultModel: data.models[0],
        // Promoted with what the form knows, exactly as the runtime arm does —
        // the Pi arm never reaches `buildByoRuntimeSetup`, so without this the
        // window would land on two arms and not the third.
        models: data.models.length > 0 ? promoteModels(data.models, data.modelMeta) : undefined,
        ...(data.miniModel !== undefined ? { miniModel: data.miniModel } : {}),
        // ONLY the custom preset emits it. On an official preset this field
        // would rewrite an Anthropic/OpenAI connection to `pi_compat` and lose
        // the server-installed catalog.
        ...(custom && data.customApi
          ? { customEndpoint: { api: data.customApi, ...(data.dialect ? { dialect: data.dialect } : {}) } }
          : {}),
        ...(data.modelsSyncedAt !== undefined
          ? { syncModelsFromEndpoint: data.modelsSyncedAt !== null }
          : {}),
      }, data.preset === 'anthropic' ? 'anthropic_api_key' : 'pi_api_key')
      return
    }
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      const isMaskedKey = data.apiKey.includes('\u2022\u2022')
      const hasUsableKey = !!data.apiKey.trim() && !isMaskedKey
      // UB3.4: a MASKED key on the edit path is now verifiable — the slug lets
      // the server resolve the stored credential and the test runs for real.
      // Only a BLANK key on the edit path stays unverifiable (there is nothing
      // stored to resolve is the server's business, but the save itself must
      // not block on a verdict the form's own "keep the stored one" semantics
      // do not need). Every other reason still blocks, and on the create path
      // nothing is skipped (the form already requires a key for a non-loopback
      // endpoint).
      const keyIsUnverifiable = !hasUsableKey && !isMaskedKey && !!editingSlug

      const testResult = await window.electronAPI.testLlmConnectionSetup({
        // Legacy discriminator; `runtimeProviderType` is what selects the driver.
        provider: 'anthropic',
        runtimeProviderType: data.providerType,
        // The mask goes through verbatim: with the slug the server resolves it
        // to the stored credential (UB3.4) instead of testing bullets. A BLANK
        // field keeps the old shape (no slug): "keep the stored one" must not
        // start a 45s verdict the form never asked for.
        apiKey: data.apiKey,
        ...(editingSlug && data.apiKey.trim() ? { slug: editingSlug } : {}),
        baseUrl: data.baseUrl,
        model: data.models[0],
      })

      if (!testResult.success && !keyIsUnverifiable) {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: testResult.error || 'Connection test failed',
        }))
        return
      }

      // BOTH OF THE LAST TWO ARE A LANE-E DEFECT BEING FIXED, NOT A NEW
      // FEATURE: `buildByoRuntimeSetup` has accepted `miniModel` and
      // `modelsSyncedAt` since E1/E2, and this call dropped them — so a
      // claude/codex connection never enrolled in the 24h metadata sync and its
      // utility-model slot was silently a no-op. The Pi arm carried both
      // through its delegation the whole time, which is why it went unnoticed.
      const setup = buildByoRuntimeSetup({
        providerType: data.providerType,
        baseUrl: data.baseUrl,
        apiKey: data.apiKey,
        models: data.models,
        editingSlug,
        existingSlugs,
        ...(data.miniModel !== undefined ? { miniModel: data.miniModel } : {}),
        ...(data.modelsSyncedAt !== undefined ? { modelsSyncedAt: data.modelsSyncedAt } : {}),
        // What the form displayed — window and wire — so the config is correct
        // at save rather than after the next refresh.
        ...(data.modelMeta ? { modelMeta: data.modelMeta } : {}),
        // Edit prefill carries the masked stored key; non-empty means one exists,
        // so a blank submit keeps it and the authType must stay keyed.
        hasStoredKey: !!state.byoRuntimeInitialValues?.apiKey,
      })
      const result = await window.electronAPI.setupLlmConnection(setup)

      if (result.success) {
        onConfigSaved?.()
        setState(s => ({ ...s, credentialStatus: 'success', completionStatus: 'complete', step: 'complete' }))
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: saveFailureMessage(result.error),
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
    }
    // `handleSubmitCredential` is a dependency because the Pi arm delegates to
    // it; omitting it would pin this callback to the first render's closure and
    // save Pi-arm connections against a stale `editingSlug`.
  }, [editingSlug, existingSlugs, onConfigSaved, state.byoRuntimeInitialValues, handleSubmitCredential])

  // Cancel OAuth flow
  const handleCancelOAuth = useCallback(async () => {
    setIsWaitingForCode(false)
    setState(s => ({ ...s, credentialStatus: 'idle', errorMessage: undefined }))
    // Clear OAuth state on backend
    await window.electronAPI.clearClaudeOAuthState()
  }, [])

  // Git Bash handlers (Windows only)
  const handleBrowseGitBash = useCallback(async () => {
    return window.electronAPI.browseForGitBash()
  }, [])

  const handleUseGitBashPath = useCallback(async (path: string) => {
    const result = await window.electronAPI.setGitBashPath(path)
    if (result.success) {
      // Update state to mark Git Bash as found and continue
      setState(s => ({
        ...s,
        gitBashStatus: { ...s.gitBashStatus!, found: true, path },
        step: 'provider-select',
      }))
    } else {
      setState(s => ({
        ...s,
        errorMessage: result.error || 'Invalid path',
      }))
    }
  }, [])

  const handleRecheckGitBash = useCallback(async () => {
    setState(s => ({ ...s, isRecheckingGitBash: true }))
    try {
      const status = await window.electronAPI.checkGitBash()
      setState(s => ({
        ...s,
        gitBashStatus: status,
        isRecheckingGitBash: false,
        // If found, automatically continue to next step
        step: status.found ? 'provider-select' : s.step,
      }))
    } catch (error) {
      console.error('[Onboarding] Failed to recheck Git Bash:', error)
      setState(s => ({ ...s, isRecheckingGitBash: false }))
    }
  }, [])

  const handleClearError = useCallback(() => {
    setState(s => ({ ...s, errorMessage: undefined }))
  }, [])

  // Skip setup — user chose "Setup later"
  const handleSkipSetup = useCallback(async () => {
    try {
      await window.electronAPI.deferSetup()
    } catch (error) {
      console.error('[Onboarding] Failed to defer setup:', error)
    }
    onComplete()
  }, [onComplete])

  // Finish onboarding
  const handleFinish = useCallback(() => {
    onComplete()
  }, [onComplete])

  // Cancel onboarding
  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, step: 'welcome' }))
  }, [])

  // Jump directly to credentials step with a pre-set method (for editing existing connections)
  const jumpToCredentials = useCallback((method: ApiSetupMethod) => {
    setState(s => ({
      ...s,
      step: 'credentials' as const,
      apiSetupMethod: method,
      apiKeyInitialValues: undefined,
      credentialStatus: 'idle' as const,
      errorMessage: undefined,
    }))
  }, [])

  /**
   * Direct edit for a BYO runtime connection. The runtime is LOCKED to the
   * stored providerType: changing it would be a different operation (the SETUP
   * handler has no path from one providerType to another), and the silent
   * version of that is exactly the conversion bug this task removed.
   */
  const jumpToByoRuntime = useCallback((args: {
    providerType: MergedEndpointArm
    initialValues: ByoRuntimeInitialValues
    /**
     * The slug being edited, PASSED IN rather than read from the hook option.
     *
     * The caller sets that option's state (`openApiSetup(slug)`) and calls this
     * in the same tick, so the hook's own `editingSlug` is still the PREVIOUS
     * value here — null on the first edit. Measured live 2026-08-14: the Fetch
     * button came up disabled on the edit path because the form had no slug to
     * send and no usable key either. Taking it as an argument removes the
     * render-ordering dependency entirely.
     */
    editingSlug?: string | null
  }) => {
    setState(s => ({
      ...s,
      step: 'byo-runtime' as const,
      apiSetupMethod: null,
      apiKeyInitialValues: undefined,
      byoRuntimeProviderType: args.providerType,
      byoRuntimeInitialValues: args.initialValues,
      byoRuntimeIsEditing: true,
      // The form cannot send a usable key on this path (the prefill is the
      // mask), so it sends the slug and the server resolves the stored one.
      byoRuntimeEditingSlug: args.editingSlug ?? editingSlug,
      credentialStatus: 'idle' as const,
      errorMessage: undefined,
    }))
  }, [editingSlug])

  // Reset onboarding to initial state (used after logout or modal close)
  const reset = useCallback(() => {
    setState({
      step: initialStep,
      loginStatus: 'idle',
      credentialStatus: 'idle',
      completionStatus: 'saving',
      apiSetupMethod: initialApiSetupMethod ?? null,
      isExistingUser: false,
      apiKeyInitialValues: undefined,
      byoRuntimeProviderType: undefined,
      byoRuntimeInitialValues: undefined,
      byoRuntimeIsEditing: false,
      byoRuntimeEditingSlug: null,
      errorMessage: undefined,
    })
    setIsWaitingForCode(false)
    // Clean up any pending OAuth state
    window.electronAPI.clearClaudeOAuthState().catch(() => {
      // Ignore errors - state may not exist
    })
  }, [initialStep, initialApiSetupMethod])

  return {
    state,
    handleContinue,
    handleBack,
    handleSelectProvider,
    handleSelectApiSetupMethod,
    handleSubmitCredential,
    handleSubmitLocalModel,
    handleSubmitByoRuntime,
    handleStartOAuth,
    // Two-step OAuth flow
    isWaitingForCode,
    handleSubmitAuthCode,
    handleCancelOAuth,
    // Git Bash (Windows)
    handleBrowseGitBash,
    handleUseGitBashPath,
    handleRecheckGitBash,
    handleClearError,
    handleSkipSetup,
    handleFinish,
    handleCancel,
    jumpToCredentials,
    jumpToByoRuntime,
    reset,
  }
}
