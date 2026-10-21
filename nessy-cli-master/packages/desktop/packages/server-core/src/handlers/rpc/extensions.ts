// [nessy-fork] desktop-internal-extension-marketplace
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  RPC_CHANNELS,
  type ExtensionActionResult,
  type ExtensionMarketplaceInstallResult,
  type ExtensionMarketplaceItem,
  type ExtensionUpdateCheck,
} from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import {
  resolveBackendRuntimePaths,
  withElectronRunAsNodeEnv,
} from '@craft-agent/shared/agent/backend';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { createInternalMarketplaceClient } from '../../services/internal-marketplace';

const execFileAsync = promisify(execFile);

// Extension operations run through the vendored Nessy CLI subprocess
// (`nessy extensions <cmd>`), which already bundles the extension manager.
// This avoids importing @nestor/nessy-cli-core, which is NOT shipped in the
// packaged app (electron-builder excludes node_modules), exactly how the ACP
// agent and skill installs already shell out to the vendored CLI.
const EXTENSIONS_COMMAND_TIMEOUT_MS = 120_000;

interface ParsedMarketplaceInstallCommand {
  source: string;
  registryUrl?: string;
  autoUpdate: boolean;
}

interface Extension {
  id: string;
  name: string;
  displayName?: string;
  path: string;
  enabledUser: boolean;
  installMetadata?: {
    source?: string;
    pluginName?: string;
  };
}

/** Shape emitted by `nessy extensions list --json` (see CLI list-json.ts). */
interface ExtensionJsonEntry {
  name: string;
  version?: string;
  path: string;
  source?: string;
  type?: string;
  enabledUser?: boolean;
}

export function parseExtensionUpdateChecks(
  output: string,
): ExtensionUpdateCheck[] {
  if (!output.trim()) return [];

  const entries: unknown = JSON.parse(output);
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        !('name' in entry) ||
        typeof entry.name !== 'string' ||
        !('updateState' in entry) ||
        typeof entry.updateState !== 'string',
    )
  ) {
    throw new Error('Invalid extension update check response');
  }

  return entries as ExtensionUpdateCheck[];
}

const installedMarketplaceExtensionOverridesByWorkspace = new Map<
  string,
  Map<string, Set<string>>
>();

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.extensions.MARKETPLACE_LIST,
  // [nessy-fork] desktop-pet-session-aggregation: мастер (AIDT-7260) добавил
  // хендлер, но не задекларировал канал — registration-тесты строят expected
  // из этого массива и падали.
  RPC_CHANNELS.extensions.MARKETPLACE_DETAILS,
  RPC_CHANNELS.extensions.MARKETPLACE_INSTALL,
  // [nessy-fork] desktop-extension-management
  RPC_CHANNELS.extensions.UNINSTALL,
  RPC_CHANNELS.extensions.SET_ENABLED,
  RPC_CHANNELS.extensions.UPDATE,
  RPC_CHANNELS.extensions.CHECK_UPDATES,
] as const;

function normalizeIdentifier(identifier: string): string {
  return identifier
    .trim()
    .replace(/^[@/]+/, '')
    .toLowerCase();
}

function rememberInstalledMarketplaceExtension(
  workspaceId: string,
  ...identifiers: Array<string | undefined>
): void {
  const installed =
    installedMarketplaceExtensionOverridesByWorkspace.get(workspaceId);
  const next = installed ?? new Map<string, Set<string>>();
  const normalizedIdentifiers = new Set(
    identifiers
      .filter((identifier): identifier is string => Boolean(identifier))
      .map(normalizeIdentifier),
  );
  if (normalizedIdentifiers.size === 0) return;
  for (const identifier of normalizedIdentifiers) {
    const existing = next.get(identifier);
    if (existing) {
      existing.forEach((value) => normalizedIdentifiers.add(value));
    }
  }
  for (const identifier of normalizedIdentifiers) {
    next.set(identifier, normalizedIdentifiers);
  }
  installedMarketplaceExtensionOverridesByWorkspace.set(workspaceId, next);
}

