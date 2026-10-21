/**
 * Provider metadata for user-facing error messages and recovery actions.
 * Maps provider identifiers to their status pages and dashboards.
 */

export interface ProviderMetadata {
  /** Display name */
  name: string
  /** Provider status page URL */
  statusPageUrl?: string
  /** Provider dashboard/billing URL */
  dashboardUrl?: string
}

/**
 * Metadata for the Nessy backend.
 */
const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  nessy: {
    name: 'Nessy CLI',
    dashboardUrl: 'https://chat.nessy.ai',
  },
}

/**
 * Look up provider metadata by provider type.
 */
export function getProviderMetadata(
  providerType: string,
): ProviderMetadata | undefined {
  if (providerType === 'nessy') {
    return PROVIDER_METADATA.nessy
  }
  return undefined
}

/**
 * Get just the display name for a provider, with a fallback.
 */
export function getProviderDisplayName(
  providerType: string,
): string {
  return getProviderMetadata(providerType)?.name ?? 'AI provider'
}
