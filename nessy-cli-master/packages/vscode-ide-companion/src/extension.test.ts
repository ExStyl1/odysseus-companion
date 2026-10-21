/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import * as vscode from 'vscode';
import { activate } from './extension.js';
import { IDE_DEFINITIONS, detectIdeFromEnv } from '@nestor/nessy-cli-core';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null) => void,
      ) => callback(null),
    ),
  };
});

vi.mock('@nestor/nessy-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@nestor/nessy-cli-core')>();
  return {
    ...actual,
    detectIdeFromEnv: vi.fn(() => actual.IDE_DEFINITIONS.vscode),
  };
});

vi.mock('vscode', () => ({
  version: '1.94.0',
  env: {
    appRoot: '/Applications/Visual Studio Code.app/Contents/Resources/app',
  },
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
    })),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createTerminal: vi.fn(() => ({
      show: vi.fn(),
      sendText: vi.fn(),
    })),
    onDidChangeActiveTextEditor: vi.fn(),
    activeTextEditor: undefined,
    tabGroups: {
      all: [],
      close: vi.fn(),
    },
    showTextDocument: vi.fn(),
    showWorkspaceFolderPick: vi.fn(),
    registerWebviewPanelSerializer: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    registerWebviewViewProvider: vi.fn(() => ({
      dispose: vi.fn(),
    })),
  },
  workspace: {
    workspaceFolders: [],
    fs: {
      createDirectory: vi.fn(),
      writeFile: vi.fn(),
    },
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
    onDidCloseTextDocument: vi.fn(),
    registerTextDocumentContentProvider: vi.fn(),
    onDidChangeWorkspaceFolders: vi.fn(),
    onDidGrantWorkspaceTrust: vi.fn(),
    registerFileSystemProvider: vi.fn(() => ({
      dispose: vi.fn(),
    })),
  },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  Uri: {
    joinPath: vi.fn((_base: unknown, path: string) => ({
      path,
      fsPath: `/path/to/global-storage/${path}`,
    })),
  },
  ExtensionMode: {
    Development: 1,
    Production: 2,
  },
  EventEmitter: vi.fn(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
  extensions: {
    getExtension: vi.fn(),
  },
}));