// [nessy-fork] desktop-extension-management
// Drops an extension from the optimistic "installed" override cache after an
// uninstall, so the marketplace item flips back to "Install" without waiting
// for a full reload. Expands to every identifier grouped with the given ones.
function forgetInstalledMarketplaceExtension(
  workspaceId: string,
  ...identifiers: Array<string | undefined>
): void {
  const installed =
    installedMarketplaceExtensionOverridesByWorkspace.get(workspaceId);
  if (!installed) return;
  const targets = new Set(
    identifiers
      .filter((identifier): identifier is string => Boolean(identifier))
      .map(normalizeIdentifier),
  );
  if (targets.size === 0) return;
  for (const identifier of [...targets]) {
    installed.get(identifier)?.forEach((value) => targets.add(value));
  }
  for (const identifier of targets) {
    installed.delete(identifier);
  }
  if (installed.size === 0) {
    installedMarketplaceExtensionOverridesByWorkspace.delete(workspaceId);
  }
}

// [nessy-fork] desktop-extension-management
// Management actions operate on the global (~/.nessy) extension store, so a
// concrete workspace isn't required — the Settings → Extensions tab has none.
// When a workspace is known we run the CLI from its root (matching install);
// otherwise the user's home directory is a safe cwd for global operations.
function resolveManagementCwd(
  workspaceId?: string,
  workingDirectory?: string,
): string {
  if (workingDirectory) return workingDirectory;
  const workspace = workspaceId
    ? getWorkspaceByNameOrId(workspaceId)
    : undefined;
  return workspace?.rootPath ?? homedir();
}

export function parseMarketplaceInstallCommand(
  command: string,
): ParsedMarketplaceInstallCommand {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (
    parts.length < 4 ||
    parts[0] !== 'nessy' ||
    parts[1] !== 'extensions' ||
    parts[2] !== 'install'
  ) {
    throw new Error('Unsupported marketplace extension install command');
  }

  const source = parts[3];
  if (!source || source.startsWith('-')) {
    throw new Error('Marketplace extension install command is missing source');
  }

  let registryUrl: string | undefined;
  let autoUpdate = false;
  for (let index = 4; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--auto-update') {
      autoUpdate = true;
      continue;
    }
    if (part.startsWith('--registry=')) {
      registryUrl = part.slice('--registry='.length);
      if (!registryUrl) {
        throw new Error('Marketplace extension registry URL is empty');
      }
      continue;
    }
    if (part === '--registry') {
      const next = parts[index + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Marketplace extension registry URL is missing');
      }
      registryUrl = next;
      index += 1;
      continue;
    }
    throw new Error('Unsupported marketplace extension install option');
  }

  return { source, registryUrl, autoUpdate };
}

function buildExtensionsCliCommand(
  deps: HandlerDeps,
  args: string[],
): { command: string; args: string[] } {
  const { nessyCliPath, nodeRuntimePath } = resolveBackendRuntimePaths({
    appRootPath: deps.platform.appRootPath,
    resourcesPath: deps.platform.resourcesPath,
    isPackaged: deps.platform.isPackaged,
  });
  if (!nessyCliPath) {
    throw new Error('Nessy CLI not found; cannot manage extensions.');
  }
  const cliArgs = ['extensions', ...args];
  // A .js entry (vendored bundle / dev checkout) must run via the Node runtime;
  // a native binary entry is executed directly.
  if (nessyCliPath.endsWith('.js')) {
    const nodePath = nodeRuntimePath || process.execPath;
    return { command: nodePath, args: [nessyCliPath, ...cliArgs] };
  }
  return { command: nessyCliPath, args: cliArgs };
}

