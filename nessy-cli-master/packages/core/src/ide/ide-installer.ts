/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as child_process from 'node:child_process';
import * as process from 'node:process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { IDE_DEFINITIONS, type IdeInfo } from './detect-ide.js';
import { NESSY_CLI_COMPANION_EXTENSION_NAME } from './constants.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const VSCODE_VSIX_URL =
  'https://s3-msk.tinkoff.ru/nestor-companion/vscode/nessy-cli-vscode-ide-companion-latest.vsix';

function getVsCodeCommand(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? 'code.cmd' : 'code';
}

export interface IdeInstaller {
  install(): Promise<InstallResult>;
}

export interface InstallResult {
  success: boolean;
  message: string;
}

async function findVsCodeCommand(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  // 1. Check PATH first.
  const vscodeCommand = getVsCodeCommand(platform);
  try {
    if (platform === 'win32') {
      const result = child_process
        .execSync(`where.exe ${vscodeCommand}`)
        .toString()
        .trim();
      // `where.exe` can return multiple paths. Return the first one.
      const firstPath = result.split(/\r?\n/)[0];
      if (firstPath) {
        return firstPath;
      }
    } else {
      child_process.execSync(`command -v ${vscodeCommand}`, {
        stdio: 'ignore',
      });
      return vscodeCommand;
    }
  } catch {
    // Not in PATH, continue to check common locations.
  }

  // 2. Check common installation locations.
  const locations: string[] = [];
  const homeDir = os.homedir();

  if (platform === 'darwin') {
    // macOS
    locations.push(
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      path.join(homeDir, 'Library/Application Support/Code/bin/code'),
    );
  } else if (platform === 'linux') {
    // Linux
    locations.push(
      '/usr/share/code/bin/code',
      '/snap/bin/code',
      path.join(homeDir, '.local/share/code/bin/code'),
    );
  } else if (platform === 'win32') {
    // Windows
    locations.push(
      path.join(
        process.env['ProgramFiles'] || 'C:\\Program Files',
        'Microsoft VS Code',
        'bin',
        'code.cmd',
      ),
      path.join(
        homeDir,
        'AppData',
        'Local',
        'Programs',
        'Microsoft VS Code',
        'bin',
        'code.cmd',
      ),
    );
  }

  for (const location of locations) {
    if (fs.existsSync(location)) {
      return location;
    }
  }

  return null;
}

async function resolveVsixSource(source: string): Promise<{
  vsixPath: string;
  cleanup?: () => Promise<void>;
}> {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    throw new Error('VSIX source is empty.');
  }

  if (/^https?:\/\//i.test(trimmedSource)) {
    const response = await fetch(trimmedSource);
    if (!response.ok) {
      throw new Error(
        `Failed to download VSIX from ${trimmedSource}: ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'nessy-vsix-'),
    );
    const vsixPath = path.join(tempDir, 'nessy-cli-vscode-ide-companion.vsix');
    await fs.promises.writeFile(vsixPath, buffer);
    return {
      vsixPath,
      cleanup: async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  throw new Error(`Unsupported VSIX source: ${trimmedSource}`);
}

class VsCodeInstaller implements IdeInstaller {
  private vsCodeCommand: Promise<string | null>;

  constructor(
    readonly ideInfo: IdeInfo,
    readonly platform = process.platform,
  ) {
    this.vsCodeCommand = findVsCodeCommand(platform);
  }

  async install(): Promise<InstallResult> {
    const commandPath = await this.vsCodeCommand;
    if (!commandPath) {
      return {
        success: false,
        message: `${this.ideInfo.displayName} CLI not found. Please ensure 'code' is in your system's PATH. For help, see https://code.visualstudio.com/docs/configure/command-line#_code-is-not-recognized-as-an-internal-or-external-command. You can also install the '${NESSY_CLI_COMPANION_EXTENSION_NAME}' extension manually from the VS Code marketplace.`,
      };
    }

    const isWindows = process.platform === 'win32';
    const vsixSource = VSCODE_VSIX_URL;
    let cleanupTemp: (() => Promise<void>) | undefined;
    let installArgs = [
      '--install-extension',
      'nessy-cli-vscode-ide-companion',
      '--force',
    ];

    try {
      const resolved = await resolveVsixSource(vsixSource);
      cleanupTemp = resolved.cleanup;
      installArgs = ['--install-extension', resolved.vsixPath, '--force'];
    } catch (error) {
      return {
        success: false,
        message: `Failed to install ${this.ideInfo.displayName} companion extension from VSIX (${vsixSource}). ${String(error)}`,
      };
    }

    try {
      const result = child_process.spawnSync(
        isWindows ? `"${commandPath}"` : commandPath,
        installArgs,
        { stdio: 'pipe', shell: isWindows },
      );

      if (result.status !== 0) {
        throw new Error(
          `Failed to install extension: ${result.stderr?.toString()}`,
        );
      }

      return {
        success: true,
        message: `${this.ideInfo.displayName} companion extension was installed successfully.`,
      };
    } catch (_error) {
      return {
        success: false,
        message: `Failed to install ${this.ideInfo.displayName} companion extension. Please try installing '${NESSY_CLI_COMPANION_EXTENSION_NAME}' manually from the ${this.ideInfo.displayName} extension marketplace.`,
      };
    } finally {
      if (cleanupTemp) {
        await cleanupTemp();
      }
    }
  }
}

