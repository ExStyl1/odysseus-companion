/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { IDEServer } from './ide-server.js';
import semver from 'semver';
import { DiffContentProvider, DiffManager } from './diff-manager.js';
import { createLogger } from './utils/logger.js';
import {
  detectIdeFromEnv,
  IDE_DEFINITIONS,
  type IdeInfo,
} from '@nestor/nessy-cli-core';
import { WebViewProvider } from './webview/providers/WebViewProvider.js';
import { ChatProviderRegistry } from './webview/providers/ChatProviderRegistry.js';
import { registerChatViewProviders } from './webview/providers/chatViewRegistration.js';
import { registerNewCommands } from './commands/index.js';
import { ReadonlyFileSystemProvider } from './services/readonlyFileSystemProvider.js';
import { isWindows } from './utils/platform.js';

// Keep the dormant daemon IDE adapter on the VSIX bundle path without wiring it
// into the active extension flow yet.
export { createSdkDaemonSessionFactory as __daemonIdeSessionFactoryForBundle } from './services/daemonIdeConnection.js';

// [nessy-fork] vscode-internal-companion
const UPDATE_MANIFEST_URL =
  'https://s3-msk.tinkoff.ru/nestor-companion/vscode/latest.json';
const BETA_UPDATE_MANIFEST_URL =
  'https://s3-msk.tinkoff.ru/nestor-companion/vscode/latest-beta.json';
const INFO_MESSAGE_SHOWN_KEY = 'nessyCodeInfoMessageShown';
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const execFileAsync = promisify(execFile);
export const DIFF_SCHEME = 'nessy-diff';

interface UpdateManifest {
  version: string;
  vsixUrl: string;
}

/**
 * IDE environments where the installation greeting is hidden.  In these
 * environments we either are pre-installed and the installation message is
 * confusing or we just want to be quiet.
 */
const HIDE_INSTALLATION_GREETING_IDES: ReadonlySet<IdeInfo['name']> = new Set([
  IDE_DEFINITIONS.firebasestudio.name,
  IDE_DEFINITIONS.cloudshell.name,
]);

let ideServer: IDEServer;
let logger: vscode.OutputChannel;
let chatProviderRegistry: ChatProviderRegistry<WebViewProvider> | null = null;

let log: (message: string) => void = () => {};

function getVsCodeCliCommand(vsixPath: string): {
  executable: string;
  args: string[];
} {
  const installArgs = ['--install-extension', vsixPath, '--force'];
  if (process.platform === 'darwin') {
    return {
      executable: path.join(vscode.env.appRoot, 'bin', 'code'),
      args: installArgs,
    };
  }

  const cliRoot = path.resolve(vscode.env.appRoot, '..', '..', 'bin');
  if (process.platform === 'win32') {
    return {
      executable: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', path.join(cliRoot, 'code.cmd'), ...installArgs],
    };
  }

  return {
    executable: path.join(cliRoot, 'code'),
    args: installArgs,
  };
}

async function installUpdate(
  context: vscode.ExtensionContext,
  manifest: UpdateManifest,
) {
  let response: Response;
  try {
    response = await fetch(manifest.vsixUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`VSIX download failed: ${message}`);
  }
  if (!response.ok) {
    throw new Error(
      `VSIX download failed: ${response.status} ${response.statusText}`,
    );
  }

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const vsixUri = vscode.Uri.joinPath(
    context.globalStorageUri,
    `nessy-cli-vscode-ide-companion-${manifest.version}.vsix`,
  );
  await vscode.workspace.fs.writeFile(
    vsixUri,
    new Uint8Array(await response.arrayBuffer()),
  );
  try {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vsixUri,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'No Servers') {
      throw new Error(`VSIX installation failed: ${message}`);
    }

    try {
      const cliCommand = getVsCodeCliCommand(vsixUri.fsPath);
      await execFileAsync(cliCommand.executable, cliCommand.args);
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(`VSIX CLI installation failed: ${fallbackMessage}`);
    }
  }

  const selection = await vscode.window.showInformationMessage(
    `Nessy CLI Companion ${manifest.version} was installed. Restart extensions to use the new version.`,
    'Restart Extensions',
  );
  if (selection === 'Restart Extensions') {
    await vscode.commands.executeCommand(
      'workbench.action.restartExtensionHost',
    );
  }
}

async function checkForUpdates(
  context: vscode.ExtensionContext,
  log: (message: string) => void,
) {
  try {
    const currentVersion = context.extension.packageJSON.version;
    const configuration = vscode.workspace.getConfiguration('nessy-cli');
    const betaUpdates = configuration.get<boolean>('betaUpdates', false);
    const manifestUrl = betaUpdates
      ? BETA_UPDATE_MANIFEST_URL
      : UPDATE_MANIFEST_URL;
    const response = await fetch(manifestUrl);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch latest extension version from S3: ${response.status} ${response.statusText}`,
      );
    }

    const manifest = (await response.json()) as UpdateManifest;

    if (semver.gt(manifest.version, currentVersion)) {
      const autoUpdate = configuration.get<boolean>('autoUpdate', true);

      if (autoUpdate) {
        await installUpdate(context, manifest);
        return;
      }

      const selection = await vscode.window.showInformationMessage(
        `A new version (${manifest.version}) of the Nessy CLI Companion extension is available.`,
        'Update to latest version',
      );
      if (selection === 'Update to latest version') {
        await installUpdate(context, manifest);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error checking for extension updates: ${message}`);
    await vscode.window.showErrorMessage(
      `Failed to update Nessy CLI Companion: ${message}`,
    );
  }
}