async function runExtensionsCli(
  deps: HandlerDeps,
  args: string[],
  cwd: string,
): Promise<string> {
  const { command, args: spawnArgs } = buildExtensionsCliCommand(deps, args);
  // In the packaged app the CLI command is the Electron binary (process.execPath)
  // plus a .js entry. Without ELECTRON_RUN_AS_NODE the binary launches a second
  // GUI instance that immediately quits on the single-instance lock, so the CLI
  // never runs and nothing is written to ~/.nessy. Mirror the ACP agent's spawn
  // env so the binary re-enters as Node. No-op for real node/bun commands (dev).
  const env = withElectronRunAsNodeEnv({ ...process.env }, command, spawnArgs);
  try {
    const { stdout } = await execFileAsync(command, spawnArgs, {
      cwd,
      env,
      timeout: EXTENSIONS_COMMAND_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '').trim()
        : '';
    const message =
      stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(message);
  }
}

async function listInstalledExtensions(
  deps: HandlerDeps,
  cwd: string,
): Promise<Extension[]> {
  const stdout = await runExtensionsCli(deps, ['list', '--json'], cwd);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return (entries as ExtensionJsonEntry[]).map((entry) => ({
    id: entry.name,
    name: entry.name,
    path: entry.path,
    enabledUser: entry.enabledUser ?? true,
    installMetadata: entry.source ? { source: entry.source } : undefined,
  }));
}

function matchesInstalledExtension(
  extension: Extension,
  marketplaceExtension: Omit<ExtensionMarketplaceItem, 'installed'>,
): boolean {
  const marketplaceIds = [
    marketplaceExtension.id,
    marketplaceExtension.name,
    marketplaceExtension.sourceUrl,
  ];
  if (marketplaceExtension.installCommand) {
    try {
      marketplaceIds.push(
        parseMarketplaceInstallCommand(marketplaceExtension.installCommand)
          .source,
      );
    } catch {
      // Invalid install commands are rejected during install; list rendering should continue.
    }
  }
  const normalizedMarketplaceIds = marketplaceIds.map(normalizeIdentifier);

  const installedIds = [
    extension.id,
    extension.name,
    extension.displayName,
    extension.path,
    extension.installMetadata?.source,
    extension.installMetadata?.pluginName,
  ]
    .filter((identifier): identifier is string => Boolean(identifier))
    .map(normalizeIdentifier);

  return normalizedMarketplaceIds.some((identifier) =>
    installedIds.includes(identifier),
  );
}

async function listMarketplaceExtensions(
  deps: HandlerDeps,
  workspaceId: string,
  workingDirectory?: string,
  page?: number,
  pageSize?: number,
  query?: string,
): Promise<{ items: ExtensionMarketplaceItem[]; total: number }> {
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) return { items: [], total: 0 };

  const marketplace = createInternalMarketplaceClient({
    fetch: deps.platform.fetch,
  });
  const result = await marketplace.listExtensions({ page, pageSize, query });
  const installedExtensions = await listInstalledExtensions(
    deps,
    workingDirectory ?? workspace.rootPath,
  );
  const installedOverrides =
    installedMarketplaceExtensionOverridesByWorkspace.get(workspaceId);

  const items = result.items.map((extension) => {
    const installedExtension = installedExtensions.find((candidate) =>
      matchesInstalledExtension(candidate, extension),
    );
    const installed =
      Boolean(installedExtension) ||
      Boolean(
        installedOverrides?.has(normalizeIdentifier(extension.id)) ||
        installedOverrides?.has(normalizeIdentifier(extension.name)) ||
        installedOverrides?.has(normalizeIdentifier(extension.sourceUrl)),
      );
    return {
      ...extension,
      installed,
      installedExtensionName: installedExtension?.name,
      enabled: installedExtension?.enabledUser ?? installed,
    };
  });
  return { items, total: result.total };
}

