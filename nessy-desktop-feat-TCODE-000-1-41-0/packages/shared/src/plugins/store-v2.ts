/**
 * Global content-addressed, activation-free plugin store (W7 Step 3).
 *
 * This is the only production plugin store. It has been the only one since the
 * W10 cutover, and since F4 it is the only one that EXISTS: the v1 store's
 * installed-registry / lockfile / trust-file halves, its commit installer and its
 * projection were deleted rather than left as test-only compatibility modules.
 * `marketplace-registry-store.ts` keeps the one slot v2 never took over, the
 * bring-your-own registry list. Key properties:
 *
 * - One immutable installed copy per `(version, bundleHash)`, addressed as
 *   `<version>/<bundleHash>` through the W1 helper `getPluginCachePath()` — never
 *   a manifest-only checksum, never a persisted absolute path.
 * - NO `enabledScopes` / `lifecycleState` on the entry: activation is owned by
 *   the capability policy store. The registry is portable and activation-free.
 * - No delete-before-install. Same-version/different-hash and repair stage
 *   side-by-side and switch `active[pluginKey]` atomically.
 * - An inactive instance is retained while a captured snapshot LEASE or an
 *   update-journal entry references it, then pruned — matching Codex cleanup
 *   without breaking Nessy's in-flight generation guarantee.
 * - Any incompatible registry is a fatal schema error and is never imported.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { PLUGINS_DIR, getPluginCachePath, pluginKeyFor } from '../workspaces/paths.ts';
import type { VerifiedStorageLayoutV2 } from '../workspaces/storage-readiness.ts';
import { BUNDLE_COPY_OPTIONS, computeNormalizedBundleHash, findUnsafeBundleSymlink } from './bundle-hash.ts';
import { normalizeNessyPluginManifest } from './schema.ts';
import type {
  NessyPluginManifest,
  PluginCacheRef,
  PluginCompatibilityReport,
  PluginDiagnostic,
  PluginInstanceId,
  PluginKey,
  PluginOrigin,
} from './types.ts';

export const PLUGIN_STORE_SCHEMA_VERSION_V2 = 2 as const;

/** Activation-free installed record. Contains only logical/relative refs. */
export interface PluginInstalledEntryV2 {
  pluginInstanceId: PluginInstanceId;
  pluginKey: PluginKey;
  marketplaceId: string;
  pluginId: string;
  version: string;
  bundleHash: string;
  cacheRef: PluginCacheRef;
  manifest: NessyPluginManifest;
  origin: PluginOrigin;
  installedAt: number;
  diagnostics: PluginDiagnostic[];
  /**
   * Adapter-owned compatibility report captured at install/repair time (A7
   * D12 fix). Optional/additive field so the registry schema version is
   * unchanged; a pre-A7 entry simply has no report until its next
   * install/repair. Never recomputed here — store-v2 stays provider-format
   * agnostic and only persists whatever the caller supplies.
   */
  compatibility?: PluginCompatibilityReport;
  /**
   * P6.557 — the provenance bit `plugin-dependencies.md` § *Remove orphaned
   * auto-installed dependencies* needs: *"Plugins you installed yourself are
   * never pruned, only those installed automatically through another plugin's
   * `dependencies` array."* Without it there is nothing to tell the two apart
   * and the `prune` verb cannot be honest.
   *
   * Optional and additive, so the registry schema version is unchanged and a
   * pre-P6.557 entry is simply read as user-installed — which is the SAFE
   * default here: it can only make prune skip something, never remove a plugin
   * the user chose. Persisted verbatim like every other field; this store never
   * derives it.
   */
  autoInstalled?: boolean;
}

export interface PluginInstalledRegistryV2 {
  schemaVersion: typeof PLUGIN_STORE_SCHEMA_VERSION_V2;
  updatedAt: number;
  /** Active instance per stable plugin key (atomic switch on update). */
  active: Record<PluginKey, PluginInstanceId>;
  plugins: PluginInstalledEntryV2[];
}

