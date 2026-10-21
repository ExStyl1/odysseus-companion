import type { CustomEndpointApi, CustomEndpointConfig } from '@config/llm-connections'

export type PresetKey = string

/**
 * Preset keys that are regional variants of a canonical Pi auth provider.
 * The Pi SDK recognizes both 'minimax' and 'minimax-cn' as separate providers
 * with distinct base URLs (api.minimax.io vs api.minimaxi.com), so only
 * 'minimax-global' needs aliasing — 'minimax-cn' maps 1:1 to the Pi SDK provider.
 */
const PI_AUTH_PROVIDER_ALIASES: Record<string, string> = {
  'minimax-global': 'minimax',
}

export function resolvePiAuthProviderForSubmit(
  activePreset: PresetKey,
  lastNonCustomPreset: PresetKey | null
): string | undefined {
  if (activePreset === 'custom') {
    // Pi SDK needs a provider hint for auth header formatting even when
    // the URL is user-provided — default to anthropic as the safest baseline.
    const resolved = lastNonCustomPreset && lastNonCustomPreset !== 'custom'
      ? lastNonCustomPreset
      : 'anthropic'
    return PI_AUTH_PROVIDER_ALIASES[resolved] ?? resolved
  }

  return PI_AUTH_PROVIDER_ALIASES[activePreset] ?? activePreset
}

export function resolvePresetStateForBaseUrlChange(params: {
  matchedPreset: PresetKey
  activePreset: PresetKey
  activePresetHasEmptyUrl: boolean
  lastNonCustomPreset: PresetKey | null
}): { activePreset: PresetKey; lastNonCustomPreset: PresetKey | null } {
  const { matchedPreset, activePreset, activePresetHasEmptyUrl, lastNonCustomPreset } = params

  if (matchedPreset !== 'custom') {
    return {
      activePreset: matchedPreset,
      lastNonCustomPreset: matchedPreset,
    }
  }

  if (activePresetHasEmptyUrl) {
    return {
      activePreset,
      lastNonCustomPreset,
    }
  }

  return {
    activePreset: 'custom',
    lastNonCustomPreset,
  }
}

/**
 * Resolve the customEndpoint + piAuthProvider payload at submit time.
 *
 * Three submit branches:
 *  - branded openai-compat preset (e.g. Manifest)  → pinned to openai-completions
 *  - generic custom preset with a base URL         → honors the protocol toggle
 *  - everything else                               → no customEndpoint, passthrough piAuth
 */
export function resolveCustomEndpointPayload(params: {
  activePreset: PresetKey
  baseUrl: string
  customApi: CustomEndpointApi
  brandedOpenAiCompatPresets: ReadonlySet<string>
  brandedOpenAiCompatPresetOptions?: Partial<Record<string, Pick<CustomEndpointConfig, 'supportsImages'>>>
  fallbackPiAuthProvider: string | undefined
  /**
   * Forced dialect for this connection's models (E6). Only meaningful on a
   * custom endpoint — a branded preset's own quirks are already known — and
   * omitted entirely when 'auto', so an existing connection's payload is
   * byte-identical to before.
   */
  dialect?: 'qwen'
  /**
   * P6.586 — which header the API key travels in. Only meaningful on a custom
   * endpoint: a branded preset's own scheme is already known, and a standard
   * provider's is fixed by that provider.
   *
   * OMITTED when it is `authorization`, deliberately, so an existing
   * connection's payload stays byte-identical: the field's absence already
   * means Authorization at every reader
   * (`codex-responses-adapter/src/nestor-client.ts` `credentialHeaderFor`), and
   * writing the default explicitly would rewrite every stored connection to say
   * what it already meant.
   */
  credentialHeader?: CustomEndpointConfig['credentialHeader']
}): {
  customEndpoint: CustomEndpointConfig | undefined
  piAuthProvider: string | undefined
} {
  const { activePreset, baseUrl, customApi, brandedOpenAiCompatPresets, brandedOpenAiCompatPresetOptions, fallbackPiAuthProvider, dialect, credentialHeader } = params

  const isBrandedOpenAiCompat = brandedOpenAiCompatPresets.has(activePreset) && !!baseUrl
  const isCustomEndpoint = (activePreset === 'custom' && !!baseUrl) || isBrandedOpenAiCompat
  const effectiveApi: CustomEndpointApi = isBrandedOpenAiCompat ? 'openai-completions' : customApi
  const presetOptions = isBrandedOpenAiCompat ? brandedOpenAiCompatPresetOptions?.[activePreset] : undefined

  return {
    customEndpoint: isCustomEndpoint
      ? {
          api: effectiveApi,
          ...(presetOptions?.supportsImages !== undefined ? { supportsImages: presetOptions.supportsImages } : {}),
          ...(dialect ? { dialect } : {}),
          ...(!isBrandedOpenAiCompat && credentialHeader === 'x-api-key' ? { credentialHeader } : {}),
        }
      : undefined,
    piAuthProvider: isCustomEndpoint
      ? (effectiveApi === 'anthropic-messages' ? 'anthropic' : 'openai')
      : fallbackPiAuthProvider,
  }
}
