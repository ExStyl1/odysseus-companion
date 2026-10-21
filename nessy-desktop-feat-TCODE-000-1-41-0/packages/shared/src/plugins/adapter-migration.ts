import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityTrustStore } from '../capabilities/trust-store.ts';
import { pluginKeyFor } from '../workspaces/paths.ts';
import { BUNDLE_COPY_OPTIONS, computeNormalizedBundleHash, findUnsafeBundleSymlink } from './bundle-hash.ts';
import { createDefaultPluginFormatAdapters, normalizePluginBundle } from './format-adapters.ts';
import { pluginDiagnostic } from './schema.ts';
import type { PluginInstalledEntryV2, PluginStoreV2 } from './store-v2.ts';
import type { PluginDiagnostic } from './types.ts';

export interface PluginAdapterMigrationResult {
  migrated: number;
  diagnostics: PluginDiagnostic[];
}

/** Re-normalize active immutable bundles when their recorded adapter is stale. */
export async function migrateOutdatedPluginAdaptersOnStartup(options: {
  store: PluginStoreV2;
  trustStore: CapabilityTrustStore;
  onPluginRepair?: (entry: PluginInstalledEntryV2) => Promise<void> | void;
}): Promise<PluginAdapterMigrationResult> {
  const diagnostics: PluginDiagnostic[] = [];
  let registry;
  try {
    registry = await options.store.readInstalledRegistry();
  } catch (error) {
    return {
      migrated: 0,
      diagnostics: [migrationWarning(
        'plugin.adapter_migration.registry_unavailable',
        `Installed plugin adapters could not be checked: ${errorMessage(error)}`,
      )],
    };
  }

  const adapters = createDefaultPluginFormatAdapters();
  let migrated = 0;
  for (const [pluginKey, pluginInstanceId] of Object.entries(registry.active).sort(([left], [right]) => left.localeCompare(right))) {
    const entry = registry.plugins.find(candidate => (
      candidate.pluginKey === pluginKey && candidate.pluginInstanceId === pluginInstanceId
    ));
    if (!entry) {
      diagnostics.push(migrationWarning(
        'plugin.adapter_migration.active_instance_missing',
        `Active plugin cache entry is missing for ${pluginKey}.`,
        { pluginKey, pluginInstanceId },
      ));
      continue;
    }

    const manifestAdapter = entry.manifest.compatibility?.adapter;
    const adapterId = entry.origin.adapterId ?? manifestAdapter?.adapterId;
    if (!adapterId) continue;
    const persistedAdapterVersion = entry.origin.adapterVersion
      ?? (manifestAdapter?.adapterId === adapterId ? manifestAdapter.adapterVersion : undefined);
    const adapter = adapters.find(candidate => candidate.id === adapterId);
    if (!adapter?.version) {
      diagnostics.push(migrationWarning(
        'plugin.adapter_migration.adapter_unavailable',
        `Recorded plugin adapter "${adapterId}" is not available; ${pluginKey} was left unchanged.`,
        { pluginKey, pluginInstanceId, adapterId },
      ));
      continue;
    }
    if (persistedAdapterVersion === adapter.version) continue;
    const versionOrder = persistedAdapterVersion === undefined
      ? -1
      : compareNumericAdapterVersions(persistedAdapterVersion, adapter.version);
    if (versionOrder === null) {
      diagnostics.push(migrationWarning(
        'plugin.adapter_migration.version_incomparable',
        `Recorded adapter version "${persistedAdapterVersion}" cannot be safely compared with "${adapter.version}"; ${pluginKey} was left unchanged.`,
        { pluginKey, pluginInstanceId, adapterId },
      ));
      continue;
    }
    if (versionOrder > 0) {
      diagnostics.push(migrationWarning(
        'plugin.adapter_migration.newer_adapter_version',
        `Plugin ${pluginKey} was normalized by newer ${adapterId}@${persistedAdapterVersion} and was left unchanged.`,
        { pluginKey, pluginInstanceId, adapterId },
      ));
      continue;
    }
    if (versionOrder === 0) continue;

    let stageDirectory: string | undefined;
    try {
      const cachePath = options.store.cachePathFor(entry.cacheRef);
      if (await findUnsafeBundleSymlink(cachePath)) {
        throw new Error('cached bundle contains an escaping or dangling symlink');
      }
      if (await computeNormalizedBundleHash(cachePath) !== entry.bundleHash) {
        throw new Error('cached bundle content does not match its content address');
      }

      const origin = {
        ...entry.origin,
        marketplaceId: entry.marketplaceId,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
      };
      // S9: re-normalize with the SAME marketplace entry the plugin installed
      // with. Without it the cached bundle alone decides, and an entry-defined
      // plugin would silently lose every component the entry declared.
      const normalized = await normalizePluginBundle(cachePath, origin, [adapter],
        entry.origin.marketplaceEntry ? { marketplaceEntry: entry.origin.marketplaceEntry } : {});
      if (!normalized.ok || !normalized.value || normalized.compatibility?.state === 'blocked') {
        const codes = normalized.diagnostics.map(diagnostic => diagnostic.code).join(', ');
        throw new Error(`adapter normalization failed${codes ? ` (${codes})` : ''}`);
      }
      const manifest = normalized.value;
      if (
        manifest.id !== entry.pluginId
        || manifest.version !== entry.version
        || pluginKeyFor(entry.marketplaceId, manifest.id) !== entry.pluginKey
      ) {
        throw new Error('adapter normalization changed the stable plugin identity');
      }

      stageDirectory = await mkdtemp(join(tmpdir(), 'nessy-plugin-adapter-migration-'));
      const normalizedDirectory = join(stageDirectory, 'normalized');
      await cp(cachePath, normalizedDirectory, BUNDLE_COPY_OPTIONS);
      await rm(join(normalizedDirectory, 'plugin.json'), { force: true });
      await writeFile(
        join(normalizedDirectory, 'plugin.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: 'utf-8', mode: 0o600 },
      );

      let trustCleanupFailure: { error: unknown } | undefined;
      const repaired = await options.trustStore.runExclusive(async () => {
        const result = await options.store.repair(entry.pluginInstanceId, {
          normalizedDirectory,
          manifest,
          origin,
          marketplaceId: entry.marketplaceId,
          ...(normalized.compatibility ?? entry.compatibility
            ? { compatibility: normalized.compatibility ?? entry.compatibility }
            : {}),
        });
        try {
          options.trustStore.purgePluginInstances([entry.pluginInstanceId]);
        } catch (error) {
          trustCleanupFailure = { error };
        }
        return result;
      });
      migrated += 1;
      diagnostics.push({
        severity: 'info',
        code: 'plugin.adapter_migration.completed',
        message: `Plugin ${pluginKey} was re-normalized with ${adapter.id}@${adapter.version}.`,
        details: {
          pluginKey,
          previousPluginInstanceId: entry.pluginInstanceId,
          pluginInstanceId: repaired.pluginInstanceId,
          adapterId: adapter.id,
          previousAdapterVersion: persistedAdapterVersion ?? null,
          adapterVersion: adapter.version,
        },
      });
      if (trustCleanupFailure) {
        diagnostics.push(migrationWarning(
          'plugin.adapter_migration.trust_cleanup_pending',
          `Plugin ${pluginKey} was re-normalized, but obsolete executable trust cleanup must be retried: ${errorMessage(trustCleanupFailure.error)}`,
          {
            pluginKey,
            previousPluginInstanceId: entry.pluginInstanceId,
            pluginInstanceId: repaired.pluginInstanceId,
          },
        ));
      }
      try {
        await options.onPluginRepair?.(repaired);
      } catch (error) {
        diagnostics.push(migrationWarning(
          'plugin.adapter_migration.connector_reconcile_pending',
          `Plugin ${pluginKey} was repaired, but connector reconciliation must be retried: ${errorMessage(error)}`,
          { pluginKey, pluginInstanceId: repaired.pluginInstanceId },
        ));
      }
    } catch (error) {
      diagnostics.push(migrationWarning(
        'plugin.adapter_migration.failed',
        `Plugin ${pluginKey} was left unchanged after adapter migration failed: ${errorMessage(error)}`,
        {
          pluginKey,
          pluginInstanceId: entry.pluginInstanceId,
          adapterId,
          previousAdapterVersion: persistedAdapterVersion ?? null,
          adapterVersion: adapter.version,
        },
      ));
    } finally {
      if (stageDirectory) {
        try {
          await rm(stageDirectory, { recursive: true, force: true });
        } catch {
          diagnostics.push(migrationWarning(
            'plugin.adapter_migration.cleanup_failed',
            'Plugin adapter migration staging cleanup failed.',
            { pluginKey },
          ));
        }
      }
    }
  }
  return { migrated, diagnostics };
}

function migrationWarning(code: string, message: string, details?: Record<string, unknown>): PluginDiagnostic {
  return pluginDiagnostic('warning', code, message, undefined, details);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareNumericAdapterVersions(left: string, right: string): -1 | 0 | 1 | null {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
