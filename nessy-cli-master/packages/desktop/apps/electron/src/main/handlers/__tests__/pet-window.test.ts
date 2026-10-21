import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

const ensureDefaultConversationWorkspace = mock(() => ({
  id: 'default-workspace',
}));

mock.module('@craft-agent/shared/config', () => ({
  ensureDefaultConversationWorkspace,
  // pet-window also imports the watcher source gates from this barrel.
  getPetTerminalSessions: () => true,
  getPetAcpSessions: () => false,
}));

// pet-window imports `app` from electron; keep this file runnable standalone
// (mock.module cannot rebind a pet-window instance cached by an earlier test
// file, so every importer carries its own mock).
mock.module('electron', () => ({
  app: {
    isPackaged: false,
    once: () => {},
  },
}));

// [nessy-fork] desktop-pet-click-activation
describe('pet window RPC handlers', () => {
  const handlers = new Map<string, HandlerFn>();

  beforeEach(() => {
    handlers.clear();
    ensureDefaultConversationWorkspace.mockClear();
  });

  async function register(windowManager: HandlerDeps['windowManager']) {
    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn);
      },
      push() {},
      async invokeClient() {},
    };
    const { registerPetWindowGuiHandlers } = await import('../pet-window');

    registerPetWindowGuiHandlers(
      server,
      {
        windowManager,
      } as HandlerDeps,
      {
        // This file exercises window handlers, not the external-session
        // watcher — substitute it so no real ~/.nessy polling starts.
        createWatcher: () =>
          ({ start() {}, stop() {} }) as unknown as import('../../session/terminal-session-watcher').TerminalSessionWatcher,
      },
    );
  }

  it('restores and focuses the last active window', async () => {
    const restore = mock(() => {});
    const show = mock(() => {});
    const focus = mock(() => {});
    const createWindow = mock(() => {});
    const window = {
      isMinimized: () => true,
      restore,
      show,
      focus,
    };
    await register({
      getLastActiveWindow: () => window,
      createWindow,
    } as unknown as HandlerDeps['windowManager']);

    await handlers.get(RPC_CHANNELS.window.PET_FOCUS_LAST_WINDOW)?.({
      clientId: 'pet',
      workspaceId: null,
      webContentsId: 1,
    });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(createWindow).not.toHaveBeenCalled();
    expect(ensureDefaultConversationWorkspace).not.toHaveBeenCalled();
  });

  it('creates a window in the default workspace when none are open', async () => {
    const createWindow = mock(() => {});
    await register({
      getLastActiveWindow: () => null,
      createWindow,
    } as unknown as HandlerDeps['windowManager']);

    await handlers.get(RPC_CHANNELS.window.PET_FOCUS_LAST_WINDOW)?.({
      clientId: 'pet',
      workspaceId: null,
      webContentsId: 1,
    });

    expect(ensureDefaultConversationWorkspace).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith({
      workspaceId: 'default-workspace',
    });
  });
});