describe('activate', () => {
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      undefined,
    );
    context = {
      subscriptions: [],
      environmentVariableCollection: {
        replace: vi.fn(),
      },
      globalState: {
        get: vi.fn(),
        update: vi.fn(),
      },
      extensionUri: {
        fsPath: '/path/to/extension',
      },
      globalStorageUri: {
        fsPath: '/path/to/global-storage',
      },
      extension: {
        packageJSON: {
          version: '1.1.0',
        },
      },
    } as unknown as vscode.ExtensionContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should show the info message on first activation', async () => {
    const showInformationMessageMock = vi
      .mocked(vscode.window.showInformationMessage)
      .mockResolvedValue(undefined as never);
    vi.mocked(context.globalState.get).mockReturnValue(undefined);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      packageJSON: { version: '1.1.0' },
    } as vscode.Extension<unknown>);
    await activate(context);
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      'Nessy CLI Companion extension successfully installed.',
    );
  });

  it('should not show the info message on subsequent activations', async () => {
    vi.mocked(context.globalState.get).mockReturnValue(true);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      packageJSON: { version: '1.1.0' },
    } as vscode.Extension<unknown>);
    await activate(context);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('should register an hourly update check and clear it on dispose', async () => {
    const timer = {} as NodeJS.Timeout;
    const setIntervalMock = vi
      .spyOn(global, 'setInterval')
      .mockReturnValue(timer);
    const clearIntervalMock = vi.spyOn(global, 'clearInterval');

    await activate(context);

    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 3600000);
    const timerDisposable = context.subscriptions.find(
      (subscription) =>
        typeof subscription === 'object' &&
        'dispose' in subscription &&
        typeof subscription.dispose === 'function',
    );
    expect(timerDisposable).toBeDefined();
    timerDisposable?.dispose();
    expect(clearIntervalMock).toHaveBeenCalledWith(timer);
  });

  it('should register a handler for onDidGrantWorkspaceTrust', async () => {
    await activate(context);
    expect(vscode.workspace.onDidGrantWorkspaceTrust).toHaveBeenCalled();
  });

  it('should register the webview view provider for the sidebar position', async () => {
    await activate(context);

    const registerCalls = vi.mocked(vscode.window.registerWebviewViewProvider)
      .mock.calls;
    expect(registerCalls).toHaveLength(1);

    const viewIds = registerCalls.map((call) => call[0]);

    expect(viewIds).toContain('nessy-cli.chatView.sidebar');
  });

  it('should launch the Nessy CLI when the user clicks the button', async () => {
    const showInformationMessageMock = vi
      .mocked(vscode.window.showInformationMessage)
      .mockResolvedValue('Run Nessy CLI' as never);
    vi.mocked(context.globalState.get).mockReturnValue(undefined);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      packageJSON: { version: '1.1.0' },
    } as vscode.Extension<unknown>);
    await activate(context);
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      'Nessy CLI Companion extension successfully installed.',
    );
  });

  describe('update notification', () => {
    beforeEach(() => {
      // Prevent the "installed" message from showing
      vi.mocked(context.globalState.get).mockReturnValue(true);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(false),
      } as unknown as vscode.WorkspaceConfiguration);
    });

    it('should show an update notification if auto update is disabled', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          version: '1.2.0',
          vsixUrl: 'https://example.com/extension-1.2.0.vsix',
        }),
      } as Response);

      const showInformationMessageMock = vi.mocked(
        vscode.window.showInformationMessage,
      );

      await activate(context);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://s3-msk.tinkoff.ru/nestor-companion/vscode/latest.json',
      );
      expect(showInformationMessageMock).toHaveBeenCalledWith(
        'A new version (1.2.0) of the Nessy CLI Companion extension is available.',
        'Update to latest version',
      );
    });

    it('should check the beta manifest if beta updates are enabled', async () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue: unknown) =>
          key === 'betaUpdates' ? true : defaultValue,
        ),
      } as unknown as vscode.WorkspaceConfiguration);
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          version: '1.2.0-beta.1',
          vsixUrl: 'https://example.com/extension-1.2.0-beta.1.vsix',
        }),
      } as Response);

      await activate(context);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://s3-msk.tinkoff.ru/nestor-companion/vscode/latest-beta.json',
      );
    });

    it('should not show an update notification if the version is the same', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          version: '1.1.0',
          vsixUrl: 'https://example.com/extension-1.1.0.vsix',
        }),
      } as Response);

      const showInformationMessageMock = vi.mocked(
        vscode.window.showInformationMessage,
      );

      await activate(context);

      expect(showInformationMessageMock).not.toHaveBeenCalled();
    });

    it.each([
      {
        ide: IDE_DEFINITIONS.cloudshell,
      },
      { ide: IDE_DEFINITIONS.firebasestudio },
    ])('does not show the notification for $ide.name', async ({ ide }) => {
      vi.mocked(detectIdeFromEnv).mockReturnValue(ide);
      vi.mocked(context.globalState.get).mockReturnValue(undefined);
      const showInformationMessageMock = vi.mocked(
        vscode.window.showInformationMessage,
      );

      await activate(context);

      expect(showInformationMessageMock).not.toHaveBeenCalled();
    });

    it('should not show an update notification if the version is older', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          version: '1.0.0',
          vsixUrl: 'https://example.com/extension-1.0.0.vsix',
        }),
      } as Response);

      const showInformationMessageMock = vi.mocked(
        vscode.window.showInformationMessage,
      );

      await activate(context);

      expect(showInformationMessageMock).not.toHaveBeenCalled();
    });

    it('should download and install the VSIX when the user clicks "Update"', async () => {
      const vsixUrl = 'https://example.com/extension-1.2.0.vsix';
      const vsixBytes = new Uint8Array([1, 2, 3]);
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: '1.2.0', vsixUrl }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => vsixBytes.buffer,
        } as Response);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
        'Update to latest version' as never,
      );
      const executeCommandMock = vi.mocked(vscode.commands.executeCommand);
      const localVsixUri = {
        path: 'nessy-cli-vscode-ide-companion-1.2.0.vsix',
        fsPath:
          '/path/to/global-storage/nessy-cli-vscode-ide-companion-1.2.0.vsix',
      };

      await activate(context);
      await new Promise(process.nextTick);

      expect(global.fetch).toHaveBeenNthCalledWith(2, vsixUrl);
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
        localVsixUri,
        vsixBytes,
      );
      expect(executeCommandMock).toHaveBeenCalledWith(
        'workbench.extensions.installExtension',
        localVsixUri,
      );
    });

    it('should install the local VSIX without prompting when auto update is enabled', async () => {
      const vsixUrl = 'https://example.com/extension-1.2.0.vsix';
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: '1.2.0', vsixUrl }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as Response);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as unknown as vscode.WorkspaceConfiguration);
      const executeCommandMock = vi.mocked(vscode.commands.executeCommand);

      await activate(context);
      await new Promise(process.nextTick);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Nessy CLI Companion 1.2.0 was installed. Restart extensions to use the new version.',
        'Restart Extensions',
      );
      expect(executeCommandMock).toHaveBeenCalledWith(
        'workbench.extensions.installExtension',
        {
          path: 'nessy-cli-vscode-ide-companion-1.2.0.vsix',
          fsPath:
            '/path/to/global-storage/nessy-cli-vscode-ide-companion-1.2.0.vsix',
        },
      );
    });

    it('should restart extension hosts when requested after installation', async () => {
      const vsixUrl = 'https://example.com/extension-1.2.0.vsix';
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: '1.2.0', vsixUrl }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as Response);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as unknown as vscode.WorkspaceConfiguration);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
        'Restart Extensions' as never,
      );

      await activate(context);
      await new Promise(process.nextTick);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.restartExtensionHost',
      );
    });

    it('should show an error if the update check fails', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await activate(context);
      await new Promise(process.nextTick);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to update Nessy CLI Companion: Failed to fetch latest extension version from S3: 500 Internal Server Error',
      );
    });

    it('should use the VS Code CLI if no extension server is available', async () => {
      const vsixUrl = 'https://example.com/extension-1.2.0.vsix';
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: '1.2.0', vsixUrl }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as Response);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as unknown as vscode.WorkspaceConfiguration);
      vi.mocked(vscode.commands.executeCommand).mockImplementation(
        (command: string) => {
          if (command === 'workbench.extensions.installExtension') {
            return Promise.reject(new Error('No Servers'));
          }
          return Promise.resolve(undefined);
        },
      );

      await activate(context);
      await new Promise(process.nextTick);

      const installArgs = [
        '--install-extension',
        '/path/to/global-storage/nessy-cli-vscode-ide-companion-1.2.0.vsix',
        '--force',
      ];
      const cliRoot = path.resolve(vscode.env.appRoot, '..', '..', 'bin');
      const expectedCommand =
        process.platform === 'darwin'
          ? {
              executable: path.join(vscode.env.appRoot, 'bin', 'code'),
              args: installArgs,
            }
          : process.platform === 'win32'
            ? {
                executable: process.env['ComSpec'] ?? 'cmd.exe',
                args: [
                  '/d',
                  '/s',
                  '/c',
                  path.join(cliRoot, 'code.cmd'),
                  ...installArgs,
                ],
              }
            : {
                executable: path.join(cliRoot, 'code'),
                args: installArgs,
              };

      expect(execFile).toHaveBeenCalledWith(
        expectedCommand.executable,
        expectedCommand.args,
        expect.any(Function),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Nessy CLI Companion 1.2.0 was installed. Restart extensions to use the new version.',
        'Restart Extensions',
      );
    });
  });
});
