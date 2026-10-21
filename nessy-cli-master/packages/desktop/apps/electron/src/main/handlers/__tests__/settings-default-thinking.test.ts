import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { RPC_CHANNELS } from '../../../shared/types';
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

const requestContext = {
  clientId: 'client-1',
  workspaceId: null,
  webContentsId: null,
};

const getDefaultThinkingLevelMock = mock(() => 'think');
const setDefaultThinkingLevelMock = mock((_level: string) => true);
let mockedWorkspace: Record<string, unknown> | null = null;
let mockedWorkspaceConfig: Record<string, unknown> | null = null;
const getWorkspaceByNameOrIdMock = mock(
  (_workspaceId: string) => mockedWorkspace,
);
const loadWorkspaceConfigMock = mock(
  (_rootPath: string) => mockedWorkspaceConfig,
);
const getNessyCoreSettingsViaAcpMock = mock(async () => ({
  user: {
    path: '',
    values: { 'tools.approvalMode': 'yolo' },
    mcpServers: [],
    hooks: [],
  },
  workspace: { path: '', values: {}, mcpServers: [], hooks: [] },
  merged: {
    values: {},
    mcpServers: [],
    hooks: [],
    extensions: [],
  },
  workspaceTrusted: true,
}));
const setNessyCoreSettingViaAcpMock = mock(async () => ({
  user: { path: '', values: {}, mcpServers: [], hooks: [] },
  workspace: { path: '', values: {}, mcpServers: [], hooks: [] },
  merged: {
    values: { 'tools.approvalMode': 'yolo' },
    mcpServers: [],
    hooks: [],
    extensions: [],
  },
  workspaceTrusted: true,
}));
const applyGlobalPermissionModeMock = mock(async (_mode: string) => {});
const getNessyMemoryPathsViaAcpMock = mock(async () => ({
  userMemoryFile: '/tmp/NESSY.md',
  projectMemoryFile: '/tmp/project/AGENTS.md',
  autoMemoryDir: '/tmp/project/memory',
}));
const getNessyMemorySettingsViaAcpMock = mock(async () => ({}));
const setNessyMemorySettingsViaAcpMock = mock(async () => ({}));

mock.module('@craft-agent/shared/config', () => ({
  getPreferencesPath: () => '/tmp/preferences.json',
  getSessionDraft: () => null,
  setSessionDraft: () => {},
  deleteSessionDraft: () => {},
  getAllSessionDrafts: () => ({}),
  getWorkspaceByNameOrId: getWorkspaceByNameOrIdMock,
  getDefaultThinkingLevel: getDefaultThinkingLevelMock,
  setDefaultThinkingLevel: setDefaultThinkingLevelMock,
  isProtectedWorkspace: () => false,
}));

mock.module('@craft-agent/shared/workspaces', () => ({
  loadWorkspaceConfig: loadWorkspaceConfigMock,
}));

mock.module('@craft-agent/shared/agent', () => ({
  getNessyCoreSettingsViaAcp: getNessyCoreSettingsViaAcpMock,
  setNessyCoreSettingViaAcp: setNessyCoreSettingViaAcpMock,
  setNessyMcpServerViaAcp: mock(async () => ({})),
  removeNessyMcpServerViaAcp: mock(async () => ({})),
  setNessyHookViaAcp: mock(async () => ({})),
  removeNessyHookViaAcp: mock(async () => ({})),
  setNessyExtensionSettingViaAcp: mock(async () => ({})),
  getNessyPermissionSettingsViaAcp: mock(async () => ({})),
  setNessyPermissionRulesViaAcp: mock(async () => ({})),
  getNessyMemorySettingsViaAcp: getNessyMemorySettingsViaAcpMock,
  setNessyMemorySettingsViaAcp: setNessyMemorySettingsViaAcpMock,
  getNessySettingsPathViaAcp: mock(async () => ''),
  getNessyMemoryPathsViaAcp: getNessyMemoryPathsViaAcpMock,
  // [nessy-fork] desktop-mcp-management: the barrel is replaced wholesale,
  // so every named import of rpc/settings.ts must exist in the mock — bun
  // validates named exports against the mock and SyntaxErrors otherwise.
  getNessyMcpStatusViaAcp: mock(async () => ({})),
  getNessyMcpToolsViaAcp: mock(async () => ({})),
  getNessyMcpResourcesViaAcp: mock(async () => ({})),
  restartNessyMcpServerViaAcp: mock(async () => ({})),
  manageNessyMcpServerViaAcp: mock(async () => ({})),
}));

