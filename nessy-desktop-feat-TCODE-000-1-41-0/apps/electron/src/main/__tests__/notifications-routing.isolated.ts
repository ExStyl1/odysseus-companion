import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../shared/types'

let clickHandler: (() => void) | null = null
const shown: Array<{ title: string; body: string }> = []

mock.module('electron', () => {
  class MockNotification {
    constructor(opts: { title: string; body: string }) {
      shown.push({ title: opts.title, body: opts.body })
    }

    static isSupported(): boolean {
      return true
    }

    on(event: string, cb: () => void): void {
      if (event === 'click') {
        clickHandler = cb
      }
    }

    show(): void {}
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
    shown.length = 0
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

  // R27a — the `PushNotification` decision half. Delivery itself is the same
  // showNotification path the two tests above already cover.
  it('suppresses a model notification while this workspace window has focus', async () => {
    const notifications = await import('../notifications')

    notifications.initNotificationService({
      getWindowByWorkspace: (workspaceId: string) => ({
        isDestroyed: () => false,
        // Only ws-focused is in front; ws-away is open but behind.
        isFocused: () => workspaceId === 'ws-focused',
      }),
    } as any)

    const focused = await notifications.deliverModelNotification({
      body: 'Build finished.', workspaceId: 'ws-focused', sessionId: 'sess-1',
    })
    expect(focused).toEqual({ delivered: false, reason: 'window-focused' })
    expect(shown).toHaveLength(0)

    // Focus is per workspace: another workspace being in front says nothing
    // about whether THIS session is being watched.
    const away = await notifications.deliverModelNotification({
      title: 'nightly', body: 'Build finished.', workspaceId: 'ws-away', sessionId: 'sess-2',
    })
    expect(away).toEqual({ delivered: true })
    expect(shown).toEqual([{ title: 'nightly', body: 'Build finished.' }])
  })

  it('delivers a model notification when no window is open for the workspace', async () => {
    const notifications = await import('../notifications')

    notifications.initNotificationService({ getWindowByWorkspace: () => null } as any)

    const result = await notifications.deliverModelNotification({
      body: 'Deploy finished.', workspaceId: 'ws-closed', sessionId: 'sess-3',
    })
    expect(result).toEqual({ delivered: true })
    expect(shown).toEqual([{ title: 'Nessy Desktop', body: 'Deploy finished.' }])
  })

  // desktop-scheduled-tasks.md:74 — "Desktop shows a notification when a
  // catch-up run starts." The window is focused in both halves below; the
  // contrast with the model-notification test directly above is the point.
  it('announces a catch-up run even while the workspace window has focus', async () => {
    const notifications = await import('../notifications')

    notifications.initNotificationService({
      getWindowByWorkspace: () => ({ isDestroyed: () => false, isFocused: () => true }),
    } as any)

    // Positive control: the model path suppresses on this exact rig.
    const model = await notifications.deliverModelNotification({
      body: 'suppressed', workspaceId: 'ws-focused', sessionId: 'sess-a',
    })
    expect(model).toEqual({ delivered: false, reason: 'window-focused' })
    expect(shown).toHaveLength(0)

    // A catch-up fires seconds after the app opens or the machine wakes —
    // exactly when the window IS focused — so the focus gate must not apply.
    const catchUp = await notifications.deliverScheduledRunNotification({
      title: 'nightly-lint',
      body: 'Catch-up run for the missed 9:00 AM schedule.',
      workspaceId: 'ws-focused',
      sessionId: 'sess-b',
    })
    expect(catchUp).toEqual({ delivered: true })
    expect(shown).toEqual([{ title: 'nightly-lint', body: 'Catch-up run for the missed 9:00 AM schedule.' }])
  })
})
