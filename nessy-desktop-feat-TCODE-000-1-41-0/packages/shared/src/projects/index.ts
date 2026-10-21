/**
 * Projects Module
 *
 * Public exports for project management.
 *
 * UA5.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/projects/index.ts` (Apache-2.0), adapted to
 * `storage.ts`'s header: `saveProjectConfig` is module-private (the folder's writers are `createProject` and
 * `setProjectFolderFromHandle`), and the folder, column, slug, error and write-hook exports are added.
 * UA5.6 restored v0.13.4 L39–L43 and L46 (the asset operations and `UploadProjectAssetInput`).
 * Server-side only (it reaches `fs`); the renderer imports `@nessy-agent/shared/projects/types`.
 */

export type {
  KanbanColumnDef,
  ProjectConfig,
  ProjectAsset,
  ProjectFolder,
  CreateProjectInput,
  LoadedProject,
  ProjectPromptContext,
} from './types.ts';

export {
  // Path utilities
  ensureProjectsDir,
  ensureProjectAssetsDir,
  getWorkspaceProjectsPath,
  getProjectPath,
  getProjectAssetsPath,
  getProjectMemoryPath,
  MEMORY_FILENAME,
  PROJECT_SLUG_REGEX,
  isValidProjectSlug,
  // Config operations
  loadProjectConfig,
  setProjectConfigWrittenHook,
  // Folder (from a handle only) and columns
  projectFolderFromHandle,
  setProjectFolderFromHandle,
  KanbanColumnDefSchema,
  KanbanColumnsSchema,
  parseKanbanColumns,
  // Memory operations
  loadProjectMemory,
  appendProjectMemoryEntry, // UB1.12 — v0.15.1's append-only writer (one O_APPEND, no read-modify-write)
  // Load operations
  loadProject,
  loadProjectById,
  loadWorkspaceProjects,
  // Create/update/delete
  generateProjectSlug,
  createProject,
  updateProject,
  deleteProject,
  projectExists,
  ProjectStorageError,
  // Asset operations
  listProjectAssets,
  uploadProjectAsset,
  deleteProjectAsset,
  sanitizeAssetFilename,
  PROJECT_ASSET_MAX_BYTES,
} from './storage.ts';

export type { UploadProjectAssetInput } from './storage.ts';

export type {
  ProjectConfigWrittenHook,
  ProjectFolderSource,
  ProjectPatch,
  ProjectStorageErrorCode,
} from './storage.ts';
