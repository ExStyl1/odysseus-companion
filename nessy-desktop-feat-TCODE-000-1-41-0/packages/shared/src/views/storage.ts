/**
 * Views Storage
 *
 * Filesystem-based storage for workspace view configurations.
 * Views are stored at {workspaceRootPath}/views.json
 *
 * Views are dynamic, expression-based filters computed at runtime from session state.
 * They are never persisted on sessions — purely runtime-evaluated.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ViewConfig } from './types.ts';
import { getDefaultViews } from './defaults.ts';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';

const VIEWS_FILE = 'views.json';

/**
 * Views configuration file structure.
 */
export interface ViewsConfig {
  /** Schema version */
  version: number;
  /** Array of view definitions */
  views: ViewConfig[];
}

/**
 * Load views configuration from workspace.
 * Returns default views if no file exists or parsing fails.
 * Also handles migration from old labels/config.json smartLabels key.
 */
export function loadViewsConfig(workspaceRootPath: string): ViewsConfig {
  const configPath = join(workspaceRootPath, VIEWS_FILE);

  // If no views.json exists, check for legacy smartLabels in labels/config.json
  // and migrate them. Otherwise seed with defaults.
  if (!existsSync(configPath)) {
    const migrated = migrateFromSmartLabels(workspaceRootPath);
    if (migrated) {
      debug('[loadViewsConfig] Migrated from legacy smartLabels');
      return migrated;
    }

    // No legacy data — seed with defaults
    const defaults: ViewsConfig = { version: 1, views: getDefaultViews() };
    debug('[loadViewsConfig] No config found, seeding with default views');
    saveViewsConfig(workspaceRootPath, defaults);
    return defaults;
  }

  try {
    const config = readJsonFileSync<ViewsConfig>(configPath);
    if (Array.isArray(config?.views)) {
      const { views, rewritten } = rewriteRetiredModeViews(config.views);
      if (rewritten.length > 0) {
        config.views = views;
        debug(`[loadViewsConfig] F1.1172: the retired explore/safe mode now reads as plan in view(s) ${rewritten.join(', ')}`);
        try {
          saveViewsConfig(workspaceRootPath, config);
        } catch {
          // Logged by saveViewsConfig; the copy returned here is rewritten, and the next save writes it.
        }
      }
    }
    return config;
  } catch (error) {
    debug('[loadViewsConfig] Failed to parse config:', error);
    return { version: 1, views: getDefaultViews() };
  }
}

/**
 * Save views configuration to disk.
 */
export function saveViewsConfig(
  workspaceRootPath: string,
  config: ViewsConfig
): void {
  const configPath = join(workspaceRootPath, VIEWS_FILE);

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveViewsConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * List views for a workspace.
 * Returns the views array from config (seeded with defaults if missing).
 */
export function listViews(workspaceRootPath: string): ViewConfig[] {
  const config = loadViewsConfig(workspaceRootPath);
  return config.views ?? [];
}

/**
 * Save views to the workspace config.
 * Replaces the entire views array.
 */
export function saveViews(
  workspaceRootPath: string,
  views: ViewConfig[]
): void {
  const config = loadViewsConfig(workspaceRootPath);
  config.views = views;
  saveViewsConfig(workspaceRootPath, config);
}

/**
 * F1.1172 — the seed as it was before F1.1172, recognised so its texts follow the new Plan-mode seed.
 * A user's own name or description is kept.
 */
const RETIRED_EXPLORE_SEED = {
  id: 'view-explore',
  name: 'Explore',
  description: 'Sessions in Explore (read-only) mode',
} as const;

/**
 * `permissionMode == "safe"` / `!= "explore"`: a comparison with a retired spelling of the read-only mode.
 * Filtrex strings are double-quoted only (single quotes name a property).
 */
const RETIRED_MODE_COMPARISON = /\bpermissionMode(\s*(?:==|!=)\s*)"(?:safe|explore)"/g;

/**
 * F1.1172 — F1.1050 retired Nessy's own explore mode and reads a stored `explore` (and its older
 * spelling `safe`) as `plan` forever, and a session's mode is normalized on load
 * (`sessions/jsonl.ts`), so a view comparing `permissionMode` with either spelling matched nothing.
 * The literal is rewritten to `plan`; the seeded view also takes the Plan-mode seed's name and
 * description when it still carries the old seed's. Residue: only `==` and `!=` with
 * `permissionMode` on the left are recognised (an `in (...)` list or a reversed comparison is not).
 */
export function rewriteRetiredModeViews(views: ViewConfig[]): { views: ViewConfig[]; rewritten: string[] } {
  const seed = getDefaultViews().find(view => view.id === RETIRED_EXPLORE_SEED.id);
  const rewritten: string[] = [];
  const next = views.map(view => {
    if (typeof view?.expression !== 'string') return view;
    const expression = view.expression.replace(RETIRED_MODE_COMPARISON, 'permissionMode$1"plan"');
    if (expression === view.expression) return view;
    rewritten.push(view.id);
    const isSeed = seed !== undefined && view.id === RETIRED_EXPLORE_SEED.id;
    return {
      ...view,
      ...(isSeed && view.name === RETIRED_EXPLORE_SEED.name ? { name: seed.name } : {}),
      ...(isSeed && view.description === RETIRED_EXPLORE_SEED.description ? { description: seed.description } : {}),
      expression,
    };
  });
  return { views: next, rewritten };
}

/**
 * Migrate legacy smartLabels from labels/config.json to views.json.
 * Renames IDs from "smart-*" to "view-*" prefix.
 * Returns the migrated config if migration occurred, null otherwise.
 */
function migrateFromSmartLabels(workspaceRootPath: string): ViewsConfig | null {
  const labelsConfigPath = join(workspaceRootPath, 'labels', 'config.json');
  if (!existsSync(labelsConfigPath)) return null;

  try {
    const labelsConfig = readJsonFileSync<Record<string, any>>(labelsConfigPath);
    if (!labelsConfig.smartLabels || !Array.isArray(labelsConfig.smartLabels)) return null;

    // Migrate: rename IDs from smart-* to view-*
    const views: ViewConfig[] = labelsConfig.smartLabels.map((sl: any) => ({
      ...sl,
      id: sl.id?.startsWith('smart-') ? sl.id.replace('smart-', 'view-') : sl.id,
    }));

    const config: ViewsConfig = { version: 1, views: rewriteRetiredModeViews(views).views };
    saveViewsConfig(workspaceRootPath, config);

    // Remove smartLabels from labels config to avoid confusion
    delete labelsConfig.smartLabels;
    writeFileSync(labelsConfigPath, JSON.stringify(labelsConfig, null, 2), 'utf-8');

    return config;
  } catch {
    return null;
  }
}
