/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// [nessy-fork] extensions-check-updates
import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  checkForExtensionUpdate,
  type ExtensionManager,
} from '@nestor/nessy-cli-core';
import { ExtensionUpdateState } from '../../ui/state/extensions.js';
import { getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

export interface ExtensionUpdateCheckEntry {
  name: string;
  updateState: ExtensionUpdateState;
}

async function collectUpdateStates(
  extensionManager: ExtensionManager,
  name?: string,
): Promise<ExtensionUpdateCheckEntry[]> {
  const extensions = extensionManager.getLoadedExtensions() ?? [];
  const targets = name
    ? extensions.filter((extension) => extension.name === name)
    : extensions;
  if (name && targets.length === 0) {
    throw new Error(t('Extension "{{name}}" not found.', { name }));
  }

  const entries: ExtensionUpdateCheckEntry[] = [];
  for (const extension of targets) {
    let updateState: ExtensionUpdateState;
    if (!extension.installMetadata) {
      // Extensions without install metadata (e.g. bundled) can't be updated.
      updateState = ExtensionUpdateState.NOT_UPDATABLE;
    } else {
      try {
        updateState = await checkForExtensionUpdate(
          extension,
          extensionManager,
        );
      } catch {
        // A single failing check (network, missing release, …) shouldn't abort
        // the whole batch — surface it as ERROR for that extension instead.
        updateState = ExtensionUpdateState.ERROR;
      }
    }
    entries.push({ name: extension.name, updateState });
  }
  return entries;
}

export async function handleCheckUpdates(args: {
  name?: string;
  json?: boolean;
}) {
  try {
    const extensionManager = await getExtensionManager();
    const entries = await collectUpdateStates(extensionManager, args.name);
    if (args.json) {
      writeStdoutLine(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      writeStdoutLine(t('No extensions installed.'));
      return;
    }
    writeStdoutLine(
      entries.map((entry) => `${entry.name}: ${entry.updateState}`).join('\n'),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export const checkUpdatesCommand: CommandModule = {
  command: 'check-updates [<name>]',
  describe: t(
    'Checks installed extensions for available updates without applying them.',
  ),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('The name of the extension to check.'),
        type: 'string',
      })
      .option('json', { type: 'boolean', default: false, hidden: true }),
  handler: async (argv) => {
    await handleCheckUpdates({
      name: argv['name'] as string | undefined,
      json: argv['json'] as boolean | undefined,
    });
  },
};
