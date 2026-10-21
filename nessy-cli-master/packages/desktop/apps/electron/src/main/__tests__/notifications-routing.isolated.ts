import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../shared/types'

let clickHandler: (() => void) | null = null
let dismissedUpdateVersion: string | null = null
let shownNotifications = 0

mock.module('@craft-agent/shared/config/storage', () => ({
  getDismissedUpdateVersion: () => dismissedUpdateVersion,
  getNotificationsEnabled: () => true,
  setDismissedUpdateVersion: (version: string) => {
    dismissedUpdateVersion = version
  },
}))

mock.module('@craft-agent/shared/i18n', () => ({
  i18n: {
    t: (key: string, options?: { version?: string }) =>
      options?.version ? `${key}:${options.version}` : key,
  },
}))

mock.module('electron', () => {
  class MockNotification {
    constructor(_opts: unknown) {}

    static isSupported(): boolean {
      return true
    }

    on(event: string, cb: () => void): void {
      if (event === 'click') {
        clickHandler = cb
      }
    }

    show(): void {
      shownNotifications += 1
    }
  }

  return {
    Notification: MockNotification,
    app: {
      dock: { setIcon: () => {} },
      setBadgeCount: () => {},
    },
    BrowserWindow: {
      getAllWindows: () => [],
    },
    nativeImage: {
      createFromPath: () => ({}),
      createFromDataURL: () => ({}),
    },
  }
})

describe('notification click routing', () => {
  beforeEach(() => {
    clickHandler = null
    dismissedUpdateVersion = null
    shownNotifications = 0
  })

  it('routes notification navigation to resolved client target when resolver is provided', async () => {
    const notifications = await import('../notifications')

    const mockWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      focus: () => {},
      webContents: {
        id: 101,
        isDestroyed: () => false,
      },
    }

    notifications.initNotificationService({
      getWindowByWorkspace: () => mockWindow,
      createWindow: () => mockWindow,
    } as any)

    const pushed: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    notifications.setNotificationEventSink(((channel: string, target: unknown, ...args: unknown[]) => {
      pushed.push({ channel, target, args })
    }) as any, (wcId) => wcId === 101 ? 'client-101' : undefined)

    notifications.showNotification('Title', 'Body', 'ws-1', 'sess-1')
    expect(clickHandler).toBeTruthy()
    clickHandler?.()

    expect(pushed.length).toBe(1)
    expect(pushed[0]?.channel).toBe(RPC_CHANNELS.notification.NAVIGATE)
    expect(pushed[0]?.target).toEqual({ to: 'client', clientId: 'client-101' })
    expect(pushed[0]?.args[0]).toEqual({ workspaceId: 'ws-1', sessionId: 'sess-1' })
  })

  it('falls back to workspace-targeted navigation when resolver is not provided', async () => {
    const notifications = await import('../notifications')

    const mockWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      focus: () => {},
      webContents: {
        id: 202,
        isDestroyed: () => false,
      },
    }

    notifications.initNotificationService({
      getWindowByWorkspace: () => mockWindow,
      createWindow: () => mockWindow,
    } as any)

    const pushed: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    notifications.setNotificationEventSink(((channel: string, target: unknown, ...args: unknown[]) => {
      pushed.push({ channel, target, args })
    }) as any)

    notifications.showNotification('Title', 'Body', 'ws-2', 'sess-2')
    expect(clickHandler).toBeTruthy()
    clickHandler?.()

    expect(pushed.length).toBe(1)
    expect(pushed[0]?.target).toEqual({ to: 'workspace', workspaceId: 'ws-2' })
    expect(pushed[0]?.args[0]).toEqual({ workspaceId: 'ws-2', sessionId: 'sess-2' })
  })

  it('shows one update notification and routes its click to the active window', async () => {
    const notifications = await import('../notifications')

    const mockWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      focus: () => {},
      webContents: {
        id: 303,
        isDestroyed: () => false,
      },
    }

    notifications.initNotificationService({
      getLastActiveWindow: () => mockWindow,
      getWorkspaceForWindow: () => 'ws-3',
    } as any)

    const pushed: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    notifications.setNotificationEventSink(((channel: string, target: unknown, ...args: unknown[]) => {
      pushed.push({ channel, target, args })
    }) as any, (wcId) => wcId === 303 ? 'client-303' : undefined)

    notifications.showUpdateNotification('1.2.3')
    notifications.showUpdateNotification('1.2.3')

    expect(shownNotifications).toBe(1)
    expect(dismissedUpdateVersion).toBe('1.2.3')
    clickHandler?.()
    expect(pushed).toEqual([{
      channel: RPC_CHANNELS.update.NAVIGATE,
      target: { to: 'client', clientId: 'client-303' },
      args: [],
    }])
  })
})
