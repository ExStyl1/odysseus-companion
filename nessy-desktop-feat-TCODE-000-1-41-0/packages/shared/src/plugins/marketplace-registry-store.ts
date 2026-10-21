/**
 * The plugin MARKETPLACE-REGISTRY store: the `marketplaces.json` slot, plus the
 * atomic JSON writer the plugin config slots share.
 *
 * This file used to be the V1 plugin store — installed registry, lockfile, trust
 * file, per-version cache directories, `commitStagedPlugin`, per-scope
 * enablement, rollback and uninstall. `store-v2.ts` has been the only production
 * plugin store since the W10 cutover, and F4 deleted the V1 halves: nothing but
 * V1's own commit installer and its tests read them, and both are gone. What
 * survived is the one slot V2 never took over — the bring-your-own registry list
 * that `marketplace/registry-source.ts` composes through its own factory — so the
 * file is named for that now rather than for a "store" whose v2 is a different
 * store.
 *
 * `writeJsonAtomic` stays exported here because `plugin-settings.ts` writes its
 * slots with it too. `store-v2.ts` deliberately keeps a private copy: it must not
 * take a dependency on this module to keep the retired path off its import graph.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PLUGINS_DIR } from '../workspaces/paths.ts';
import { PLUGIN_STORE_SCHEMA_VERSION } from './types.ts';

export interface PluginStoreOptions {
  rootDirectory?: string;
  now?: () => number;
}

/**
 * A bring-your-own plugin registry: a repo/URL/local folder whose catalog
 * manifest lists many plugins (Codex "marketplace" model). Persisted in the
 * `marketplaces.json` store slot; R2/R3 fetch + merge these into the browse list.
 *
 * `installedRoot` is the ABSOLUTE local clone path. It is SERVER-ONLY and MUST
 * NOT be projected to the renderer (Safe boundary enforced in R2/R3). R1 only
 * stores it.
 */
export interface PluginMarketplaceRegistry {
  /** Stable server-generated id for this registry row. */
  id: string;
  /** Raw user-supplied source string (repo/URL/local path); classified at fetch time. */
  source: string;
  /** Git ref to fetch (git sources only); maps to the staging `ref`. */
  refName?: string;
  /**
   * Scoping hint recorded on the row for R3. METADATA-ONLY in R1: the staging
   * layer clones the full repository archive with no git sparse-checkout
   * support, so these paths are not yet honored during fetch (limitation
   * recorded per plan; same discipline as U5).
   */
  sparsePaths?: string[];
  /** Human-readable label for the registry (never a path). */
  displayName?: string;
  /**
   * P3.220 — request headers for this marketplace's own catalog fetch.
   *
   * `settings-reference.md#extraknownmarketplaces`, § Marketplace source types:
   * a `url` source takes "`url` and optional `headers` and `headersHelper` for
   * authenticated access"; `plugins/host-marketplace.md#authenticate-archive-downloads`
   * places the first fetch: "Before each fetch of the marketplace's
   * `marketplace.json`".
   *
   * ALREADY FILTERED when it lands here (`plugins/request-header-filter.ts`) and
   * written only by the managed delivery path — a user-added marketplace has no
   * surface to declare one, which is deliberate: a credential typed into the
   * add box would be a credential in a store slot with no owner. The VALUES are
   * a credential: never log them, never project them to the renderer, and never
   * put them in a diagnostic.
   */
  headers?: Record<string, string>;
  /** ABSOLUTE local clone path — SERVER-ONLY, never projected to the renderer. */
  installedRoot?: string;
  addedAt: number;
  lastUpgradedAt?: number;
  /**
   * `settings-reference.md#extraknownmarketplaces`'s `autoUpdate` — whether this
   * marketplace is refreshed in the background
   * after startup. Written by the per-marketplace UI toggle
   * (`plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace`) and seeded by a managed `extraKnownMarketplaces`
   * entry that declares the key at delivery time.
   *
   * OPTIONAL, and `undefined` is a THIRD state, not a `false`: it means "nobody
   * has decided", so the reader falls through to the documented default polarity
   * (`marketplace/registry-source.ts:resolveRegistryAutoUpdate`). An existing
   * `marketplaces.json` therefore keeps working untouched, which is why
   * `PLUGIN_STORE_SCHEMA_VERSION` does not move for it — but it IS a
   * persistence-boundary change: this field lands in the on-disk file.
   *
   * The MANAGED value is deliberately not frozen into the row. Delivery is
   * idempotent (a second run short-circuits on `alreadyAdded`), so a value
   * persisted at add time could never be revised by a later policy; the managed
   * answer is re-read live from `extraKnownMarketplaces` and outranks this field.
   */
  autoUpdate?: boolean;
}

export interface PluginMarketplaceRegistryFile {
  schemaVersion: typeof PLUGIN_STORE_SCHEMA_VERSION;
  updatedAt: number;
  registries: PluginMarketplaceRegistry[];
}

export class PluginMarketplaceRegistryStore {
  readonly rootDirectory: string;
  private readonly now: () => number;

  constructor(options: PluginStoreOptions = {}) {
    this.rootDirectory = options.rootDirectory ?? getDefaultPluginStoreRoot();
    this.now = options.now ?? (() => Date.now());
  }

  get paths() {
    return {
      marketplaces: join(this.rootDirectory, 'marketplaces.json'),
    };
  }

  /**
   * P6.418 — an image CAN lay this file down, and that asymmetry with the
   * installed-plugin registry is deliberate rather than an omission.
   *
   * There is no content hash anywhere in a row: this is plain JSON, read as
   * written, with `installedRoot` naming a clone the image also bakes in. So a
   * pre-populated `marketplaces.json` is honoured by the first session with
   * nothing fetched at runtime, and no materialiser is needed here.
   *
   * The PLUGIN half is the opposite and needs one — every installed entry
   * carries a `bundleHash` the store verifies, so a hand-laid entry is silently
   * skipped. See `store-v2.ts` `seedFromDirectory`.
   */
  async readMarketplaceRegistries(): Promise<PluginMarketplaceRegistryFile> {
    return readJsonOrDefault(this.paths.marketplaces, emptyMarketplaceRegistries(this.now()), 'marketplace registries');
  }

  async writeMarketplaceRegistries(file: PluginMarketplaceRegistryFile): Promise<void> {
    await writeJsonAtomic(this.paths.marketplaces, { ...file, updatedAt: this.now() });
  }
}

export function getDefaultPluginStoreRoot(): string {
  return PLUGINS_DIR;
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
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

async function readJsonOrDefault<T>(filePath: string, fallback: T, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to read plugin ${label} at ${filePath}: invalid JSON (${error.message})`);
    }
    throw error;
  }
}

function emptyMarketplaceRegistries(updatedAt: number): PluginMarketplaceRegistryFile {
  return { schemaVersion: PLUGIN_STORE_SCHEMA_VERSION, updatedAt, registries: [] };
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
