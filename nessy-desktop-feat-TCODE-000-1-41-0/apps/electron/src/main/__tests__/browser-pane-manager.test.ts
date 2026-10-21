/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron BrowserWindow and session modules to validate lifecycle,
 * session binding, and navigation behavior.
 */

import { describe, it, expect, afterAll, afterEach, beforeEach, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const createdWindows: any[] = []
let toolbarLoadFailuresRemaining = 0
const mockShellOpenExternal = mock(async () => {})
const mockIpcMainHandle = mock(() => {})

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  let currentUrl = 'about:blank'
  return {
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: {},
    isDestroyed: mock(() => false),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
      const isToolbarUrl = typeof url === 'string' && url.includes('browser-toolbar.html')
      if (isToolbarUrl && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    loadFile: mock(async (path: string, _opts?: unknown) => {
      const isToolbarFile = typeof path === 'string' && path.includes('browser-toolbar.html')
      if (isToolbarFile && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    capturePage: mock(async () => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: (_opts: any) => img,
        toPNG: () => Buffer.from('fake-png'),
        toJPEG: (_quality: number) => Buffer.from('fake-jpeg'),
      }
      return img
    }),
    // UB4.16 — the paint probe and the throttle toggle (mock() so the
    // hidden-capture arms can count calls).
    setBackgroundThrottling: mock((_throttle: boolean) => {}),
    executeJavaScript: mock(async (expr: string) => eval(expr)),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: any) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb({}, ...args)
    },
  }
}

function createMockBrowserView() {
  const webContents = createMockWebContents()
  return {
    webContents,
    setBounds: mock(() => {}),
    setAutoResize: mock(() => {}),
  }
}

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0

  const win = {
    webContents,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    show: mock(() => {}),
    showInactive: mock(() => {}),
    // UB4.16 — the invisible reveal (macOS/win arm and the Linux park arm).
    getBounds: mock(() => ({ x: 40, y: 60, width: 1200, height: 900 })),
    setBounds: mock((_b: unknown) => {}),
    setPosition: mock((_x: number, _y: number) => {}),
    setOpacity: mock((_o: number) => {}),
    getOpacity: mock(() => 1),
    setAlwaysOnTop: mock((_flag: boolean, _level?: string) => {}),
    setIgnoreMouseEvents: mock((_ignore: boolean) => {}),
    setSkipTaskbar: mock((_skip: boolean) => {}),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    setBrowserView: mock((_view: any) => {}),
    addBrowserView: mock((_view: any) => {}),
    setTopBrowserView: mock((_view: any) => {}),
    getContentSize: mock(() => [contentWidth, contentHeight]),
    setContentSize: mock((width: number, height: number) => {
      contentWidth = Math.max(minWidth, Math.floor(width))
      contentHeight = Math.max(minHeight, Math.floor(height))
    }),
    loadURL: mock(async (_url: string) => {}),
  }
  createdWindows.push(win)
  return win
}

// F1.134's recipe, extended to `electron` (GF1): the stub SPREADS this snapshot of the real
// namespace, taken before the stub is installed. The narrow stub amputated every name it does
// not list, and `host-approvals-key.ts` (`import { app, safeStorage } from 'electron'`) died at
// import when its test ran after this file in the same process — SyntaxError: Export named
// 'safeStorage' not found. There is NO afterAll restore back to this snapshot: outside the app
// shell the real module exports only the binary path, so restoring it would move the death to
// the next file in the chunk; the spread itself is what keeps every name linkable.
const realElectron = { ...(await import('electron')) } as Record<string, unknown>
// The real entry is CJS whose exports are built at runtime, so the snapshot cannot carry
// `safeStorage` as a static name; the stub provides the binding the import needs. Nothing here
// touches it — `host-approvals-key.test.ts` injects its own fake through `deps(...)`.
realElectron.safeStorage ??= {
  isEncryptionAvailable: mock(() => false),
  encryptString: mock((_plain: Buffer) => Buffer.alloc(0)),
  decryptString: mock((_sealed: Buffer) => Buffer.alloc(0)),
}

mock.module('electron', () => ({
  ...realElectron,
  app: {
    getPath: mock((name: string) => name === 'downloads' ? '/tmp/mock-downloads' : `/tmp/mock-${name}`),
  },
  BrowserWindow: class MockBrowserWindow {
    webContents: any
    constructor(opts?: any) {
      const win = createMockWindow(opts)
      this.webContents = win.webContents
      Object.assign(this, win)
    }
  },
  BrowserView: class MockBrowserView {
    webContents: any
    constructor(_opts?: any) {
      const view = createMockBrowserView()
      this.webContents = view.webContents
      Object.assign(this, view)
    }
  },
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  Menu: {
    buildFromTemplate: mock(() => ({
      popup: mock(() => {}),
    })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  // UB4.16 — the Linux invisible-reveal park needs real display geometry.
  screen: {
    getAllDisplays: mock(() => [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
    ]),
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
      webRequest: {
        onBeforeRequest: mock((_cb: any) => {}),
        onCompleted: mock((_cb: any) => {}),
        onErrorOccurred: mock((_cb: any) => {}),
      },
      on: mock((_event: string, _cb: any) => {}),
    })),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

// F1.462 (F1.134's recipe): the browser-cdp stub SPREADS this snapshot, taken
// with the electron and logger stubs above already in place, and afterAll restores it.
const realBrowserCdp = { ...(await import('../browser-cdp')) }
mock.module('../browser-cdp', () => ({
  ...realBrowserCdp,
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    getAccessibilitySnapshot = mock(async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [],
    }))
    clickElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    fillElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    selectOption = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    renderTemporaryOverlay = mock(async () => {})
    clearTemporaryOverlay = mock(async () => {})
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
    getElementGeometry = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    getElementGeometryBySelector = mock(async () => ({
      ref: 'selector:div.card',
      box: { x: 5, y: 5, width: 20, height: 20 },
      clickPoint: { x: 15, y: 15 },
    }))
  },
}))

afterAll(() => {
  mock.module('../browser-cdp', () => realBrowserCdp)
})

const {
  recordCodexInAppBrowserRequirement,
  registerManagedInAppBrowserDisabledProvider,
} = await import('@nessy-agent/shared/config')

const { BrowserPaneManager } = await import('../browser-pane-manager')
const { registerBrowserTrustPrompter } = await import('../browser-trust-gate')
const { resetBrowserTrustForTests } = await import('../browser-origin-trust-store')

/**
 * P6.536 — `navigate()` now passes the per-origin trust gate, which FAILS
 * CLOSED with no prompter registered (that refusal is asserted in
 * `browser-trust-gate.test.ts`). These suites are about pane lifecycle and
 * layout, so they stand in as the user who said yes, and point the store at a
 * temporary file so no verdict can reach the developer's own config directory.
 */
