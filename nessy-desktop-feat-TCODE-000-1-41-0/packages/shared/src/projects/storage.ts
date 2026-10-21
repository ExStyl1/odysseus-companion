/**
 * Project Storage
 *
 * CRUD operations for workspace-scoped projects.
 * Projects are stored at {workspaceRootPath}/projects/{projectSlug}/
 *
 * Note: All functions take `workspaceRootPath` (absolute path to workspace folder),
 * NOT a workspace slug. The `LoadedProject.workspaceId` is derived via basename().
 *
 * UA5.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/projects/storage.ts` (Apache-2.0) under OQ-1
 * option (a′): upstream's entity, our folder handle. Adapted (spec §12; reason (b) unless named):
 * 1. **The folder comes only from a handle.** `workingDirectory` became `folder` ({@link ProjectFolder}, the
 *    `WorkspaceDefaultProject` shape). It is written by {@link createProject}'s handle argument and by
 *    {@link setProjectFolderFromHandle}, both through {@link projectFolderFromHandle}, which persists a STABLE
 *    `projectKey` and never a process-only one. {@link updateProject} refuses a `folder` (or upstream
 *    `workingDirectory`) key with `project-folder-handle-required`, and `saveProjectConfig` is module-private so no
 *    other writer exists. On read, a legacy `workingDirectory` key is dropped (a raw path never becomes a folder),
 *    and a malformed `folder` — a relative path, a NUL, an ill-formed `projectKey` — is dropped with a debug line:
 *    `config.json` is agent-writable, and UA5.4 re-validates any folder through the handle service anyway.
 * 2. **Columns are validated with zod** ({@link KanbanColumnsSchema}): ids unique and slug-shaped, names non-empty.
 *    `updateProject` refuses a bad set with `project-columns-invalid`; on read a bad set is dropped (the board then
 *    shows the default columns, as for a project without any). An empty array stays legal: upstream's editor writes
 *    it when the last custom column is removed, meaning "the default columns".
 * 3. **No memory for a foldered project** (OQ-9, reason (c): the folder's own `.nessy-agent/MEMORY.md` does it):
 *    {@link loadProjectMemory} answers `null` for one. The folderless half is upstream's, carried for a folderless project (UA5.12).
 * 4. **A storage-v2 cleanup participant: none is needed (RESULT).** Every byte this module writes is under
 *    `{workspaceRootPath}/projects/`, inside the root `WorkspaceService.delete` stages into `.trash`, and the
 *    project-context digests (UA5.5) live in `{workspaceRootPath}/host-approvals.json`, inside the same root. The
 *    participants exist for state OUTSIDE the root (trust, policy, recents, plugin data); `entity-storage.test.ts`
 *    pins that a workspace delete removes the projects directory with no projects participant registered.
 * 5. **A `context.md` writer hook** ({@link setProjectConfigWrittenHook}): called after every config write with the
 *    written config. UA5.5 registers the mirror writer + ledger digest there; nothing is registered before it. A hook
 *    that throws fails the write's caller (the config is already on disk — the next write retries the mirror).
 * 6. **Slugs are path-safe** (`/^[a-z0-9-]+$/`, the `pages/validation.ts` rule): {@link getProjectPath} refuses any
 *    other, so `deleteProject(root, '..')` cannot reach the workspace root; reads answer `null` for one, and a
 *    loaded config's `slug` is the directory name, never the file's own value.
 * Kept verbatim otherwise: ids, slugs, timestamps, the portable `~` path form, the assets directory (created with the
 * project, as upstream).
 *
 * 7. **Assets (UA5.6)** — upstream's asset CRUD (v0.13.4 L340–L484), with two NESSY changes. (b) A name in `assets/`
 *    counts as taken when ANY entry holds it, a link included (`lstat`), and the write is exclusive (`wx`), so an
 *    upload never writes THROUGH a link planted in `assets/` (agent-writable); the listing skips links, as upstream.
 *    (UA12.113) A 16 MiB per-upload cap, {@link PROJECT_ASSET_MAX_BYTES}, refused with `project-asset-too-large`
 *    before the payload is decoded (upstream has no cap). The `sourcePath` arm is kept for in-process callers; the
 *    RPC refuses it (`rpc/projects.ts`), since a path from the wire would copy any file the server can read.
 * 8. **Append-only memory (UB1.12)** — upstream v0.15.1: {@link appendProjectMemoryEntry} is the one writer of a
 *    folderless project's `MEMORY.md` that sessions reach (`project_memory_append` behind
 *    `SessionManager.appendProjectMemoryFn`): one `appendFileSync`, no read-modify-write, so two sessions appending
 *    keep each other's notes — a Write/Edit rewrite from a session-start snapshot dropped them (measured, the
 *    row's two-session Pi drive). {@link loadProjectMemory} keeps head AND tail over budget (30 % / 70 %) instead of
 *    head only, because appended notes land at the end.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from 'fs';
import { basename, extname, isAbsolute, join } from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { atomicWriteFileSync, readJsonFileSync, getMimeType } from '../utils/files.ts';
import { generateUniqueSlug } from '../utils/slug.ts';
import { debug } from '../utils/debug.ts';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { estimateTokensDensityAware } from '../utils/large-response.ts';
import { isValidProjectKey } from './project-identity.ts';
import type { ResolvedProjectHandle } from './project-handle-service.ts';
import type {
  ProjectConfig,
  ProjectAsset,
  ProjectFolder,
  LoadedProject,
  CreateProjectInput,
  KanbanColumnDef,
} from './types.ts';

// ============================================================
// Errors and validation (UA5.2)
// ============================================================

export type ProjectStorageErrorCode =
  | 'project-folder-handle-required'
  | 'project-columns-invalid'
  | 'project-name-required'
  | 'project-slug-invalid'
  | 'project-not-found'
  | 'project-asset-too-large';

/**
 * UA12.113 — the largest asset ONE upload may write: 16 MiB, aligned with the artifacts service's own
 * single-content cap (`MAX_ARTIFACT_CONTENT_BYTES`, `artifacts/t-artifacts-client.ts`). Upstream v0.13.4 has no
 * cap (its `uploadProjectAsset`, storage.ts L406, read 2026-10-04); a wire upload would otherwise be held TWICE
 * in server memory (the base64 text and its decoded bytes), so the check runs BEFORE the decode — the base64 arm
 * measures the exact decoded length from the string (no allocation), the text arm `Buffer.byteLength`, the
 * sourcePath arm `statSync`'s size.
 */
