import type { CapabilityCatalogChangedEvent } from '@nessy-agent/shared/protocol/capabilities'

interface CapabilityRefreshContext {
  workspaceId: string
  sessionId: string | null
}

interface CapabilityDependentRefreshers {
  refreshCapabilityViews: () => unknown
  refreshCustomSlashCommands: () => unknown
  invalidateMarketplaceQueries: () => unknown
}

/** Refresh every renderer projection derived from the same capability snapshot. */
export function refreshCapabilityDependentsOnChange(
  event: Pick<CapabilityCatalogChangedEvent, 'workspaceId' | 'sessionId'>,
  context: CapabilityRefreshContext,
  refreshers: CapabilityDependentRefreshers,
): boolean {
  if (event.workspaceId !== context.workspaceId) return false
  if (event.sessionId && event.sessionId !== context.sessionId) return false

  void refreshers.refreshCapabilityViews()
  void refreshers.refreshCustomSlashCommands()
  void refreshers.invalidateMarketplaceQueries()
  return true
}