export function getIdeInstaller(
  ide: IdeInfo,
  platform = process.platform,
): IdeInstaller | null {
  switch (ide.name) {
    case IDE_DEFINITIONS.vscode.name:
    case IDE_DEFINITIONS.firebasestudio.name:
    case IDE_DEFINITIONS.vscodefork.name:
      return new VsCodeInstaller(ide, platform);
    case IDE_DEFINITIONS.intellij.name:
    case IDE_DEFINITIONS.jetbrains.name:
      return new JetBrainsInstaller(ide, platform);
    default:
      return null;
  }
}

class JetBrainsInstaller implements IdeInstaller {
  private static readonly PLUGIN_ID = 'org.nessy.intellij';
  private static readonly PLUGIN_DIR_NAME = 'nessy-intellij';
  private static readonly ZIP_FILENAME =
    'nessy-intellij-ide-companion-latest-since-233.zip';
  private static readonly S3_BASE_URL =
    process.env['NESSY_JETBRAINS_PLUGIN_S3_URL'] ||
    'https://s3-msk.tinkoff.ru/nestor-companion/release/jetbrains';
  private readonly log = createDebugLogger('JetBrainsInstaller');

  constructor(
    readonly ideInfo: IdeInfo,
    readonly platform = process.platform,
  ) {}

  async install(): Promise<InstallResult> {
    this.log.info(
      'Starting install for',
      this.ideInfo.displayName,
      `(name=${this.ideInfo.name}, platform=${this.platform})`,
    );

    // Check if plugin is already installed in the IDE plugins directory
    const alreadyInstalled = await this.isPluginInstalled();
    if (alreadyInstalled) {
      this.log.info('Plugin already installed in plugins directory, skipping');
      return {
        success: true,
        message: `The '${this.ideInfo.displayName}' companion plugin is already installed. If you're experiencing issues, try restarting your IDE.`,
      };
    }

    // Try automatic installation using JetBrains CLI installPlugins command
    this.log.info('Attempting auto-install via installPlugins CLI command');
    const autoInstallResult = await this.tryAutoInstall();
    if (autoInstallResult.success) {
      return autoInstallResult;
    }

    // Fallback: try direct ZIP download to plugins directory
    this.log.info('Auto-install failed, attempting direct ZIP download');
    const directInstallResult = await this.tryDirectInstall();
    if (directInstallResult.success) {
      return directInstallResult;
    }

    // Final fallback to manual installation instructions
    this.log.warn('All automatic methods failed, showing manual instructions');
    return this.getManualInstallInstructions();
  }

