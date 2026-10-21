/**
 * ApiKeyInput - Reusable API key entry form control
 *
 * Renders a password input for the API key, a preset selector for Base URL,
 * and an optional Model override field.
 *
 * Does NOT include layout wrappers or action buttons — the parent
 * controls placement via the form ID ("api-key-form") for submit binding.
 *
 * Used in: Onboarding CredentialsStep, Settings API dialog
 *
 * Look: merged per hunk from v0.15.1:apps/electron/src/renderer/components/apisetup/ApiKeyInput.tsx
 * (UB14.38) — `field-surface` fields, the segmented track (selected `bg-raised shadow-elev-1`),
 * the hairline preset pill, the `popover-styled` tier list, and an eye toggle named by
 * `common.show`/`common.hide`. Upstream's Cloudflare AI Gateway preset and its submit-time URL
 * check are NOT taken (B2-11 DROP-a: a third-party gateway receiving session content); our own
 * rows (P6.586 credential header, C3 catalog, DA1.11 notice, P6.457 region note) wear the same
 * recipe.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from "cmdk"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-dropdown"
import { cn } from "@/lib/utils"
import { Check, ChevronDown, Eye, EyeOff, Loader2 } from "lucide-react"
import { pickTierDefaults, resolveTierModels, type PiModelInfo } from "./tier-models"
import {
  resolveCustomEndpointPayload,
  resolvePiAuthProviderForSubmit,
  resolvePresetStateForBaseUrlChange,
  type PresetKey,
} from "./submit-helpers"
import {
  NESSY_GATEWAY_BASE_URL,
  NESSY_GATEWAY_MODELS,
  NESSY_GATEWAY_PRESET_KEY,
} from "./nessy-gateway"
import { isGatewayHostNonGatewayEndpoint } from "./byo-runtime"

import type { CustomEndpointApi, CustomEndpointConfig } from '@config/llm-connections'
import type { ModelProbeResult } from '@nessy-agent/shared/protocol'
import { ModelCatalogPicker } from './ModelCatalogPicker'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { ModelDefinition } from '@config/models'

export type ApiKeyStatus = 'idle' | 'validating' | 'success' | 'error'

export type { CustomEndpointApi }

export type ApiKeySubmitModel = ModelDefinition | string

export interface ApiKeySubmitData {
  apiKey: string
  baseUrl?: string
  connectionDefaultModel?: string
  models?: ApiKeySubmitModel[]
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /** Custom endpoint protocol — set when user configures an arbitrary API endpoint */
  customEndpoint?: CustomEndpointConfig
  /**
   * Enroll (or withdraw) this connection from the daily model-metadata refresh.
   * Optional by contract: lane A's playground registry imports this type.
   */
  syncModelsFromEndpoint?: boolean
  /**
   * The utility-model slot (E1). Threaded through this type because the merged
   * form's Pi arm submits through the `pi_api_key` pipeline rather than through
   * `buildByoRuntimeSetup` — without it a miniModel picked on that arm is
   * dropped between the form and the payload, silently.
   */
  miniModel?: string
  /** IAM credentials for Pi+Bedrock (piAuthProvider='amazon-bedrock') setup */
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** AWS region for Pi+Bedrock */
  awsRegion?: string
  /** Bedrock authentication method — determines auth type for Pi+Bedrock connections */
  bedrockAuthMethod?: 'iam_credentials' | 'environment'
}

export interface ApiKeyInitialValues {
  apiKey?: string
  baseUrl?: string
  connectionDefaultModel?: string
  activePreset?: string
  models?: string[]
  customApi?: CustomEndpointApi
  /**
   * P6.586 — which header this connection's API key travels in. Absent means
   * `authorization`, the same thing its absence means at every reader.
   */
  credentialHeader?: CustomEndpointConfig['credentialHeader']
  /** Whether this connection is already enrolled in the daily metadata refresh. */
  syncModelsFromEndpoint?: boolean
}

export interface ApiKeyInputProps {
  /** Current validation status */
  status: ApiKeyStatus
  /** Error message to display when status is 'error' */
  errorMessage?: string
  /** Called when the form is submitted with the key and optional endpoint config */
  onSubmit: (data: ApiKeySubmitData) => void
  /** Form ID for external submit button binding (default: "api-key-form") */
  formId?: string
  /** Disable the input (e.g. during validation) */
  disabled?: boolean
  /** Provider type determines which presets and placeholders to show */
  providerType?: 'anthropic' | 'openai' | 'pi' | 'google' | 'pi_api_key'
  /** Pre-fill values when editing an existing connection */
  initialValues?: ApiKeyInitialValues
}

interface Preset {
  key: PresetKey
  label: string
  url: string
  placeholder?: string
  /** Hint for the base URL field when the user must enter a tenant-specific endpoint. */
  urlPlaceholder?: string
}

