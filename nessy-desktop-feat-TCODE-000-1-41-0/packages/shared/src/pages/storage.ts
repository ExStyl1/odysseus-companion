/**
 * Page Storage
 *
 * CRUD operations for workspace-scoped pages.
 * Pages are stored at {workspaceRootPath}/pages/{pageSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace
 * folder), NOT a workspace slug — same contract as projects/storage.ts.
 *
 * Cross-process contract: refresh scripts own data/store.sqlite (never read
 * it from here); the host only reads data/snapshot.json, and page.json is
 * always the last file touched (the watcher's completion marker).
 *
 * UA6.1 — copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/storage.ts` (Apache-2.0), adapted:
 * - dropped: v0.13.4 L54–L55 (`DEFAULT_PAGE_GRANT_TTL_MS`), L519–L565 (`AddPageGrantInput`, `addPageGrant`) and
 *   L637–L658 (`revokePageGrant`) — reason (b): an agent can write page.json, so grants are never kept there; the
 *   host ledger holds them (`approvals/host-approvals.ts`, kind `page-grant`; UA9.2 issues and revokes them).
 * - dropped: v0.13.4 L613–L635 (`setPageShareState`, the Craft publication pointer writer) — reason (a). UA6.7:
 *   a page's publication lives in the workspace's artifact registry (`artifacts/registry.ts`, a `'page'` row), and
 *   `loadPage` / `loadWorkspacePages` join it onto `LoadedPage.publication` ({@link pagePublicationFromRegistry}).
 * - `loadPageConfig` and `savePageConfig` strip a `grants` or `share` key ({@link stripUnownedPageFields}): a
 *   page.json written by hand or by an older build keeps neither past the next read or write.
 * - `deletePageLocal` (end of file) is `v0.13.4:packages/shared/src/pages/publisher.ts` L422–L471
 *   (`deletePageWithUnpublish`); the Craft share-service client is dropped under reason (a) (spec §3), and UA6.7's
 *   unpublish (one DELETE on t-artifacts) comes in as the caller's `unpublish` port. It is the single implementation
 *   behind `pages:delete` and `delete_page` (UA6.2, UA6.4).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'fs';
import { basename, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import type {
  PageConfig,
  PageDataSnapshot,
  PagePublication,
  PageRefreshStatus,
  PageThumbnailInfo,
} from '@nessy-agent/core';
import { findPageRegistryEntry, readArtifactRegistry, type ArtifactRegistryEntry } from '../artifacts/registry.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { generateUniqueSlug } from '../utils/slug.ts';
import { debug } from '../utils/debug.ts';
import { validatePageConfig, assertValidPageSlug, isValidPageSlug } from './validation.ts';
import type { CreatePageInput, LoadedPage } from './types.ts';

/** Filename of a page's config (also the watcher's completion marker) */
export const PAGE_CONFIG_FILENAME = 'page.json';
/** Filename of a page's self-contained HTML content */
export const PAGE_CONTENT_FILENAME = 'index.html';
/** Filename of the atomically-written cross-process data snapshot */
export const PAGE_SNAPSHOT_FILENAME = 'snapshot.json';
/** Filename of the script-private SQLite working store */
export const PAGE_STORE_FILENAME = 'store.sqlite';
/**
 * Filename of the cached preview poster. JPEG, not WebP: Electron's
 * `nativeImage` can encode JPEG/PNG natively but not WebP, and adding a WebP
 * encoder dependency isn't worth it for a tile poster.
 */
export const PAGE_THUMBNAIL_FILENAME = 'thumbnail.jpg';

/** Max stored length for lastRefresh.error */
const REFRESH_ERROR_MAX_LENGTH = 2000;

/**
 * The page.json keys this module never keeps (UA6.1, spec §3 and §15): upstream's `grants` (reason (b) — an
 * agent can write page.json; grants live in the host ledger) and its Craft publication pointer `share` (reason (a);
 * UA6.7's own lives in the artifact registry). Applied on every read and every write, so neither survives a round trip.
 */
const UNOWNED_PAGE_CONFIG_KEYS = ['grants', 'share'] as const;