export async function activate(context: vscode.ExtensionContext) {
  logger = vscode.window.createOutputChannel('Nessy CLI Companion');
  log = createLogger(context, logger);
  log('Extension activated');

  let updateCheckRunning = false;
  const runUpdateCheck = async () => {
    if (updateCheckRunning) {
      return;
    }
    updateCheckRunning = true;
    try {
      await checkForUpdates(context, log);
    } finally {
      updateCheckRunning = false;
    }
  };
  void runUpdateCheck();
  const updateCheckTimer = setInterval(() => {
    void runUpdateCheck();
  }, UPDATE_CHECK_INTERVAL_MS);
  context.subscriptions.push({
    dispose: () => clearInterval(updateCheckTimer),
  });

  // Create and register readonly file system provider
  // The provider registers itself as a singleton in the constructor
  const readonlyProvider = new ReadonlyFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      ReadonlyFileSystemProvider.getScheme(),
      readonlyProvider,
      { isCaseSensitive: true, isReadonly: true },
    ),
    readonlyProvider,
  );
  log('Readonly file system provider registered');

  chatProviderRegistry = new ChatProviderRegistry(
    () => new WebViewProvider(context, context.extensionUri),
  );

  const diffContentProvider = new DiffContentProvider();
  const diffManager = new DiffManager(
    log,
    diffContentProvider,
    // Delay when any chat surface has a pending permission drawer
    () =>
      chatProviderRegistry
        ?.getPermissionAwareProviders()
        .some((p) => p.hasPendingPermission()) ?? false,
    // Suppress diffs when active mode is auto or yolo in any chat surface
    () => {
      const providers =
        chatProviderRegistry
          ?.getPermissionAwareProviders()
          .filter((p) => typeof p.shouldSuppressDiff === 'function') ?? [];
      if (providers.length === 0) {
        return false;
      }
      return providers.every((p) => p.shouldSuppressDiff());
    },
  );

  // Helper function to create a new WebView provider instance
  const createWebViewProvider = (): WebViewProvider =>
    chatProviderRegistry!.createEditorProvider();

  const createViewProvider = (): WebViewProvider =>
    chatProviderRegistry!.createViewProvider();

  registerChatViewProviders({
    context,
    createViewProvider,
  });

  // Register WebView panel serializer for persistence across reloads
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('nessyCode.chat', {
      async deserializeWebviewPanel(
        webviewPanel: vscode.WebviewPanel,
        state: unknown,
      ) {
        console.log(
          '[Extension] Deserializing WebView panel with state:',
          state,
        );

        // Create a new provider for the restored panel
        const provider = createWebViewProvider();
        console.log('[Extension] Provider created for deserialization');

        // Restore state if available BEFORE restoring the panel
        if (state && typeof state === 'object') {
          console.log('[Extension] Restoring state:', state);
          provider.restoreState(
            state as {
              conversationId: string | null;
              agentInitialized: boolean;
            },
          );
        } else {
          console.log('[Extension] No state to restore or invalid state');
        }

        await provider.restorePanel(webviewPanel);
        console.log('[Extension] Panel restore completed');

        log('WebView panel restored from serialization');
      },
    }),
  );

  // Register newly added commands via commands module
  registerNewCommands(
    context,
    log,
    diffManager,
    () => chatProviderRegistry?.getEditorProviders() ?? [],
    createWebViewProvider,
    logger,
  );

  // Register copy commands for webview context menu
  // Only send to the first provider with an active webview (the one the user right-clicked)
  const sendCopyToActive = (action: string) => {
    for (const provider of chatProviderRegistry?.getPermissionAwareProviders() ??
      []) {
      if (provider.sendCopyCommand(action)) {
        break;
      }
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('nessy-cli.copyMessage', () =>
      sendCopyToActive('copyMessage'),
    ),
    vscode.commands.registerCommand('nessy-cli.copyAllMessages', () =>
      sendCopyToActive('copyAllMessages'),
    ),
    vscode.commands.registerCommand('nessy-cli.copyLastReply', () =>
      sendCopyToActive('copyLastReply'),
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === DIFF_SCHEME) {
        diffManager.cancelDiff(doc.uri);
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      diffContentProvider,
    ),
    (vscode.commands.registerCommand(
      'nessy.diff.accept',
      (uri?: vscode.Uri) => {
        const docUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (docUri && docUri.scheme === DIFF_SCHEME) {
          diffManager.acceptDiff(docUri);
        }
        // If any chat surface is requesting permission, actively select allow (prefer once)
        try {
          for (const provider of chatProviderRegistry?.getPermissionAwareProviders() ??
            []) {
            if (provider?.hasPendingPermission()) {
              provider.respondToPendingPermission('allow');
            }
          }
        } catch (err) {
          console.warn('[Extension] Auto-allow on diff.accept failed:', err);
        }
        console.log('[Extension] Diff accepted');
      },
    ),
    vscode.commands.registerCommand('nessy.diff.cancel', (uri?: vscode.Uri) => {
      const docUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (docUri && docUri.scheme === DIFF_SCHEME) {
        diffManager.cancelDiff(docUri);
      }
      // If any chat surface is requesting permission, actively select reject/cancel
      try {
        for (const provider of chatProviderRegistry?.getPermissionAwareProviders() ??
          []) {
          if (provider?.hasPendingPermission()) {
            provider.respondToPendingPermission('cancel');
          }
        }
      } catch (err) {
        console.warn('[Extension] Auto-reject on diff.cancel failed:', err);
      }
      console.log('[Extension] Diff cancelled');
    })),
    vscode.commands.registerCommand('nessy.diff.closeAll', async () => {
      try {
        await diffManager.closeAll();
      } catch (err) {
        console.warn('[Extension] nessy.diff.closeAll failed:', err);
      }
    }),
    vscode.commands.registerCommand('nessy.diff.suppressBriefly', async () => {
      try {
        diffManager.suppressFor(1200);
      } catch (err) {
        console.warn('[Extension] nessy.diff.suppressBriefly failed:', err);
      }
    }),
  );

  ideServer = new IDEServer(log, diffManager);
  try {
    await ideServer.start(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to start IDE server: ${message}`);
  }

  const infoMessageEnabled = !HIDE_INSTALLATION_GREETING_IDES.has(
    detectIdeFromEnv().name,
  );

  if (!context.globalState.get(INFO_MESSAGE_SHOWN_KEY) && infoMessageEnabled) {
    void vscode.window.showInformationMessage(
      'Nessy CLI Companion extension successfully installed.',
    );
    context.globalState.update(INFO_MESSAGE_SHOWN_KEY, true);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ideServer.syncEnvVars();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      ideServer.syncEnvVars();
    }),
    vscode.commands.registerCommand(
      'nessy-cli.runNessyCLI',
      async (
        location?:
          | vscode.TerminalLocation
          | vscode.TerminalEditorLocationOptions,
      ) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          vscode.window.showInformationMessage(
            'No folder open. Please open a folder to run Nessy CLI.',
          );
          return;
        }

        let selectedFolder: vscode.WorkspaceFolder | undefined;
        if (workspaceFolders.length === 1) {
          selectedFolder = workspaceFolders[0];
        } else {
          selectedFolder = await vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Select a folder to run Nessy CLI in',
          });
        }

        if (selectedFolder) {
          const cliEntry = vscode.Uri.joinPath(
            context.extensionUri,
            'dist',
            'nessy-cli',
            'cli.js',
          ).fsPath;
          const execPath = process.execPath;

          const terminalOptions: vscode.TerminalOptions = {
            name: `Nessy CLI (${selectedFolder.name})`,
            cwd: selectedFolder.uri.fsPath,
            location,
          };

          let nessyCmd: string;

          if (isWindows) {
            // On Windows, try multiple strategies to find a Node.js runtime:
            // 1. Check if VSCode ships a standalone node.exe alongside Code.exe
            // 2. Check VSCode's internal Node.js in resources directory
            // 3. Fall back to using Code.exe with ELECTRON_RUN_AS_NODE=1
            const quoteCmd = (s: string) => `"${s.replace(/"/g, '""')}"`;
            const cliQuoted = quoteCmd(cliEntry);
            // TODO: @yiliang114, temporarily run through node, and later hope to decouple from the local node
            nessyCmd = `node ${cliQuoted}`;
            terminalOptions.shellPath = process.env.ComSpec;
          } else {
            // macOS/Linux: All VSCode-like IDEs (VSCode, Cursor, Windsurf, etc.)
            // are Electron-based, so we always need ELECTRON_RUN_AS_NODE=1
            // to run Node.js scripts using the IDE's bundled runtime.
            const quotePosix = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
            const baseCmd = `${quotePosix(execPath)} ${quotePosix(cliEntry)}`;
            nessyCmd = `ELECTRON_RUN_AS_NODE=1 ${baseCmd}`;
          }

          const terminal = vscode.window.createTerminal(terminalOptions);
          terminal.show();
          terminal.sendText(nessyCmd);
        }
      },
    ),
    vscode.commands.registerCommand('nessy-cli.showNotices', async () => {
      const noticePath = vscode.Uri.joinPath(
        context.extensionUri,
        'NOTICES.txt',
      );
      await vscode.window.showTextDocument(noticePath);
    }),
  );
}

export async function deactivate(): Promise<void> {
  log('Extension deactivated');
  try {
    if (ideServer) {
      await ideServer.stop();
    }
    chatProviderRegistry?.disposeAll();
    chatProviderRegistry = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to stop IDE server during deactivation: ${message}`);
  } finally {
    if (logger) {
      logger.dispose();
    }
  }
}