// Anthropic provider presets - for Claude Code backend
// Also used by Pi API key flow (same providers, routed via Pi SDK)
const ANTHROPIC_PRESETS: Preset[] = [
  // DA1.32 — the placeholder used to name the credentials file and tell the
  // user to paste the JWT out of it. The setup RPC refuses to store one, so
  // that instruction sent a user to copy a live corporate token for nothing.
  //
  // DA1.53 — and this ROW is UNREACHABLE. Measured 2026-09-17 at `6dd16c921`,
  // five readings in this file and two outside it, so the next reader does not
  // restore a prefill "for the preset that needs it":
  //   1. `getPresetsForProvider` filters every list it returns through
  //      `VISIBLE_ENDPOINT_PRESET_KEYS`, which holds `anthropic`, `openai` and
  //      `custom` — never the gateway key. So the row is in no picker.
  //   2. `getPresetForUrl` searches that same FILTERED list, so an edit whose
  //      stored URL is the gateway's resolves to `custom`, not to this row.
  //   3. `activePresetObj` is `presets.find(...)` over the filtered list too,
  //      so even the one feed that names the gateway key explicitly — the
  //      playground's `initialValues.activePreset` — finds nothing and
  //      `apiKeyPlaceholder` falls through to the generic default. The
  //      placeholder DA1.32 wrote above is therefore itself unreachable.
  //   4. The only PRODUCTION feed of `initialValues.activePreset` is
  //      `pages/settings/AiSettingsPage.tsx`, which writes `'custom'` for any
  //      custom-endpoint connection — and a gateway connection is one.
  //   5. `canEditLlmConnection` (`apisetup/nessy-gateway.ts`) hides Edit for a
  //      gateway connection anyway, so that form does not open for it.
  // The KEY is live and the ROW is not: `NESSY_GATEWAY_PRESET_KEY` is still
  // read by `OPENAI_COMPAT_CUSTOM_URL_PRESETS` below, by the `submittedModels`
  // branch in `handleSubmit`, and by `apisetup/gateway-one-click.ts` — which
  // builds its OWN preset set and never reads this table. Nothing is deleted
  // here because deleting the row would change the playground registry, which
  // is outside the row that measured this.
  { key: NESSY_GATEWAY_PRESET_KEY, label: 'Nessy Gateway', url: NESSY_GATEWAY_BASE_URL, placeholder: 'Not needed — the one-click Nessy Gateway card signs you in' },
  { key: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com', placeholder: 'sk-ant-...' },
  { key: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'openai-eu', label: 'OpenAI EU', url: 'https://eu.api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'openai-us', label: 'OpenAI US', url: 'https://us.api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'google', label: 'Google AI Studio', url: 'https://generativelanguage.googleapis.com/v1beta', placeholder: 'AIza...' },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', placeholder: 'sk-or-...' },
  { key: 'azure-openai-responses', label: 'Azure OpenAI', url: '', placeholder: 'Paste your key here...', urlPlaceholder: 'https://<resource>.openai.azure.com/openai/v1' },
  { key: 'amazon-bedrock', label: 'Amazon Bedrock', url: 'https://bedrock-runtime.us-east-1.amazonaws.com', placeholder: 'AKIA...' },
  { key: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', placeholder: 'gsk_...' },
  { key: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1', placeholder: 'Paste your key here...' },
  { key: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com', placeholder: 'sk-...' },
  { key: 'xai', label: 'xAI (Grok)', url: 'https://api.x.ai/v1', placeholder: 'xai-...' },
  { key: 'cerebras', label: 'Cerebras', url: 'https://api.cerebras.ai/v1', placeholder: 'csk-...' },
  { key: 'zai', label: 'z.ai (GLM)', url: 'https://api.z.ai/api/coding/paas/v4', placeholder: 'Paste your key here...' },
  { key: 'huggingface', label: 'Hugging Face', url: 'https://router.huggingface.co/v1', placeholder: 'hf_...' },
  { key: 'minimax-global', label: 'Minimax Global', url: 'https://api.minimax.io/anthropic', placeholder: 'Paste your key here...' },
  { key: 'minimax-cn', label: 'Minimax CN', url: 'https://api.minimaxi.com/anthropic', placeholder: 'Paste your key here...' },
  { key: 'kimi-coding', label: 'Kimi (Coding)', url: 'https://api.kimi.com/coding', placeholder: 'sk-kimi-...' },
  { key: 'vercel-ai-gateway', label: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh', placeholder: 'Paste your key here...' },
  { key: 'manifest', label: 'Manifest', url: 'https://app.manifest.build/v1', placeholder: 'mnfst_...' },
  { key: 'custom', label: 'Custom', url: '', placeholder: 'Paste your key here...' },
]

/**
 * Presets without a Pi SDK provider entry that nonetheless expose a known
 * OpenAI-compatible protocol. They behave like 'custom' on submit (customEndpoint
 * gets pinned to openai-completions) but stay branded in the dropdown.
 */
const OPENAI_COMPAT_CUSTOM_URL_PRESETS: ReadonlySet<string> = new Set([NESSY_GATEWAY_PRESET_KEY, 'manifest'])
const OPENAI_COMPAT_CUSTOM_URL_PRESET_OPTIONS: Partial<Record<string, Pick<CustomEndpointConfig, 'supportsImages'>>> = {
  [NESSY_GATEWAY_PRESET_KEY]: { supportsImages: false },
}

// OpenAI provider presets - for Codex backend
// Only direct OpenAI is supported; 3PP providers (OpenRouter, Vercel, Ollama) should be
// configured via the Anthropic/Claude connection which routes through the Claude Agent SDK.
const OPENAI_PRESETS: Preset[] = [
  { key: 'openai', label: 'OpenAI', url: '' },
]

// Pi provider presets - unified API for 20+ LLM providers
const PI_PRESETS: Preset[] = [
  { key: 'pi', label: 'Nessy Backend (Direct)', url: '' },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api' },
  { key: 'custom', label: 'Custom', url: '' },
]

// Google AI Studio preset - single endpoint, no custom URL needed
const GOOGLE_PRESETS: Preset[] = [
  { key: 'google', label: 'Google AI Studio', url: '' },
]

/** Presets that require the Pi SDK for authentication — hidden in Anthropic API Key mode */
const PI_ONLY_PRESET_KEYS: ReadonlySet<string> = new Set(['minimax-global', 'minimax-cn'])

const COMPAT_ANTHROPIC_DEFAULTS = 'claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5'
const COMPAT_OPENAI_DEFAULTS = 'openai/gpt-5.2-codex, openai/gpt-5.1-codex-mini'
const COMPAT_MINIMAX_DEFAULTS = 'MiniMax-M2.5, MiniMax-M2.5-highspeed'
// UB7.7 / OQ-43.9 (a) — the Kimi K3 defaults (upstream v0.15.1's list); the mini default kimi-k2.6 lands with UB7.15.
const COMPAT_KIMI_DEFAULTS = 'k3, kimi-for-coding, kimi-for-coding-highspeed'

/**
 * UB7.7 / OQ-43.9 (a) — Moonshot's own API hosts. NO preset carries these URLs
 * (the owner's decision keeps the preset list closed); a BYO connection whose
 * base URL points here still gets the Kimi label, icon and model defaults.
 */
function isMoonshotHostBaseUrl(value: string): boolean {
  const url = value.toLowerCase()
  return url.includes('api.moonshot.ai') || url.includes('api.moonshot.cn')
}

// Corp default: the endpoint picker offers only Anthropic, OpenAI, and Custom.
// The other presets stay in ANTHROPIC_PRESETS (hidden, not deleted) — the
// Nessy Gateway one-click setup uses NESSY_GATEWAY_PRESET_KEY programmatically,
// and stored connections with a hidden preset URL resolve to 'custom' on edit.
const VISIBLE_ENDPOINT_PRESET_KEYS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'custom'])

function getPresetsForProvider(providerType: 'anthropic' | 'openai' | 'pi' | 'google' | 'pi_api_key'): Preset[] {
  if (providerType === 'pi_api_key') {
    return ANTHROPIC_PRESETS.filter(p => VISIBLE_ENDPOINT_PRESET_KEYS.has(p.key))
  }
  if (providerType === 'google') return GOOGLE_PRESETS
  if (providerType === 'pi') return PI_PRESETS
  if (providerType === 'openai') return OPENAI_PRESETS
  // Anthropic mode: exclude presets that only work via Pi SDK
  return ANTHROPIC_PRESETS
    .filter(p => !PI_ONLY_PRESET_KEYS.has(p.key))
    .filter(p => VISIBLE_ENDPOINT_PRESET_KEYS.has(p.key))
}

function getPresetForUrl(url: string, presets: Preset[]): PresetKey {
  const match = presets.find(p => p.key !== 'custom' && p.url === url)
  return match?.key ?? 'custom'
}

function parseModelList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

// ============================================================
// Pi model tier selection (for providers with many models)
// ============================================================

export function ApiKeyInput({
  status,
  errorMessage,
  onSubmit,
  formId = "api-key-form",
  disabled,
  providerType = 'anthropic',
  initialValues,
}: ApiKeyInputProps) {
  // Get presets based on provider type
  const presets = getPresetsForProvider(providerType)
  const defaultPreset = presets[0]

  // Compute initial preset: explicit (Pi piAuthProvider), derived from URL, or default
  const initialPreset = initialValues?.activePreset
    ?? (initialValues?.baseUrl ? getPresetForUrl(initialValues.baseUrl, presets) : defaultPreset.key)

  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState(initialValues?.apiKey ?? '')
  const [showValue, setShowValue] = useState(false)
  const [baseUrl, setBaseUrl] = useState(initialValues?.baseUrl ?? defaultPreset.url)
  const [activePreset, setActivePreset] = useState<PresetKey>(initialPreset)
  const [lastNonCustomPreset, setLastNonCustomPreset] = useState<PresetKey | null>(
    initialPreset !== 'custom' ? initialPreset : defaultPreset.key
  )
  const [connectionDefaultModel, setConnectionDefaultModel] = useState(initialValues?.connectionDefaultModel ?? '')
  const [customApi, setCustomApi] = useState<CustomEndpointApi>(initialValues?.customApi ?? 'openai-completions')
  // P6.586 — the header the key travels in. `authorization` is the default at
  // every reader, so an untouched form submits nothing new.
  const [credentialHeader, setCredentialHeader] = useState<NonNullable<CustomEndpointConfig['credentialHeader']>>(
    initialValues?.credentialHeader ?? 'authorization',
  )
  const [modelError, setModelError] = useState<string | null>(null)

  // Endpoint model catalog (C3): what the endpoint publishes, the user's pick of
  // it, and the entitlement verdicts for that pick.
  const [modelCatalog, setModelCatalog] = useState<ModelDefinition[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [modelProbes, setModelProbes] = useState<Record<string, ModelProbeResult['verdict']>>({})
  const [probing, setProbing] = useState(false)
  const [syncModelsFromEndpoint, setSyncModelsFromEndpoint] = useState(initialValues?.syncModelsFromEndpoint ?? false)
  /**
   * Submit the sync flag ONLY once the user has touched it. An untouched edit
   * must leave enrollment exactly as persisted — sending the unprefilled `false`
   * would silently withdraw a connection the user enrolled earlier.
   */
  const [syncToggleTouched, setSyncToggleTouched] = useState(false)

  // Bedrock auth state
  const [bedrockAuthMethod, setBedrockAuthMethod] = useState<'iam_credentials' | 'environment'>('iam_credentials')
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('')
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('')
  const [awsSessionToken, setAwsSessionToken] = useState('')
  const [awsRegion, setAwsRegion] = useState('us-east-1')

  // Pi model tier state (for providers with many models like OpenRouter, Vercel)
  const [piModels, setPiModels] = useState<PiModelInfo[]>([])
  const [piModelsLoading, setPiModelsLoading] = useState(false)
  const [bestModel, setBestModel] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [cheapModel, setCheapModel] = useState('')
  const [openTier, setOpenTier] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState('')
  const [tierDropdownPosition, setTierDropdownPosition] = useState<{ top: number; left: number; width: number } | null>(null)
  const tierFilterInputRef = useRef<HTMLInputElement>(null)
  const hydratedTierProviderRef = useRef<string | null>(null)

  const isDisabled = disabled || status === 'validating'

  const isPiApiKeyFlow = providerType === 'pi_api_key'
  const isBedrock = activePreset === 'amazon-bedrock'
  // Hide endpoint/model fields for providers with well-known endpoints handled by the SDK
  const DEFAULT_ENDPOINT_PROVIDERS = new Set(['anthropic', 'openai', 'pi', 'google'])
  const isDefaultProviderPreset = DEFAULT_ENDPOINT_PROVIDERS.has(activePreset)

  // Provider-specific placeholders from the active preset — UA12.214: the one prose placeholder a person can reach (the 'custom' row and this fallback; DA1.53's visible-key filter) goes through t(), the rest are key-format examples
  const activePresetObj = presets.find(p => p.key === activePreset)
  const apiKeyPlaceholder = activePresetObj?.key === 'custom' ? t('apiSetup.placeholderPasteKey') : activePresetObj?.placeholder
    ?? (providerType === 'google' ? 'AIza...'
    : providerType === 'pi' ? 'pi-...'
    : providerType === 'openai' ? 'sk-...'
    : t('apiSetup.placeholderPasteKey'))

  // Fetch Pi SDK models when a provider is selected in pi_api_key flow.
  // Returns all models sorted by cost (expensive-first) for the searchable tier dropdowns.
  const loadPiModels = useCallback(async (provider: string) => {
    if (!isPiApiKeyFlow || !provider || provider === 'custom' || DEFAULT_ENDPOINT_PROVIDERS.has(provider) || OPENAI_COMPAT_CUSTOM_URL_PRESETS.has(provider)) {
      setPiModels([])
      return
    }
    setPiModelsLoading(true)
    try {
      const result = await window.electronAPI.getPiProviderModels(provider)
      setPiModels(result.models)

      if (hydratedTierProviderRef.current !== provider) {
        const tiers = resolveTierModels(result.models, provider === initialPreset ? initialValues?.models : undefined)
        setBestModel(tiers.best)
        setDefaultModel(tiers.default_)
        setCheapModel(tiers.cheap)
        hydratedTierProviderRef.current = provider
      }
    } catch (err) {
      console.error('[ApiKeyInput] Failed to load models for', provider, err)
      setPiModels([])
    } finally {
      setPiModelsLoading(false)
    }
  }, [isPiApiKeyFlow])

  useEffect(() => {
    loadPiModels(activePreset)
  }, [activePreset, loadPiModels])

  // DA1.32 — **the gateway preset leaves this field BLANK, deliberately.** An
  // effect here used to read the live Nestor JWT off the main-process bridge
  // and drop it into the visible API-key input whenever the gateway preset was
  // active. Since DA1.13 (`packages/server-core/src/handlers/rpc/llm-connections.ts`)
  // the setup RPC REFUSES to store a gateway credential and deletes any
  // snapshot an older install left behind, so the prefill bought nothing and
  // paid for it by rendering a corporate token in a form field the user can
  // copy out of. The one-click gateway card
  // (`apps/electron/src/renderer/components/apisetup/gateway-one-click.ts`
  // symbol `createGatewayConnection`) is the only door, and it submits no
  // credential at all.
  //
  // Measured before the removal (2026-09-14): emptiness is load-bearing for
  // NOTHING on this surface. `handleSubmit` below never checks `apiKey`, the
  // step's Continue button is `disabled={false}`
  // (`components/onboarding/CredentialsStep.tsx`), and the only
  // `apiKeyRequired` verdict in the renderer belongs to a DIFFERENT form
  // (`apisetup/byo-runtime.ts` symbol `validateByoRuntimeForm`, rendered by
  // `components/onboarding/ByoRuntimeStep.tsx`). The bridge itself stays — its
  // live reader is `components/onboarding/GatewayConnectStep.tsx`, which needs
  // the value to prove the sign-in happened and never displays it.

  // Whether to show 3 tier dropdowns instead of text input
  const hasPiModels = isPiApiKeyFlow && piModels.length > 0 && !isDefaultProviderPreset && activePreset !== 'custom' && !isBedrock

  // Only an OpenAI-compatible endpoint publishes a usable `/models` catalog. An
  // Anthropic-shaped one answers without context lengths, so it is not offered.
  const canFetchModelCatalog = !isBedrock
    && !isDefaultProviderPreset
    && !!baseUrl.trim()
    && customApi === 'openai-completions'

  const selectedModelIds = useMemo(() => parseModelList(connectionDefaultModel), [connectionDefaultModel])

  const handleFetchModelCatalog = useCallback(async () => {
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      const result = await window.electronAPI.testLlmConnectionSetup({
        provider: 'anthropic',
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        customEndpoint: { api: 'openai-completions' },
        fetchModels: true,
      })
      if (!result.success) {
        setCatalogError(result.error ?? t('apiSetup.modelCatalog.fetchFailed'))
        return
      }
      setModelCatalog(result.models ?? [])
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error))
    } finally {
      setCatalogLoading(false)
    }
  }, [apiKey, baseUrl, t])

  const handleProbeSelectedModels = useCallback(async () => {
    if (selectedModelIds.length === 0) return
    setProbing(true)
    try {
      const result = await window.electronAPI.testLlmConnectionSetup({
        provider: 'anthropic',
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        customEndpoint: { api: 'openai-completions' },
        validateModels: selectedModelIds,
      })
      const next: Record<string, ModelProbeResult['verdict']> = {}
      for (const probe of result.modelProbes ?? []) next[probe.id] = probe.verdict
      setModelProbes(next)
    } catch {
      // A failed probe leaves the previous verdicts alone — it says nothing new.
    } finally {
      setProbing(false)
    }
  }, [apiKey, baseUrl, selectedModelIds])

  const handlePresetSelect = (preset: Preset) => {
    setActivePreset(preset.key)
    if (preset.key !== 'custom') {
      setLastNonCustomPreset(preset.key)
    }
    if (preset.key === 'custom') {
      setBaseUrl('')
    } else {
      setBaseUrl(preset.url)
    }
    setModelError(null)
    // Pre-fill recommended model for Ollama; clear for all others
    // (Default provider presets hide the field entirely, others default to provider model IDs when empty)
    if (preset.key === 'ollama') {
      setConnectionDefaultModel('qwen3-coder')
    } else if (preset.key === 'openrouter' || preset.key === 'vercel-ai-gateway') {
      setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
    } else if (preset.key === 'minimax-global' || preset.key === 'minimax-cn') {
      setConnectionDefaultModel(COMPAT_MINIMAX_DEFAULTS)
    } else if (preset.key === 'kimi-coding') {
      setConnectionDefaultModel(COMPAT_KIMI_DEFAULTS)
    } else if (preset.key === NESSY_GATEWAY_PRESET_KEY) {
      setConnectionDefaultModel(NESSY_GATEWAY_MODELS.map(model => model.id).join(', '))
    } else if (preset.key === 'manifest') {
      setConnectionDefaultModel('auto')
    } else if (preset.key === 'custom' || OPENAI_COMPAT_CUSTOM_URL_PRESETS.has(preset.key)) {
      setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
    } else {
      setConnectionDefaultModel('')
    }
  }

  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value)
    const presetKey = getPresetForUrl(value, presets)
    const currentPresetObj = presets.find(p => p.key === activePreset)
    const nextPresetState = resolvePresetStateForBaseUrlChange({
      matchedPreset: presetKey,
      activePreset,
      activePresetHasEmptyUrl: currentPresetObj?.url === '',
      lastNonCustomPreset,
    })
    setActivePreset(nextPresetState.activePreset)
    setLastNonCustomPreset(nextPresetState.lastNonCustomPreset)
    setModelError(null)
    if (!connectionDefaultModel.trim()) {
      if (presetKey === 'ollama') {
        setConnectionDefaultModel('qwen3-coder')
      } else if (presetKey === NESSY_GATEWAY_PRESET_KEY) {
        setConnectionDefaultModel(NESSY_GATEWAY_MODELS.map(model => model.id).join(', '))
      } else if (presetKey === 'manifest') {
        setConnectionDefaultModel('auto')
      } else if (presetKey === 'minimax-global' || presetKey === 'minimax-cn') {
        setConnectionDefaultModel(COMPAT_MINIMAX_DEFAULTS)
      } else if (presetKey === 'kimi-coding' || isMoonshotHostBaseUrl(value)) {
        // UB7.7 / OQ-43.9 (a) — a Moonshot host (no preset by decision) still
        // defaults to the Kimi K3 models when the field is empty.
        setConnectionDefaultModel(COMPAT_KIMI_DEFAULTS)
      } else if (presetKey === 'openrouter' || presetKey === 'vercel-ai-gateway' || presetKey === 'custom') {
        setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
      }
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const effectivePiAuthProvider = isPiApiKeyFlow
      ? resolvePiAuthProviderForSubmit(activePreset, lastNonCustomPreset)
      : undefined

    // Pi API key flow with tier dropdowns — submit selected models
    if (hasPiModels) {
      if (!bestModel || !defaultModel || !cheapModel) {
        setModelError('Please select a model for each tier.')
        return
      }
      const models: string[] = [bestModel, defaultModel, cheapModel]
      onSubmit({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        connectionDefaultModel: bestModel,
        models,
        piAuthProvider: effectivePiAuthProvider,
        modelSelectionMode: 'userDefined3Tier',
      })
      return
    }

    // Bedrock — routes through Pi SDK with piAuthProvider='amazon-bedrock'.
    // Submit with auth method and optional IAM credentials.
    if (isBedrock) {
      if (bedrockAuthMethod === 'iam_credentials' && !awsAccessKeyId.trim()) {
        setModelError('Access Key ID is required for IAM authentication.')
        return
      }
      if (bedrockAuthMethod === 'iam_credentials' && !awsSecretAccessKey.trim()) {
        setModelError('Secret Access Key is required for IAM authentication.')
        return
      }
      const parsedModels = parseModelList(connectionDefaultModel)
      onSubmit({
        apiKey: '',
        piAuthProvider: effectivePiAuthProvider,
        bedrockAuthMethod,
        awsRegion: awsRegion.trim() || 'us-east-1',
        ...(bedrockAuthMethod === 'iam_credentials' ? {
          iamCredentials: {
            accessKeyId: awsAccessKeyId.trim(),
            secretAccessKey: awsSecretAccessKey.trim(),
            ...(awsSessionToken.trim() ? { sessionToken: awsSessionToken.trim() } : {}),
          },
        } : {}),
        connectionDefaultModel: parsedModels[0],
        models: parsedModels.length > 0 ? parsedModels : undefined,
      })
      return
    }

    const effectiveBaseUrl = baseUrl.trim()

    const parsedModels = parseModelList(connectionDefaultModel)
    const submittedModels = activePreset === NESSY_GATEWAY_PRESET_KEY
      ? NESSY_GATEWAY_MODELS
      : parsedModels

    const isUsingDefaultEndpoint = isDefaultProviderPreset || !effectiveBaseUrl
    const requiresModel = !isDefaultProviderPreset && !!effectiveBaseUrl
    if (requiresModel && parsedModels.length === 0) {
      setModelError('Default model is required for custom endpoints.')
      return
    }

    // Include custom endpoint protocol when user configured a custom base URL.
    // Branded openai-compat presets (e.g. Manifest) are pinned to openai-completions
    // and routed via the Pi SDK's openai adapter.
    const { customEndpoint, piAuthProvider: resolvedPiAuthProvider } = resolveCustomEndpointPayload({
      activePreset,
      baseUrl: effectiveBaseUrl,
      customApi,
      brandedOpenAiCompatPresets: OPENAI_COMPAT_CUSTOM_URL_PRESETS,
      brandedOpenAiCompatPresetOptions: OPENAI_COMPAT_CUSTOM_URL_PRESET_OPTIONS,
      fallbackPiAuthProvider: effectivePiAuthProvider,
      credentialHeader,
    })

    onSubmit({
      apiKey: apiKey.trim(),
      baseUrl: isUsingDefaultEndpoint ? undefined : effectiveBaseUrl,
      connectionDefaultModel: parsedModels[0],
      models: submittedModels.length > 0 ? submittedModels : undefined,
      piAuthProvider: resolvedPiAuthProvider,
      modelSelectionMode: isPiApiKeyFlow
        ? (parsedModels.length > 0 ? 'userDefined3Tier' : 'automaticallySyncedFromProvider')
        : undefined,
      customEndpoint,
      ...(canFetchModelCatalog && syncToggleTouched ? { syncModelsFromEndpoint } : {}),
    })
  }

  const tierConfigs = [
    { label: 'Best', desc: 'most capable', value: bestModel, onChange: setBestModel },
    { label: 'Balanced', desc: 'good for everyday use', value: defaultModel, onChange: setDefaultModel },
    { label: 'Fast', desc: 'summarization & utility', value: cheapModel, onChange: setCheapModel },
  ]
  const activeTierConfig = openTier ? tierConfigs.find(t => t.label === openTier) : null

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-6">
      {/* API Key — hidden for Bedrock (uses IAM/Environment auth) */}
      {!isBedrock && (<div className="space-y-2">
        <Label htmlFor="api-key">{t('apiSetup.apiKey')}</Label>
        <div className={cn(
          "field-surface relative rounded-md"
        )}>
          <Input
            id="api-key"
            type={showValue ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={apiKeyPlaceholder}
            className={cn(
              "pr-10 border-0 bg-transparent shadow-none",
              status === 'error' && "focus-visible:ring-destructive"
            )}
            disabled={isDisabled}
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowValue(!showValue)}
            className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center text-tertiary hover:text-foreground"
            tabIndex={-1}
            aria-label={showValue ? t('common.hide') : t('common.show')}
          >
            {showValue ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        </div>
      </div>)}

      {/* Endpoint/Provider Preset Selector - hidden when only one preset (e.g. Codex/OpenAI direct) */}
      {presets.length > 1 && (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="base-url">{t('apiSetup.endpoint')}</Label>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={isDisabled}
              className="motion-press flex h-control-sm items-center gap-1 rounded-full pl-2.5 pr-2 text-label-sm font-medium text-secondary ring-1 ring-inset ring-border hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"
            >
              {presets.find(p => p.key === activePreset)?.label}
              <ChevronDown className="size-2.5 text-tertiary" />
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end" className="z-floating-menu">
              {presets.map((preset) => (
                <StyledDropdownMenuItem
                  key={preset.key}
                  onClick={() => handlePresetSelect(preset)}
                  className="justify-between"
                >
                  {preset.label}
                  <Check className={cn("size-3", activePreset === preset.key ? "opacity-100" : "opacity-0")} />
                </StyledDropdownMenuItem>
              ))}
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Base URL input - hidden for default provider presets (Anthropic/OpenAI) and Bedrock */}
        {!isDefaultProviderPreset && !isBedrock && (
          <div className={cn(
            "field-surface rounded-md"
          )}>
            <Input
              id="base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
              placeholder={activePresetObj?.urlPlaceholder ?? "https://your-api-endpoint.com"}
              className="border-0 bg-transparent shadow-none"
              disabled={isDisabled}
            />
          </div>
        )}
        {/* DA1.11 — the gateway HOST on a path that is not the gateway URL.
            A NOTICE and not a refusal: per AGENTS.md that URL is a legitimate
            custom endpoint with normal provider auth, so the form must not
            block it — it must stop the silence. Today such a connection gets no
            `Nestor-Token` (it classifies BYO) and no forced re-mint, and the
            gateway's raw token-parse 401 then reads as a broken login. The EXACT
            gateway URL is a different case and is still refused outright, by
            `validateByoRuntimeForm`/`validateMergedEndpointForm`. */}
        {isGatewayHostNonGatewayEndpoint(baseUrl) && (
          <p className="text-label-sm text-tertiary">{t('apiSetup.gatewayHostNotGatewayUrl')}</p>
        )}
      </div>
      )}

      {/* Protocol Toggle — visible as soon as Custom preset is selected */}
      {activePreset === 'custom' && !isDefaultProviderPreset && (
        <div className="space-y-2">
          <Label>{t('apiSetup.protocol')}</Label>
          <div className={cn(
            "flex gap-0.5 rounded-md bg-fill-hover p-0.5",
            "bg-foreground-2",
            isDisabled && "opacity-50 pointer-events-none"
          )}>
            {([
              { value: 'openai-completions' as const, label: 'OpenAI Compatible' },
              { value: 'anthropic-messages' as const, label: 'Anthropic Compatible' },
            ]).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                disabled={isDisabled}
                onClick={() => setCustomApi(value)}
                className={cn(
                  "flex-1 rounded-sm py-1 text-label-sm font-medium transition-colors duration-micro ease-out-subtle hover:duration-instant",
                  customApi === value
                    ? "bg-raised text-foreground shadow-elev-1"
                    : "text-secondary hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-label-sm text-tertiary">
            {t('apiSetup.protocolHint')}
          </p>
        </div>
      )}

      {/* P6.586 — the credential header. The model layer has carried
          `customEndpoint.credentialHeader` since P6.258 and both wires have
          honoured it since P6.585; until now nothing could set it, so an
          endpoint that reads its key from `x-api-key` was unreachable from the
          UI at all. Shown only for a genuine custom endpoint: a branded
          preset's scheme is already known and is pinned in the payload builder. */}
      {activePreset === 'custom' && !isDefaultProviderPreset && (
        <div className="space-y-2">
          <Label>{t('apiSetup.credentialHeader.label')}</Label>
          <div className={cn(
            "flex gap-0.5 rounded-md bg-fill-hover p-0.5",
            "bg-foreground-2",
            isDisabled && "opacity-50 pointer-events-none"
          )}>
            {([
              { value: 'authorization' as const, label: t('apiSetup.credentialHeader.authorization') },
              { value: 'x-api-key' as const, label: t('apiSetup.credentialHeader.xApiKey') },
            ]).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                disabled={isDisabled}
                onClick={() => setCredentialHeader(value)}
                className={cn(
                  "flex-1 rounded-sm py-1 text-label-sm font-medium transition-colors duration-micro ease-out-subtle hover:duration-instant",
                  credentialHeader === value
                    ? "bg-raised text-foreground shadow-elev-1"
                    : "text-secondary hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-label-sm text-tertiary">
            {t('apiSetup.credentialHeader.help')}
          </p>
        </div>
      )}

      {/* Bedrock Auth Section */}
      {isBedrock && (
        <>
          {/* Auth Method Toggle */}
          <div className="space-y-2">
            <Label>{t('apiSetup.authentication')}</Label>
            <div className={cn(
              "flex gap-0.5 rounded-md bg-fill-hover p-0.5",
              "bg-foreground-2",
              isDisabled && "opacity-50 pointer-events-none"
            )}>
              {([
                { value: 'iam_credentials' as const, label: 'IAM Credentials' },
                { value: 'environment' as const, label: 'Environment (AWS CLI)' },
              ]).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => setBedrockAuthMethod(value)}
                  className={cn(
                    "flex-1 rounded-sm py-1 text-label-sm font-medium transition-colors duration-micro ease-out-subtle hover:duration-instant",
                    bedrockAuthMethod === value
                      ? "bg-raised text-foreground shadow-elev-1"
                      : "text-secondary hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* IAM Credential Fields */}
          {bedrockAuthMethod === 'iam_credentials' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="aws-access-key-id" className="text-label-sm font-normal text-secondary">
                  {t('apiSetup.awsAccessKeyId')}
                </Label>
                <div className="field-surface rounded-md">
                  <Input
                    id="aws-access-key-id"
                    type="text"
                    value={awsAccessKeyId}
                    onChange={(e) => setAwsAccessKeyId(e.target.value)}
                    placeholder="AKIA..."
                    className="border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                    autoFocus
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="aws-secret-key" className="text-label-sm font-normal text-secondary">
                  {t('apiSetup.awsSecretAccessKey')}
                </Label>
                <div className="field-surface relative rounded-md">
                  <Input
                    id="aws-secret-key"
                    type={showValue ? 'text' : 'password'}
                    value={awsSecretAccessKey}
                    onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                    placeholder={t("apiSetup.secretAccessKey")}
                    className="pr-10 border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                  />
                  <button
                    type="button"
                    onClick={() => setShowValue(!showValue)}
                    className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center text-tertiary hover:text-foreground"
                    tabIndex={-1}
                    aria-label={showValue ? t('common.hide') : t('common.show')}
                  >
                    {showValue ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="aws-session-token" className="text-label-sm font-normal text-secondary">
                  {t('apiSetup.awsSessionToken')} <span className="text-tertiary">· {t('apiSetup.optional')}</span>
                </Label>
                <div className="field-surface rounded-md">
                  <Input
                    id="aws-session-token"
                    type="text"
                    value={awsSessionToken}
                    onChange={(e) => setAwsSessionToken(e.target.value)}
                    placeholder={t("apiSetup.temporaryCredentials")}
                    className="border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Environment info */}
          {bedrockAuthMethod === 'environment' && (
            <div className="rounded-md bg-foreground-2 p-3">
              <p className="text-label-sm text-tertiary">
                <Trans i18nKey="apiSetup.awsCredentialChain" components={{ code: <code className="text-secondary" /> }} />
              </p>
            </div>
          )}

          {/* AWS Region */}
          <div className="space-y-1.5">
            <Label htmlFor="aws-region" className="text-label-sm font-normal text-secondary">
              {t('apiSetup.awsRegion')}
            </Label>
            <div className="field-surface rounded-md">
              <Input
                id="aws-region"
                type="text"
                value={awsRegion}
                onChange={(e) => setAwsRegion(e.target.value)}
                placeholder="us-east-1"
                className="border-0 bg-transparent shadow-none"
                disabled={isDisabled}
              />
            </div>
            {/* P6.457 — the panel above promises "your existing AWS credential
                chain"; this says what that chain does about the REGION, which is
                the half the model-id prefix is silently derived from. */}
            <p className="text-label-sm text-tertiary">{t("apiSetup.bedrockRegionSource")}</p>
          </div>
        </>
      )}

      {/* Model Selection — 3 tier dropdowns for Pi providers, text input for custom/compat */}
      {hasPiModels ? (
        <div className="space-y-3">
          {piModelsLoading ? (
            <div className="flex items-center gap-2 py-3 text-tertiary">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-xs">{t("apiSetup.loadingModels")}</span>
            </div>
          ) : (
            <>
              {tierConfigs.map(({ label, desc, value }) => (
                <div key={label} className="space-y-1.5">
                  <Label className="text-label-sm font-normal text-secondary">
                    {label}{' '}
                    <span className="text-tertiary">· {desc}</span>
                  </Label>
                  <button
                    type="button"
                    disabled={isDisabled}
                    onClick={(e) => {
                      if (openTier === label) {
                        setOpenTier(null)
                        setTierFilter('')
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setTierDropdownPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width })
                        setOpenTier(label)
                        setTierFilter('')
                        setTimeout(() => tierFilterInputRef.current?.focus(), 0)
                      }
                    }}
                    className={cn(
                      "field-surface flex h-9 w-full items-center justify-between rounded-md px-3 text-label",
                      isDisabled && "opacity-50 pointer-events-none"
                    )}
                  >
                    <span className="truncate text-foreground">
                      {piModels.find(m => m.id === value)?.name ?? t('apiSetup.selectModel')}
                    </span>
                    <ChevronDown className="size-3 shrink-0 text-tertiary" />
                  </button>
                </div>
              ))}
              {activeTierConfig && tierDropdownPosition && (
                <>
                  <div
                    className="fixed inset-0 z-floating-backdrop"
                    onClick={() => { setOpenTier(null); setTierFilter('') }}
                  />
                  <div
                    className="popover-styled fixed z-floating-menu min-w-[200px] overflow-hidden text-foreground"
                    style={{
                      top: tierDropdownPosition.top,
                      left: tierDropdownPosition.left,
                      width: tierDropdownPosition.width,
                    }}
                  >
                    <CommandPrimitive
                      className="min-w-[200px]"
                      shouldFilter={false}
                    >
                      <div className="border-b border-subtle px-3 py-2">
                        <CommandPrimitive.Input
                          ref={tierFilterInputRef}
                          value={tierFilter}
                          onValueChange={setTierFilter}
                          placeholder={t("apiSetup.searchModels")}
                          autoFocus
                          className="w-full bg-transparent text-label outline-none placeholder:text-tertiary placeholder:select-none"
                        />
                      </div>
                      <CommandPrimitive.List className="max-h-[240px] overflow-y-auto p-1">
                        {piModels
                          .filter(m => m.name.toLowerCase().includes(tierFilter.toLowerCase()))
                          .map((model) => (
                            <CommandPrimitive.Item
                              key={model.id}
                              value={model.id}
                              onSelect={() => {
                                activeTierConfig.onChange(model.id)
                                setOpenTier(null)
                                setTierFilter('')
                              }}
                              className={cn(
                                "flex min-h-row-menu cursor-pointer select-none items-center justify-between gap-3 rounded-md px-3 text-label",
                                "outline-none data-[selected=true]:bg-fill-hover"
                              )}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="truncate">{model.name}</span>
                                {model.reasoning && (
                                  <span className="shrink-0 text-caption text-tertiary">reasoning</span>
                                )}
                              </div>
                              <Check className={cn("size-3 shrink-0", activeTierConfig.value === model.id ? "opacity-100" : "opacity-0")} />
                            </CommandPrimitive.Item>
                          ))}
                      </CommandPrimitive.List>
                    </CommandPrimitive>
                  </div>
                </>
              )}
              {modelError && (
                <p className="text-xs text-destructive">{modelError}</p>
              )}
            </>
          )}
        </div>
      ) : !isDefaultProviderPreset && (
        <div className="space-y-2">
          <Label htmlFor="connection-default-model" className="font-normal text-secondary">
            {t('apiSetup.defaultModel')}{' '}
            <span className="text-tertiary">
              · {!isBedrock && baseUrl.trim() ? t('apiSetup.required') : t('apiSetup.optional')}
            </span>
          </Label>
          <div className={cn(
            "field-surface rounded-md",
            modelError && "ring-1 ring-destructive/40"
          )}>
            <Input
              id="connection-default-model"
              type="text"
              value={connectionDefaultModel}
              onChange={(e) => {
                setConnectionDefaultModel(e.target.value)
                setModelError(null)
              }}
              placeholder="e.g. claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5"
              className="border-0 bg-transparent shadow-none"
              disabled={isDisabled}
            />
          </div>
          {modelError && (
            <p className="text-xs text-destructive">{modelError}</p>
          )}
          <p className="text-label-sm text-tertiary">
            {t('apiSetup.modelListHint')}
          </p>

          {/* Endpoint model catalog (C3) — only for OpenAI-compatible endpoints. */}
          {canFetchModelCatalog && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={isDisabled || catalogLoading}
                  onClick={handleFetchModelCatalog}
                >
                  {catalogLoading && <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />}
                  {t('apiSetup.modelCatalog.fetch')}
                </Button>
                {modelCatalog && (
                  <span className="text-label-sm text-tertiary">
                    {t('apiSetup.modelCatalog.publishedCount', { count: modelCatalog.length })}
                  </span>
                )}
              </div>

              {catalogError && <p className="text-xs text-destructive">{catalogError}</p>}

              {modelCatalog && (
                <ModelCatalogPicker
                  catalog={modelCatalog}
                  selectedIds={selectedModelIds}
                  onSelectionChange={(ids) => {
                    setConnectionDefaultModel(ids.join(', '))
                    setModelError(null)
                  }}
                  probes={modelProbes}
                  onProbeSelected={handleProbeSelectedModels}
                  probing={probing}
                />
              )}

              <label className="flex items-start gap-2 text-label-sm text-secondary">
                <Switch
                  checked={syncModelsFromEndpoint}
                  onCheckedChange={(next) => { setSyncModelsFromEndpoint(next); setSyncToggleTouched(true) }}
                  disabled={isDisabled}
                />
                <span>
                  {t('apiSetup.modelCatalog.autoRefresh')}
                  <span className="block text-tertiary">{t('apiSetup.modelCatalog.autoRefreshHint')}</span>
                </span>
              </label>
            </div>
          )}
          {(activePreset === 'custom' || !activePreset) && (
            <p className="text-label-sm text-tertiary">
              {t('apiSetup.customModelHint')}
            </p>
          )}
        </div>
      )}

      {/* Error message */}
      {status === 'error' && errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}
    </form>
  )
}