export const PROJECT_ASSET_MAX_BYTES = 16 * 1024 * 1024;

export class ProjectStorageError extends Error {
  override readonly name = 'ProjectStorageError';

  constructor(readonly code: ProjectStorageErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Path-safe project slug — the `pages/validation.ts` `PAGE_SLUG_REGEX` rule; `slugifyName` only produces these. */
export const PROJECT_SLUG_REGEX = /^[a-z0-9-]+$/;

export function isValidProjectSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && PROJECT_SLUG_REGEX.test(slug);
}

/** One column: a slug-shaped id (`todo`, `in-progress`, `done`, upstream's `col-<8 hex>`), a non-empty name. */
export const KanbanColumnDefSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'column id must be 1–64 letters, digits, "-" or "_"'),
  name: z.string().trim().min(1, 'column name must not be empty').max(200),
  dropStatusId: z.string().min(1).max(128).optional(),
  color: z.string().min(1).max(64).optional(),
});

/** The full ordered column set; ids unique. Empty = the default columns (upstream's "last column removed"). */
export const KanbanColumnsSchema = z.array(KanbanColumnDefSchema).max(64).superRefine((columns, ctx) => {
  const seen = new Set<string>();
  for (const [index, column] of columns.entries()) {
    if (seen.has(column.id)) {
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate column id "${column.id}"` });
    }
    seen.add(column.id);
  }
});

/** Parse a column set, or throw `project-columns-invalid` naming the first issue. */
export function parseKanbanColumns(value: unknown): KanbanColumnDef[] {
  const parsed = KanbanColumnsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectStorageError('project-columns-invalid', parsed.error.issues.map(issue => issue.message).join('; '));
  }
  return parsed.data;
}

/** The handle fields a folder is built from: a resolved handle (`ProjectHandleService.resolveHandle`), nothing else. */
export type ProjectFolderSource = Pick<ResolvedProjectHandle, 'displayPath' | 'projectKey' | 'persistence'>;

/**
 * The one folder builder: the handle's display path (as `WorkspaceDefaultProject` stores it) and, for a STABLE
 * identity only, its `projectKey` — "Stable identities only. Process-only keys must not be persisted."
 */
export function projectFolderFromHandle(handle: ProjectFolderSource): ProjectFolder {
  return {
    workingDirectory: handle.displayPath,
    ...(handle.persistence === 'stable' && isValidProjectKey(handle.projectKey) ? { projectKey: handle.projectKey } : {}),
  };
}

/** A stored folder as read from an agent-writable file: kept only when well-formed (header item 1). */
function readStoredFolder(raw: unknown, projectSlug: string): ProjectFolder | undefined {
  if (raw === undefined) return undefined;
  const candidate = raw as { workingDirectory?: unknown; projectKey?: unknown } | null;
  const dir = candidate?.workingDirectory;
  const wellFormed = typeof candidate === 'object' && candidate !== null
    && typeof dir === 'string' && !dir.includes('\0')
    && (isAbsolute(dir) || dir === '~' || dir.startsWith('~/'))
    && (candidate.projectKey === undefined || isValidProjectKey(candidate.projectKey));
  if (!wellFormed) {
    debug('[loadProjectConfig] Dropped a malformed folder:', projectSlug);
    return undefined;
  }
  return {
    workingDirectory: expandPath(dir),
    ...(candidate.projectKey !== undefined ? { projectKey: candidate.projectKey as string } : {}),
  };
}

// ============================================================
// Write hook (UA5.5's context.md mirror)
// ============================================================

/** Called after every config write with the config as written (absolute folder path). */
export type ProjectConfigWrittenHook = (workspaceRootPath: string, config: ProjectConfig) => void;

let configWrittenHook: ProjectConfigWrittenHook | null = null;

/** Register (or, with `null`, remove) the hook. One registrant: UA5.5's context.md writer. */
export function setProjectConfigWrittenHook(hook: ProjectConfigWrittenHook | null): void {
  configWrittenHook = hook;
}

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Get path to workspace projects directory.
 */
export function getWorkspaceProjectsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'projects');
}

/**
 * Get path to a project folder within a workspace. The single path chokepoint: an unsafe slug throws.
 */
export function getProjectPath(workspaceRootPath: string, projectSlug: string): string {
  if (!isValidProjectSlug(projectSlug)) throw new ProjectStorageError('project-slug-invalid', JSON.stringify(projectSlug));
  return join(getWorkspaceProjectsPath(workspaceRootPath), projectSlug);
}

/**
 * Get path to a project's assets directory.
 */
export function getProjectAssetsPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), 'assets');
}

/** Filename of a project's agent-maintained "lessons learned" doc. */
export const MEMORY_FILENAME = 'MEMORY.md';

/**
 * Get path to a project's MEMORY.md. Deliberately a sibling of config.json
 * (outside assets/) so it never shows up in the asset manifest.
 */
export function getProjectMemoryPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), MEMORY_FILENAME);
}

/**
 * Ensure projects directory exists for a workspace.
 */
export function ensureProjectsDir(workspaceRootPath: string): void {
  const dir = getWorkspaceProjectsPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure a project's assets directory exists.
 */
export function ensureProjectAssetsDir(workspaceRootPath: string, projectSlug: string): void {
  const dir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load project config.json.
 * Returns null if the slug is unsafe, or the config does not exist or fails to parse.
 */
export function loadProjectConfig(
  workspaceRootPath: string,
  projectSlug: string,
): ProjectConfig | null {
  if (!isValidProjectSlug(projectSlug)) return null;
  const configPath = join(getProjectPath(workspaceRootPath, projectSlug), 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const raw = readJsonFileSync<Record<string, unknown>>(configPath);
    if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
      debug('[loadProjectConfig] Not a project config:', projectSlug);
      return null;
    }
    const { workingDirectory: _legacyRawPath, folder: rawFolder, kanbanColumns: rawColumns, ...rest } = raw;
    const config = { ...rest, slug: projectSlug } as unknown as ProjectConfig;

    // Expand portable paths on read so consumers always see absolute paths.
    const folder = readStoredFolder(rawFolder, projectSlug);
    if (folder) config.folder = folder;

    if (rawColumns !== undefined) {
      const columns = KanbanColumnsSchema.safeParse(rawColumns);
      if (columns.success) config.kanbanColumns = columns.data;
      else debug('[loadProjectConfig] Dropped an invalid column set:', projectSlug);
    }

    return config;
  } catch (error) {
    debug('[loadProjectConfig] Failed to read project config:', projectSlug, error);
    return null;
  }
}

/**
 * Save project config.json (atomic write, bumps updatedAt), then run the write hook.
 * Module-private (header item 1): the folder reaches it only from {@link projectFolderFromHandle}.
 */
function saveProjectConfig(workspaceRootPath: string, config: ProjectConfig): ProjectConfig {
  const dir = getProjectPath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const written: ProjectConfig = {
    ...config,
    updatedAt: Date.now(),
  };
  const storageConfig: ProjectConfig = { ...written };

  if (storageConfig.folder) {
    storageConfig.folder = { ...storageConfig.folder, workingDirectory: toPortablePath(storageConfig.folder.workingDirectory) };
  }

  atomicWriteFileSync(join(dir, 'config.json'), JSON.stringify(storageConfig, null, 2));
  configWrittenHook?.(workspaceRootPath, written);
  return written;
}

// ============================================================
// Memory Operations
// ============================================================

/**
 * Load a project's MEMORY.md, capped at `maxTokens` for prompt injection.
 *
 * Returns `null` when the file is missing or effectively empty. Over the budget,
 * the start and the end are kept with a marker between them: notes are appended
 * at the end ({@link appendProjectMemoryEntry}, UB1.12), while older files were
 * written newest-first at the top. The returned string — marker included — stays
 * within the token budget.
 *
 * UA5.2: `null` for a foldered project (header item 3, OQ-9).
 */
export function loadProjectMemory(
  workspaceRootPath: string,
  projectSlug: string,
  maxTokens = 5000,
): string | null {
  if (!isValidProjectSlug(projectSlug)) return null;
  if (loadProjectConfig(workspaceRootPath, projectSlug)?.folder) return null;
  const memoryPath = getProjectMemoryPath(workspaceRootPath, projectSlug);
  if (!existsSync(memoryPath)) return null;

  let content: string;
  try {
    content = readFileSync(memoryPath, 'utf-8');
  } catch (error) {
    debug('[loadProjectMemory] Failed to read MEMORY.md:', projectSlug, error);
    return null;
  }

  if (!content.trim()) return null;

  const tokens = estimateTokensDensityAware(content);
  if (tokens <= maxTokens) return content;

  // Over budget: reserve room for the marker, then keep 30% from the start and 70%
  // from the end (where new notes land). `charsPerToken` is derived from the actual
  // content so a density-corrected estimate (base64-heavy memory) still maps back to a
  // sensible character budget.
  const marker = `\n\n…[MEMORY.md is over the ${maxTokens}-token cap; its middle is omitted]…\n\n`;
  const markerTokens = estimateTokensDensityAware(marker);
  const bodyBudget = Math.max(0, maxTokens - markerTokens);
  const charsPerToken = content.length / tokens;
  const charBudget = Math.floor(bodyBudget * charsPerToken);
  const headChars = Math.floor(charBudget * 0.3);
  const head = content.slice(0, headChars).trimEnd();
  const tail = content.slice(content.length - (charBudget - headChars)).trimStart();
  return `${head}${marker}${tail}`;
}

/**
 * Append a note to a project's MEMORY.md under a `## <heading>` line, creating
 * the file. One O_APPEND write and no read-modify-write, so sessions appending
 * at the same time keep each other's notes (rewriting the file with Write/Edit
 * from a session-start snapshot lost them).
 *
 * UB1.12 — copied from craft-agents-oss `v0.15.1:packages/shared/src/projects/storage.ts`
 * `appendProjectMemoryEntry` (Apache-2.0) verbatim; the dated heading is the caller's
 * (`SessionManager`'s `## <ISO> — <session name>`).
 */
export function appendProjectMemoryEntry(
  workspaceRootPath: string,
  projectSlug: string,
  heading: string,
  note: string,
): { path: string; heading: string; bytesAppended: number } {
  const path = getProjectMemoryPath(workspaceRootPath, projectSlug);
  mkdirSync(getProjectPath(workspaceRootPath, projectSlug), { recursive: true });
  const cleanHeading = heading.replace(/\s+/g, ' ').trim();
  // Reading only to pick the blank line before the heading; the write itself never rewrites.
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const chunk = `${separator}## ${cleanHeading}\n\n${note.trim()}\n`;
  appendFileSync(path, chunk, 'utf-8');
  return { path, heading: cleanHeading, bytesAppended: Buffer.byteLength(chunk, 'utf-8') };
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single project by slug.
 */
export function loadProject(
  workspaceRootPath: string,
  projectSlug: string,
): LoadedProject | null {
  const config = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!config) return null;

  const folderPath = getProjectPath(workspaceRootPath, projectSlug);
  const assetsPath = getProjectAssetsPath(workspaceRootPath, projectSlug);
  const workspaceId = basename(workspaceRootPath);

  return {
    config,
    folderPath,
    assetsPath,
    workspaceRootPath,
    workspaceId,
  };
}

/**
 * Load a project by id (scans workspace projects for a matching id).
 * Slugs are unique within a workspace, but callers may persist the project id
 * on a session (more stable across renames).
 */
export function loadProjectById(
  workspaceRootPath: string,
  projectId: string,
): LoadedProject | null {
  const projects = loadWorkspaceProjects(workspaceRootPath);
  return projects.find((p) => p.config.id === projectId) ?? null;
}

/**
 * Load all projects for a workspace.
 */
export function loadWorkspaceProjects(workspaceRootPath: string): LoadedProject[] {
  ensureProjectsDir(workspaceRootPath);

  const projects: LoadedProject[] = [];
  const projectsDir = getWorkspaceProjectsPath(workspaceRootPath);

  if (!existsSync(projectsDir)) return projects;

  const entries = readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = loadProject(workspaceRootPath, entry.name);
    if (project) projects.push(project);
  }

  return projects;
}

// ============================================================
// Create / Update / Delete
// ============================================================

/**
 * Generate a URL-safe, workspace-unique project slug.
 */
export function generateProjectSlug(workspaceRootPath: string, name: string): string {
  const projectsDir = getWorkspaceProjectsPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingSlugs.add(entry.name);
    }
  }
  return generateUniqueSlug(name, existingSlugs, 'project');
}

/**
 * Create a new project in a workspace. The folder, if any, is a resolved handle (header item 1).
 */
export function createProject(
  workspaceRootPath: string,
  input: CreateProjectInput,
  folderHandle?: ProjectFolderSource,
): ProjectConfig {
  if (typeof input.name !== 'string' || !input.name.trim()) throw new ProjectStorageError('project-name-required');
  if ('workingDirectory' in input || 'folder' in input) throw new ProjectStorageError('project-folder-handle-required');
  const slug = generateProjectSlug(workspaceRootPath, input.name);
  const now = Date.now();

  const config: ProjectConfig = {
    id: `proj_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name,
    description: input.description,
    ...(folderHandle ? { folder: projectFolderFromHandle(folderHandle) } : {}),
    details: input.details,
    colorTheme: input.colorTheme,
    createdAt: now,
    updatedAt: now,
  };

  const written = saveProjectConfig(workspaceRootPath, config);
  ensureProjectAssetsDir(workspaceRootPath, slug);

  return written;
}

/** The fields `updateProject` may patch: never the identity, the timestamps it owns, or the folder (header item 1). */
export type ProjectPatch = Partial<Omit<ProjectConfig, 'id' | 'slug' | 'createdAt' | 'folder'>>;

const CLEARABLE_TEXT_KEYS = ['description', 'details', 'colorTheme', 'color'] as const;

/**
 * Update a project's config with a partial patch.
 * `id` and `slug` cannot be changed; a `folder` (or upstream `workingDirectory`) key is refused —
 * {@link setProjectFolderFromHandle} is the folder's only writer.
 */
export function updateProject(
  workspaceRootPath: string,
  projectSlug: string,
  patch: ProjectPatch,
): ProjectConfig {
  if ('folder' in patch || 'workingDirectory' in patch) throw new ProjectStorageError('project-folder-handle-required');
  if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) {
    throw new ProjectStorageError('project-name-required');
  }
  const kanbanColumns = patch.kanbanColumns === undefined ? undefined : parseKanbanColumns(patch.kanbanColumns);

  const existing = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!existing) {
    throw new ProjectStorageError('project-not-found', projectSlug);
  }

  const updated: ProjectConfig = {
    ...existing,
    ...patch,
    ...(kanbanColumns !== undefined ? { kanbanColumns } : {}),
    id: existing.id,
    slug: existing.slug,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  if (existing.folder) updated.folder = existing.folder;
  else delete updated.folder;
  // UA5.8 follow-up (ours): an emptied optional text field is how the project page clears it (`undefined` does
  // not survive the JSON transport), so '' removes the key — a stored '' would defeat every `color ?? fallback`.
  for (const key of CLEARABLE_TEXT_KEYS) {
    const value = updated[key];
    if (typeof value === 'string' && !value.trim()) delete updated[key];
  }

  return saveProjectConfig(workspaceRootPath, updated);
}

/**
 * Bind (or, with `null`, unbind) a project's folder from a resolved handle — the folder's only writer after
 * creation. It never touches sessions already bound to the project (UA5.4 re-validates on the next create).
 */
export function setProjectFolderFromHandle(
  workspaceRootPath: string,
  projectSlug: string,
  folderHandle: ProjectFolderSource | null,
): ProjectConfig {
  const existing = loadProjectConfig(workspaceRootPath, projectSlug);
  if (!existing) {
    throw new ProjectStorageError('project-not-found', projectSlug);
  }
  const { folder: _previous, ...rest } = existing;
  return saveProjectConfig(workspaceRootPath, {
    ...rest,
    ...(folderHandle ? { folder: projectFolderFromHandle(folderHandle) } : {}),
  });
}

/**
 * Delete a project (removes folder and all assets).
 * Caller is responsible for unsetting `projectId` on sessions that referenced it.
 * The project's bound `folder` (the user's directory) is never touched: only `projects/<slug>/` is removed.
 */
export function deleteProject(workspaceRootPath: string, projectSlug: string): void {
  const dir = getProjectPath(workspaceRootPath, projectSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

/**
 * Check if a project exists in a workspace.
 */
export function projectExists(workspaceRootPath: string, projectSlug: string): boolean {
  if (!isValidProjectSlug(projectSlug)) return false;
  return existsSync(join(getProjectPath(workspaceRootPath, projectSlug), 'config.json'));
}

// ============================================================
// Asset Operations
// ============================================================

/**
 * Sanitize an upload filename so it stays inside the assets directory.
 * Strips path separators and leading dots; falls back to a uuid name if empty.
 */
export function sanitizeAssetFilename(filename: string): string {
  // Strip path separators AND control chars (NUL/newlines/DEL) so a crafted upload name can't
  // escape the assets dir or, once listed, forge new lines in the <project_assets> prompt block.
  // (NESSY: upstream's `eslint-disable-next-line no-control-regex` dropped — our config reports it unused.)
  const base = basename(filename).replace(/[\\/\x00-\x1f\x7f]+/g, '').replace(/^\.+/, '');
  if (!base) return `asset_${randomUUID().slice(0, 8)}`;
  return base.slice(0, 255);
}

/**
 * List all assets for a project (sorted newest first).
 */
export function listProjectAssets(
  workspaceRootPath: string,
  projectSlug: string,
): ProjectAsset[] {
  ensureProjectAssetsDir(workspaceRootPath, projectSlug);

  const assetsDir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  if (!existsSync(assetsDir)) return [];

  const assets: ProjectAsset[] = [];
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = join(assetsDir, entry.name);
    try {
      const stats = statSync(filePath);
      assets.push({
        filename: entry.name,
        sizeBytes: stats.size,
        mimeType: getMimeType(filePath),
        uploadedAt: stats.mtimeMs,
        absolutePath: filePath,
      });
    } catch (error) {
      debug('[listProjectAssets] Failed to stat asset:', filePath, error);
    }
  }

  assets.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return assets;
}

export interface UploadProjectAssetInput {
  filename: string;
  /** Base64-encoded contents (preferred for cross-process IPC) */
  base64?: string;
  /** Raw text contents (for small text/markdown uploads) */
  text?: string;
  /** Absolute source path on disk; copied into the assets folder (in-process callers only: the RPC refuses it) */
  sourcePath?: string;
}

/** UA12.113 — the exact decoded length of a base64 string, computed WITHOUT allocating the decoded bytes. */
function base64DecodedLength(encoded: string): number {
  let padding = 0;
  for (let index = encoded.length - 1; index >= 0 && encoded[index] === '='; index--) padding++;
  return Math.max(0, Math.floor(((encoded.length - padding) * 3) / 4));
}

/**
 * Upload (write) an asset into the project's assets directory.
 * Accepts base64, text, or a sourcePath to copy from.
 * Resolves filename collisions by appending `-{n}` before the extension.
 */
export function uploadProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  input: UploadProjectAssetInput,
): ProjectAsset {
  if (!projectExists(workspaceRootPath, projectSlug)) {
    throw new ProjectStorageError('project-not-found', projectSlug);
  }

  ensureProjectAssetsDir(workspaceRootPath, projectSlug);

  const safeName = sanitizeAssetFilename(input.filename);
  const assetsDir = getProjectAssetsPath(workspaceRootPath, projectSlug);
  const targetPath = resolveUniqueAssetPath(assetsDir, safeName);

  // NESSY (header item 7): exclusive create — never through an entry that appeared since the name was chosen.
  if (input.base64 !== undefined) {
    // UA12.113 — measured from the string WITHOUT decoding: an over-cap payload is refused before the decoded
    // bytes exist (the double hold the cap exists for). `Buffer.from(_, 'base64')` ignores invalid characters,
    // so the estimate can only run HIGH — conservative for a cap.
    const decoded = base64DecodedLength(input.base64);
    if (decoded > PROJECT_ASSET_MAX_BYTES) {
      throw new ProjectStorageError('project-asset-too-large', `${decoded} decoded bytes`);
    }
    writeFileSync(targetPath, Buffer.from(input.base64, 'base64'), { flag: 'wx' });
  } else if (input.text !== undefined) {
    const bytes = Buffer.byteLength(input.text, 'utf-8');
    if (bytes > PROJECT_ASSET_MAX_BYTES) {
      throw new ProjectStorageError('project-asset-too-large', `${bytes} bytes`);
    }
    writeFileSync(targetPath, input.text, { encoding: 'utf-8', flag: 'wx' });
  } else if (input.sourcePath) {
    if (!existsSync(input.sourcePath)) {
      throw new Error(`Source file does not exist: ${input.sourcePath}`);
    }
    const size = statSync(input.sourcePath).size;
    if (size > PROJECT_ASSET_MAX_BYTES) {
      throw new ProjectStorageError('project-asset-too-large', `${size} bytes`);
    }
    const data = readFileSync(input.sourcePath);
    writeFileSync(targetPath, data, { flag: 'wx' });
  } else {
    throw new Error('uploadProjectAsset requires one of: base64, text, sourcePath');
  }

  const stats = statSync(targetPath);
  return {
    filename: basename(targetPath),
    sizeBytes: stats.size,
    mimeType: getMimeType(targetPath),
    uploadedAt: stats.mtimeMs,
    absolutePath: targetPath,
  };
}

/**
 * Delete a single asset from a project (no-op if missing).
 */
export function deleteProjectAsset(
  workspaceRootPath: string,
  projectSlug: string,
  filename: string,
): void {
  const safe = sanitizeAssetFilename(filename);
  const target = join(getProjectAssetsPath(workspaceRootPath, projectSlug), safe);
  if (!existsSync(target)) return;

  // Refuse to follow path traversal — `safe` should already be the bare filename.
  if (basename(target) !== safe) {
    throw new Error(`Refusing to delete asset outside assets directory: ${filename}`);
  }

  try {
    unlinkSync(target);
  } catch (error) {
    debug('[deleteProjectAsset] Failed to delete asset:', target, error);
    throw error;
  }
}

/** NESSY (header item 7): true when ANY directory entry holds `path` — a symlink, dangling or not, included. */
function assetEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a target path inside `assetsDir` that does not collide with existing files.
 * Returns the original name if free; otherwise appends `-2`, `-3`, ... before the extension.
 */
function resolveUniqueAssetPath(assetsDir: string, filename: string): string {
  const candidate = join(assetsDir, filename);
  if (!assetEntryExists(candidate)) return candidate;

  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;

  let counter = 2;
  while (assetEntryExists(join(assetsDir, `${stem}-${counter}${ext}`))) counter++;
  return join(assetsDir, `${stem}-${counter}${ext}`);
}