export function registerExtensionsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  server.handle(
    RPC_CHANNELS.extensions.MARKETPLACE_LIST,
    async (
      _ctx,
      workspaceId: string,
      workingDirectory?: string,
      page?: number,
      pageSize?: number,
      query?: string,
    ) =>
      listMarketplaceExtensions(
        deps,
        workspaceId,
        workingDirectory,
        page,
        pageSize,
        query,
      ),
  );

  server.handle(
    RPC_CHANNELS.extensions.MARKETPLACE_DETAILS,
    async (
      _ctx,
      workspaceId: string,
      extensionId: string,
      workingDirectory?: string,
    ) => {
      const marketplace = createInternalMarketplaceClient({
        fetch: deps.platform.fetch,
      });
      return marketplace.getExtension(extensionId);
    },
  );

  server.handle(
    RPC_CHANNELS.extensions.MARKETPLACE_INSTALL,
    async (
      _ctx,
      workspaceId: string,
      extensionId: string,
      workingDirectory?: string,
    ): Promise<ExtensionMarketplaceInstallResult> => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) throw new Error('Workspace not found');

      const marketplace = createInternalMarketplaceClient({
        fetch: deps.platform.fetch,
      });

      // Get extension details (note: details endpoint doesn't return install.command)
      const marketplaceExtension = await marketplace.getExtension(extensionId);

      // Get installCommand from list endpoint (it has the command)
      const listResult = await marketplace.listExtensions({ pageSize: 100 });
      const listExtension = listResult.items.find(
        (ext) => ext.id === extensionId,
      );
      const installCommand =
        listExtension?.installCommand || marketplaceExtension.installCommand;

      if (!installCommand) {
        throw new Error(
          `Extension "${marketplaceExtension.name}" does not have an install command`,
        );
      }

      const parsedCommand = parseMarketplaceInstallCommand(installCommand);

      const workspaceDir = workingDirectory ?? workspace.rootPath;

      // Snapshot installed extensions so the newly installed one can be
      // identified after the CLI install completes.
      const before = await listInstalledExtensions(deps, workspaceDir);
      const beforeNames = new Set(before.map((ext) => ext.name));

      const installArgs = ['install', parsedCommand.source];
      if (parsedCommand.registryUrl) {
        // The CLI validates that --registry is only used with npm sources.
        installArgs.push('--registry', parsedCommand.registryUrl);
      }
      if (parsedCommand.autoUpdate) {
        installArgs.push('--auto-update');
      }
      // Desktop installs are pre-approved by the marketplace UI, so acknowledge
      // the security prompt non-interactively.
      installArgs.push('--consent');
      await runExtensionsCli(deps, installArgs, workspaceDir);

      const after = await listInstalledExtensions(deps, workspaceDir);
      const installedExtension =
        after.find((ext) => !beforeNames.has(ext.name)) ??
        after.find(
          (ext) =>
            normalizeIdentifier(ext.installMetadata?.source ?? '') ===
            normalizeIdentifier(parsedCommand.source),
        );
      const installedName =
        installedExtension?.name ?? marketplaceExtension.name;

      rememberInstalledMarketplaceExtension(
        workspaceId,
        marketplaceExtension.id,
        marketplaceExtension.name,
        marketplaceExtension.sourceUrl,
        parsedCommand.source,
        installedExtension?.id,
        installedName,
      );
      deps.platform.logger?.info(
        `Installed marketplace extension: ${marketplaceExtension.name}`,
      );

      return {
        id: marketplaceExtension.id,
        name: installedName,
        installedPath: installedExtension?.path ?? '',
        source: 'nessy-extension-manager',
      };
    },
  );

  // [nessy-fork] desktop-extension-management
  // The management actions below all shell out to the vendored CLI through the
  // same `runExtensionsCli` path as install/list. `runExtensionsCli` throws with
  // the CLI stderr on non-zero exit, so failures propagate to the renderer's
  // try/catch (mirroring the install handler).
  server.handle(
    RPC_CHANNELS.extensions.UNINSTALL,
    async (
      _ctx,
      workspaceId: string | undefined,
      name: string,
      workingDirectory?: string,
    ): Promise<ExtensionActionResult> => {
      const cwd = resolveManagementCwd(workspaceId, workingDirectory);
      const stdout = await runExtensionsCli(deps, ['uninstall', name], cwd);
      if (workspaceId) forgetInstalledMarketplaceExtension(workspaceId, name);
      deps.platform.logger?.info(`Uninstalled extension: ${name}`);
      return { name, ok: true, message: stdout.trim() || undefined };
    },
  );

  server.handle(
    RPC_CHANNELS.extensions.SET_ENABLED,
    async (
      _ctx,
      workspaceId: string | undefined,
      name: string,
      enabled: boolean,
      scope?: 'user' | 'workspace',
      workingDirectory?: string,
    ): Promise<ExtensionActionResult> => {
      const cwd = resolveManagementCwd(workspaceId, workingDirectory);
      const stdout = await runExtensionsCli(
        deps,
        [enabled ? 'enable' : 'disable', name, '--scope', scope ?? 'user'],
        cwd,
      );
      return { name, ok: true, message: stdout.trim() || undefined };
    },
  );

  server.handle(
    RPC_CHANNELS.extensions.UPDATE,
    async (
      _ctx,
      workspaceId: string | undefined,
      name: string,
      workingDirectory?: string,
    ): Promise<ExtensionActionResult> => {
      const cwd = resolveManagementCwd(workspaceId, workingDirectory);
      const stdout = await runExtensionsCli(deps, ['update', name], cwd);
      return { name, ok: true, message: stdout.trim() || undefined };
    },
  );

  server.handle(
    RPC_CHANNELS.extensions.CHECK_UPDATES,
    async (
      _ctx,
      workspaceId: string | undefined,
      workingDirectory?: string,
    ): Promise<ExtensionUpdateCheck[]> => {
      const cwd = resolveManagementCwd(workspaceId, workingDirectory);
      const stdout = await runExtensionsCli(
        deps,
        ['check-updates', '--json'],
        cwd,
      );
      return parseExtensionUpdateChecks(stdout);
    },
  );
}
