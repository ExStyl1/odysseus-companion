import * as os from 'node:os';
import type { Extension, ExtensionManager } from '@nestor/nessy-cli-core';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getExtensionManager } from './utils.js';

export interface ExtensionJsonEntry {
  name: string;
  version: string;
  path: string;
  source?: string;
  type?: string;
  releaseTag?: string;
  enabledUser: boolean;
  enabledWorkspace: boolean;
  skills: string[];
  mcpServers: Record<string, unknown>;
}

export function extensionToJsonEntry(
  extension: Extension,
  extensionManager: ExtensionManager,
  workspaceDir: string,
): ExtensionJsonEntry {
  return {
    name: extension.name,
    version: extension.version,
    path: extension.path,
    ...(extension.installMetadata?.source && {
      source: extension.installMetadata.source,
    }),
    ...(extension.installMetadata?.type && {
      type: extension.installMetadata.type,
    }),
    ...(extension.installMetadata?.releaseTag && {
      releaseTag: extension.installMetadata.releaseTag,
    }),
    enabledUser: extensionManager.isEnabled(extension.name, os.homedir()),
    enabledWorkspace: extensionManager.isEnabled(extension.name, workspaceDir),
    skills: (extension.skills ?? []).map((skill) => skill.name),
    mcpServers: extension.mcpServers ?? {},
  };
}

export async function handleListJson(): Promise<void> {
  try {
    const extensionManager = await getExtensionManager();
    const extensions = extensionManager.getLoadedExtensions() ?? [];
    const entries = extensions.map((extension) =>
      extensionToJsonEntry(extension, extensionManager, process.cwd()),
    );
    writeStdoutLine(JSON.stringify(entries, null, 2));
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}
