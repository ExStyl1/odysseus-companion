/**
 * D1.278 — every rpc module declares exactly what it registers, not just
 * `settings.ts`.
 *
 * D1.248 closed this class for ONE module and said so: the same hand-kept copy
 * exists in every other module here, and three separate commits have already
 * shipped a `server.handle` with no declaration (`notification:*` P3.317,
 * `sessions:reconnectMcpServer` + `getMcpServerStatuses` `59ad1034c`, and the
 * four `codexSubagents`/`primaryDirectory` channels found on 2026-09-17). Each
 * was caught only by `apps/electron/src/main/handlers/__tests__/registration-profiles.test.ts`,
 * which loads 26 module graphs behind a 600 000 ms hook budget, in a different
 * package from the declaration it is checking.
 *
 * ## Both directions, per module, and why the table names the SKIPS
 *
 * A channel REGISTERED and not declared leaves every consumer of the
 * declaration wrong about what the module owns. A channel DECLARED and not
 * registered is the quieter one: a profile promises a channel that answers
 * nothing, which reaches the renderer as a hang rather than as a missing
 * feature.
 *
 * A registrar that cannot run against a stub is RECORDED BY NAME with its
 * error rather than dropped, because "this module is not covered" and "this
 * module has no rows" are the same green otherwise — the census control below
 * is what makes the difference visible.
 *
 * ## Why it is an assertion and not a derivation
 *
 * D1.248's reason, unchanged: `HANDLED_CHANNELS` is read at MODULE level by two
 * Electron registration suites and by the profile sets, i.e. without ever
 * constructing `HandlerDeps`, while the registrations only exist once the
 * registrar has been called. Making the registrar return its channels would
 * leave the module-level readers with nothing to import.
 *
 * `settings.ts` is in the table AND keeps its own file
 * (`settings-handled-channels.test.ts`): that file is D1.248's narrative and its
 * three cases are this table's control — if the table ever goes green by
 * measuring nothing, the single-module case still fails.
 */
import { describe, expect, it } from 'bun:test'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'

import * as agents from '../agents'
import * as auth from '../auth'
import * as automations from '../automations'
import * as capabilities from '../capabilities'
import * as decisions from '../decisions'
import * as dpAuth from '../dp-auth'
import * as files from '../files'
import * as labels from '../labels'
import * as llmConnections from '../llm-connections'
import * as marketplace from '../marketplace'
import * as oauth from '../oauth'
import * as onboarding from '../onboarding'
import * as plugins from '../plugins'
import * as projects from '../projects'
import * as resources from '../resources'
import * as scheduledWork from '../scheduled-work'
import * as sessions from '../sessions'
import * as serverModule from '../server'
import * as settings from '../settings'
import * as skills from '../skills'
import * as sources from '../sources'
import * as statuses from '../statuses'
import * as system from '../system'
import * as tasks from '../tasks'
import * as pages from '../pages'
// UA1.19
import * as artifactsModule from '../artifacts'
import * as transfer from '../transfer'
import * as workspace from '../workspace'

interface ModuleUnderTest {
  readonly name: string
  readonly declared: readonly string[]
  readonly register: (server: RpcServer, deps: HandlerDeps) => void
}

/**
 * `system.ts` and `workspace.ts` declare `CORE_HANDLED_CHANNELS`, deliberately:
 * the Electron main process registers more channels on the same prefixes, so
 * their constant is the CORE subset and the registrar under test is the core
 * one. Both directions still hold for that pair.
 */
