/**
 * P2.10 — a managed policy takes the in-app updater fully dark.
 *
 * The claim under test is not "the button is disabled" but "no entry point
 * reaches electron-updater": the menu item, the renderer's Check Now, the
 * launch check and the install are four different callers of the same three
 * exported functions, and each one is asserted against the UPDATER MOCK rather
 * than against the returned state — a returned `available: false` is what an
 * up-to-date app also says, so it cannot tell a refusal from a successful check
 * (the detector rule in AGENTS.md).
 *
 * ## Why `.isolated.ts`
 *
 * `electron`, `electron-updater` and `../logger` are all replaced in full —
 * none of the three can be imported under bun, so there is nothing to spread
 * (the `mock.module` amputation trap in AGENTS.md is about partial mocks of OUR
 * modules; `browser-pane-manager.test.ts` replaces the same three the same
 * way). A full replacement of `../logger` that omitted one export would break
 * every later file in a shared `bun test` process, so this suite takes its own
 * process instead of leaving that hazard behind — which matters more than usual
 * while other agents run tests in this tree.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, mock } from 'bun:test'
import {
  recordCodexInAppUpdatesRequirement,
  registerManagedInAppUpdatesDisabledProvider,
} from '@nessy-agent/shared/config'
import { RPC_CHANNELS } from '../../shared/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

interface UpdaterMock {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  on: (event: string, handler: (...args: unknown[]) => void) => void
  checkForUpdates: () => Promise<unknown>
  quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void
  checkCalls: number
  quitAndInstallCalls: number
}

const updater: UpdaterMock = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  logger: undefined,
  on: () => {},
  checkForUpdates: async () => {
    updater.checkCalls += 1
    // `null` keeps the ungated path off its 500ms settle wait: `checkForUpdates`
    // only sleeps when the result carries `updateInfo`.
    return null
  },
  quitAndInstall: () => {
    updater.quitAndInstallCalls += 1
  },
  checkCalls: 0,
  quitAndInstallCalls: 0,
}

mock.module('electron-updater', () => ({ autoUpdater: updater }))

mock.module('electron', () => ({
  app: {
    getName: () => 'Nessy Desktop',
    getVersion: () => '1.0.0',
    getPath: () => '/tmp/nessy-auto-update-test-home',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    autoUpdateLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

// Loaded AFTER the mocks — a static import is hoisted above them.
let autoUpdate: typeof import('../auto-update')

beforeAll(async () => {
  autoUpdate = await import('../auto-update')
}, MODULE_GRAPH_HOOK_BUDGET_MS)

beforeEach(() => {
  updater.checkCalls = 0
  updater.quitAndInstallCalls = 0
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
})

afterEach(() => {
  registerManagedInAppUpdatesDisabledProvider(undefined)
  recordCodexInAppUpdatesRequirement(undefined)
  autoUpdate.setAutoUpdateEventSink(null as never)
})

function disableUpdatesByPolicy(): void {
  registerManagedInAppUpdatesDisabledProvider(() => true)
}

describe('managed policy disables in-app updates', () => {
  it('refuses the manual check — the menu item and the renderer\'s Check Now both land here', async () => {
    disableUpdatesByPolicy()
    const info = await autoUpdate.checkForUpdates({ autoDownload: true })
    expect(updater.checkCalls).toBe(0)
    expect(info.available).toBe(false)
    expect(info.downloadState).toBe('idle')
    expect(info.managedDisabled).toBe(true)
  })

  it('refuses the launch check, and says why', async () => {
    disableUpdatesByPolicy()
    const result = await autoUpdate.checkForUpdatesOnLaunch()
    expect(updater.checkCalls).toBe(0)
    expect(result.action).toBe('skipped')
    expect(result.reason).toBe('managed')
  })

  it('silences electron-updater\'s own two autonomous paths', async () => {
    disableUpdatesByPolicy()
    await autoUpdate.checkForUpdates({ autoDownload: true })
    // Background download and install-on-quit are the updater's own decisions;
    // refusing our entry points alone would leave a pending download installing
    // itself on the next quit.
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('refuses the install — no quitAndInstall, even if a download is already staged', async () => {
    disableUpdatesByPolicy()
    await expect(autoUpdate.installUpdate()).rejects.toThrow(/managed/i)
    expect(updater.quitAndInstallCalls).toBe(0)
  })

  it('reports the managed state so the settings page can say so', () => {
    disableUpdatesByPolicy()
    const info = autoUpdate.getUpdateInfo()
    expect(info.managedDisabled).toBe(true)
    expect(info.available).toBe(false)
  })
})

/**
 * P3.240 — the payload also names WHICH document decided.
 *
 * The indicator P2.10 built says a policy exists; it could not say whose, and
 * two documents set this switch — the host's composed `managed-policy.json` and
 * a codex deployment's `requirements.toml`, changed by different people in
 * different places. Resolved in the same call as the gate so the flag and its
 * source describe one moment: the codex tier arms mid-session, and a source read
 * a moment later could name a document that was not the reason for THIS refusal.
 */
