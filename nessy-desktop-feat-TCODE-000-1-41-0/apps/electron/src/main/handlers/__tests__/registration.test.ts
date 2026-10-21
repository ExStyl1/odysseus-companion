import { beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { createCapabilityResolver } from '@nessy-agent/shared/capabilities/resolver'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'

setDefaultTimeout(120_000)

const registeredChannels: string[] = []

mock.module('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  // Minimal stubs for symbols imported by IPC domain modules
  app: {
    isPackaged: false,
    getAppPath: () => '/',
    quit: () => {},
    dock: { setIcon: () => {}, setBadge: () => {} },
  },
  nativeTheme: { shouldUseDarkColors: false },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({}),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
    showItemInFolder: () => {},
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  BrowserView: class {},
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
  },
  session: {},
}))

function createMockServer(): RpcServer {
  return {
    handle(channel: string, _handler: unknown) {
      registeredChannels.push(channel)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
}

function createMockDeps(): HandlerDeps {
  const capabilityResolver = createCapabilityResolver({
    inputs: () => ({
      nativeInventory: { records: [], blockedLayers: [] },
      installedPlugins: [],
      activePluginInstances: {},
      pluginCandidates: [],
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'not-required',
    }),
  })
  const projectHandleService = new ProjectHandleService({
    identityOptions: {
      realpathSync: path => path,
      statSync: () => ({ dev: 1n, ino: 1n }),
      processSalt: 'registration-test',
    },
  })
  return {
    sessionManager: {
      getCapabilityResolver: () => capabilityResolver,
      getProjectHandleService: () => projectHandleService,
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    browserPaneManager: {
      onStateChange: () => {},
      onRemoved: () => {},
      onInteracted: () => {},
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {
      store: () => {},
      getByState: () => null,
      remove: () => {},
      cleanup: () => {},
      dispose: () => {},
      size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  }
}

async function getExpectedChannels(): Promise<Set<string>> {
  // Core handler channels (now in server-core)
  const [
    agents,
    auth,
    automations,
    capabilities,
    decisions,
    dpAuth,
    files,
    labels,
    llm,
    marketplace,
    oauth,
    plugins,
    projects,
    sessions,
    coreSettings,
    skills,
    sources,
    statuses,
    coreSystem,
    coreWorkspace,
    onboarding,
    resources,
    scheduledWork,
    transfer,
    tasks,
    pages,
    artifacts,
  ] = await Promise.all([
    import('@nessy-agent/server-core/handlers/rpc/agents'),
    import('@nessy-agent/server-core/handlers/rpc/auth'),
    import('@nessy-agent/server-core/handlers/rpc/automations'),
    import('@nessy-agent/server-core/handlers/rpc/capabilities'),
    // UB6.3 — the decision layer module (the census is a list of imports).
    import('@nessy-agent/server-core/handlers/rpc/decisions'),
    import('@nessy-agent/server-core/handlers/rpc/dp-auth'),
    import('@nessy-agent/server-core/handlers/rpc/files'),
    import('@nessy-agent/server-core/handlers/rpc/labels'),
    import('@nessy-agent/server-core/handlers/rpc/llm-connections'),
    import('@nessy-agent/server-core/handlers/rpc/marketplace'),
    import('@nessy-agent/server-core/handlers/rpc/oauth'),
    import('@nessy-agent/server-core/handlers/rpc/plugins'),
    import('@nessy-agent/server-core/handlers/rpc/projects'),
    import('@nessy-agent/server-core/handlers/rpc/sessions'),
    import('@nessy-agent/server-core/handlers/rpc/settings'),
    import('@nessy-agent/server-core/handlers/rpc/skills'),
    import('@nessy-agent/server-core/handlers/rpc/sources'),
    import('@nessy-agent/server-core/handlers/rpc/statuses'),
    import('@nessy-agent/server-core/handlers/rpc/system'),
    import('@nessy-agent/server-core/handlers/rpc/workspace'),
    import('@nessy-agent/server-core/handlers/rpc/onboarding'),
    import('@nessy-agent/server-core/handlers/rpc/resources'),
    // D1.440, 2026-09-20 — `scheduled-work` was registered and NOT declared, so
    // `sessions:listScheduledWork` read as `unexpected` and this case has been
    // red since D1.97/D1.98 gave the read its own module. The census is a list
    // of imports, which is the one shape a new module is invisible to.
    //
    // `handlers/rpc/server.ts` is the other module exporting `HANDLED_CHANNELS`
    // and stays OUT deliberately: `registerServerHandlers` runs only
    // `if (serverCtx)` (the headless server), so the electron registrar these
    // mock deps drive never reaches it and declaring its six channels here
    // would make them `missing` instead. Those two are the whole set today —
    // `git grep -lE 'export const (HANDLED_CHANNELS|CORE_HANDLED_CHANNELS|GUI_HANDLED_CHANNELS)'`
    // over the two handler directories is how to re-derive it rather than
    // re-count this list.
    import('@nessy-agent/server-core/handlers/rpc/scheduled-work'),
    import('@nessy-agent/server-core/handlers/rpc/transfer'),
    // UA3.4 — the durable Tasks module.
    import('@nessy-agent/server-core/handlers/rpc/tasks'),
    // UA6.4 — workspace Pages (the core channels).
    import('@nessy-agent/server-core/handlers/rpc/pages'),
    // UA1.19 — the Published pages list (t-artifacts).
    import('@nessy-agent/server-core/handlers/rpc/artifacts'),
  ])

  // GUI handler channels (remain in electron)
  const [browser, guiSystem, guiWorkspace, guiSettings] = await Promise.all([
    import('../browser'),
    import('../system'),
    import('../workspace'),
    import('../settings'),
  ])

  return new Set([
    ...agents.HANDLED_CHANNELS,
    ...auth.HANDLED_CHANNELS,
    ...automations.HANDLED_CHANNELS,
    ...capabilities.HANDLED_CHANNELS,
    ...decisions.HANDLED_CHANNELS,
    ...dpAuth.HANDLED_CHANNELS,
    ...files.HANDLED_CHANNELS,
    ...labels.HANDLED_CHANNELS,
    ...llm.HANDLED_CHANNELS,
    ...marketplace.HANDLED_CHANNELS,
    ...oauth.HANDLED_CHANNELS,
    ...plugins.HANDLED_CHANNELS,
    ...projects.HANDLED_CHANNELS,
    ...sessions.HANDLED_CHANNELS,
    ...coreSettings.HANDLED_CHANNELS,
    ...skills.HANDLED_CHANNELS,
    ...sources.HANDLED_CHANNELS,
    ...statuses.HANDLED_CHANNELS,
    ...coreSystem.CORE_HANDLED_CHANNELS,
    ...coreWorkspace.CORE_HANDLED_CHANNELS,
    ...onboarding.HANDLED_CHANNELS,
    ...resources.HANDLED_CHANNELS,
    ...scheduledWork.HANDLED_CHANNELS,
    ...transfer.HANDLED_CHANNELS,
    ...tasks.HANDLED_CHANNELS,
    ...pages.HANDLED_CHANNELS,
    ...artifacts.HANDLED_CHANNELS,
    ...browser.HANDLED_CHANNELS,
    ...guiSystem.GUI_HANDLED_CHANNELS,
    ...guiWorkspace.GUI_HANDLED_CHANNELS,
    ...guiSettings.GUI_HANDLED_CHANNELS,
  ])
}

// The 27 module graphs above are loaded HERE, at file load, and never inside a
// case — AGENTS.md §Traps, and its sibling `registration-profiles.test.ts` went
// red on exactly this.
//
// A dynamic `await import()` inside a test spends that graph's load against the
// PER-TEST timer, and this graph costs minutes on a loaded box. The timed-out
// body then keeps running, reaches its `expect` after the NEXT case has refilled
// `registeredChannels`, and reports a channel list that is an artefact of the
// clock rather than of the registration.
//
// They stay DYNAMIC and stay below `mock.module('electron')`: a static import is
// hoisted above it, and the handler tree would then load the real `electron`.
const EXPECTED_CHANNELS = await getExpectedChannels()
const { registerAllRpcHandlers } = await import('../index')
const { HANDLED_CHANNELS: ONBOARDING_CHANNELS } =
  await import('@nessy-agent/server-core/handlers/rpc/onboarding')

describe('RPC handler registration', () => {
  beforeEach(() => {
    registeredChannels.length = 0
  })

  it('registers all declared handled channels exactly once', () => {
    const expected = EXPECTED_CHANNELS

    registerAllRpcHandlers(createMockServer(), createMockDeps())

    const appChannels = registeredChannels.filter(ch => ch.includes(':'))
    const actual = new Set(appChannels)

    const missing = [...expected].filter(ch => !actual.has(ch)).sort()
    const unexpected = [...actual].filter(ch => !expected.has(ch)).sort()

    expect(missing).toEqual([])
    expect(unexpected).toEqual([])

    // Check for duplicates
    const counts = new Map<string, number>()
    for (const ch of appChannels) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([channel, count]) => `${channel} (${count}x)`)
      .sort()

    expect(duplicates).toEqual([])
  })

  it('keeps onboarding channels in registration coverage', () => {
    registerAllRpcHandlers(createMockServer(), createMockDeps())

    const actual = new Set(registeredChannels)
    const missingOnboarding = ONBOARDING_CHANNELS.filter(ch => !actual.has(ch))

    expect(missingOnboarding).toEqual([])
  })
})