interface UpdateJournalEntry {
  pluginKey: PluginKey;
  from?: PluginInstanceId;
  to: PluginInstanceId;
  startedAt: number;
}

interface UpdateJournalV2 {
  schemaVersion: typeof PLUGIN_STORE_SCHEMA_VERSION_V2;
  entries: UpdateJournalEntry[];
}

export interface PluginInstallInputV2 {
  /** Absolute path to the staged, normalized bundle to install. */
  normalizedDirectory: string;
  manifest: NessyPluginManifest;
  origin: PluginOrigin;
  marketplaceId?: string;
  /** Adapter-owned compatibility report to persist alongside the entry. */
  compatibility?: PluginCompatibilityReport;
  /** P6.557 — see {@link PluginInstalledEntryV2.autoInstalled}. */
  autoInstalled?: boolean;
}

export interface PluginStoreV2Options {
  /** Test seam: override the store root. Defaults to the managed plugins dir. */
  rootDirectory?: string;
  now?: () => number;
}

/** Thrown when a same-hash repair cannot proceed because a lease is held. */
export class PluginRepairDeferredError extends Error {
  constructor(readonly pluginInstanceId: PluginInstanceId) {
    super(`Repair deferred; instance is leased: ${pluginInstanceId}`);
    this.name = 'PluginRepairDeferredError';
  }
}

/**
 * P6.418 — where an image lays down plugins for a first session to find.
 *
 * Defaults to `<store root>/seed`. One host variable, deliberately, rather than
 * one per artefact kind: the operator's question is "where is the tree I baked
 * into the image", and a second name would only let the two disagree.
 */
export const PLUGIN_SEED_DIR_ENV = 'NESSY_PLUGIN_SEED_DIR';

/** What one seeding pass did, per declared bundle. */
export interface PluginSeedReceipt {
  /** The directory read, or `undefined` when there was none (the normal case). */
  seedDirectory?: string;
  /** `pluginKey`s installed by this pass. */
  seeded: PluginKey[];
  /** Bundles the pass did not install, each with the reason. */
  skipped: { directory: string; reason: string }[];
}

export function createPluginInstanceIdV2(ref: PluginCacheRef): PluginInstanceId {
  return `plugin://${ref.marketplaceId}/${ref.pluginId}@${ref.version}#${ref.bundleHash}`;
}