describe('the refusal names its source', () => {
  it('names the host tier', () => {
    registerManagedInAppUpdatesDisabledProvider(() => true)
    expect(autoUpdate.getUpdateInfo().managedSource).toBe('host')
  })

  it('names the codex tier', () => {
    recordCodexInAppUpdatesRequirement(true)
    expect(autoUpdate.getUpdateInfo().managedSource).toBe('codex')
  })

  it('names both when both require it', () => {
    registerManagedInAppUpdatesDisabledProvider(() => true)
    recordCodexInAppUpdatesRequirement(true)
    expect(autoUpdate.getUpdateInfo().managedSource).toBe('both')
  })

  it('rides the same payload as the refusal, on the manual check too', async () => {
    // The renderer reads one object. A source that appeared on the pull and not
    // on the check would be present or absent depending on how the page got here.
    recordCodexInAppUpdatesRequirement(true)
    const info = await autoUpdate.checkForUpdates({ autoDownload: true })
    expect(info.managedDisabled).toBe(true)
    expect(info.managedSource).toBe('codex')
  })

  it('is absent on an unmanaged install, so its payload is unchanged', async () => {
    expect(autoUpdate.getUpdateInfo().managedSource).toBeUndefined()
    const info = await autoUpdate.checkForUpdates({ autoDownload: true })
    expect(info.managedSource).toBeUndefined()
  })

  it('is absent when a tier answered and ALLOWED updates', () => {
    // An opinion is not a reason. Naming a document here would put a managed
    // sentence under a card that is not managed.
    registerManagedInAppUpdatesDisabledProvider(() => false)
    recordCodexInAppUpdatesRequirement(false)
    const info = autoUpdate.getUpdateInfo()
    expect(info.managedDisabled).toBeUndefined()
    expect(info.managedSource).toBeUndefined()
  })
})

describe('with no managed policy, nothing changes', () => {
  it('still runs the real check', async () => {
    const info = await autoUpdate.checkForUpdates({ autoDownload: true })
    expect(updater.checkCalls).toBe(1)
    expect(info.managedDisabled).toBeUndefined()
  })

  it('leaves the updater\'s own flags alone', async () => {
    await autoUpdate.checkForUpdates({ autoDownload: true })
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })

  it('keeps the pre-existing install guard as the only refusal', async () => {
    await expect(autoUpdate.installUpdate()).rejects.toThrow('No update ready to install')
    expect(updater.quitAndInstallCalls).toBe(0)
  })

  it('reports no managed state', () => {
    expect(autoUpdate.getUpdateInfo().managedDisabled).toBeUndefined()
  })
})

/**
 * P2.7 clause (b) — a managed answer that ARRIVES flips a live settings page.
 *
 * P2.10 reported `managedDisabled` correctly to anything that ASKED, and nothing
 * asked twice: the renderer pulls `getUpdateInfo()` on mount and then listens.
 * Both writers of this policy land after mount in the ordinary case — the host
 * tier at bootstrap, the codex tier when the first codex runtime starts — so
 * without a push the page keeps offering an update `installUpdate` will refuse.
 *
 * Asserted against the EVENT SINK, not the returned state: `available:false` is
 * what an up-to-date app reports too, so only the pushed payload's
 * `managedDisabled` separates a refusal from a successful check.
 */
describe('registering the policy broadcasts to live renderers', () => {
  interface Broadcast { channel: string; payload: unknown }

  function captureBroadcasts(): Broadcast[] {
    const seen: Broadcast[] = []
    autoUpdate.setAutoUpdateEventSink(((channel: string, _target: unknown, payload: unknown) => {
      seen.push({ channel, payload })
    }) as never)
    return seen
  }

  it('pushes the managed state when the HOST tier registers', () => {
    const seen = captureBroadcasts()
    registerManagedInAppUpdatesDisabledProvider(() => true)
    expect(seen.map(entry => entry.channel)).toEqual([RPC_CHANNELS.update.AVAILABLE])
    expect(seen[0]?.payload).toMatchObject({ managedDisabled: true, available: false })
  })

  it('pushes it when the CODEX tier reports mid-session', () => {
    const seen = captureBroadcasts()
    recordCodexInAppUpdatesRequirement(true)
    expect(seen.map(entry => entry.channel)).toEqual([RPC_CHANNELS.update.AVAILABLE])
    expect(seen[0]?.payload).toMatchObject({ managedDisabled: true })
  })

  it('pushes the release too, so a lifted policy stops showing as managed', () => {
    registerManagedInAppUpdatesDisabledProvider(() => true)
    const seen = captureBroadcasts()
    registerManagedInAppUpdatesDisabledProvider(undefined)
    expect(seen.length).toBe(1)
    expect((seen[0]?.payload as { managedDisabled?: boolean }).managedDisabled).toBeUndefined()
  })

  it('costs nothing before a sink exists', () => {
    // The policy can be registered before the first window; `broadcastUpdateInfo`
    // no-ops without a sink and the renderer's own mount-time pull covers it.
    expect(() => registerManagedInAppUpdatesDisabledProvider(() => true)).not.toThrow()
  })
})
