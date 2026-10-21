/**
 * Provider Icons
 *
 * Maps LLM provider types and base URLs to their respective brand icons.
 * Used in AI Settings page and anywhere connection logos are needed.
 */

import type { ComponentType } from 'react'

import awsIcon from '@/assets/provider-icons/aws.svg'
import azureIcon from '@/assets/provider-icons/azure.svg'
import googleIcon from '@/assets/provider-icons/google.svg'
import huggingfaceIcon from '@/assets/provider-icons/huggingface.svg'
import kimiIcon from '@/assets/provider-icons/kimi.svg'
import minimaxIcon from '@/assets/provider-icons/minimax.svg'
import mistralIcon from '@/assets/provider-icons/mistral.svg'
import ollamaIcon from '@/assets/provider-icons/ollama.svg'
import openrouterIcon from '@/assets/provider-icons/openrouter.svg'
import vercelIcon from '@/assets/provider-icons/vercel.svg'
import { NessySymbol } from '@/components/icons/NessySymbol'
import { ClaudeIcon, OpenAiIcon, PiIcon } from '@/components/icons/runtime'

import { isNestorCliBaseUrl } from '@nessy-agent/shared/auth/nestor'
import type { LlmProviderType } from '@nessy-agent/shared/config/llm-connections'

/** Mono marks are React components so they inherit `currentColor`; the rest stay static files. */
export type ProviderIconComponent = ComponentType<{ className?: string }>

export type ProviderIcon =
  | { kind: 'component'; Component: ProviderIconComponent }
  | { kind: 'url'; url: string }

const component = (Component: ProviderIconComponent): ProviderIcon => ({ kind: 'component', Component })
const url = (value: string): ProviderIcon => ({ kind: 'url', url: value })

/**
 * Icon for each provider. Brand marks we own the shape of (Claude, OpenAI,
 * Nessy, Pi) are mono components; the remaining vendors keep their static
 * multi-color SVGs.
 */
export const providerIcons = {
  anthropic: component(ClaudeIcon),
  openai: component(OpenAiIcon),
  aws: url(awsIcon),
  azure: url(azureIcon),
  google: url(googleIcon),
  huggingface: url(huggingfaceIcon),
  kimi: url(kimiIcon),
  minimax: url(minimaxIcon),
  mistral: url(mistralIcon),
  ollama: url(ollamaIcon),
  openrouter: url(openrouterIcon),
  vercel: url(vercelIcon),
} as const

export type ProviderIconKey = keyof typeof providerIcons

/** Human-readable provider names */
const providerDisplayNames: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compat: 'OpenAI',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  minimax: 'Minimax',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  'nestor-cloud-agent': 'Nessy Cloud Agent',
  pi: 'Nessy Backend',
  pi_compat: 'Nessy Backend',
  vercel: 'Vercel',
}

/** Get a human-readable provider name from provider type and optional base URL */
export function getProviderDisplayName(providerType: string, baseUrl?: string | null): string {
  // Try URL detection first for compat providers
  if (baseUrl) {
    const url = baseUrl.toLowerCase()
    if (url.includes('openrouter.ai')) return 'OpenRouter'
    if (url.includes('ollama')) return 'Ollama'
    if (url.includes('kimi.com')) return 'Kimi'
    // UB7.2->UB7.7 — Moonshot hosts wear the Kimi brand (same vendor), OQ-43.9 (a).
    if (url.includes('moonshot.ai') || url.includes('moonshot.cn')) return 'Moonshot AI'
    if (url.includes('minimax.io') || url.includes('minimaxi.com')) return 'Minimax'
    if (url.includes('v0.dev') || url.includes('vercel')) return 'Vercel'
    if (url.includes('manifest.build')) return 'Manifest'
  }
  return providerDisplayNames[providerType] || providerType
}

/**
 * Detect provider from base URL
 */
function detectProviderFromUrl(baseUrl: string): ProviderIconKey | null {
  const url = baseUrl.toLowerCase()

  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('ollama')) return 'ollama'
  if (url.includes('api.anthropic.com')) return 'anthropic'
  if (url.includes('api.openai.com')) return 'openai'
  if (url.includes('v0.dev') || url.includes('vercel')) return 'vercel'
  if (url.includes('generativelanguage.googleapis.com') || url.includes('ai.google')) return 'google'
  if (url.includes('kimi.com')) return 'kimi'
  // UB7.7 — Moonshot hosts reuse the Kimi static icon (same vendor, OQ-43.9 (a)).
  if (url.includes('moonshot.ai') || url.includes('moonshot.cn')) return 'kimi'
  if (url.includes('minimax.io') || url.includes('minimaxi.com')) return 'minimax'
  if (url.includes('mistral.ai')) return 'mistral'
  if (url.includes('bedrock')) return 'aws'
  if (url.includes('huggingface.co')) return 'huggingface'

  return null
}

