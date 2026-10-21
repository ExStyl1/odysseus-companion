import { describe, expect, it } from 'bun:test'
import { handleDeepLink } from '../deep-link'
import { RPC_CHANNELS } from '../../shared/types'
import type { EventSink } from '@nessy-agent/server-core/transport'
import type { WindowManager } from '../window-manager'

function createMockWindow(webContentsId: number) {
  return {
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isLoading: () => false,
      isDestroyed: () => false,
      once: () => {},
    },
  }
}

describe('handleDeepLink routing', () => {
  it('prefers resolved target client over preferred caller client', async () => {
    const targetWindow = createMockWindow(22)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: (webContentsId: number) => webContentsId === 22 ? 'ws-target' : 'ws-other',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'nessy://workspace/ws-target/allSessions',
      windowManager,
      'external',
      sink,
      (wcId) => wcId === 22 ? 'client-target' : undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.channel).toBe(RPC_CHANNELS.deeplink.NAVIGATE)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-target' })
  })

  it('uses preferred client only when no resolver is provided', async () => {
    const targetWindow = createMockWindow(31)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'nessy://workspace/ws-target/allSessions',
      windowManager,
      'external',
      sink,
      undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-caller' })
  })

  it('falls back to workspace routing when resolver exists but target client is unresolved', async () => {
    const targetWindow = createMockWindow(44)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'nessy://workspace/ws-target/allSessions',
      windowManager,
      'external',
      sink,
      () => undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'workspace', workspaceId: 'ws-target' })
  })

  it('stamps the origin the entry point supplied onto the payload', async () => {
    const targetWindow = createMockWindow(55)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    // The shape an attacker's page would deliver: a seeded prompt asking to send.
    await handleDeepLink(
      'nessy://action/new-session?input=hello&send=true',
      windowManager,
      'external',
      sink,
      () => 'client-target',
    )

    expect(sent.length).toBe(1)
    const navigation = sent[0]?.args[0] as { origin?: string; action?: string; actionParams?: Record<string, string> }
    expect(navigation.action).toBe('new-session')
    expect(navigation.origin).toBe('external')
    // The params still travel verbatim — the renderer, not this handler, decides
    // what an external link may act on.
    expect(navigation.actionParams?.send).toBe('true')
  })
})
