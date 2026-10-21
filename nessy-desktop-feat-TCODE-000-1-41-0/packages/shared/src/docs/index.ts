/**
 * Documentation Utilities
 *
 * Provides access to built-in documentation that Claude can reference
 * when performing configuration tasks (sources, agents, permissions, etc.).
 *
 * Docs are stored at ~/.nessy-agent/docs/ and synced from bundled assets.
 * Source content lives in apps/electron/resources/docs/*.md for easier editing.
 */

import { join, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { resolveContainedPath } from '../workspaces/paths.ts';

const DOCS_DIR = join(CONFIG_DIR, 'docs');

// Track if docs have been initialized this session (prevents re-init on hot reload)
let docsInitialized = false;

// Resolve the bundled docs assets directory using the shared asset resolver.
// Handles all environments: dev (resources/docs), bundled (dist/resources/docs),
// and packaged Electron (setBundledAssetsRoot sets the base path at startup).
function getAssetsDir(): string {
  return getBundledAssetsDir('docs')
    // Fallback: development path (will fail gracefully if files don't exist)
    ?? join(process.cwd(), 'resources', 'docs');
}

/**
 * Load bundled docs from asset files.
 * Called once at module initialization.
 * Returns empty strings if files don't exist (graceful degradation).
 */
function loadBundledDocs(): Record<string, string> {
  const assetsDir = getAssetsDir();
  const docs: Record<string, string> = {};

  // Auto-discover all files in the bundled docs directory.
  // No hardcoded list — any file dropped into resources/docs/ is synced automatically.
  let files: string[];
  try {
    files = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  } catch {
    console.warn(`[docs] Could not read assets dir: ${assetsDir}`);
    return docs;
  }

  for (const filename of files) {
    const filePath = join(assetsDir, filename);
    try {
      docs[filename] = readFileSync(filePath, 'utf-8');
    } catch (error) {
      console.error(`[docs] Failed to load ${filename}:`, error);
    }
  }

  return docs;
}

// Lazy-loaded bundled docs cache.
// IMPORTANT: Must NOT load at module initialization because setBundledAssetsRoot()
// hasn't been called yet. Loading eagerly causes empty docs on fresh install.
let _bundledDocs: Record<string, string> | null = null;

/**
 * Get bundled docs, loading them lazily on first access.
 * This ensures docs are loaded AFTER setBundledAssetsRoot() has been called.
 */
function getBundledDocs(): Record<string, string> {
  if (_bundledDocs === null) {
    _bundledDocs = loadBundledDocs();
  }
  return _bundledDocs;
}

/**
 * Get the docs directory path
 */
export function getDocsDir(): string {
  return DOCS_DIR;
}

/**
 * Get path to a specific doc file
 */
export function getDocPath(filename: string): string {
  return resolveContainedPath(DOCS_DIR, filename);
}

/**
 * Human-readable display form of the ACTIVE config root, for prompt/display
 * text only. Collapses the home prefix to `~` so the default root renders as
 * `~/.nessy-agent`, but honors `NESSY_CONFIG_DIR` so a custom/multi-instance
 * root (e.g. `~/.nessy-agent-1` or a test temp dir) is emitted correctly and
 * the system prompt never tells the agent to read docs from the wrong directory
 * (W6). Do NOT use APP_ROOT for real filesystem reads/writes — use CONFIG_DIR.
 */
function toDisplayRoot(configDir: string): string {
  const home = homedir();
  if (configDir === home) return '~';
  if (configDir.startsWith(home + sep)) return `~${configDir.slice(home.length)}`;
  return configDir;
}

export const APP_ROOT = toDisplayRoot(CONFIG_DIR);

/**
 * Documentation file references for use in error messages and tool descriptions.
 * Use these constants instead of hardcoding paths to keep references in sync.
 */
export const DOC_REFS = {
  appRoot: APP_ROOT,
  sources: `${APP_ROOT}/docs/sources.md`,
  permissions: `${APP_ROOT}/docs/permissions.md`,
  skills: `${APP_ROOT}/docs/skills.md`,
  themes: `${APP_ROOT}/docs/themes.md`,
  statuses: `${APP_ROOT}/docs/statuses.md`,
  labels: `${APP_ROOT}/docs/labels.md`,
  toolIcons: `${APP_ROOT}/docs/tool-icons.md`,
  automations: `${APP_ROOT}/docs/automations.md`,
  hooks: `${APP_ROOT}/docs/automations.md`,
  tasks: `${APP_ROOT}/docs/automations.md`,
  // UA4.10 — the task board guide (`apps/electron/resources/docs/board.md`): the board, tasks and subtasks, and
  // `create_board_task`. `tasks` above stays the automations guide (upstream's key, a different meaning).
  board: `${APP_ROOT}/docs/board.md`,
  mermaid: `${APP_ROOT}/docs/mermaid.md`,
  dataTables: `${APP_ROOT}/docs/data-tables.md`,
  htmlPreview: `${APP_ROOT}/docs/html-preview.md`,
  pdfPreview: `${APP_ROOT}/docs/pdf-preview.md`,
  imagePreview: `${APP_ROOT}/docs/image-preview.md`,
  markdownPreview: `${APP_ROOT}/docs/markdown-preview.md`,
  llmTool: `${APP_ROOT}/docs/llm-tool.md`,
  // UA6.5 — the Pages authoring guide (`apps/electron/resources/docs/pages.md`), read by the page tools' descriptions
  // and the "## Pages" prompt section on all three runtimes.
  pages: `${APP_ROOT}/docs/pages.md`,
  // UA1.21 shipped the guide; UA12.59 names it in the Configuration Documentation table — the artifact publishing
  // guide (`apps/electron/resources/docs/artifacts.md`): the consent card, the link as the only access control,
  // and the residues of publishing.
  artifacts: `${APP_ROOT}/docs/artifacts.md`,
  browserTools: `${APP_ROOT}/docs/browser-tools.md`,
  nessyCli: `${APP_ROOT}/docs/nessy-general-agent.md`,
  // UB6.1b — the decision model guide (`apps/electron/resources/docs/decisions.md`): the wire,
  // the providers, the fail-closed invariant and the privacy/records contract. Its
  // Configuration Documentation row is UB12.81's `decisionsDocTableRow` in prompts/system.ts,
  // present only while the `decide` tool is offered (upstream: `decideToolActive`).
  decisions: `${APP_ROOT}/docs/decisions.md`,
  docsDir: `${APP_ROOT}/docs/`,
} as const;

/**
 * Check if docs directory exists
 */
export function docsExist(): boolean {
  return existsSync(DOCS_DIR);
}

/**
 * List available doc files
 */
export function listDocs(): string[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
}

/**
 * Initialize docs directory with bundled documentation.
 * Always writes all docs on launch to ensure consistency across debug and release modes.
 */
export function initializeDocs(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (docsInitialized) {
    return;
  }
  docsInitialized = true;

  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true });
  }

  // Load bundled docs lazily (after setBundledAssetsRoot has been called)
  const bundledDocs = getBundledDocs();

  // Always write bundled docs to disk on launch.
  // This ensures consistent behavior between debug and release modes —
  // docs are always up-to-date with the running version.
  for (const [filename, content] of Object.entries(bundledDocs)) {
    const docPath = join(DOCS_DIR, filename);
    writeFileSync(docPath, content, 'utf-8');
  }

  debug(`[docs] Synced ${Object.keys(bundledDocs).length} docs`);
}

// Export the lazy getter for external access
export { getBundledDocs };

// Re-export source guides utilities (parsing only - bundled guides removed)
export {
  parseSourceGuide,
  getSourceGuide,
  getSourceGuideForDomain,
  getSourceKnowledge,
  extractDomainFromSource,
  extractDomainFromUrl,
  type ParsedSourceGuide,
  type SourceGuideFrontmatter,
} from './source-guides.ts';

// Re-export doc links (for UI help popovers)
export {
  getDocUrl,
  getDocInfo,
  DOCS,
  type DocFeature,
  type DocInfo,
} from './doc-links.ts';