/** Return `config` without the {@link UNOWNED_PAGE_CONFIG_KEYS}; the input is not mutated. */
export function stripUnownedPageFields(config: PageConfig): PageConfig {
  if (!UNOWNED_PAGE_CONFIG_KEYS.some((key) => key in config)) return config;
  const clean = { ...config } as Record<string, unknown>;
  for (const key of UNOWNED_PAGE_CONFIG_KEYS) delete clean[key];
  return clean as unknown as PageConfig;
}

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Get path to workspace pages directory.
 */
export function getWorkspacePagesPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'pages');
}

/**
 * Get path to a page folder within a workspace.
 */
export function getPagePath(workspaceRootPath: string, pageSlug: string): string {
  // Single chokepoint: every page path (config/content/data/snapshot/store/
  // thumbnail, and thus delete/read/write) derives from here, so validating the
  // slug once guarantees no on-disk path can escape {workspaceRoot}/pages/.
  assertValidPageSlug(pageSlug);
  return join(getWorkspacePagesPath(workspaceRootPath), pageSlug);
}

/**
 * Get path to a page's page.json.
 */
export function getPageConfigPath(workspaceRootPath: string, pageSlug: string): string {
  return join(getPagePath(workspaceRootPath, pageSlug), PAGE_CONFIG_FILENAME);
}

/**
 * Get path to a page's index.html content.
 */
export function getPageContentPath(workspaceRootPath: string, pageSlug: string): string {
  return join(getPagePath(workspaceRootPath, pageSlug), PAGE_CONTENT_FILENAME);
}

/**
 * Get path to a page's data directory.
 */
export function getPageDataPath(workspaceRootPath: string, pageSlug: string): string {
  return join(getPagePath(workspaceRootPath, pageSlug), 'data');
}

/**
 * Get path to a page's data/snapshot.json (cross-process data contract).
 */
export function getPageSnapshotPath(workspaceRootPath: string, pageSlug: string): string {
  return join(getPageDataPath(workspaceRootPath, pageSlug), PAGE_SNAPSHOT_FILENAME);
}

/**
 * Get path to a page's data/store.sqlite (script-private; see pages/data-store.ts).
 */
export function getPageStorePath(workspaceRootPath: string, pageSlug: string): string {
  return join(getPageDataPath(workspaceRootPath, pageSlug), PAGE_STORE_FILENAME);
}

/**
 * Get path to a page's cached preview poster (pages/{slug}/thumbnail.jpg).
 */
export function getPageThumbnailPath(workspaceRootPath: string, pageSlug: string): string {
  return join(getPagePath(workspaceRootPath, pageSlug), PAGE_THUMBNAIL_FILENAME);
}

/**
 * Ensure pages directory exists for a workspace.
 */
