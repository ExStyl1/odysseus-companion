import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { PluginManagementApi, PluginStoreV2 } from '@nessy-agent/shared/plugins'
import type { MarketplaceRegistryController } from '@nessy-agent/shared/marketplace'
import type { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import type { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import type { IsolationCapabilityReport } from '../pi-harness/isolation-capabilities'

/**
 * Generic handler dependency bag.
 * Concrete hosts specialize these generics to their runtime implementations.
 *
 * TSessionManager defaults to ISessionManager, TOAuthFlowStore
 * defaults to IOAuthFlowStore, TWindowManager defaults to IWindowManager,
 * and TBrowserPaneManager defaults to IBrowserPaneManager so core handlers
 * get typed access without specialization.  Electron narrows all to their
 * concrete implementations.
 */
export interface HandlerDeps<
  TSessionManager extends ISessionManager = ISessionManager,
  TOAuthFlowStore extends IOAuthFlowStore = IOAuthFlowStore,
  TWindowManager extends IWindowManager = IWindowManager,
  TBrowserPaneManager extends IBrowserPaneManager = IBrowserPaneManager,
> {
  sessionManager: TSessionManager
  platform: PlatformServices
  windowManager?: TWindowManager
  browserPaneManager?: TBrowserPaneManager
  oauthFlowStore: TOAuthFlowStore
  /** Canonical name-only Workspace boundary. Required by production W9 composition. */
  workspaceService?: WorkspaceService
  /** Verified-v2 plugin mutation boundary. Required by plugin/marketplace mutations. */
  pluginManagement?: PluginManagementApi
  /** Immutable active plugin authority for connector transport/auth binding. */
  pluginStore?: PluginStoreV2
  /** Effective scoped plugin/capability activation authority. */
  capabilityPolicyStore?: CapabilityPolicyStore
  /**
   * Bring-your-own registry controller (R3). Backs the marketplace registry
   * add/upgrade/remove/list channels and is injected into MarketplaceService as
   * the registry source so registry catalog items merge into the browse list.
   */
  marketplaceRegistrySource?: MarketplaceRegistryController
  /** Executable trust decisions (grant/revoke). Required by the trust-review RPCs. */
  capabilityTrustStore?: CapabilityTrustStore
  /**
   * Per-profile isolation availability, probed once at startup. Read-only
   * diagnosis for the Settings surface; it never gates an execution.
   */
  isolationCapabilities?: IsolationCapabilityReport
}