  private async tryAutoInstall(): Promise<InstallResult> {
    const ideExecutable = await this.findIdeExecutable();
    if (!ideExecutable) {
      this.log.warn('No IDE executable found in PATH or common locations');
      return { success: false, message: '' };
    }
    this.log.info('Found IDE executable:', ideExecutable);

    const repoUrl =
      process.env['NESSY_JETBRAINS_PLUGIN_REPO_URL'] ||
      '[InternalLinks48]:[InternalLinks49]';
    this.log.info('Using repo URL:', repoUrl);

    const cmd = `"${ideExecutable}" installPlugins ${JetBrainsInstaller.PLUGIN_ID} ${repoUrl}`;
    this.log.debug('Running command:', cmd);

    try {
      const output = child_process.execSync(cmd, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
        encoding: 'utf8',
      });
      this.log.debug('installPlugins stdout:', output);

      // Verify the plugin was actually installed
      const installed = await this.isPluginInstalled();
      if (installed) {
        this.log.info(
          'Plugin verified in plugins directory after installPlugins',
        );
        return {
          success: true,
          message: `The '${this.ideInfo.displayName}' companion plugin was installed successfully. Please restart your IDE.`,
        };
      }

      this.log.warn(
        'installPlugins exited 0 but plugin not found in plugins directory',
      );
      return { success: false, message: '' };
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr || '';
      this.log.error(
        'installPlugins failed:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      if (stderr) {
        this.log.error('installPlugins stderr:', stderr);
      }
      return { success: false, message: '' };
    }
  }

  private async tryDirectInstall(): Promise<InstallResult> {
    const pluginsDirs = await this.findPluginsDirs();
    if (pluginsDirs.length === 0) {
      this.log.warn('No JetBrains plugins directories found');
      return { success: false, message: '' };
    }
    this.log.info('Found plugins directories:', pluginsDirs);

    const zipUrl = `${JetBrainsInstaller.S3_BASE_URL}/${JetBrainsInstaller.ZIP_FILENAME}`;
    this.log.info('Downloading plugin ZIP from:', zipUrl);

    try {
      const response = await fetch(zipUrl);
      if (!response.ok) {
        this.log.error(
          `Failed to download plugin ZIP: ${response.status} ${response.statusText} from ${zipUrl}`,
        );
        return { success: false, message: '' };
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      this.log.debug('Downloaded ZIP size:', buffer.length, 'bytes');

      // Install to the most recent plugins directory
      const targetDir = pluginsDirs[0]!;

      // Save ZIP to temp location and extract to plugins directory
      // JetBrains expects extracted plugin directory (e.g. nessy-intellij-ide-companion/lib/*.jar)
      const tempZipPath = path.join(
        os.tmpdir(),
        `${JetBrainsInstaller.PLUGIN_DIR_NAME}.zip`,
      );
      await fs.promises.writeFile(tempZipPath, buffer);
      this.log.info('Extracting plugin ZIP to:', targetDir);

      try {
        child_process.execSync(`unzip -o "${tempZipPath}" -d "${targetDir}"`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
        });
      } finally {
        await fs.promises.unlink(tempZipPath).catch(() => {});
      }

      // Verify extraction
      const installed = await this.isPluginInstalled();
      if (!installed) {
        this.log.error(
          'Plugin ZIP extracted but plugin not found in plugins directory',
        );
        return { success: false, message: '' };
      }

      this.log.info('Plugin extracted successfully to:', targetDir);
      return {
        success: true,
        message: `The '${this.ideInfo.displayName}' companion plugin was installed to ${targetDir}. Please restart your IDE.`,
      };
    } catch (error) {
      this.log.error(
        'Direct install failed:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      return { success: false, message: '' };
    }
  }

  private async findIdeExecutable(): Promise<string | null> {
    const ideName = this.ideInfo.name;
    const executables: Record<string, string[]> = {
      intellij: [
        'idea',
        'idea.sh',
        'idea64.exe',
        '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
      ],
      jetbrains: [
        // WebStorm
        'webstorm',
        'webstorm.sh',
        'webstorm64.exe',
        '/Applications/WebStorm.app/Contents/MacOS/webstorm',
        // PyCharm
        'pycharm',
        'pycharm.sh',
        'pycharm64.exe',
        '/Applications/PyCharm.app/Contents/MacOS/pycharm',
        // GoLand
        'goland',
        'goland.sh',
        'goland64.exe',
        '/Applications/GoLand.app/Contents/MacOS/goland',
        // PhpStorm
        'phpstorm',
        'phpstorm.sh',
        'phpstorm64.exe',
        '/Applications/PhpStorm.app/Contents/MacOS/phpstorm',
        // CLion
        'clion',
        'clion.sh',
        'clion64.exe',
        '/Applications/CLion.app/Contents/MacOS/clion',
        // Rider
        'rider',
        'rider.sh',
        'rider64.exe',
        '/Applications/Rider.app/Contents/MacOS/rider',
        // DataGrip
        'datagrip',
        'datagrip.sh',
        'datagrip64.exe',
        '/Applications/DataGrip.app/Contents/MacOS/datagrip',
      ],
    };

    const possibleExecutables =
      executables[ideName] || executables['jetbrains'];
    this.log.debug(
      'Searching for IDE executable, ideName:',
      ideName,
      'candidates:',
      possibleExecutables,
    );

    // Try to find the executable in PATH
    for (const exe of possibleExecutables) {
      try {
        const cmd =
          this.platform === 'win32' ? `where.exe ${exe}` : `command -v ${exe}`;
        const result = child_process
          .execSync(cmd, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          })
          .trim();
        if (result) {
          return result;
        }
      } catch {
        // Try next executable
      }
    }

    // Check common installation locations
    for (const exe of possibleExecutables) {
      if (exe.startsWith('/Applications/') || exe.includes('Program Files')) {
        if (fs.existsSync(exe)) {
          return exe;
        }
      }
    }

    return null;
  }

  private getManualInstallInstructions(): InstallResult {
    const zipUrl = `${JetBrainsInstaller.S3_BASE_URL}/${JetBrainsInstaller.ZIP_FILENAME}`;

    let instructions = `Automatic installation is not supported for ${this.ideInfo.displayName}. Please install the 'Nessy CLI Companion' plugin manually:\n\n`;

    instructions += `**Option 1: From Disk**\n`;
    instructions += `1. Download from: ${zipUrl}\n`;
    instructions += `2. In your JetBrains IDE: Settings → Plugins → ⚙️ → Install Plugin from Disk...\n`;
    instructions += `3. Select the downloaded ZIP file\n`;
    instructions += `4. Restart the IDE\n\n`;

    // Add troubleshooting tip
    instructions += `**Troubleshooting**:\n`;
    instructions += `- Make sure the IDE executable ('idea', 'webstorm', etc.) is in your PATH\n`;
    instructions += `- Or set NESSY_JETBRAINS_PLUGIN_REPO_URL environment variable to use repository installation\n`;
    instructions += `- Run with DEBUG=1 for more details`;

    return {
      success: false,
      message: instructions,
    };
  }

  /**
   * Find JetBrains IDE plugins directories sorted by modification time (newest first).
   * JetBrains stores plugins in:
   * - macOS: ~/Library/Application Support/JetBrains/<Product><Version>/plugins/
   * - Linux: ~/.local/share/JetBrains/<Product><Version>/plugins/
   * - Windows: %APPDATA%/JetBrains/<Product><Version>/plugins/
   */
  private async findPluginsDirs(): Promise<string[]> {
    const homeDir = os.homedir();
    let jetbrainsBase: string;

    if (this.platform === 'darwin') {
      jetbrainsBase = path.join(
        homeDir,
        'Library',
        'Application Support',
        'JetBrains',
      );
    } else if (this.platform === 'win32') {
      jetbrainsBase = path.join(
        process.env['APPDATA'] || path.join(homeDir, 'AppData', 'Roaming'),
        'JetBrains',
      );
    } else {
      jetbrainsBase = path.join(homeDir, '.local', 'share', 'JetBrains');
    }
    this.log.debug('JetBrains base directory:', jetbrainsBase);

    try {
      const entries = await fs.promises.readdir(jetbrainsBase, {
        withFileTypes: true,
      });
      const allDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      this.log.debug('All directories in JetBrains base:', allDirs);

      const productDirs = allDirs.filter((name) =>
        /^(IntelliJIdea|WebStorm|PyCharm|GoLand|PhpStorm|CLion|Rider|DataGrip|RubyMine|Fleet)/i.test(
          name,
        ),
      );
      this.log.debug('Matched product directories:', productDirs);

      const pluginsDirs: Array<{ dir: string; mtime: number }> = [];
      for (const productDir of productDirs) {
        const pluginsPath = path.join(jetbrainsBase, productDir, 'plugins');
        try {
          const stat = await fs.promises.stat(pluginsPath);
          if (stat.isDirectory()) {
            pluginsDirs.push({ dir: pluginsPath, mtime: stat.mtimeMs });
          }
        } catch {
          this.log.debug('No plugins dir for:', productDir);
        }
      }

      const result = pluginsDirs
        .sort((a, b) => b.mtime - a.mtime)
        .map((p) => p.dir);
      this.log.debug('Found plugins directories:', result);
      return result;
    } catch (error) {
      this.log.warn(
        'Cannot read JetBrains base directory:',
        jetbrainsBase,
        error instanceof Error ? error.message : '',
      );
      return [];
    }
  }

  private async isPluginInstalled(): Promise<boolean> {
    const pluginsDirs = await this.findPluginsDirs();
    for (const pluginsDir of pluginsDirs) {
      try {
        const entries = await fs.promises.readdir(pluginsDir, {
          withFileTypes: true,
        });
        // Plugin must be an extracted directory (not a ZIP file)
        const match = entries.find(
          (e) => e.isDirectory() && e.name.toLowerCase().includes('nessy'),
        );
        if (match) {
          this.log.info('Plugin found in', pluginsDir, ':', match.name);
          return true;
        }
        const zipMatch = entries.find(
          (e) => e.isFile() && e.name.toLowerCase().includes('nessy'),
        );
        if (zipMatch) {
          this.log.warn(
            'Found unextracted plugin file in',
            pluginsDir,
            ':',
            zipMatch.name,
            '- not counting as installed',
          );
        }
        this.log.debug('No nessy plugin directory in', pluginsDir);
      } catch {
        // skip
      }
    }
    this.log.debug('Plugin not found in any plugins directory');
    return false;
  }
}
