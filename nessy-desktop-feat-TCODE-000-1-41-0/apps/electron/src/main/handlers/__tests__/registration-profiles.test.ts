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
      processSalt: 'registration-profiles-test',
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

async function getExpectedCoreChannels(): Promise<Set<string>> {
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
    settings,
    skills,
    sources,
    statuses,
    system,
    workspace,
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
    import('@nessy-agent/server-core/handlers/rpc/scheduled-work'),
    import('@nessy-agent/server-core/handlers/rpc/transfer'),
    // UA3.4 — the durable Tasks module.
    import('@nessy-agent/server-core/handlers/rpc/tasks'),
    // UA6.4 — workspace Pages (the core channels).
    import('@nessy-agent/server-core/handlers/rpc/pages'),
    // UA1.19 — the Published pages list (t-artifacts).
    import('@nessy-agent/server-core/handlers/rpc/artifacts'),
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
    ...settings.HANDLED_CHANNELS,
    ...skills.HANDLED_CHANNELS,
    ...sources.HANDLED_CHANNELS,
    ...statuses.HANDLED_CHANNELS,
    ...system.CORE_HANDLED_CHANNELS,
    ...workspace.CORE_HANDLED_CHANNELS,
    ...onboarding.HANDLED_CHANNELS,
    ...resources.HANDLED_CHANNELS,
    // D1.97/D1.98 — the session's crons and watches as one flat list.
    ...scheduledWork.HANDLED_CHANNELS,
    ...transfer.HANDLED_CHANNELS,
    ...tasks.HANDLED_CHANNELS,
    ...pages.HANDLED_CHANNELS,
    ...artifacts.HANDLED_CHANNELS,
  ])
}

async function getExpectedGuiChannels(): Promise<Set<string>> {
  const [browser, system, workspace, settings] = await Promise.all([
    import('../browser'),
    import('../system'),
    import('../workspace'),
    import('../settings'),
  ])

  return new Set([
    ...browser.HANDLED_CHANNELS,
    ...system.GUI_HANDLED_CHANNELS,
    ...workspace.GUI_HANDLED_CHANNELS,
    ...settings.GUI_HANDLED_CHANNELS,
  ])
}

// The 26 module graphs above are loaded HERE, at file load, and never inside a
// case — AGENTS.md §Traps, and it is what this file went red on.
//
// A dynamic `await import()` inside a test spends that graph's load against the
// PER-TEST timer. Measured 2026-09-11 at load ~11: the first case took
// 284 698 ms against this file's 120 000 ms budget and timed out with zero
// assertion failures. The report is then doubly misleading — the timed-out body
// keeps running, reaches its `expect` after the NEXT case's `beforeEach` has
// cleared `registeredChannels` and that case has filled it with GUI channels,
// and reports "59 unexpected channels" as an unhandled error between tests. A
// reader chasing that list is chasing an artefact of the clock.
//
// The zero-case control prices what is left: `-t` with a regex matching nothing
// loads this file's own graph in 32.99 s at 0.54 s user — I/O wait, not
// contention — so the ~250 s difference is exactly these imports. At top level
// they are outside every timer, which is the remedy `sources-management-registry.test.ts`
// settled on rather than a budget.
//
// They stay DYNAMIC and stay below `mock.module('electron')`: a static import
// is hoisted above it, and the handler tree would then load the real `electron`.
const EXPECTED_CORE_CHANNELS = await getExpectedCoreChannels()
const EXPECTED_GUI_CHANNELS = await getExpectedGuiChannels()
const { registerCoreRpcHandlers, registerGuiRpcHandlers } = await import('../index')

describe('RPC handler profile registration', () => {
  beforeEach(() => {
    registeredChannels.length = 0
  })

  it('registerCoreRpcHandlers registers only core channels', () => {
    registerCoreRpcHandlers(createMockServer(), createMockDeps())

    const actual = new Set(registeredChannels.filter(ch => ch.includes(':')))
    expect([...EXPECTED_CORE_CHANNELS].filter(ch => !actual.has(ch))).toEqual([])
    expect([...actual].filter(ch => !EXPECTED_CORE_CHANNELS.has(ch))).toEqual([])
  })

  it('registerGuiRpcHandlers registers only gui channels', () => {
    registerGuiRpcHandlers(createMockServer(), createMockDeps())

    const actual = new Set(registeredChannels.filter(ch => ch.includes(':')))
    expect([...EXPECTED_GUI_CHANNELS].filter(ch => !actual.has(ch))).toEqual([])
    expect([...actual].filter(ch => !EXPECTED_GUI_CHANNELS.has(ch))).toEqual([])
  })
})