const PANE_TRUST_DIR = mkdtempSync(join(tmpdir(), 'w8o-pane-trust-'))
beforeEach(() => {
  resetBrowserTrustForTests(join(PANE_TRUST_DIR, `trust-${Math.random().toString(36).slice(2)}.json`))
  registerBrowserTrustPrompter(async () => 'allow-once')
})

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    createdWindows.length = 0
    toolbarLoadFailuresRemaining = 0
    mockShellOpenExternal.mockClear()
    mockIpcMainHandle.mockClear()
    manager = new BrowserPaneManager()
  })

  it('creates and lists instances', () => {
    const id = manager.createInstance('test-1')
    const list = manager.listInstances()
    expect(id).toBe('test-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test-1')
    expect(list[0].agentControlActive).toBe(false)
  })

  it('is idempotent when explicit ID already exists', () => {
    const first = manager.createInstance('same-id')
    const second = manager.createInstance('same-id')
    expect(first).toBe('same-id')
    expect(second).toBe('same-id')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('allows http(s) popups with shared browser partition', () => {
    manager.createInstance('popup-allow')
    const instance = (manager as any).instances.get('popup-allow')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      disposition: 'new-popup',
      frameName: 'oauth-popup',
    })

    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBe('persist:browser-pane')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.nodeIntegration).toBe(false)
    expect(result.overrideBrowserWindowOptions?.webPreferences?.contextIsolation).toBe(true)
  })

  it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = (manager as any).instances.get('popup-deeplink')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'nessy://settings',
      disposition: 'new-popup',
      frameName: '',
    })

    expect(result).toEqual({ action: 'deny' })
    await Bun.sleep(0)
    expect(mockShellOpenExternal).toHaveBeenCalledWith('nessy://settings')
  })

  it('destroys child popups when parent instance is destroyed', () => {
    manager.createInstance('popup-parent')
    const instance = (manager as any).instances.get('popup-parent')

    const popupWindow = createMockWindow({ width: 520, height: 720 })
    for (const listener of instance.pageView.webContents._listeners['did-create-window'] || []) {
      listener(popupWindow, { url: 'https://accounts.google.com/signin' })
    }

    expect((manager as any).popupWindowsByParentInstanceId.get('popup-parent')?.size).toBe(1)

    manager.destroyInstance('popup-parent')

    expect(popupWindow.destroy).toHaveBeenCalledTimes(1)
    expect((manager as any).popupWindowsByParentInstanceId.has('popup-parent')).toBe(false)
  })

  it('destroys instances', () => {
    manager.createInstance('d1')
    manager.destroyInstance('d1')
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('destroys instance via toolbar destroy IPC handler', async () => {
    manager.createInstance('d-ipc-destroy')
    manager.registerToolbarIpc()

    const destroyRegistration = (
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (_event: unknown, instanceId: string) => Promise<void>,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:destroy')

    expect(destroyRegistration).toBeTruthy()
    if (!destroyRegistration) throw new Error('Expected browser-toolbar:destroy IPC registration')

    const [, destroyHandler] = destroyRegistration
    await destroyHandler({}, 'd-ipc-destroy')

    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback exactly once when destroy triggers closed', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))

    manager.createInstance('d-removed-once')
    manager.destroyInstance('d-removed-once')

    expect(removed).toEqual(['d-removed-once'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('ignores late state events after instance was removed', () => {
    const states: string[] = []
    manager.onStateChange((info) => states.push(info.id))

    manager.createInstance('d-late-state')
    const instance = (manager as any).instances.get('d-late-state')
    states.length = 0

    manager.destroyInstance('d-late-state')
    const countAfterDestroy = states.length

    instance.window._emit('hide')
    instance.window._emit('show')

    expect(states.length).toBe(countAfterDestroy)
  })

  it('binds and unbinds sessions', () => {
    manager.createInstance('b1')
    manager.bindSession('b1', 'session-abc')
    expect(manager.listInstances()[0].boundSessionId).toBe('session-abc')
    expect(manager.listInstances()[0].ownerType).toBe('session')

    manager.unbindSession('b1')
    expect(manager.listInstances()[0].boundSessionId).toBeNull()
    expect(manager.listInstances()[0].ownerType).toBe('manual')
  })

  it('createForSession returns canonical bound instance', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-1')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('getOrCreateForSession reuses existing instance', () => {
    const id1 = manager.getOrCreateForSession('sess-1')
    const id2 = manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('createForSession reuses an unbound manual window before creating new', () => {
    manager.createInstance('manual-1')

    const id = manager.createForSession('sess-reuse')

    expect(id).toBe('manual-1')
    const info = manager.listInstances()[0]
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-reuse')
    expect(info.boundSessionId).toBe('sess-reuse')
    expect(manager.listInstances()).toHaveLength(1)
  })

  describe('workspaceId stamping', () => {
    it('createForSession with workspaceId stamps the field on a new instance', () => {
      const id = manager.createForSession('sess-ws', { workspaceId: 'ws-alpha' })
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBe('ws-alpha')
    })

    it('createForSession without workspaceId defaults to null', () => {
      const id = manager.createForSession('sess-plain')
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance with no options leaves workspaceId null (unbound window)', () => {
      manager.createInstance('manual-ws')
      const info = manager.listInstances().find((i) => i.id === 'manual-ws')
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance accepts workspaceId option (TopBar manual open)', () => {
      // The browser-pane CREATE handler passes ctx.workspaceId so TopBar-
      // opened windows stay scoped to the workspace the user clicked from,
      // rather than being broadcast to every workspace.
      manager.createInstance('manual-scoped', { workspaceId: 'ws-toolbar' })
      const info = manager.listInstances().find((i) => i.id === 'manual-scoped')
      expect(info?.workspaceId).toBe('ws-toolbar')
    })

    it('reusing an unbound manual window adopts the new binder workspace', () => {
      manager.createInstance('manual-reuse')
      expect(manager.listInstances().find((i) => i.id === 'manual-reuse')?.workspaceId).toBeNull()

      const id = manager.createForSession('sess-reuse-ws', { workspaceId: 'ws-beta' })
      expect(id).toBe('manual-reuse')

      const info = manager.listInstances().find((i) => i.id === 'manual-reuse')
      expect(info?.workspaceId).toBe('ws-beta')
      expect(info?.ownerSessionId).toBe('sess-reuse-ws')
    })

    it('bindSession with workspaceId overwrites the instance workspaceId', () => {
      manager.createInstance('bind-ws')
      manager.bindSession('bind-ws', 'sess-bound', { workspaceId: 'ws-gamma' })
      const info = manager.listInstances().find((i) => i.id === 'bind-ws')
      expect(info?.workspaceId).toBe('ws-gamma')
      expect(info?.boundSessionId).toBe('sess-bound')
    })

    it('setAgentControl backfills workspaceId when previously null', () => {
      // Legacy path: instance was created without a workspace, then the overlay
      // path supplies it. Backfill should stamp it.
      manager.createInstance('legacy-overlay')
      manager.bindSession('legacy-overlay', 'sess-legacy')
      manager.setAgentControl('sess-legacy', { displayName: 'browser_navigate' }, { workspaceId: 'ws-delta' })

      const info = manager.listInstances().find((i) => i.id === 'legacy-overlay')
      expect(info?.workspaceId).toBe('ws-delta')
    })

    it('toInfo emits workspaceId on the DTO', () => {
      manager.createForSession('sess-dto', { workspaceId: 'ws-epsilon' })
      const dto = manager.listInstances().find((i) => i.ownerSessionId === 'sess-dto')
      expect(dto).toBeDefined()
      expect(dto).toHaveProperty('workspaceId', 'ws-epsilon')
    })

    describe('composite session identity (same sessionId across workspaces)', () => {
      it('createForSession keeps same-id sessions in different workspaces on separate panes', () => {
        // Two live workspaces reuse the same bare sessionId "dup".
        const paneA = manager.createForSession('dup', { workspaceId: 'ws-a' })
        const paneB = manager.createForSession('dup', { workspaceId: 'ws-b' })

        expect(paneB).not.toBe(paneA)
        expect(manager.listInstances()).toHaveLength(2)
        // Each pane is bound by the composite {sessionId, workspaceId}.
        expect(manager.getBoundForSession('dup', 'ws-a')).toBe(paneA)
        expect(manager.getBoundForSession('dup', 'ws-b')).toBe(paneB)
        // Re-requesting within a workspace returns that workspace's pane, not the other's.
        expect(manager.getOrCreateForSession('dup', { workspaceId: 'ws-a' })).toBe(paneA)
        expect(manager.getOrCreateForSession('dup', { workspaceId: 'ws-b' })).toBe(paneB)
      })

      it('destroyForSession scoped by workspace leaves the other workspace pane intact', () => {
        const paneA = manager.createForSession('dup', { workspaceId: 'ws-a' })
        const paneB = manager.createForSession('dup', { workspaceId: 'ws-b' })

        manager.destroyForSession('dup', { workspaceId: 'ws-a' })

        expect(manager.getBoundForSession('dup', 'ws-a')).toBeNull()
        expect(manager.getBoundForSession('dup', 'ws-b')).toBe(paneB)
        expect(manager.listInstances().map((i) => i.id)).toEqual([paneB])
        void paneA
      })
    })

    describe('cross-workspace reuse', () => {
      it('does NOT reuse an unbound session window from another workspace', () => {
        // Session in workspace A opens a window, then its turn ends — the
        // unbind path sets ownerType='manual' and clears boundSessionId, but
        // workspaceId stays = A. A session in workspace B asking for a window
        // must NOT pick it up; that would "move" the window across workspaces.
        const wsA = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a')

        // Sanity: instance is now unbound + manual but retains workspaceId=A.
        const after = manager.listInstances().find((i) => i.id === wsA)
        expect(after?.boundSessionId).toBeNull()
        expect(after?.ownerType).toBe('manual')
        expect(after?.workspaceId).toBe('ws-a')

        const wsB = manager.createForSession('sess-b', { workspaceId: 'ws-b' })
        expect(wsB).not.toBe(wsA)
        expect(manager.listInstances()).toHaveLength(2)

        // Workspace-A's window still belongs to A.
        const stillA = manager.listInstances().find((i) => i.id === wsA)
        expect(stillA?.workspaceId).toBe('ws-a')
      })

      it('DOES reuse an unbound window within the same workspace (next-turn case)', () => {
        // The legitimate same-workspace reuse: session-A ends a turn, leaves
        // an unbound window behind; the same workspace's session-A (or any
        // session in workspace A) should grab it on the next turn.
        const original = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a1')

        const reused = manager.createForSession('sess-a2', { workspaceId: 'ws-a' })
        expect(reused).toBe(original)
        expect(manager.listInstances()).toHaveLength(1)
      })

      it('lets any workspace adopt a truly unbound (workspaceId=null) manual window', () => {
        manager.createInstance('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBeNull()

        const adopted = manager.createForSession('sess-c', { workspaceId: 'ws-c' })
        expect(adopted).toBe('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBe('ws-c')
      })

      it('does NOT reuse a workspaceId=null unbound window when allowReuseManual=false', () => {
        // Remote-bridge dispatcher path: every lifecycle call passes
        // allowReuseManual=false so a stale window from before workspace
        // stamping (workspaceId=null) cannot get hijacked by a remote agent
        // for an unrelated workspace.
        manager.createInstance('legacy-unstamped')
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()

        const fresh = manager.createForSession('sess-d', {
          workspaceId: 'ws-d',
          allowReuseManual: false,
        })
        expect(fresh).not.toBe('legacy-unstamped')
        // Legacy window is left untouched.
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()
        // A new instance was created for the remote session.
        expect(manager.listInstances().find((i) => i.id === fresh)?.ownerSessionId).toBe('sess-d')
      })
    })
  })

  it('navigate normalizes hostnames to https', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = (manager as any).instances.get('nav-1')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'nessy agents browser tools')
    const instance = (manager as any).instances.get('nav-2')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=nessy%20agents%20browser%20tools'
    )
  })

  it('clears navigation timeout timer on success', async () => {
    manager.createInstance('nav-timeout')

    const originalClearTimeout = globalThis.clearTimeout
    const clearTimeoutSpy = mock((handle: Parameters<typeof clearTimeout>[0]) => originalClearTimeout(handle))
    ;(globalThis as any).clearTimeout = clearTimeoutSpy

    try {
      await manager.navigate('nav-timeout', 'https://example.com')
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      ;(globalThis as any).clearTimeout = originalClearTimeout
    }
  })

  it('focus brings the instance window to front', () => {
    manager.createInstance('f1')
    manager.focus('f1')

    const instance = (manager as any).instances.get('f1')
    instance.window._emit('ready-to-show')

    expect(instance.window.show).toHaveBeenCalled()
    expect(instance.window.focus).toHaveBeenCalled()
  })

  it('dedupes repeated focus calls before ready-to-show', () => {
    manager.createInstance('f2')

    manager.focus('f2')
    manager.focus('f2')
    manager.focus('f2')

    const instance = (manager as any).instances.get('f2')
    instance.window._emit('ready-to-show')

    expect(instance.window.show.mock.calls.length).toBe(1)
    expect(instance.window.focus.mock.calls.length).toBe(1)
  })

  it('cancels deferred pre-ready focus when hide happens first', () => {
    manager.createInstance('f-hide-race')

    manager.focus('f-hide-race')
    manager.hide('f-hide-race')

    const instance = (manager as any).instances.get('f-hide-race')
    const showCallsBeforeReady = instance.window.show.mock.calls.length
    const focusCallsBeforeReady = instance.window.focus.mock.calls.length

    instance.window._emit('ready-to-show')

    expect(instance.window.show.mock.calls.length).toBe(showCallsBeforeReady)
    expect(instance.window.focus.mock.calls.length).toBe(focusCallsBeforeReady)
  })

  it('user close hides window and keeps instance alive', () => {
    manager.createInstance('h1')
    const instance = (manager as any).instances.get('h1')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(manager.listInstances()).toHaveLength(1)
    expect(manager.listInstances()[0].isVisible).toBe(false)
  })

  it('does not intercept close when destroy is explicit', () => {
    manager.createInstance('h-explicit-destroy')
    const instance = (manager as any).instances.get('h-explicit-destroy')

    ;(manager as any).destroyingIds.add('h-explicit-destroy')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(instance.window.hide).not.toHaveBeenCalled()
  })

  it('still destroys instance when cleanup throws', () => {
    manager.createInstance('destroy-cleanup-throw')
    const instance = (manager as any).instances.get('destroy-cleanup-throw')

    ;(manager as any).updateNativeOverlayState = () => {
      throw new Error('mock overlay cleanup failure')
    }

    expect(() => manager.destroyInstance('destroy-cleanup-throw')).not.toThrow()
    expect(instance.window.destroy).toHaveBeenCalledTimes(1)
    expect(manager.listInstances()).toHaveLength(0)
  })

  // UB4.6 — the last unguarded steps. Before the port, a throwing `cdp.detach()`
  // (or a throwing `closePopupsForParent`, the shape an already-closed popup window
  // produces) escaped `finalizeDestroyedInstance` BEFORE `instances.delete`, leaving a
  // dead instance registered so every later browser_tool call failed with
  // "Object has been destroyed" until the app restarted (upstream #1059).
  it('UB4.6 — a throwing cdp.detach() still reaches instances.delete', () => {
    manager.createInstance('destroy-detach-throw')
    const instance = (manager as any).instances.get('destroy-detach-throw')
    instance.cdp.detach = () => {
      throw new Error('mock detach failure')
    }

    expect(() => manager.destroyInstance('destroy-detach-throw')).not.toThrow()
    expect((manager as any).instances.has('destroy-detach-throw')).toBe(false)
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('UB4.6 — a throwing closePopupsForParent (a closed popup window) still reaches instances.delete', () => {
    manager.createInstance('destroy-popups-throw')
    ;(manager as any).closePopupsForParent = () => {
      throw new Error('mock popup window already destroyed')
    }

    expect(() => manager.destroyInstance('destroy-popups-throw')).not.toThrow()
    expect((manager as any).instances.has('destroy-popups-throw')).toBe(false)
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback when window closes', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('r1')

    const instance = (manager as any).instances.get('r1')
    instance.window._emit('closed')

    expect(removed).toEqual(['r1'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('retries toolbar load and recovers', async () => {
    toolbarLoadFailuresRemaining = 2
    manager.createInstance('retry-toolbar')

    await Bun.sleep(1800)

    const instance = (manager as any).instances.get('retry-toolbar')
    const toolbarWebContents = instance.toolbarView.webContents
    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(3)
    expect(toolbarWebContents.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('loads toolbar fallback page after retry exhaustion', async () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('fallback-toolbar')

    await Bun.sleep(3200)

    const instance = (manager as any).instances.get('fallback-toolbar')
    const toolbarWebContents = instance.toolbarView.webContents
    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(5)
    expect(toolbarWebContents.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('captures and filters console entries', () => {
    manager.createInstance('console-1')
    const instance = (manager as any).instances.get('console-1')
    // UB4.19 — a created instance starts on the internal empty-state page, whose
    // console is the app's own; put it on a user page for the capture.
    instance.onInternalPage = false

    instance.pageView.webContents._emit('console-message', 2, 'warn message')
    instance.pageView.webContents._emit('console-message', 3, 'error message')

    const allEntries = manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

  it('applies observer theme signal and skips regular console logging for it', () => {
    manager.createInstance('theme-signal')
    const instance = (manager as any).instances.get('theme-signal')
    instance.themeObserverToken = 'tok-1'

    instance.pageView.webContents._emit('console-message', 1, '__nessy_theme_color__:tok-1:#123456')

    expect(manager.listInstances().find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

  it('dedupes repeated observer theme signals', () => {
    manager.createInstance('theme-dedupe')
    const instance = (manager as any).instances.get('theme-dedupe')
    instance.themeObserverToken = 'tok-2'

    instance.pageView.webContents._emit('console-message', 1, '__nessy_theme_color__:tok-2:#445566')
    const sendCallsAfterFirst = instance.window.webContents.send.mock.calls.length

    instance.pageView.webContents._emit('console-message', 1, '__nessy_theme_color__:tok-2:#445566')
    const sendCallsAfterSecond = instance.window.webContents.send.mock.calls.length

    expect(sendCallsAfterSecond).toBe(sendCallsAfterFirst)
  })

  it('ignores observer theme signals from stale token', () => {
    manager.createInstance('theme-stale-token')
    const instance = (manager as any).instances.get('theme-stale-token')
    instance.themeObserverToken = 'tok-current'
    instance.themeColor = '#aaaaaa'

    instance.pageView.webContents._emit('console-message', 1, '__nessy_theme_color__:tok-old:#bbccdd')

    expect(manager.listInstances().find(i => i.id === 'theme-stale-token')?.themeColor).toBe('#aaaaaa')
  })

  it('clears theme on explicit null sentinel signal', () => {
    manager.createInstance('theme-null')
    const instance = (manager as any).instances.get('theme-null')
    instance.themeObserverToken = 'tok-null'

    instance.pageView.webContents._emit('console-message', 1, '__nessy_theme_color__:tok-null:#223344')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBe('#223344')

    instance.pageView.webContents._emit('console-message', 1, '__nessy_theme_color__:tok-null:__NULL__')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBeNull()
  })

  it('replays toolbar state with theme color when window is shown', () => {
    manager.createInstance('theme-show-replay')
    const instance = (manager as any).instances.get('theme-show-replay')

    instance.currentUrl = 'https://example.com'
    instance.title = 'Example'
    instance.canGoBack = true
    instance.canGoForward = false
    instance.themeColor = '#123456'

    const sendsBeforeShow = instance.toolbarView.webContents.send.mock.calls.length
    instance.window._emit('show')

    const sendCallsAfterShow = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeShow)
    expect(sendCallsAfterShow).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        themeColor: '#123456',
        // P6.536 — see the note on the sibling assertion below.
        trustPrompt: null,
      },
    ])
  })

  it('replays full toolbar state when toolbar renderer finishes loading', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-finish-load-replay')
    const instance = (manager as any).instances.get('toolbar-finish-load-replay')

    instance.currentUrl = 'https://example.com'
    instance.title = 'Nessy'
    instance.isLoading = true
    instance.canGoBack = true
    instance.canGoForward = true
    instance.themeColor = '#654321'

    instance.toolbarView.webContents.getURL = mock(() => 'http://localhost:5173/browser-toolbar.html?instanceId=toolbar-finish-load-replay')

    const sendsBeforeFinishLoad = instance.toolbarView.webContents.send.mock.calls.length
    instance.toolbarView.webContents._emit('did-finish-load')

    const sendCallsAfterFinishLoad = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeFinishLoad)
    expect(sendCallsAfterFinishLoad).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com',
        title: 'Nessy',
        isLoading: true,
        canGoBack: true,
        canGoForward: true,
        themeColor: '#654321',
        // P6.536 — the trust card rides on the state push the toolbar already
        // subscribes to; `null` is the ordinary state and is asserted so a card
        // can never appear on a replay nobody asked for one on.
        trustPrompt: null,
      },
    ])
  })

  it('does not mark toolbar ready for about:blank did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-ignore-about-blank')
    const instance = (manager as any).instances.get('toolbar-ignore-about-blank')

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(false)
  })

  it('marks toolbar ready for fallback data page did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-fallback-ready')
    const instance = (manager as any).instances.get('toolbar-fallback-ready')

    instance.toolbarView.webContents.getURL = mock(() => 'data:text/html;charset=UTF-8,%3Chtml%3E%3C%2Fhtml%3E')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
  })

  it('keeps focus deferred until a valid toolbar document loads', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-focus-guard')
    const instance = (manager as any).instances.get('toolbar-focus-guard')

    manager.focus('toolbar-focus-guard')
    expect(instance.pendingShowOnReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

  it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = (manager as any).instances.get('theme-early')
    instance.pageView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    instance.pageView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect(manager.listInstances().find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

  it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = (manager as any).instances.get('theme-timer-clear')

    instance.pageView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(instance.inPageThemeTimer).not.toBeNull()

    instance.pageView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(instance.inPageThemeTimer).toBeNull()
  })

  it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = (manager as any).instances.get('screenshot-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshot('screenshot-empty-image')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('throws when screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('screenshot-empty-png')
    const instance = (manager as any).instances.get('screenshot-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('recovers screenshot via non-disruptive inactive reveal and restores hidden state', async () => {
    manager.createInstance('screenshot-rescue-success')
    const instance = (manager as any).instances.get('screenshot-rescue-success')

    // UB4.16 — a page that is not painting skips the hidden attempts straight to
    // the invisible reveal; the rescue capture is its one chance.
    instance.pageView.webContents.capturePage = mock(async () => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: function() { return this },
        toPNG: () => Buffer.from('rescued-png'),
        toJPEG: (_q: number) => Buffer.from('rescued-jpeg'),
      }
      return img
    })

    const result = await manager.screenshot('screenshot-rescue-success', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('rescued-png')
    expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).not.toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(result.metadata?.warnings?.some((w: string) => w.includes('shown invisibly'))).toBe(true)
  })

  // UB4.16 (upstream v0.15.1 "captures of a hidden page", adapted) — found
  // upstream 2026-10-11: screenshots of a hidden window showed an old frame. A
  // throttled background page stops painting and capturePage copies its last
  // composited frame.
  describe('captures of a hidden page (UB4.16)', () => {
    const image = (label: string) => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.from(label),
      toJPEG: (_q: number) => Buffer.from(label),
    })
    /** The paint probe never resolves until `paints()` is called (a hidden, throttled page). */
    const paintProbe = (instance: any) => {
      let painting = false
      const original = instance.pageView.webContents.executeJavaScript
      instance.pageView.webContents.executeJavaScript = mock(async (expr: string) => {
        if (!expr.includes('requestAnimationFrame')) return original(expr)
        return painting ? true : new Promise(() => {})
      })
      return { paints: () => { painting = true } }
    }

    it('lets the page render for the capture and throttles it again afterwards', async () => {
      manager.createInstance('cap-throttle')
      const instance = (manager as any).instances.get('cap-throttle')

      await manager.screenshot('cap-throttle')

      expect(instance.pageView.webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
      expect(instance.rendersWhileHidden).toBe(false)
    })

    it('keeps the page rendering while an agent controls the window', () => {
      manager.createInstance('cap-agent')
      manager.bindSession('cap-agent', 'sess-cap')
      const instance = (manager as any).instances.get('cap-agent')

      manager.setAgentControl('sess-cap', { displayName: 'Browser' })
      expect(instance.pageView.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(false)

      manager.clearAgentControl('sess-cap')
      expect(instance.pageView.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    })

    it('THE ROW: a hidden page that is not painting is revealed invisibly and the warning names it', async () => {
      manager.createInstance('cap-stale')
      const instance = (manager as any).instances.get('cap-stale')
      const probe = paintProbe(instance)
      instance.window.showInactive = mock(() => { probe.paints() })
      instance.pageView.webContents.capturePage = mock(async (_rect: unknown, opts: unknown) => image(opts ? 'stale-hidden' : 'fresh'))

      const result = await manager.screenshot('cap-stale')

      expect(result.imageBuffer.toString()).toBe('fresh')
      expect(instance.pageView.webContents.capturePage).toHaveBeenCalledTimes(1)
      expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
      expect(instance.window.hide).toHaveBeenCalled()
      // Raw screenshots report warnings without includeMetadata.
      expect(result.metadata?.warnings?.some((w: string) => w.includes('shown invisibly'))).toBe(true)
    })

    it('CONTROL: a painting page is captured hidden with no reveal', async () => {
      manager.createInstance('cap-painting')
      const instance = (manager as any).instances.get('cap-painting')
      paintProbe(instance).paints()
      instance.pageView.webContents.capturePage = mock(async () => image('current'))

      const result = await manager.screenshot('cap-painting')

      expect(result.imageBuffer.toString()).toBe('current')
      expect(instance.window.showInactive).not.toHaveBeenCalled()
      expect(instance.window.hide).not.toHaveBeenCalled()
      expect(result.metadata?.warnings?.some((w: string) => w.includes('shown invisibly') || w.includes('did not paint'))).toBeFalsy()
    })

    // setOpacity does nothing on Linux, so a transparent reveal would flash the window there.
    it('parks the window beyond every display on Linux instead of making it transparent', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'linux' })
      try {
        manager.createInstance('cap-linux')
        const instance = (manager as any).instances.get('cap-linux')
        const probe = paintProbe(instance)
        instance.window.showInactive = mock(() => { probe.paints() })

        await manager.screenshot('cap-linux')

        expect(instance.window.setOpacity).not.toHaveBeenCalled()
        expect(instance.window.setPosition).toHaveBeenCalledWith(4580, 60) // right of both displays
        expect(instance.window.setSkipTaskbar.mock.calls).toEqual([[true], [false]])
        expect(instance.window.setBounds).toHaveBeenCalledWith({ x: 40, y: 60, width: 1200, height: 900 })
        expect(instance.window.hide).toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', platform)
      }
    })

    it('warns when even a reveal produced no new frame (stale-frame warning reaches the agent)', async () => {
      manager.createInstance('cap-never')
      const instance = (manager as any).instances.get('cap-never')
      paintProbe(instance)

      const result = await manager.screenshot('cap-never')

      expect(result.metadata?.warnings).toContain('The page did not paint a new frame, so this capture may show an older one.')
    })
  })

  it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = (manager as any).instances.get('region-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshotRegion('region-empty-image', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('throws when region screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('region-empty-png')
    const instance = (manager as any).instances.get('region-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshotRegion('region-empty-png', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('captures screenshot region from ref target', async () => {
    manager.createInstance('region-ref')
    const result = await manager.screenshotRegion('region-ref', { ref: '@e1' })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('ref')
  })

  it('captures screenshot region from selector target', async () => {
    manager.createInstance('region-selector')
    const result = await manager.screenshotRegion('region-selector', { selector: 'div.card', padding: 4 })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('selector')
  })

  it('throws for ambiguous screenshot region target modes', async () => {
    manager.createInstance('region-ambiguous')

    await expect(
      manager.screenshotRegion('region-ambiguous', { ref: '@e1', selector: 'div.card' })
    ).rejects.toThrow('Region screenshot target is ambiguous')
  })

  it('throws when selector target cannot be resolved', async () => {
    manager.createInstance('region-selector-missing')
    const instance = (manager as any).instances.get('region-selector-missing')
    instance.cdp.getElementGeometryBySelector = mock(async () => {
      throw new Error('No element found for selector "div.missing"')
    })

    await expect(
      manager.screenshotRegion('region-selector-missing', { selector: 'div.missing' })
    ).rejects.toThrow('No element found for selector "div.missing"')
  })

  it('throws when resolved region is outside viewport', async () => {
    manager.createInstance('region-oob')

    await expect(
      manager.screenshotRegion('region-oob', { x: 5000, y: 5000, width: 100, height: 100 })
    ).rejects.toThrow('Resolved screenshot region is outside the current viewport')
  })

  it('resizes browser window viewport and returns effective applied size', () => {
    manager.createInstance('resize-1')
    const resized = manager.windowResize('resize-1', 1280, 720)

    const instance = (manager as any).instances.get('resize-1')
    expect(instance.window.setContentSize).toHaveBeenCalledWith(1280, 768)
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

  it('returns effective viewport size when min window constraints apply', () => {
    manager.createInstance('resize-min')
    const resized = manager.windowResize('resize-min', 200, 200)

    // BrowserWindow minHeight is 500, toolbar is 48, so effective viewport height is 452.
    expect(resized).toEqual({ width: 700, height: 452 })
  })

  describe('agent control overlay', () => {
    it('setAgentControl activates native overlay on bound instance', async () => {
      manager.createInstance('ac-1')
      manager.bindSession('ac-1', 'sess-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-1')
      expect(instance.agentControl).toEqual({
        active: true,
        sessionId: 'sess-1',
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
      })
      expect(instance.nativeOverlayView.webContents.executeJavaScript).toHaveBeenCalled()
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    it('keeps native overlay visible for active session control', async () => {
      manager.createInstance('ac-idle')
      manager.bindSession('ac-idle', 'sess-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this window',
      })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-idle')
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 48, width: 1200, height: 852 })
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-idle')?.agentControlActive).toBe(true)
    })

    it('emits state change when agent control is set and cleared', () => {
      const stateEvents: any[] = []
      manager.onStateChange((info) => stateEvents.push(info))

      manager.createInstance('ac-state')
      manager.bindSession('ac-state', 'sess-state')

      manager.setAgentControl('sess-state', { displayName: 'Browser Snapshot' })
      manager.clearAgentControl('sess-state')

      const acStateEvents = stateEvents.filter((event) => event.id === 'ac-state')
      expect(acStateEvents.some((event) => event.agentControlActive === true)).toBe(true)
      expect(acStateEvents.some((event) => event.agentControlActive === false)).toBe(true)
    })

    it('reapplies native overlay after did-stop-loading while control is active', async () => {
      manager.createInstance('ac-reapply')
      manager.bindSession('ac-reapply', 'sess-reapply')

      manager.setAgentControl('sess-reapply', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.pageView.webContents._emit('did-stop-loading')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('reapplies native overlay after hide/show while control is active', async () => {
      manager.createInstance('ac-show-reapply')
      manager.bindSession('ac-show-reapply', 'sess-show-reapply')

      manager.setAgentControl('sess-show-reapply', { displayName: 'Click Button', intent: 'Clicking submit' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-show-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.window._emit('hide')
      instance.window._emit('show')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('setAgentControl uses fallback label when no intent', async () => {
      manager.createInstance('ac-2')
      manager.bindSession('ac-2', 'sess-2')

      manager.setAgentControl('sess-2', { displayName: 'Browser Snapshot' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-2')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Browser Snapshot')
    })

    it('setAgentControl uses default label when no metadata', async () => {
      manager.createInstance('ac-3')
      manager.bindSession('ac-3', 'sess-3')

      manager.setAgentControl('sess-3', {})
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-3')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Agent is working…')
    })

    it('clearAgentControl dismisses native overlay', () => {
      manager.createInstance('ac-4')
      manager.bindSession('ac-4', 'sess-4')

      manager.setAgentControl('sess-4', { displayName: 'Click Button', intent: 'Clicking submit' })
      manager.clearAgentControl('sess-4')

      const instance = (manager as any).instances.get('ac-4')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('clearAgentControl is a no-op when not active', () => {
      manager.createInstance('ac-5')
      manager.bindSession('ac-5', 'sess-5')

      manager.clearAgentControl('sess-5')

      const instance = (manager as any).instances.get('ac-5')
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('clearVisualsForSession resets agent control state', async () => {
      manager.createInstance('ac-6')
      manager.bindSession('ac-6', 'sess-6')

      manager.setAgentControl('sess-6', { displayName: 'Fill Input', intent: 'Typing email' })
      await manager.clearVisualsForSession('sess-6')

      const instance = (manager as any).instances.get('ac-6')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('setAgentControl ignores unbound sessions', () => {
      manager.createInstance('ac-7')

      manager.setAgentControl('nonexistent-session', { displayName: 'Test' })

      const instance = (manager as any).instances.get('ac-7')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('navigate does not trigger overlay by itself', async () => {
      manager.createInstance('ac-8')
      manager.bindSession('ac-8', 'sess-8')

      await manager.navigate('ac-8', 'https://example.com')

      const instance = (manager as any).instances.get('ac-8')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })
  })

  describe('failed interaction tracking', () => {
    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = (manager as any).instances.get('fail-click')
      instance.cdp.clickElement = mock(async () => { throw new Error('click failed') })

      await expect(manager.clickElement('fail-click', '@e1')).rejects.toThrow('click failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'failed',
      })
    })

    it('fillElement records failed lastAction on error', async () => {
      manager.createInstance('fail-fill')
      const instance = (manager as any).instances.get('fail-fill')
      instance.cdp.fillElement = mock(async () => { throw new Error('fill failed') })

      await expect(manager.fillElement('fail-fill', '@e2', 'hello')).rejects.toThrow('fill failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_fill',
        ref: '@e2',
        status: 'failed',
      })
    })

    it('selectOption records failed lastAction on error', async () => {
      manager.createInstance('fail-select')
      const instance = (manager as any).instances.get('fail-select')
      instance.cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })

  /**
   * P2.399 — the managed in-app-browser gate.
   *
   * The posture under test is NO PANE AT ALL with the affordance kept and
   * REFUSING by name, so these are the two halves of that: `createInstance`
   * refuses while the policy disables, and a pane already open is CLOSED when
   * the policy arrives mid-session (which is when the codex tier lands — the
   * first codex runtime of a process starts long after a window could have been
   * opened).
   *
   * Every case carries its own positive control, because "the pane did not
   * open" is the same observation as "the mock broke".
   */
  describe('managed in-app-browser policy', () => {
    afterEach(() => {
      registerManagedInAppBrowserDisabledProvider(undefined)
      recordCodexInAppBrowserRequirement(undefined)
    })

    it('opens normally while no administrator has an opinion — the positive control', () => {
      const id = manager.createInstance('policy-unset')
      expect(id).toBe('policy-unset')
      expect(manager.listInstances().map(i => i.id)).toEqual(['policy-unset'])
    })

    it('refuses to open a pane while the HOST policy disables the browser, naming the document', () => {
      registerManagedInAppBrowserDisabledProvider(() => true)
      expect(() => manager.createInstance('policy-host')).toThrow(/disableInAppBrowser/)
      expect(manager.listInstances()).toHaveLength(0)
    })

    it('refuses while the CODEX tier disables it, naming requirements.toml instead', () => {
      recordCodexInAppBrowserRequirement(true)
      expect(() => manager.createInstance('policy-codex')).toThrow(/in_app_browser = false/)
      expect(manager.listInstances()).toHaveLength(0)
    })

    it('refuses every session-bound entry point too, not only the bare create', () => {
      registerManagedInAppBrowserDisabledProvider(() => true)
      expect(() => manager.createForSession('s-1')).toThrow(/built-in browser is disabled/)
      expect(() => manager.getOrCreateForSession('s-2')).toThrow(/built-in browser is disabled/)
      expect(() => manager.focusBoundForSession('s-3')).toThrow(/built-in browser is disabled/)
      expect(manager.listInstances()).toHaveLength(0)
    })

    it('opens again once the policy stops disabling — a managed `false` is not a latch', () => {
      registerManagedInAppBrowserDisabledProvider(() => true)
      expect(() => manager.createInstance('policy-latch')).toThrow()
      registerManagedInAppBrowserDisabledProvider(() => false)
      expect(manager.createInstance('policy-latch')).toBe('policy-latch')
    })

    it('closes a pane that is already open when the policy arrives mid-session', () => {
      manager.registerManagedPolicyEnforcement()
      manager.createInstance('policy-open-first')
      expect(manager.listInstances()).toHaveLength(1)

      // The codex tier landing is the real mid-session trigger: the write
      // notifies, the manager tears down.
      recordCodexInAppBrowserRequirement(true)
      expect(manager.listInstances()).toHaveLength(0)
    })

    it('leaves an open pane alone when the arriving policy does NOT disable — the control for the tear-down', () => {
      manager.registerManagedPolicyEnforcement()
      manager.createInstance('policy-open-allowed')
      recordCodexInAppBrowserRequirement(false)
      expect(manager.listInstances().map(i => i.id)).toEqual(['policy-open-allowed'])
    })

    it('enforces at startup, so a pane surviving a restart into a disabled policy is closed too', () => {
      manager.createInstance('policy-pre-existing')
      registerManagedInAppBrowserDisabledProvider(() => true)
      // Registration alone notifies, but a manager that has not started
      // enforcing must not be listening yet — that is what makes the startup
      // pass load-bearing rather than decorative.
      expect(manager.listInstances()).toHaveLength(1)
      manager.registerManagedPolicyEnforcement()
      expect(manager.listInstances()).toHaveLength(0)
    })

    it('stops listening once destroyAll has run, so a disposed manager is not a leaked subscriber', () => {
      manager.registerManagedPolicyEnforcement()
      manager.destroyAll()
      expect(() => recordCodexInAppBrowserRequirement(true)).not.toThrow()
      expect(manager.listInstances()).toHaveLength(0)
    })
  })

  // UB4.19 (B5-05; upstream v0.15.1) — console and network logs are scoped to the committed
  // site, and the internal empty-state page is never logged. At HEAD pushNetworkLog had no
  // scoping and the console push no internal-page filter, so an agent reading `console` or
  // `network` on a new site got the PREVIOUS site's entries (and the app's own dev-server
  // requests). The callbacks below are the ones the manager registered on its partition
  // session's webRequest observers (the electron mock records them).
  describe('browser log scoping (UB4.19)', () => {
    function observerCallbacks() {
      const electronMock = require('electron') as any
      const results = electronMock.session.fromPartition.mock.results
      const ses = results[results.length - 1].value
      return {
        onBeforeRequest: ses.webRequest.onBeforeRequest.mock.calls.at(-1)![0] as (d: any, cb: any) => void,
        onCompleted: ses.webRequest.onCompleted.mock.calls.at(-1)![0] as (d: any) => void,
        onErrorOccurred: ses.webRequest.onErrorOccurred.mock.calls.at(-1)![0] as (d: any) => void,
      }
    }

    function request(id: number, url: string, wcId = 4242) {
      return { id, webContentsId: wcId, method: 'GET', url }
    }

    /** Fire the navigation pair the way Electron does: start, then commit. */
    async function navigate(url: string, instanceId = 'log-scope-1') {
      const inst = (manager as any).instances.get(instanceId)
      inst.pageView.webContents.getURL = mock(() => url)
      inst.pageView.webContents._emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false }, url, true, false)
      await new Promise((r) => setTimeout(r, 6))
      inst.pageView.webContents._emit('did-navigate', url)
      await new Promise((r) => setTimeout(r, 6))
      return inst
    }

    it('THE ROW: navigating A→B drops A\u0027s entries and A\u0027s late finishers', async () => {
      manager.createInstance('log-scope-1')
      const inst = (manager as any).instances.get('log-scope-1')
      inst.pageView.webContents.id = 4242
      const cb = observerCallbacks()
      await navigate('https://a.example/page')

      // Two requests on site A: one completes there, one stays in flight.
      cb.onBeforeRequest(request(101, 'https://a.example/api/one'), () => {})
      cb.onCompleted({ ...request(101, 'https://a.example/api/one'), statusCode: 200 })
      cb.onBeforeRequest(request(102, 'https://a.example/api/slow'), () => {})

      expect(inst.networkLogs).toHaveLength(1)
      expect(inst.networkLogs[0].url).toBe('https://a.example/api/one')

      await navigate('https://b.example/page')

      // Site A's committed entry is dropped with the scope...
      expect(inst.networkLogs.some((e: { url: string }) => e.url.includes('a.example'))).toBe(false)
      // ...and A's late finisher, completing after B committed, never enters either.
      cb.onCompleted({ ...request(102, 'https://a.example/api/slow'), statusCode: 200 })
      expect(inst.networkLogs.some((e: { url: string }) => e.url.includes('a.example'))).toBe(false)

      // B's own traffic logs normally.
      cb.onBeforeRequest(request(103, 'https://b.example/api/data'), () => {})
      cb.onCompleted({ ...request(103, 'https://b.example/api/data'), statusCode: 200 })
      expect(inst.networkLogs.map((e: { url: string }) => e.url)).toEqual(['https://b.example/api/data'])
    })

    it('CONTROL: a same-site navigation keeps the site\u0027s entries', async () => {
      manager.createInstance('log-scope-2')
      const inst = (manager as any).instances.get('log-scope-2')
      inst.pageView.webContents.id = 4243
      const cb = observerCallbacks()
      await navigate('https://a.example/page', 'log-scope-2')

      cb.onBeforeRequest(request(201, 'https://a.example/api/one', 4243), () => {})
      cb.onCompleted({ ...request(201, 'https://a.example/api/one', 4243), statusCode: 200 })

      await navigate('https://a.example/other', 'log-scope-2')

      // Same origin: the scope did not move, the entry survived the commit.
      expect(inst.networkLogs.map((e: { url: string }) => e.url)).toEqual(['https://a.example/api/one'])
    })

    it('CONTROL: the empty-state page\u0027s requests and console are never logged', async () => {
      manager.createInstance('log-scope-3')
      const inst = (manager as any).instances.get('log-scope-3')
      inst.pageView.webContents.id = 4244
      const cb = observerCallbacks()
      await navigate('https://app.local/browser-empty-state.html', 'log-scope-3')

      expect(inst.onInternalPage).toBe(true)

      cb.onBeforeRequest(request(301, 'https://app.local/dev-server-bundle.js', 4244), () => {})
      cb.onCompleted({ ...request(301, 'https://app.local/dev-server-bundle.js', 4244), statusCode: 200 })
      cb.onBeforeRequest(request(302, 'https://app.local/missing.map', 4244), () => {})
      cb.onErrorOccurred({ ...request(302, 'https://app.local/missing.map', 4244) })

      expect(inst.networkLogs).toHaveLength(0)

      // The console filter: the theme-signal arm runs first (the app needs it), the rest is
      // dropped while onInternalPage.
      inst.pageView.webContents._emit('console-message', 2, 'a warning from the app shell')
      expect(inst.consoleLogs).toHaveLength(0)

      // Leaving the internal page restores logging.
      await navigate('https://b.example/page', 'log-scope-3')
      inst.pageView.webContents._emit('console-message', 2, 'a real page warning')
      expect(inst.consoleLogs.map((e: { message: string }) => e.message)).toEqual(['a real page warning'])
    })
  })

  // UB4.21 (B5-08, B5-14; upstream v0.15.1) — one sign-in popup per origin across the browser
  // windows of ONE workspace. Every pane of a workspace shares one cookie partition, so a second
  // window's Google sign-in is denied and the first is raised for the user; the ADAPT scopes the
  // search to the requester's own workspace (upstream searches all windows; ours are
  // workspace-scoped and telling workspace B about workspace A's window would leak).
  describe('sign-in popup joining (UB4.21)', () => {
    function fakePopupWindow(wcId: number, url: string) {
      const win = {
        webContents: {
          id: wcId,
          getURL: mock(() => url),
          on: mock((_e: string, _cb: Function) => {}),
        },
        isDestroyed: mock(() => false),
        moveTop: mock(() => {}),
        on: mock((_e: string, _cb: Function) => {}),
      }
      return win
    }

    function openHandlerFor(instanceId: string) {
      manager.createInstance(instanceId)
      const inst = (manager as any).instances.get(instanceId) as any
      return { inst, handler: (inst.pageView.webContents.setWindowOpenHandler as any).mock.calls.at(-1)![0] as (d: { url: string; disposition?: string }) => { action: string } }
    }

    it('THE ROW: a second window\u0027s sign-in for an origin already signing in is denied, the first is raised, and the agent is told to reload', async () => {
      const a = openHandlerFor('signin-a')
      a.inst.workspaceId = 'ws-shared'
      const popup = fakePopupWindow(9001, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')
      ;(manager as any).registerPopupWindow(a.inst, popup, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')

      const b = openHandlerFor('signin-b')
      b.inst.workspaceId = 'ws-shared'

      const verdict = b.handler({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', disposition: 'new-window' })

      expect(verdict.action).toBe('deny')
      expect(popup.moveTop).toHaveBeenCalled()
      // The agent is told to reload once that sign-in finishes instead of starting another.
      const notice = (manager as any).describePopupEvents(b.inst, 0) as string
      expect(notice).toContain('already open from another browser window')
      expect(notice).toContain('reload this page')
    })

    it('CONTROL: a non-sign-in popup opens normally', () => {
      const a = openHandlerFor('popup-plain')
      a.inst.workspaceId = 'ws-shared'
      const popup = fakePopupWindow(9002, 'https://example.com/normal')
      ;(manager as any).registerPopupWindow(a.inst, popup, 'https://example.com/normal')

      const verdict = a.handler({ url: 'https://example.com/other', disposition: 'new-window' })

      expect(verdict.action).toBe('allow')
      expect(popup.moveTop).not.toHaveBeenCalled()
    })

    it('CONTROL (the ADAPT): a sign-in in ANOTHER workspace opens normally', () => {
      const a = openHandlerFor('signin-ws-a')
      a.inst.workspaceId = 'ws-a'
      const popup = fakePopupWindow(9003, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')
      ;(manager as any).registerPopupWindow(a.inst, popup, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')

      const b = openHandlerFor('signin-ws-b')
      b.inst.workspaceId = 'ws-b'

      const verdict = b.handler({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', disposition: 'new-window' })

      // Cookies are global, but panes are workspace-scoped: workspace B's agent must not learn
      // about workspace A's window, so B opens its own sign-in.
      expect(verdict.action).toBe('allow')
      expect(popup.moveTop).not.toHaveBeenCalled()
    })
  })
})