describe('settings default thinking RPC handlers', () => {
  const handlers = new Map<string, HandlerFn>();

  beforeEach(async () => {
    handlers.clear();
    getDefaultThinkingLevelMock.mockClear();
    setDefaultThinkingLevelMock.mockClear();
    mockedWorkspace = null;
    mockedWorkspaceConfig = null;
    getWorkspaceByNameOrIdMock.mockClear();
    loadWorkspaceConfigMock.mockClear();
    getNessyCoreSettingsViaAcpMock.mockClear();
    setNessyCoreSettingViaAcpMock.mockClear();
    applyGlobalPermissionModeMock.mockClear();
    getNessyMemorySettingsViaAcpMock.mockClear();
    setNessyMemorySettingsViaAcpMock.mockClear();
    getNessyMemoryPathsViaAcpMock.mockClear();

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn);
      },
      push() {},
      async invokeClient() {
        return null;
      },
    };

    const deps: HandlerDeps = {
      sessionManager: {
        applyGlobalPermissionMode: applyGlobalPermissionModeMock,
      } as unknown as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
      },
      oauthFlowStore: {
        store: () => {},
        getByState: () => null,
        remove: () => {},
        cleanup: () => {},
        dispose: () => {},
        get size() {
          return 0;
        },
      } as unknown as HandlerDeps['oauthFlowStore'],
    };

    const { registerSettingsHandlers } =
      await import('@craft-agent/server-core/handlers/rpc/settings');
    registerSettingsHandlers(server, deps);
  });

  it('returns persisted default thinking level', async () => {
    const getHandler = handlers.get(
      RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
    );
    expect(getHandler).toBeTruthy();

    const result = await getHandler!(requestContext);
    expect(result).toBe('think');
    expect(getDefaultThinkingLevelMock).toHaveBeenCalledTimes(1);
  });

  it('persists valid thinking level values', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
    );
    expect(setHandler).toBeTruthy();

    const result = await setHandler!(requestContext, 'max');
    expect(result).toEqual({ success: true });
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledWith('max');
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid thinking level values before persistence', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
    );
    expect(setHandler).toBeTruthy();

    await expect(setHandler!(requestContext, 'ultra')).rejects.toThrow(
      'Invalid thinking level',
    );
    expect(setDefaultThinkingLevelMock).not.toHaveBeenCalled();
  });

  it('returns global permission mode through Nessy ACP', async () => {
    const getHandler = handlers.get(
      RPC_CHANNELS.settings.GET_GLOBAL_PERMISSION_MODE,
    );
    expect(getHandler).toBeTruthy();

    const result = await getHandler!(requestContext);
    expect(result).toBe('allow-all');
    expect(getNessyCoreSettingsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(applyGlobalPermissionModeMock).toHaveBeenCalledWith('allow-all', {
      changedBy: 'restore',
    });
  });

  it('persists global permission mode through Nessy ACP', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_GLOBAL_PERMISSION_MODE,
    );
    expect(setHandler).toBeTruthy();

    const result = await setHandler!(requestContext, 'yolo');
    expect(result).toEqual({ success: true });
    const call = setNessyCoreSettingViaAcpMock.mock.calls[0] as unknown[];
    // [nessy-fork] desktop-pet-session-aggregation: 'yolo' is a legacy alias —
    // the handler deliberately persists the canonical Nessy approval mode
    // (parsePermissionMode('yolo') → 'allow-all' → 'auto'), matching the GET
    // test above which already expects the canonical 'allow-all'.
    expect(call.slice(1)).toEqual(['user', 'tools.approvalMode', 'auto']);
    expect(applyGlobalPermissionModeMock).toHaveBeenCalledWith('allow-all');
  });

  it('syncs global permission mode when approval mode is saved as a Nessy core setting', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_NESSY_CORE_SETTING,
    );
    expect(setHandler).toBeTruthy();

    await setHandler!(requestContext, 'user', 'tools.approvalMode', 'yolo');

    expect(applyGlobalPermissionModeMock).toHaveBeenCalledWith('allow-all');
  });

  it('uses the workspace working directory as the Nessy memory project root', async () => {
    mockedWorkspace = {
      id: 'ws-1',
      name: 'nessy-cli',
      slug: 'nessy-cli',
      rootPath: '/Users/dragon/.craft-agent/workspaces/nessy-cli',
    };
    mockedWorkspaceConfig = {
      defaults: {
        workingDirectory: '/Users/dragon/Documents/nessy-cli',
      },
    };

    const getHandler = handlers.get(RPC_CHANNELS.memory.GET_PATHS);
    expect(getHandler).toBeTruthy();

    await getHandler!(requestContext, 'ws-1');

    expect(getNessyMemoryPathsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(getNessyMemoryPathsViaAcpMock.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/Users/dragon/Documents/nessy-cli',
      processCwd: '/Users/dragon/.craft-agent/workspaces/nessy-cli',
      projectRoot: '/Users/dragon/Documents/nessy-cli',
    });
  });

  it('loads memory settings through the workspace Nessy ACP process', async () => {
    mockedWorkspace = {
      id: 'ws-1',
      name: 'nessy-cli',
      slug: 'nessy-cli',
      rootPath: '/Users/dragon/.craft-agent/workspaces/nessy-cli',
    };
    mockedWorkspaceConfig = {
      defaults: {
        workingDirectory: '/Users/dragon/Documents/nessy-cli',
      },
    };

    const getHandler = handlers.get(RPC_CHANNELS.memory.GET_SETTINGS);
    expect(getHandler).toBeTruthy();

    await getHandler!(requestContext, 'ws-1');

    expect(getNessyMemorySettingsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(getNessyMemorySettingsViaAcpMock.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/Users/dragon/Documents/nessy-cli',
      processCwd: '/Users/dragon/.craft-agent/workspaces/nessy-cli',
      projectRoot: '/Users/dragon/Documents/nessy-cli',
    });
  });

  it('saves memory settings through the workspace Nessy ACP process', async () => {
    mockedWorkspace = {
      id: 'ws-1',
      name: 'nessy-cli',
      slug: 'nessy-cli',
      rootPath: '/Users/dragon/.craft-agent/workspaces/nessy-cli',
    };
    mockedWorkspaceConfig = {
      defaults: {
        workingDirectory: '/Users/dragon/Documents/nessy-cli',
      },
    };

    const setHandler = handlers.get(RPC_CHANNELS.memory.SET_SETTINGS);
    expect(setHandler).toBeTruthy();

    const updates = { enableManagedAutoDream: true };
    await setHandler!(requestContext, updates, 'ws-1');

    expect(setNessyMemorySettingsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(setNessyMemorySettingsViaAcpMock.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/Users/dragon/Documents/nessy-cli',
      processCwd: '/Users/dragon/.craft-agent/workspaces/nessy-cli',
      projectRoot: '/Users/dragon/Documents/nessy-cli',
    });
    expect(setNessyMemorySettingsViaAcpMock.mock.calls[0]?.[1]).toBe(updates);
  });
});
