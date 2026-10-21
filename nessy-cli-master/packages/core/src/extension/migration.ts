/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Extension, ExtensionManager } from '../index.js';

const LEGACY_EXTENSION_NAME = 'nessy-default-extension';
const LEGACY_GITLAB_URL =
  'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions';
const NEW_NPM_SOURCE = '@nestor/nessy-cli-extensions';

// [nessy-fork] auto-update-migration
function isDefaultNpmExtension(extension: Extension): boolean {
  return (
    extension.installMetadata?.type === 'npm' &&
    extension.installMetadata.source.toLowerCase().includes(NEW_NPM_SOURCE)
  );
}

/**
 * Checks if a legacy GitLab extension is installed
 * Legacy = installed from GitLab (gitlab-git type), not npm
 */
export function isLegacyExtensionInstalled(extensions: Extension[]): boolean {
  return extensions.some((ext) => {
    // Check for gitlab-git type with T-Bank URL
    const isGitLabType = ext.installMetadata?.type === 'gitlab-git';
    const isGitLabSource = ext.installMetadata?.source?.includes(
      'gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
    );

    // Also check for old name with gitlab type (fallback)
    const isLegacyName = ext.name.toLowerCase() === 'nessy-default-extension';

    return (isGitLabType && isGitLabSource) || (isLegacyName && isGitLabType);
  });
}

/**
 * Checks if the new npm extension is installed
 */
export function isNewExtensionInstalled(extensions: Extension[]): boolean {
  return extensions.some(isDefaultNpmExtension);
}

/**
 * Migrates a legacy GitLab extension to the new npm package
 *
 * This function:
 * 1. Uninstalls the old GitLab extension
 * 2. Installs the new npm extension
 * 3. Preserves user settings and configurations
 *
 * @param extensionManager - The extension manager instance
 * @param requestConsent - Optional consent function for user approval
 * @returns true if migration was successful, false otherwise
 */
export async function migrateLegacyToNpm(
  extensionManager: ExtensionManager,
  requestConsent?: () => Promise<void>,
): Promise<boolean> {
  try {
    // Get current extensions
    const currentExtensions = extensionManager.getLoadedExtensions();

    // Find legacy extension
    const legacyExtension = currentExtensions.find(
      (ext) =>
        ext.name.toLowerCase() === LEGACY_EXTENSION_NAME.toLowerCase() ||
        (ext.installMetadata?.type === 'gitlab-git' &&
          ext.installMetadata?.source?.includes(
            'gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
          )),
    );

    if (!legacyExtension) {
      // No legacy extension found, nothing to migrate
      return false;
    }

    // Check if new extension is already installed
    const newExtensionExists = isNewExtensionInstalled(currentExtensions);
    if (newExtensionExists) {
      // Both old and new are installed - just remove the old one
      await extensionManager.uninstallExtension(legacyExtension.name, false);
      return true;
    }

    // Uninstall legacy extension
    await extensionManager.uninstallExtension(legacyExtension.name, false);

    // Install new npm extension
    await extensionManager.installExtension(
      {
        source: NEW_NPM_SOURCE,
        type: 'npm',
        registryUrl:
          'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
      },
      requestConsent,
    );

    return true;
  } catch (error) {
    console.error('Migration failed:', error);
    return false;
  }
}

/**
 * Returns migration info for UI display
 */
export function getMigrationInfo() {
  return {
    legacyName: LEGACY_EXTENSION_NAME,
    legacyUrl: LEGACY_GITLAB_URL,
    newSource: NEW_NPM_SOURCE,
    message: 'A newer version of the default extension is available via npm',
    benefits: [
      'Faster installation via npm registry',
      'Better version management',
      'Automatic updates through npm',
    ],
  };
}

// ============================================================================
// Auto-update migration for npm extension
// [nessy-fork] auto-update-migration
// ============================================================================

/**
 * Checks if the npm extension needs auto-update migration
 * (installed as npm but autoUpdate is not enabled)
 */
export function needsAutoUpdateMigration(extensions: Extension[]): boolean {
  return extensions.some(
    (extension) =>
      isDefaultNpmExtension(extension) &&
      extension.installMetadata?.autoUpdate !== true,
  );
}

/**
 * Migrates the npm extension to enable auto-update
 *
 * This function:
 * 1. Finds the @nestor/nessy-cli-extensions extension
 * 2. Updates the install metadata to enable autoUpdate
 * 3. Persists the change to .nessy-extension-install.json
 *
 * @param extensionManager - The extension manager instance
 * @returns true if migration was successful, false otherwise
 */
export async function migrateAutoUpdateForNpmExtension(
  extensionManager: ExtensionManager,
): Promise<boolean> {
  try {
    const extensions = extensionManager.getLoadedExtensions();

    // Find the npm extension
    const npmExtension = extensions.find(isDefaultNpmExtension);

    if (!npmExtension) {
      // Extension not found, nothing to migrate
      return false;
    }

    // Check if autoUpdate is already enabled
    if (npmExtension.installMetadata?.autoUpdate === true) {
      // Already enabled, skip migration
      return false;
    }

    // Load current metadata
    const metadata = extensionManager.loadInstallMetadata(npmExtension.path);

    if (!metadata) {
      console.error(
        '[AutoUpdate Migration] Could not load install metadata for',
        npmExtension.name,
      );
      return false;
    }

    // Update metadata to enable autoUpdate
    metadata.autoUpdate = true;

    // Persist updated metadata
    const fs = await import('node:fs');
    const path = await import('node:path');
    const metadataPath = path.join(
      npmExtension.path,
      '.nessy-extension-install.json',
    );

    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2),
    );
    npmExtension.installMetadata = metadata;

    console.log(
      '[AutoUpdate Migration] Enabled auto-update for',
      npmExtension.name,
    );

    return true;
  } catch (error) {
    console.error('[AutoUpdate Migration] Failed:', error);
    return false;
  }
}