export class PluginStoreV2 {
  readonly rootDirectory: string;
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly leases = new Map<PluginInstanceId, number>();
  private pruneInFlight: Promise<void> | null = null;
  private prunePending = false;
  /**
   * In-process registry-mutation queue. `install`/`repair`/`uninstall` each
   * read-modify-write the shared registry file; without serialization two
   * concurrent mutations (e.g. a user-initiated update racing an install)
   * silently lose one writer's change (RED-proven — see
   * `__tests__/store-v2.test.ts` "does not lose an update under a concurrent
   * install/repair race"). This does not protect against a second OS process
   * writing the same store root; managed storage is single-process per root.
   */
  private registryMutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: PluginStoreV2Options = {}) {
    this.rootDirectory = options.rootDirectory ?? PLUGINS_DIR;
    this.cacheDir = join(this.rootDirectory, 'cache');
    this.now = options.now ?? (() => Date.now());
  }

  /** Serialize a registry read-modify-write section against other mutations. */
  private withRegistryMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.registryMutationQueue.then(fn, fn);
    // Swallow rejection for chaining purposes only; the real result/error is
    // still returned to this call's caller via `run`.
    this.registryMutationQueue = run.catch(() => undefined);
    return run;
  }

  private get registryPath(): string {
    return join(this.rootDirectory, 'installed.json');
  }

  private get lockPath(): string {
    return join(this.rootDirectory, 'lock.json');
  }

  private get journalPath(): string {
    return join(this.rootDirectory, 'update-journal.json');
  }

  cachePathFor(ref: PluginCacheRef): string {
    return getPluginCachePath(ref, this.cacheDir);
  }

  async readInstalledRegistry(): Promise<PluginInstalledRegistryV2> {
    const empty: PluginInstalledRegistryV2 = {
      schemaVersion: PLUGIN_STORE_SCHEMA_VERSION_V2,
      updatedAt: this.now(),
      active: {},
      plugins: [],
    };
    if (!existsSync(this.registryPath)) return empty;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.registryPath, 'utf-8'));
    } catch (error) {
      throw new Error(`Failed to read plugin v2 registry: invalid JSON (${errorMessage(error)})`);
    }
    if (
      typeof parsed !== 'object'
      || parsed === null
      || (parsed as { schemaVersion?: unknown }).schemaVersion !== PLUGIN_STORE_SCHEMA_VERSION_V2
    ) {
      // Any incompatible registry is a fatal schema error; never import it.
      throw new Error('Incompatible plugin registry schema; refusing to import');
    }
    return parsed as PluginInstalledRegistryV2;
  }

  /**
   * Install (or update to) a normalized bundle. Content-addressed, no
   * delete-before-install; atomically switches the active instance and prunes
   * inactive, unleased, unjournaled instances afterwards.
   */
  async install(input: PluginInstallInputV2): Promise<PluginInstalledEntryV2> {
    await assertSafeNormalizedBundle(input.normalizedDirectory);
    await mkdir(this.cacheDir, { recursive: true });
    const marketplaceId = input.origin.marketplaceId ?? input.marketplaceId ?? 'local';
    const version = input.manifest.version;
    const bundleHash = await computeNormalizedBundleHash(input.normalizedDirectory);
    const cacheRef: PluginCacheRef = { marketplaceId, pluginId: input.manifest.id, version, bundleHash };
    const cachePath = this.cachePathFor(cacheRef);

    await this.placeBundle(input.normalizedDirectory, cachePath, bundleHash);

    const pluginKey = pluginKeyFor(marketplaceId, input.manifest.id);
    const pluginInstanceId = createPluginInstanceIdV2(cacheRef);
    const entry: PluginInstalledEntryV2 = {
      pluginInstanceId,
      pluginKey,
      marketplaceId,
      pluginId: input.manifest.id,
      version,
      bundleHash,
      cacheRef,
      manifest: input.manifest,
      origin: input.origin,
      installedAt: this.now(),
      diagnostics: [],
      ...(input.compatibility ? { compatibility: input.compatibility } : {}),
      ...(input.autoInstalled ? { autoInstalled: true } : {}),
    };

    // Serialized: a concurrent install/repair/uninstall must not read-modify-
    // write the shared registry file interleaved with this one (lost update).
    await this.withRegistryMutation(async () => {
      const registry = await this.readInstalledRegistry();
      const previous = registry.active[pluginKey];

      // Record intent in the journal so a crash mid-switch keeps the old instance.
      await this.writeJournal({
        schemaVersion: PLUGIN_STORE_SCHEMA_VERSION_V2,
        entries: [{ pluginKey, ...(previous ? { from: previous } : {}), to: pluginInstanceId, startedAt: this.now() }],
      });

      registry.plugins = [
        ...registry.plugins.filter(p => p.pluginInstanceId !== pluginInstanceId),
        entry,
      ].sort((a, b) => a.pluginInstanceId.localeCompare(b.pluginInstanceId));
      registry.active[pluginKey] = pluginInstanceId; // atomic switch on write
      await this.writeRegistry(registry);

      await this.writeJournal({ schemaVersion: PLUGIN_STORE_SCHEMA_VERSION_V2, entries: [] });
    });
    await this.prune();
    return entry;
  }

  /**
   * Repair an installed instance from a freshly-staged copy. A different hash
   * stages side-by-side and switches. An identical hash replaces the directory
   * only when no lease is held (never mutates bytes visible to a lease); a held
   * lease raises `PluginRepairDeferredError`.
   */
  async repair(pluginInstanceId: PluginInstanceId, input: PluginInstallInputV2): Promise<PluginInstalledEntryV2> {
    await assertSafeNormalizedBundle(input.normalizedDirectory);
    const registry = await this.readInstalledRegistry();
    const existing = registry.plugins.find(p => p.pluginInstanceId === pluginInstanceId);
    if (!existing) throw new Error(`Installed plugin not found: ${pluginInstanceId}`);

    const repairedHash = await computeNormalizedBundleHash(input.normalizedDirectory);
    if (repairedHash === existing.bundleHash) {
      return this.withRegistryMutation(async () => {
        const currentRegistry = await this.readInstalledRegistry();
        const currentIndex = currentRegistry.plugins.findIndex(p => p.pluginInstanceId === pluginInstanceId);
        const current = currentRegistry.plugins[currentIndex];
        if (!current || current.bundleHash !== repairedHash) {
          throw new Error(`Installed plugin changed during repair: ${pluginInstanceId}`);
        }
        if ((this.leases.get(pluginInstanceId) ?? 0) > 0) {
          throw new PluginRepairDeferredError(pluginInstanceId);
        }
        const cachePath = this.cachePathFor(current.cacheRef);
        const staging = `${cachePath}.repair.${randomUUID()}`;
        try {
          await cp(input.normalizedDirectory, staging, BUNDLE_COPY_OPTIONS);
          await assertSafeNormalizedBundle(staging);
          if ((await computeNormalizedBundleHash(staging)) !== current.bundleHash) {
            throw new Error('Repaired bundle failed hash verification');
          }
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        // Atomic replace: move the old dir aside, move the verified copy in.
        const retired = `${cachePath}.retired.${randomUUID()}`;
        const hadCache = existsSync(cachePath);
        let retiredCache = false;
        try {
          if (hadCache) {
            await rename(cachePath, retired);
            retiredCache = true;
          }
          await rename(staging, cachePath);
        } catch (error) {
          // The registry still references this cache address. Restore the
          // previous verified directory before surfacing promotion failure.
          let rollbackError: unknown;
          if (retiredCache) {
            try {
              await rename(retired, cachePath);
            } catch (caught) {
              rollbackError = caught;
            }
          }
          await rm(staging, { recursive: true, force: true });
          if (!existsSync(cachePath)) {
            if (currentRegistry.active[current.pluginKey] === pluginInstanceId) {
              delete currentRegistry.active[current.pluginKey];
            }
            currentRegistry.plugins.splice(currentIndex, 1);
            await this.writeRegistry(currentRegistry);
          }
          if (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Plugin cache replacement and rollback failed; the missing cache was removed from the registry.',
            );
          }
          throw error;
        }
        await rm(retired, { recursive: true, force: true });

        const repaired: PluginInstalledEntryV2 = {
          ...current,
          manifest: input.manifest,
          origin: input.origin,
        };
        if (input.compatibility) repaired.compatibility = input.compatibility;
        else delete repaired.compatibility;
        currentRegistry.plugins[currentIndex] = repaired;
        await this.writeRegistry(currentRegistry);
        return repaired;
      });
    }

    // Different hash: install side-by-side and switch atomically.
    return this.install({ ...input, marketplaceId: existing.marketplaceId });
  }

  /**
   * Remove the active instance for a stable plugin key. A leased instance stays
   * readable until its snapshot drains; otherwise its registry/cache entry is
   * pruned immediately.
   */
  async uninstall(pluginKey: PluginKey): Promise<void> {
    await this.withRegistryMutation(async () => {
      const registry = await this.readInstalledRegistry();
      if (!registry.active[pluginKey]) return;
      delete registry.active[pluginKey];
      await this.writeRegistry(registry);
    });
    await this.prune();
  }

  /** Capture a snapshot lease on an instance. Call the returned fn to release. */
  acquireInstanceLease(pluginInstanceId: PluginInstanceId): () => void {
    this.leases.set(pluginInstanceId, (this.leases.get(pluginInstanceId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(pluginInstanceId) ?? 1) - 1;
      if (count <= 0) {
        this.leases.delete(pluginInstanceId);
        this.schedulePrune();
      } else {
        this.leases.set(pluginInstanceId, count);
      }
    };
  }

  private schedulePrune(): void {
    this.prunePending = true;
    void this.prune().catch(() => undefined);
  }

  /**
   * Remove every inactive instance that is neither leased nor protected by an
   * update-journal entry, dropping its registry record and cache directory.
   */
  async prune(): Promise<void> {
    if (this.pruneInFlight) return this.pruneInFlight;
    const run = (async () => {
      do {
        this.prunePending = false;
        await this.pruneInactiveInstances();
      } while (this.prunePending);
    })();
    this.pruneInFlight = run.finally(() => {
      this.pruneInFlight = null;
    });
    return this.pruneInFlight;
  }

  private async pruneInactiveInstances(): Promise<void> {
    // Serialized against install/repair/uninstall's registry read-modify-
    // write: without this, a prune running concurrently with an install can
    // read a stale `plugins` array and overwrite the installing entry right
    // out of the registry (RED-proven lost update).
    await this.withRegistryMutation(() => this.pruneInactiveInstancesLocked());
  }

  private async pruneInactiveInstancesLocked(): Promise<void> {
    const registry = await this.readInstalledRegistry();
    const activeIds = new Set(Object.values(registry.active));
    const journalIds = new Set(
      (await this.readJournal()).entries.flatMap(e => [e.to, ...(e.from ? [e.from] : [])]),
    );

    const keep: PluginInstalledEntryV2[] = [];
    for (const entry of registry.plugins) {
      const protectedInstance =
        activeIds.has(entry.pluginInstanceId)
        || journalIds.has(entry.pluginInstanceId)
        || (this.leases.get(entry.pluginInstanceId) ?? 0) > 0;
      if (protectedInstance) {
        keep.push(entry);
        continue;
      }
      await rm(this.cachePathFor(entry.cacheRef), { recursive: true, force: true });
    }
    if (keep.length !== registry.plugins.length) {
      registry.plugins = keep;
      await this.writeRegistry(registry);
    }
  }

  /**
   * Startup prune: identical to `prune()`, but honors the update journal so an
   * instance mid-update is retained across a restart.
   */
  async pruneOnStartup(): Promise<void> {
    // P6.418 — BEFORE the prune, because a seeded bundle must be `active` by the
    // time the prune decides what is unreferenced.
    await this.seedFromDirectory();
    await this.prune();
    await this.backfillRuntimeCompatibilityOnStartup();
  }

  /**
   * P6.418 — materialise plugins an image laid down, once, at startup.
   *
   * ## Why a materialiser and not a hand-laid `installed.json`
   *
   * The row was filed as *"plugins cannot be pre-populated into a container or
   * CI image"*, which is too strong: the registry file CAN be written by an
   * image. The blocker is the HASH. Every entry carries a `bundleHash` that
   * {@link install} computes with {@link computeNormalizedBundleHash} and that
   * later reads verify against the cached bytes, so a hand-laid entry whose hash
   * was produced by anything else is silently skipped — present in the file and
   * absent from the product, which is the worst of the two failures.
   *
   * So the seed is a tree of NORMALIZED BUNDLES, and this calls the store's own
   * {@link install} once per bundle: the hash is computed by the code that
   * verifies it, and the seeded entry is byte-for-byte an ordinary install.
   * Nothing is fetched — the bundle is already on disk.
   *
   * The MARKETPLACE half needs no equivalent and that asymmetry is the point:
   * `marketplaces.json` is plain JSON with no content hash (see
   * `marketplace-registry-store.ts`), so an image lays it down directly, with
   * `installedRoot` pointing at a clone it also baked in.
   *
   * ## Native mechanism, asked and rejected
   *
   * The vendored runtime reads `CLAUDE_CODE_PLUGIN_SEED_DIR` /
   * `CLAUDE_CODE_PLUGIN_CACHE_DIR` for its OWN plugin tree, which this fork
   * bypasses entirely (it passes `plugins: []`). Enabling those would seed a
   * store nothing here reads — a no-op that LOOKS like a working control, which
   * is worse than an absent one. Codex and Pi have no seed concept at all. Host
   * case (3): built here, with the reason recorded.
   *
   * Idempotent and fail-soft: a bundle whose `pluginKey` is already active is
   * skipped (an image is re-seeded on every start), and a malformed bundle is
   * recorded in the receipt rather than failing the startup of an app whose
   * other plugins are fine.
   */
  async seedFromDirectory(seedDirectory?: string): Promise<PluginSeedReceipt> {
    const directory = seedDirectory
      ?? process.env[PLUGIN_SEED_DIR_ENV]
      ?? join(this.rootDirectory, 'seed');
    if (!existsSync(directory)) return { seeded: [], skipped: [] };

    const receipt: PluginSeedReceipt = { seedDirectory: directory, seeded: [], skipped: [] };
    let entries: string[];
    try {
      entries = (await readdir(directory, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    } catch (error) {
      receipt.skipped.push({ directory, reason: `unreadable seed directory: ${errorMessage(error)}` });
      return receipt;
    }

    const active = new Set(Object.keys((await this.readInstalledRegistry()).active));
    for (const name of entries) {
      const bundleDirectory = join(directory, name);
      let manifestText: string;
      try {
        manifestText = await readFile(join(bundleDirectory, 'plugin.json'), 'utf-8');
      } catch (error) {
        receipt.skipped.push({ directory: bundleDirectory, reason: `no readable plugin.json: ${errorMessage(error)}` });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifestText);
      } catch (error) {
        receipt.skipped.push({ directory: bundleDirectory, reason: `invalid plugin.json: ${errorMessage(error)}` });
        continue;
      }
      const normalized = normalizeNessyPluginManifest(parsed);
      const manifest = normalized.ok ? normalized.value : undefined;
      if (!manifest) {
        receipt.skipped.push({
          directory: bundleDirectory,
          reason: `manifest rejected: ${normalized.diagnostics.map(d => d.code).join(', ')}`,
        });
        continue;
      }
      const pluginKey = pluginKeyFor('seed', manifest.id);
      if (active.has(pluginKey)) {
        receipt.skipped.push({ directory: bundleDirectory, reason: 'already installed' });
        continue;
      }
      try {
        await this.install({
          normalizedDirectory: bundleDirectory,
          manifest,
          // `local-path` because that is what it is: bytes already on this disk,
          // never fetched. `marketplaceId: 'seed'` keeps every seeded plugin
          // under one key namespace, so an operator can tell at a glance which
          // of a profile's plugins the image put there.
          origin: { source: 'local-path', marketplaceId: 'seed', localPath: bundleDirectory, resolvedAt: this.now() },
        });
        receipt.seeded.push(pluginKey);
      } catch (error) {
        receipt.skipped.push({ directory: bundleDirectory, reason: `install failed: ${errorMessage(error)}` });
      }
    }
    return receipt;
  }

  /**
   * Repair additive runtime metadata lost by an earlier manifest-normalization
   * bug. The immutable normalized bundle is the only recovery source, and its
   * complete content hash must still match the installed instance identity.
   */
  private async backfillRuntimeCompatibilityOnStartup(): Promise<void> {
    await this.withRegistryMutation(async () => {
      const registry = await this.readInstalledRegistry();
      let changed = false;

      for (let index = 0; index < registry.plugins.length; index += 1) {
        const entry = registry.plugins[index];
        if (!entry || entry.manifest.runtimeCompatibility) continue;

        const cachePath = this.cachePathFor(entry.cacheRef);
        const manifestPath = join(cachePath, 'plugin.json');
        let manifestText: string;
        try {
          manifestText = await readFile(manifestPath, 'utf-8');
        } catch {
          continue;
        }

        let cachedManifest: unknown;
        try {
          cachedManifest = JSON.parse(manifestText);
        } catch {
          continue;
        }
        const normalized = normalizeNessyPluginManifest(cachedManifest);
        const runtimeCompatibility = normalized.value?.runtimeCompatibility;
        if (!normalized.ok || !runtimeCompatibility) continue;
        if (normalized.value?.id !== entry.pluginId || normalized.value.version !== entry.version) continue;

        try {
          if ((await computeNormalizedBundleHash(cachePath)) !== entry.bundleHash) continue;
          if (await readFile(manifestPath, 'utf-8') !== manifestText) continue;
        } catch {
          continue;
        }

        registry.plugins[index] = {
          ...entry,
          manifest: { ...entry.manifest, runtimeCompatibility },
        };
        changed = true;
      }

      if (changed) await this.writeRegistry(registry);
    });
  }

  private async placeBundle(source: string, cachePath: string, expectedHash: string): Promise<void> {
    if (existsSync(cachePath)) {
      // Content-addressed: an existing dir with this hash is already correct.
      if ((await computeNormalizedBundleHash(cachePath)) !== expectedHash) {
        throw new Error(`Cache directory content does not match its address: ${cachePath}`);
      }
      return;
    }
    await mkdir(dirname(cachePath), { recursive: true });
    const staging = `${cachePath}.staging.${randomUUID()}`;
    try {
      await cp(source, staging, BUNDLE_COPY_OPTIONS);
      await assertSafeNormalizedBundle(staging);
      if ((await computeNormalizedBundleHash(staging)) !== expectedHash) {
        throw new Error('Staged bundle failed hash verification before activation');
      }
      try {
        await rename(staging, cachePath);
      } catch (error) {
        // A concurrent install may have won the race; accept an identical dir.
        if (existsSync(cachePath) && (await computeNormalizedBundleHash(cachePath)) === expectedHash) {
          await rm(staging, { recursive: true, force: true });
          return;
        }
        throw error;
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async readJournal(): Promise<UpdateJournalV2> {
    const empty: UpdateJournalV2 = { schemaVersion: PLUGIN_STORE_SCHEMA_VERSION_V2, entries: [] };
    if (!existsSync(this.journalPath)) return empty;
    try {
      const parsed = JSON.parse(await readFile(this.journalPath, 'utf-8')) as UpdateJournalV2;
      if (parsed?.schemaVersion !== PLUGIN_STORE_SCHEMA_VERSION_V2) return empty;
      return parsed;
    } catch {
      return empty;
    }
  }

  private async writeJournal(journal: UpdateJournalV2): Promise<void> {
    await writeJsonAtomic(this.journalPath, journal);
  }

  private async writeRegistry(registry: PluginInstalledRegistryV2): Promise<void> {
    await writeJsonAtomic(this.registryPath, { ...registry, updatedAt: this.now() });
    // A minimal lockfile mirrors the active set for W10 bootstrap use.
    await writeJsonAtomic(this.lockPath, {
      schemaVersion: PLUGIN_STORE_SCHEMA_VERSION_V2,
      updatedAt: this.now(),
      active: registry.active,
      entries: registry.plugins.map(p => ({
        pluginInstanceId: p.pluginInstanceId,
        pluginKey: p.pluginKey,
        cacheRef: p.cacheRef,
      })),
    });
  }
}

async function assertSafeNormalizedBundle(directory: string): Promise<void> {
  const unsafeSymlink = await findUnsafeBundleSymlink(directory);
  if (unsafeSymlink) {
    throw new Error(`Normalized plugin bundle contains an escaping or dangling symlink: ${relative(directory, unsafeSymlink)}`);
  }
}

/**
 * Build the v2 store. Requires proof the v2 layout is ready; paths derive from
 * the managed config root (the token is a readiness proof, not a path source).
 */
export function createPluginStoreV2(
  _layout: VerifiedStorageLayoutV2,
  options: PluginStoreV2Options = {},
): PluginStoreV2 {
  return new PluginStoreV2(options);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
