import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

import { registerAgentsHandlers } from './agents'
import { registerAuthHandlers } from './auth'
import { registerAutomationsHandlers } from './automations'
import { registerCapabilitiesHandlers } from './capabilities'
import { registerDecisionsHandlers } from './decisions'
import { registerFilesHandlers } from './files'
import { registerLabelsHandlers } from './labels'
import { registerLlmConnectionsHandlers } from './llm-connections'
import { registerMarketplaceHandlers } from './marketplace'
import { startMarketplaceAutoUpdate } from './marketplace-auto-update'
import { registerOAuthHandlers } from './oauth'
import { registerDpAuthHandlers } from './dp-auth'
import { registerPluginsHandlers } from './plugins'
import { registerProjectsHandlers } from './projects'
import { registerResourcesHandlers } from './resources'
import { registerScheduledWorkHandlers } from './scheduled-work'
import { registerOnboardingHandlers } from './onboarding'
import { registerSessionsHandlers } from './sessions'
export { registerSessionsHandlers, cleanupSessionFileWatchForClient } from './sessions'
import { registerServerHandlers } from './server'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
export type { ServerHandlerContext } from '../../bootstrap/headless-start'
export { getHealthCheck } from './server'
import { registerSettingsHandlers } from './settings'
import { registerSkillsHandlers } from './skills'
import { registerSourcesHandlers } from './sources'
import { registerStatusesHandlers } from './statuses'
import { registerSystemCoreHandlers } from './system'
import { registerTransferHandlers } from './transfer'
import { registerWorkspaceCoreHandlers } from './workspace'

export function registerCoreRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  registerAgentsHandlers(server, deps)
  registerAuthHandlers(server, deps)
  registerAutomationsHandlers(server, deps)
  registerCapabilitiesHandlers(server, deps)
  registerDecisionsHandlers(server, deps)
  registerFilesHandlers(server, deps)
  registerLabelsHandlers(server, deps)
  registerLlmConnectionsHandlers(server, deps)
  registerMarketplaceHandlers(server, deps)
  // `plugins/loading.md#when-auto-update-runs` — the post-startup check, armed once per
  // process with a random delay of up to ten minutes. A no-op without a
  // composed registry controller, and the timer is unref'd, so nothing here
  // holds a headless server open or fires inside a test that stubs deps.
  startMarketplaceAutoUpdate(server, deps)
  registerOAuthHandlers(server, deps)
  registerDpAuthHandlers(server, deps)
  registerOnboardingHandlers(server, deps)
  registerPluginsHandlers(server, deps)
  registerProjectsHandlers(server, deps)
  registerResourcesHandlers(server, deps)
  // D1.97/D1.98 — the session's cron records and its watches, as one flat list.
  registerScheduledWorkHandlers(server, deps)
  registerSessionsHandlers(server, deps)
  if (serverCtx) registerServerHandlers(server, deps, serverCtx)
  registerSettingsHandlers(server, deps)
  registerSkillsHandlers(server, deps)
  registerSourcesHandlers(server, deps)
  registerStatusesHandlers(server, deps)
  registerSystemCoreHandlers(server, deps)
  // UA3.4 — durable Tasks (validate, create, get, list, getResults, delete); the Conductor arms are UA4.x's.
  registerTasksHandlers(server, deps)
  // UA6.4 — workspace Pages, the core channels (grants/actions UA9.3, thumbnails UA7.4, publishing UA6.7).
  registerPagesHandlers(server, deps)
  // UA1.19 — the Published pages list (t-artifacts): list, extend, delete.
  registerArtifactsHandlers(server, deps)
  registerTransferHandlers(server)
  registerWorkspaceCoreHandlers(server, deps)
}
// UA3.4 — imported at the end so the docs-cited lines above keep their numbers.
import { registerTasksHandlers } from './tasks'
// UA1.19 — imported at the end for UA3.4's reason.
import { registerArtifactsHandlers } from './artifacts'
// UA6.4 — imported at the end for UA3.4's reason.
import { registerPagesHandlers } from './pages'
