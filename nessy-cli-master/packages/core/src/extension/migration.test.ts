/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Extension } from './extensionManager.js';
import {
  isLegacyExtensionInstalled,
  isNewExtensionInstalled,
  getMigrationInfo,
  needsAutoUpdateMigration,
  migrateAutoUpdateForNpmExtension,
} from './migration.js';

describe('Extension Migration', () => {
  const createMockExtension = (
    name: string,
    type?: string,
    source?: string,
  ): Extension =>
    ({
      id: name,
      name,
      version: '1.0.0',
      isActive: true,
      path: `/path/to/${name}`,
      config: { name, version: '1.0.0' },
      installMetadata: type
        ? {
            type: type as any,
            source: source || '',
          }
        : undefined,
    }) as Extension;

  describe('isLegacyExtensionInstalled', () => {
    it('should return true for legacy extension name with gitlab-git type', () => {
      const extensions = [
        {
          id: 'nessy-default-extension',
          name: 'nessy-default-extension',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: 'nessy-default-extension', version: '1.0.0' },
          installMetadata: {
            type: 'gitlab-git' as const,
            source: 'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];
      expect(isLegacyExtensionInstalled(extensions)).toBe(true);
    });

    it('should return true for GitLab extension with legacy URL', () => {
      const extensions = [
        createMockExtension(
          'my-extension',
          'gitlab-git',
          'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
        ),
      ];
      expect(isLegacyExtensionInstalled(extensions)).toBe(true);
    });

    it('should return false for npm extension with same name', () => {
      const extensions = [
        {
          id: 'nessy-default-extension',
          name: 'nessy-default-extension',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: 'nessy-default-extension', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];
      expect(isLegacyExtensionInstalled(extensions)).toBe(false);
    });

    it('should return false for empty extensions array', () => {
      expect(isLegacyExtensionInstalled([])).toBe(false);
    });

    it('should return false for unrelated extensions', () => {
      const extensions = [
        createMockExtension('some-other-extension'),
        createMockExtension('another-extension'),
      ];
      expect(isLegacyExtensionInstalled(extensions)).toBe(false);
    });
  });

  describe('isNewExtensionInstalled', () => {
    it('should return true for npm extension with npm source', () => {
      const extensions = [
        {
          id: 'nessy-default-extension',
          name: 'nessy-default-extension',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: 'nessy-default-extension', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];
      expect(isNewExtensionInstalled(extensions)).toBe(true);
    });

    it('should match npm source case-insensitively', () => {
      const extensions = [
        createMockExtension(
          'nessy-default-extension',
          'npm',
          '@Nestor/nessy-cli-extensions',
        ),
      ];

      expect(isNewExtensionInstalled(extensions)).toBe(true);
    });

    it('should return false for GitLab extension', () => {
      const extensions = [
        createMockExtension(
          'nessy-default-extension',
          'gitlab-git',
          'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
        ),
      ];
      expect(isNewExtensionInstalled(extensions)).toBe(false);
    });

    it('should return false for empty extensions array', () => {
      expect(isNewExtensionInstalled([])).toBe(false);
    });
  });

  describe('getMigrationInfo', () => {
    it('should return correct migration info', () => {
      const info = getMigrationInfo();

      expect(info.legacyName).toBe('nessy-default-extension');
      expect(info.legacyUrl).toBe(
        'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
      );
      expect(info.newSource).toBe('@nestor/nessy-cli-extensions');
      expect(info.message).toBe(
        'A newer version of the default extension is available via npm',
      );
      expect(info.benefits).toHaveLength(3);
      expect(info.benefits[0]).toContain('Faster installation');
      expect(info.benefits[1]).toContain('Better version management');
      expect(info.benefits[2]).toContain('Automatic updates');
    });
  });

  describe('Mixed extension scenarios', () => {
    it('should detect both legacy and new when both installed', () => {
      const extensions = [
        {
          id: 'nessy-default-extension',
          name: 'nessy-default-extension',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: 'nessy-default-extension', version: '1.0.0' },
          installMetadata: {
            type: 'gitlab-git' as const,
            source: 'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
          },
        } as Extension,
        {
          id: 'nessy-default-extension',
          name: 'nessy-default-extension',
          version: '1.0.1',
          isActive: true,
          path: '/path/to/ext2',
          config: { name: 'nessy-default-extension', version: '1.0.1' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];

      expect(isLegacyExtensionInstalled(extensions)).toBe(true);
      expect(isNewExtensionInstalled(extensions)).toBe(true);
    });

    it('should detect legacy in presence of unrelated extensions', () => {
      const extensions = [
        createMockExtension('some-extension'),
        createMockExtension(
          'nessy-default-extension',
          'gitlab-git',
          'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
        ),
        createMockExtension('another-extension'),
      ];

      expect(isLegacyExtensionInstalled(extensions)).toBe(true);
      expect(isNewExtensionInstalled(extensions)).toBe(false);
    });

    it('should detect new npm extension after migration', () => {
      const extensions = [
        {
          id: 'nessy-default-extension',
          name: 'nessy-default-extension',
          version: '1.0.1',
          isActive: true,
          path: '/path/to/ext',
          config: { name: 'nessy-default-extension', version: '1.0.1' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];

      expect(isLegacyExtensionInstalled(extensions)).toBe(false);
      expect(isNewExtensionInstalled(extensions)).toBe(true);
    });
  });

  describe('needsAutoUpdateMigration', () => {
    it('should return true for npm extension without autoUpdate', () => {
      const extensions = [
        {
          id: '@nestor/nessy-cli-extensions',
          name: '@nestor/nessy-cli-extensions',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@nestor/nessy-cli-extensions', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
            // autoUpdate is undefined or false
          },
        } as Extension,
      ];
      expect(needsAutoUpdateMigration(extensions)).toBe(true);
    });

    it('should return true for npm extension with autoUpdate explicitly false', () => {
      const extensions = [
        {
          id: '@nestor/nessy-cli-extensions',
          name: '@nestor/nessy-cli-extensions',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@nestor/nessy-cli-extensions', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
            autoUpdate: false,
          },
        } as Extension,
      ];
      expect(needsAutoUpdateMigration(extensions)).toBe(true);
    });

    it('should return false for npm extension with autoUpdate already true', () => {
      const extensions = [
        {
          id: '@nestor/nessy-cli-extensions',
          name: '@nestor/nessy-cli-extensions',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@nestor/nessy-cli-extensions', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
            autoUpdate: true,
          },
        } as Extension,
      ];
      expect(needsAutoUpdateMigration(extensions)).toBe(false);
    });

    it('should return false for non-npm extensions', () => {
      const extensions = [
        {
          id: 'some-extension',
          name: 'some-extension',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: 'some-extension', version: '1.0.0' },
          installMetadata: {
            type: 'git' as const,
            source: 'https://github.com/example/repo',
          },
        } as Extension,
      ];
      expect(needsAutoUpdateMigration(extensions)).toBe(false);
    });

    it('should return false for empty extensions array', () => {
      expect(needsAutoUpdateMigration([])).toBe(false);
    });

    it('should return false when extension name does not match', () => {
      const extensions = [
        {
          id: '@other/extension',
          name: '@other/extension',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@other/extension', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@other/extension',
          },
        } as Extension,
      ];
      expect(needsAutoUpdateMigration(extensions)).toBe(false);
    });
  });

  describe('migrateAutoUpdateForNpmExtension', () => {
    const createMockExtensionManager = (extensions: Extension[]) => ({
      getLoadedExtensions: vi.fn().mockReturnValue(extensions),
      loadInstallMetadata: vi.fn().mockReturnValue({
        type: 'npm',
        source: '@nestor/nessy-cli-extensions',
      }),
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should enable autoUpdate for npm extension', async () => {
      const extensions = [
        {
          id: '@nestor/nessy-cli-extensions',
          name: '@nestor/nessy-cli-extensions',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@nestor/nessy-cli-extensions', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];

      const mockWriteFile = vi.fn().mockResolvedValue(undefined);

      // Create a mock manager that returns metadata and tracks updates
      let capturedMetadata: any = {
        type: 'npm',
        source: '@nestor/nessy-cli-extensions',
      };

      const mockManager = {
        getLoadedExtensions: vi.fn().mockReturnValue(extensions),
        loadInstallMetadata: vi.fn().mockReturnValue(capturedMetadata),
      };

      // Temporarily replace fs.promises.writeFile
      const fs = await import('node:fs');
      const originalWriteFile = fs.promises.writeFile;
      fs.promises.writeFile = mockWriteFile as any;

      try {
        const result = await migrateAutoUpdateForNpmExtension(
          mockManager as any,
        );

        expect(result).toBe(true);
        expect(capturedMetadata.autoUpdate).toBe(true);
        expect(mockWriteFile).toHaveBeenCalled();
      } finally {
        // Restore original
        fs.promises.writeFile = originalWriteFile;
      }
    });

    it('should return false if extension not found', async () => {
      const extensions = [
        {
          id: 'other-extension',
          name: 'other-extension',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: 'other-extension', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@other/extension',
          },
        } as Extension,
      ];

      const mockManager = createMockExtensionManager(extensions);
      const result = await migrateAutoUpdateForNpmExtension(mockManager as any);

      expect(result).toBe(false);
    });

    it('should return false if autoUpdate is already enabled', async () => {
      const extensions = [
        {
          id: '@nestor/nessy-cli-extensions',
          name: '@nestor/nessy-cli-extensions',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@nestor/nessy-cli-extensions', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
            autoUpdate: true,
          },
        } as Extension,
      ];

      const mockManager = createMockExtensionManager(extensions);
      const result = await migrateAutoUpdateForNpmExtension(mockManager as any);

      expect(result).toBe(false);
    });

    it('should return false if metadata cannot be loaded', async () => {
      const extensions = [
        {
          id: '@nestor/nessy-cli-extensions',
          name: '@nestor/nessy-cli-extensions',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@nestor/nessy-cli-extensions', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];

      const mockManager = {
        getLoadedExtensions: vi.fn().mockReturnValue(extensions),
        loadInstallMetadata: vi.fn().mockReturnValue(undefined),
      };

      const result = await migrateAutoUpdateForNpmExtension(mockManager as any);

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      const extensions = [
        {
          id: '@nestor/nessy-cli-extensions',
          name: '@nestor/nessy-cli-extensions',
          version: '1.0.0',
          isActive: true,
          path: '/path/to/ext',
          config: { name: '@nestor/nessy-cli-extensions', version: '1.0.0' },
          installMetadata: {
            type: 'npm' as const,
            source: '@nestor/nessy-cli-extensions',
          },
        } as Extension,
      ];

      const mockManager = {
        getLoadedExtensions: vi.fn().mockReturnValue(extensions),
        loadInstallMetadata: vi.fn().mockImplementation(() => {
          throw new Error('Failed to load metadata');
        }),
      };

      const result = await migrateAutoUpdateForNpmExtension(mockManager as any);

      expect(result).toBe(false);
    });
  });
});