const MODULES: readonly ModuleUnderTest[] = [
  { name: 'agents', declared: agents.HANDLED_CHANNELS, register: agents.registerAgentsHandlers },
  { name: 'auth', declared: auth.HANDLED_CHANNELS, register: auth.registerAuthHandlers },
  { name: 'automations', declared: automations.HANDLED_CHANNELS, register: automations.registerAutomationsHandlers },
  { name: 'capabilities', declared: capabilities.HANDLED_CHANNELS, register: capabilities.registerCapabilitiesHandlers },
  // UB6.3 — the decision layer's Settings card, its connectivity test and its usage read.
  { name: 'decisions', declared: decisions.HANDLED_CHANNELS, register: decisions.registerDecisionsHandlers },
  { name: 'dp-auth', declared: dpAuth.HANDLED_CHANNELS, register: dpAuth.registerDpAuthHandlers },
  { name: 'files', declared: files.HANDLED_CHANNELS, register: files.registerFilesHandlers },
  { name: 'labels', declared: labels.HANDLED_CHANNELS, register: labels.registerLabelsHandlers },
  { name: 'llm-connections', declared: llmConnections.HANDLED_CHANNELS, register: llmConnections.registerLlmConnectionsHandlers },
  { name: 'marketplace', declared: marketplace.HANDLED_CHANNELS, register: marketplace.registerMarketplaceHandlers },
  { name: 'oauth', declared: oauth.HANDLED_CHANNELS, register: oauth.registerOAuthHandlers },
  { name: 'onboarding', declared: onboarding.HANDLED_CHANNELS, register: onboarding.registerOnboardingHandlers },
  { name: 'plugins', declared: plugins.HANDLED_CHANNELS, register: plugins.registerPluginsHandlers },
  { name: 'projects', declared: projects.HANDLED_CHANNELS, register: projects.registerProjectsHandlers },
  { name: 'resources', declared: resources.HANDLED_CHANNELS, register: resources.registerResourcesHandlers },
  { name: 'scheduled-work', declared: scheduledWork.HANDLED_CHANNELS, register: scheduledWork.registerScheduledWorkHandlers },
  { name: 'sessions', declared: sessions.HANDLED_CHANNELS, register: sessions.registerSessionsHandlers },
  // The one registrar with a third argument: it takes the headless
  // `ServerHandlerContext`, which the same inert node answers.
  { name: 'server', declared: serverModule.HANDLED_CHANNELS, register: (server, deps) => serverModule.registerServerHandlers(server, deps, stubDeps() as never) },
  { name: 'settings', declared: settings.HANDLED_CHANNELS, register: settings.registerSettingsHandlers },
  { name: 'skills', declared: skills.HANDLED_CHANNELS, register: skills.registerSkillsHandlers },
  { name: 'sources', declared: sources.HANDLED_CHANNELS, register: sources.registerSourcesHandlers },
  { name: 'statuses', declared: statuses.HANDLED_CHANNELS, register: statuses.registerStatusesHandlers },
  { name: 'system (core)', declared: system.CORE_HANDLED_CHANNELS, register: system.registerSystemCoreHandlers },
  // UA3.4 — the durable Tasks module.
  { name: 'tasks', declared: tasks.HANDLED_CHANNELS, register: (server, deps) => tasks.registerTasksHandlers(server, deps) },
  // UA6.4 — workspace Pages (the core channels).
  { name: 'pages', declared: pages.HANDLED_CHANNELS, register: pages.registerPagesHandlers },
  // UA1.19 — the Published pages list (t-artifacts).
  { name: 'artifacts', declared: artifactsModule.HANDLED_CHANNELS, register: (server, deps) => artifactsModule.registerArtifactsHandlers(server, deps) },
  { name: 'transfer', declared: transfer.HANDLED_CHANNELS, register: (server) => transfer.registerTransferHandlers(server) },
  { name: 'workspace (core)', declared: workspace.CORE_HANDLED_CHANNELS, register: workspace.registerWorkspaceCoreHandlers },
]

/**
 * Anything a registrar reads at REGISTRATION time answers with an inert value.
 * A handler that needs a real dependency fails on INVOCATION, and nothing here
 * invokes one — the registrars store closures.
 */
function stubDeps(): HandlerDeps {
  // The target is a FUNCTION so the same node answers both shapes a registrar
  // reaches for: `deps.platform.logger.info` and
  // `deps.sessionManager.getProjectHandleService?.()`, which `capabilities.ts`
  // and `projects.ts` both call while registering. `then` answers `undefined`
  // so an accidental `await` of one of these does not hang.
  const makeNode = (): unknown => {
    const cache = new Map<string, unknown>()
    return new Proxy(function stub() {} as unknown as Record<string, unknown>, {
      get(_target, property) {
        if (property === 'then' || typeof property !== 'string') return undefined
        if (!cache.has(property)) cache.set(property, makeNode())
        return cache.get(property)
      },
      apply() { return makeNode() },
    })
  }
  return makeNode() as HandlerDeps
}

function registeredChannels(module: ModuleUnderTest): { channels: string[]; error?: string } {
  const channels: string[] = []
  const server = {
    handle(channel: string, _handler: HandlerFn) { channels.push(channel) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  try {
    module.register(server, stubDeps())
  } catch (error) {
    return { channels, error: error instanceof Error ? error.message : String(error) }
  }
  return { channels }
}

describe('D1.278 · every rpc module declares exactly what it registers', () => {
  for (const module of MODULES) {
    it(`${module.name} — registers nothing it does not declare, and declares nothing it does not register`, () => {
      const { channels, error } = registeredChannels(module)
      // A registrar that cannot run against a stub is a finding, not a skip:
      // silence here is indistinguishable from a module with no channels.
      expect(error).toBeUndefined()

      const declared = new Set<string>(module.declared)
      // Named, not counted: the four channels open on 2026-09-17 were found by
      // reading their names out of a failure.
      expect(channels.filter(channel => !declared.has(channel))).toEqual([])
      expect([...module.declared].filter(channel => !channels.includes(channel))).toEqual([])
      expect(new Set(module.declared).size).toBe(module.declared.length)
      expect(new Set(channels).size).toBe(channels.length)
    })
  }

  it('and the table can SEE channels at all — the positive control', () => {
    // Without this, a stub server that silently dropped `handle`, or a table
    // whose registrars all threw, would satisfy every case above forever.
    const total = MODULES.reduce((count, module) => count + registeredChannels(module).channels.length, 0)
    expect(total).toBeGreaterThan(200)
    // And the table covers the family rather than a corner of it: every
    // `register*Handlers` that `handlers/rpc/index.ts` calls is in the table,
    // `server.ts`'s three-argument one included.
    expect(MODULES.length).toBeGreaterThanOrEqual(26)
  })
})