export function ensurePagesDir(workspaceRootPath: string): void {
  const dir = getWorkspacePagesPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure a page's data directory exists.
 */
export function ensurePageDataDir(workspaceRootPath: string, pageSlug: string): void {
  const dir = getPageDataPath(workspaceRootPath, pageSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load page.json.
 * Returns null if the config does not exist or fails to parse.
 */
export function loadPageConfig(
  workspaceRootPath: string,
  pageSlug: string,
): PageConfig | null {
  // Lenient read: an unsafe slug is simply "not found" (never a thrown path
  // traversal). This also keeps loadPage/GET_ONE's id-or-slug fallback working
  // — an id like `page_ab12` isn't a valid slug, so it falls through to loadPageById.
  if (!isValidPageSlug(pageSlug)) return null;
  const configPath = getPageConfigPath(workspaceRootPath, pageSlug);
  if (!existsSync(configPath)) return null;

  try {
    return stripUnownedPageFields(readJsonFileSync<PageConfig>(configPath));
  } catch (error) {
    debug('[loadPageConfig] Failed to read page config:', pageSlug, error);
    return null;
  }
}

/**
 * Save page.json (validated, atomic write, bumps updatedAt).
 *
 * @throws Error if the config fails schema validation
 */
export function savePageConfig(workspaceRootPath: string, config: PageConfig): void {
  const storageConfig: PageConfig = {
    ...stripUnownedPageFields(config),
    updatedAt: Date.now(),
  };

  const validation = validatePageConfig(storageConfig);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    debug('[savePageConfig] Validation failed:', errorMessages);
    throw new Error(`Invalid page config: ${errorMessages}`);
  }

  const dir = getPagePath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  atomicWriteFileSync(join(dir, PAGE_CONFIG_FILENAME), JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single page by slug.
 */
export function loadPage(
  workspaceRootPath: string,
  pageSlug: string,
): LoadedPage | null {
  return loadPageJoined(workspaceRootPath, pageSlug, readRegistryForPages(workspaceRootPath));
}

/** UA6.7 — `loadPage` against registry rows read once by the caller (a list reads the file once, not per page). */
function loadPageJoined(
  workspaceRootPath: string,
  pageSlug: string,
  registry: readonly ArtifactRegistryEntry[],
): LoadedPage | null {
  const config = loadPageConfig(workspaceRootPath, pageSlug);
  if (!config) return null;
  const publication = pagePublicationFromRegistry(registry, config.id);

  return {
    config,
    folderPath: getPagePath(workspaceRootPath, pageSlug),
    contentPath: getPageContentPath(workspaceRootPath, pageSlug),
    dataPath: getPageDataPath(workspaceRootPath, pageSlug),
    snapshotPath: getPageSnapshotPath(workspaceRootPath, pageSlug),
    workspaceRootPath,
    workspaceId: basename(workspaceRootPath),
    ...(publication ? { publication } : {}),
  };
}

/**
 * UA6.7 — the workspace's artifact registry for the page loaders. An unreadable registry is read as empty HERE (a
 * page list must still load; no page then shows a publication) — the registry module itself never overwrites it, and
 * the Published pages list says it could not be read.
 */
function readRegistryForPages(workspaceRootPath: string): ArtifactRegistryEntry[] {
  try {
    return readArtifactRegistry(workspaceRootPath);
  } catch {
    return [];
  }
}

/** UA6.7 — the page's publication from the registry rows (its `'page'` row, keyed by the page's stable id). */
export function pagePublicationFromRegistry(
  registry: readonly ArtifactRegistryEntry[],
  pageId: string,
): PagePublication | undefined {
  const entry = findPageRegistryEntry(registry, pageId);
  if (!entry?.page) return undefined;
  return {
    artifactId: entry.id,
    url: entry.url,
    expiresAt: entry.expiresAt,
    publishedAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    contentDigest: entry.contentDigest,
    ...(entry.page.contentDigest !== undefined ? { pageContentDigest: entry.page.contentDigest } : {}),
    includesData: entry.page.includesData,
    ...(entry.pendingDelete ? { pendingDelete: true } : {}),
  };
}

/**
 * Load a page by id (scans workspace pages for a matching id).
 */
export function loadPageById(
  workspaceRootPath: string,
  pageId: string,
): LoadedPage | null {
  const pages = loadWorkspacePages(workspaceRootPath);
  return pages.find((p) => p.config.id === pageId) ?? null;
}

/**
 * Load all pages for a workspace.
 */
export function loadWorkspacePages(workspaceRootPath: string): LoadedPage[] {
  const pages: LoadedPage[] = [];
  const pagesDir = getWorkspacePagesPath(workspaceRootPath);

  if (!existsSync(pagesDir)) return pages;

  const entries = readdirSync(pagesDir, { withFileTypes: true });
  const registry = readRegistryForPages(workspaceRootPath);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const page = loadPageJoined(workspaceRootPath, entry.name, registry);
    if (page) pages.push(page);
  }

  return pages;
}

/**
 * Check if a page exists in a workspace.
 */
export function pageExists(workspaceRootPath: string, pageSlug: string): boolean {
  if (!isValidPageSlug(pageSlug)) return false;
  return existsSync(getPageConfigPath(workspaceRootPath, pageSlug));
}

// ============================================================
// Create / Update / Delete
// ============================================================

/**
 * Generate a URL-safe, workspace-unique page slug.
 */
export function generatePageSlug(workspaceRootPath: string, name: string): string {
  const pagesDir = getWorkspacePagesPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(pagesDir)) {
    for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingSlugs.add(entry.name);
    }
  }
  return generateUniqueSlug(name, existingSlugs, 'page');
}

/**
 * Create a new page in a workspace.
 */
export function createPage(
  workspaceRootPath: string,
  input: CreatePageInput,
): PageConfig {
  const slug = generatePageSlug(workspaceRootPath, input.name);
  const now = Date.now();

  let config: PageConfig = {
    schemaVersion: 1,
    id: `page_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name,
    description: input.description,
    kind: input.kind ?? 'interactive',
    projectId: input.projectId,
    refresh: input.refresh,
    createdAt: now,
    updatedAt: now,
  };

  savePageConfig(workspaceRootPath, config);
  ensurePageDataDir(workspaceRootPath, slug);

  if (input.content !== undefined) {
    config = savePageContent(workspaceRootPath, slug, input.content);
  }

  return config;
}

/**
 * Patch shape for updatePage. The optional fields additionally accept an
 * explicit `null` meaning "clear this field": `undefined` cannot cross a JSON
 * transport (the RPC layer drops it, so the key never reaches the merge) and
 * a bare missing key must keep meaning "leave unchanged".
 */
export type UpdatePagePatch = Partial<
  // The null-clearable fields are OMITTED here and re-added below — an
  // intersection would intersect their property types ((string | undefined) &
  // (string | null) = string) and silently forbid the null again.
  Omit<
    PageConfig,
    'schemaVersion' | 'id' | 'slug' | 'createdAt' | 'contentDigest' | 'lastRefresh' | 'thumbnail' | 'projectId' | 'description' | 'refresh'
  >
> & {
  projectId?: string | null;
  description?: string | null;
  refresh?: PageConfig['refresh'] | null;
};

/** Patch fields where an explicit null means "clear" (see UpdatePagePatch) */
const NULL_CLEARABLE_PAGE_FIELDS = ['projectId', 'description', 'refresh'] as const;

/**
 * Update a page's config with a partial patch.
 * `id`, `slug`, and the managed fields (`contentDigest`, `lastRefresh`,
 * `thumbnail`) cannot be changed here — use savePageContent /
 * recordPageRefresh / recordPageThumbnail instead.
 *
 * This is the single normalization point for null-clears — the pages:update
 * RPC and the update_page session tool both pass their patches through
 * verbatim, so "null clears" behaves identically from every caller.
 */
export function updatePage(
  workspaceRootPath: string,
  pageSlug: string,
  patch: UpdatePagePatch,
): PageConfig {
  const existing = loadPageConfig(workspaceRootPath, pageSlug);
  if (!existing) {
    throw new Error(`Page not found: ${pageSlug}`);
  }

  // Null → PRESENT undefined key: the spread below then overrides the existing
  // value, and the validate-on-write schema sees a valid absent optional.
  // Keys not in the patch stay absent and leave the field unchanged.
  const normalized = { ...patch } as Partial<PageConfig>;
  for (const field of NULL_CLEARABLE_PAGE_FIELDS) {
    if (patch[field] === null) (normalized as Record<string, unknown>)[field] = undefined;
  }

  const updated: PageConfig = {
    ...existing,
    ...normalized,
    schemaVersion: existing.schemaVersion,
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    contentDigest: existing.contentDigest,
    lastRefresh: existing.lastRefresh,
    thumbnail: existing.thumbnail,
    updatedAt: Date.now(),
  };

  savePageConfig(workspaceRootPath, updated);
  return updated;
}

/**
 * Delete a page (removes folder including content and data).
 * `force` rides over mid-tree races (a file vanishing between listing and
 * unlink, Windows EBUSY retries) instead of aborting half-deleted.
 */
export function deletePage(workspaceRootPath: string, pageSlug: string): void {
  const dir = getPagePath(workspaceRootPath, pageSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Unbind a project from all pages that reference it (project deletion).
 * Mirrors session unbinding. Returns the number of pages touched.
 */
export function unbindProjectFromPages(workspaceRootPath: string, projectId: string): number {
  let touched = 0;
  for (const page of loadWorkspacePages(workspaceRootPath)) {
    if (page.config.projectId !== projectId) continue;
    const { projectId: _removed, ...rest } = page.config;
    savePageConfig(workspaceRootPath, rest);
    touched++;
  }
  return touched;
}

// ============================================================
// Content Operations
// ============================================================

/**
 * Compute the sha256 hex digest of page content.
 * Grants and render leases are bound to this digest.
 */
export function computePageContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Load a page's index.html content.
 * Returns null if the file does not exist or cannot be read.
 */
export function loadPageContent(workspaceRootPath: string, pageSlug: string): string | null {
  if (!isValidPageSlug(pageSlug)) return null;
  const contentPath = getPageContentPath(workspaceRootPath, pageSlug);
  if (!existsSync(contentPath)) return null;

  try {
    return readFileSync(contentPath, 'utf-8');
  } catch (error) {
    debug('[loadPageContent] Failed to read page content:', pageSlug, error);
    return null;
  }
}

/**
 * Save a page's index.html content (atomic) and update contentDigest.
 *
 * Grants (kept in the host ledger, UA9.2) are bound to the previous digest,
 * so they stop validating until re-approved — that is the security model,
 * not an oversight.
 */
export function savePageContent(
  workspaceRootPath: string,
  pageSlug: string,
  content: string,
): PageConfig {
  const existing = loadPageConfig(workspaceRootPath, pageSlug);
  if (!existing) {
    throw new Error(`Page not found: ${pageSlug}`);
  }

  atomicWriteFileSync(getPageContentPath(workspaceRootPath, pageSlug), content);

  const updated: PageConfig = {
    ...existing,
    contentDigest: computePageContentDigest(content),
    updatedAt: Date.now(),
  };
  savePageConfig(workspaceRootPath, updated);
  return updated;
}

// ============================================================
// Data Operations
// ============================================================

/**
 * Read a page's data/snapshot.json.
 * Returns null when missing or malformed (a refresh may not have run yet).
 */
export function readPageDataSnapshot(
  workspaceRootPath: string,
  pageSlug: string,
): PageDataSnapshot | null {
  if (!isValidPageSlug(pageSlug)) return null;
  const snapshotPath = getPageSnapshotPath(workspaceRootPath, pageSlug);
  if (!existsSync(snapshotPath)) return null;

  try {
    return readJsonFileSync<PageDataSnapshot>(snapshotPath);
  } catch (error) {
    debug('[readPageDataSnapshot] Failed to read snapshot:', pageSlug, error);
    return null;
  }
}

/**
 * Record the outcome of a refresh run on page.json.
 *
 * This is deliberately the LAST write of a refresh flow: the config watcher
 * reacts to page.json (and only page.json) with a `pages:changed` push, so
 * observers never see a half-written data/ directory as complete.
 */
export function recordPageRefresh(
  workspaceRootPath: string,
  pageSlug: string,
  status: PageRefreshStatus,
): PageConfig {
  const existing = loadPageConfig(workspaceRootPath, pageSlug);
  if (!existing) {
    throw new Error(`Page not found: ${pageSlug}`);
  }

  const updated: PageConfig = {
    ...existing,
    lastRefresh: {
      ...status,
      error: status.error?.slice(0, REFRESH_ERROR_MAX_LENGTH),
    },
    updatedAt: Date.now(),
  };
  savePageConfig(workspaceRootPath, updated);
  return updated;
}

// ============================================================
// Thumbnail (cached poster)
// ============================================================

/**
 * A cached poster is fresh only when it was captured for the page's CURRENT
 * content digest. Data-only refreshes deliberately do not invalidate it (v1).
 * Single source of truth for the freshness check (RPC + capturer both use it).
 */
export function isThumbnailFresh(
  config: Pick<PageConfig, 'contentDigest' | 'thumbnail'>,
): boolean {
  return (
    config.thumbnail !== undefined &&
    config.contentDigest !== undefined &&
    config.thumbnail.digest === config.contentDigest
  );
}

/**
 * Record (or clear) a page's cached-poster pointer (the managed `thumbnail`
 * field). Written only by the thumbnail capture flow after the .jpg is on disk;
 * stamping page.json last makes the config watcher emit `pages:changed` so open
 * grids pick up the fresh poster. Pass `undefined` to clear (e.g. capture
 * failed or content removed).
 */
export function recordPageThumbnail(
  workspaceRootPath: string,
  pageSlug: string,
  thumbnail: PageThumbnailInfo | undefined,
): PageConfig {
  const existing = loadPageConfig(workspaceRootPath, pageSlug);
  if (!existing) {
    throw new Error(`Page not found: ${pageSlug}`);
  }

  const { thumbnail: _previous, ...rest } = existing;
  const updated: PageConfig = {
    ...rest,
    ...(thumbnail ? { thumbnail } : {}),
    updatedAt: Date.now(),
  };
  savePageConfig(workspaceRootPath, updated);
  return updated;
}

// ============================================================
// Local delete (the single delete implementation)
// ============================================================

/** Outcome of {@link deletePageLocal} (the shape of upstream's `DeletePageOutcome`). */
export interface DeletePageOutcome {
  /** True when the page was published and the remote copy may still exist (UA6.7: its DELETE did not go through). */
  publicCopyMayRemain: boolean;
}

/** UA6.7 — the caller's unpublish step (one DELETE through the artifact registry); never throws on purpose. */
export type PageUnpublishBeforeDelete = (page: { slug: string; publication: PagePublication }) => Promise<{ publicCopyMayRemain: boolean }>;

/**
 * Delete a page, unpublishing it first when it has a publication — the single implementation behind BOTH the
 * `pages:delete` RPC and the `delete_page` session tool, so the two paths cannot drift (unpublish-before-delete is a
 * policy, not a handler detail).
 *
 * Ported from `v0.13.4:packages/shared/src/pages/publisher.ts` `deletePageWithUnpublish` (Apache-2.0). The Craft
 * share-service client is dropped under reason (a); UA6.7's unpublish is the caller's `options.unpublish` (one
 * DELETE through the registry, a failure kept as a pending deletion — `server-core/src/pages/page-publishing.ts`).
 * As upstream, an unpublish failure never blocks the local delete: it is folded into `publicCopyMayRemain` and
 * logged. A published page deleted by a caller that brings no `unpublish` port reports `publicCopyMayRemain: true`
 * — it never claims a copy went offline that nobody asked to take down. `workspaceId` is unused (upstream's
 * publisher keyed its vault by it).
 *
 * @throws Error with upstream's sentences when the folder cannot be removed — `Deleting the local page folder
 *   failed: <detail>`, or `The page was unpublished, but deleting the local folder failed: <detail>` — never a bare
 *   fs error.
 */
export async function deletePageLocal(
  workspaceRootPath: string,
  _workspaceId: string,
  pageSlug: string,
  options?: { log?: (message: string) => void; unpublish?: PageUnpublishBeforeDelete },
): Promise<DeletePageOutcome> {
  let publicCopyMayRemain = false;
  const publication = loadPage(workspaceRootPath, pageSlug)?.publication;
  if (publication) {
    if (!options?.unpublish) {
      publicCopyMayRemain = true;
      options?.log?.(`Page ${pageSlug} is published at ${publication.url}; this delete path cannot take that copy down.`);
    } else {
      try {
        publicCopyMayRemain = (await options.unpublish({ slug: pageSlug, publication })).publicCopyMayRemain;
      } catch (error) {
        publicCopyMayRemain = true;
        options.log?.(
          `Unpublish before delete failed for ${pageSlug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  try {
    deletePage(workspaceRootPath, pageSlug);
  } catch (error) {
    // The unpublish (if any) already happened by now — a bare fs error would
    // misreport that state and send the user retrying the remote half too.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      publication && !publicCopyMayRemain
        ? `The page was unpublished, but deleting the local folder failed: ${detail}`
        : `Deleting the local page folder failed: ${detail}`,
    );
  }
  return { publicCopyMayRemain };
}