/**
 * Map Pi SDK auth provider names to icon keys.
 * For Pi connections, we show the actual upstream provider's icon
 * instead of the generic Pi logo.
 */
function piAuthProviderToIcon(piAuthProvider: string): ProviderIconKey | null {
  switch (piAuthProvider) {
    case 'openai':
    case 'openai-codex':
      return 'openai'
    case 'anthropic':
      return 'anthropic'
    case 'openrouter':
      return 'openrouter'
    case 'google':
      return 'google'
    case 'kimi-coding':
    // UB7.7 — Moonshot's Pi auth providers reuse the Kimi icon (OQ-43.9 (a)).
    case 'moonshotai':
    case 'moonshotai-cn':
      return 'kimi'
    case 'minimax':
    case 'minimax-global':
    case 'minimax-cn':
      return 'minimax'
    case 'mistral':
      return 'mistral'
    case 'amazon-bedrock':
      return 'aws'
    case 'azure-openai-responses':
      return 'azure'
    case 'huggingface':
      return 'huggingface'
    case 'vercel-ai-gateway':
      return 'vercel'
    default:
      return null
  }
}

/**
 * Domain map for providers without static SVG icons.
 * Used to generate Google Favicon V2 URLs as fallback.
 */
const PI_AUTH_PROVIDER_DOMAINS: Record<string, string> = {
  groq: 'groq.com',
  xai: 'x.ai',
  cerebras: 'cerebras.ai',
  deepseek: 'deepseek.com',
  zai: 'z.ai',
}

/**
 * Get provider icon URL for a given provider type and optional base URL.
 * Base URL detection takes precedence for compatible providers (openai_compat, pi_compat).
 * For Pi connections, resolves to the upstream provider's icon via piAuthProvider.
 *
 * @param providerType - The LLM provider type
 * @param baseUrl - Optional custom base URL for detection
 * @param piAuthProvider - Optional Pi SDK auth provider (e.g. 'openai-codex', 'openrouter')
 * @returns A mono component or an icon URL, or null if no matching icon
 */
export function getProviderIcon(
  providerType: LlmProviderType | string,
  baseUrl?: string | null,
  piAuthProvider?: string | null
): ProviderIcon | null {
  // For compatible providers, try to detect from URL first
  if (baseUrl && (providerType === 'openai_compat' || providerType === 'pi_compat')) {
    const detectedProvider = detectProviderFromUrl(baseUrl)
    if (detectedProvider) {
      return providerIcons[detectedProvider]
    }
    // Manifest has no bundled SVG — fall back to Google Favicon V2 (same trick used for groq/xai elsewhere).
    if (baseUrl.toLowerCase().includes('manifest.build')) {
      return url('https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=https://app.manifest.build')
    }
  }

  // Map provider type to icon
  switch (providerType) {
    case 'anthropic':
    case 'claude-runtime':
      return providerIcons.anthropic
    case 'openai':
    case 'openai_compat':
    case 'codex-runtime':
      return providerIcons.openai
    case 'nestor-cloud-agent':
      return component(NessySymbol)
    case 'pi':
    case 'pi_compat': {
      // The built-in Nessy Gateway connection is ours, not the upstream vendor's
      if (isNestorCliBaseUrl(baseUrl)) return component(NessySymbol)
      // Resolve to actual upstream provider icon
      if (piAuthProvider) {
        const iconKey = piAuthProviderToIcon(piAuthProvider)
        if (iconKey) return providerIcons[iconKey]
        // Favicon fallback for providers without static SVGs
        const domain = PI_AUTH_PROVIDER_DOMAINS[piAuthProvider]
        if (domain) {
          return url(`https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=https://${domain}`)
        }
      }
      return component(PiIcon)  // Unknown/custom Pi provider
    }
    default:
      // Try URL detection as fallback
      if (baseUrl) {
        const detectedProvider = detectProviderFromUrl(baseUrl)
        if (detectedProvider) {
          return providerIcons[detectedProvider]
        }
      }
      return null
  }
}
