/**
 * Label Storage
 *
 * Filesystem-based storage for workspace label configurations.
 * Labels are stored at {workspaceRootPath}/labels/config.json
 *
 * Hierarchy: Labels form a nested JSON tree. IDs are simple slugs.
 * New workspaces are seeded with default labels (Development + Content groups).
 * Labels are visual by color only (colored circles in the UI).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WorkspaceLabelConfig, LabelConfig } from './types.ts';
import { flattenLabels, findLabelById, collectAllIds } from './tree.ts';
import { extractLabelId, mapLabelEntryId } from './values.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { migrateLabelColors } from '../colors/migrate.ts';
import { debug } from '../utils/debug.ts';

const LABEL_CONFIG_DIR = 'labels';
const LABEL_CONFIG_FILE = 'labels/config.json';

/**
 * Get default label configuration.
 * Provides a starter set of labels organized into two complementary color families:
 * - Development (blue family): Code, Bug, Automation
 * - Content (purple family): Writing, Research, Design
 * Plus flat valued labels: Priority (number), Project (string)
 *
 * Children use hue-shifted shades of their parent color to show visual hierarchy.
 */
export function getDefaultLabelConfig(): WorkspaceLabelConfig {
  return {
    version: 1,
    labels: [
      {
        id: 'development',
        name: 'Development',
        color: { light: '#3B82F6', dark: '#60A5FA' },
        children: [
          {
            id: 'code',
            name: 'Code',
            color: { light: '#4F46E5', dark: '#818CF8' }, // indigo shift
          },
          {
            id: 'bug',
            name: 'Bug',
            color: { light: '#0EA5E9', dark: '#38BDF8' }, // sky shift
          },
          {
            id: 'automation',
            name: 'Automation',
            color: { light: '#06B6D4', dark: '#22D3EE' }, // cyan shift
          },
        ],
      },
      {
        id: 'content',
        name: 'Content',
        color: { light: '#8B5CF6', dark: '#A78BFA' },
        children: [
          {
            id: 'writing',
            name: 'Writing',
            color: { light: '#7C3AED', dark: '#C4B5FD' }, // deeper violet
          },
          {
            id: 'research',
            name: 'Research',
            color: { light: '#A855F7', dark: '#C084FC' }, // lighter purple
          },
          {
            id: 'design',
            name: 'Design',
            color: { light: '#D946EF', dark: '#E879F9' }, // fuchsia shift
          },
        ],
      },
      {
        id: 'priority',
        name: 'Priority',
        color: { light: '#F59E0B', dark: '#FBBF24' },
        valueType: 'number',
      },
      {
        id: 'project',
        name: 'Project',
        color: 'foreground/50',
        valueType: 'string',
      },
    ],
  };
}

/**
 * Load workspace label configuration.
 * Returns empty config if no file exists or parsing fails.
 * Auto-migrates old Tailwind color format to EntityColor on first load.
 */
export function loadLabelConfig(workspaceRootPath: string): WorkspaceLabelConfig {
  const configPath = join(workspaceRootPath, LABEL_CONFIG_FILE);

  // If no config file exists, seed with defaults and persist to disk.
  // This ensures existing workspaces (created before default labels existed) get populated.
  if (!existsSync(configPath)) {
    const defaults = getDefaultLabelConfig();
    debug('[loadLabelConfig] No config found, seeding with default labels');
    saveLabelConfig(workspaceRootPath, defaults);
    return defaults;
  }

  try {
    const config = readJsonFileSync<WorkspaceLabelConfig>(configPath);

    // Auto-migrate old Tailwind class colors (e.g., "text-accent") to new EntityColor format.
    // If migration occurs, write the updated config back to disk.
    const migrated = migrateLabelColors(config);
    if (migrated) {
      debug('[loadLabelConfig] Migrated old color format, writing back');
      saveLabelConfig(workspaceRootPath, config);
    }

    return config;
  } catch (error) {
    debug('[loadLabelConfig] Failed to parse config:', error);
    return getDefaultLabelConfig();
  }
}

/**
 * Save workspace label configuration to disk.
 * Creates the labels directory if missing.
 */
export function saveLabelConfig(
  workspaceRootPath: string,
  config: WorkspaceLabelConfig
): void {
  const labelDir = join(workspaceRootPath, LABEL_CONFIG_DIR);
  const configPath = join(workspaceRootPath, LABEL_CONFIG_FILE);

  if (!existsSync(labelDir)) {
    mkdirSync(labelDir, { recursive: true });
  }

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    debug('[saveLabelConfig] Failed to save config:', error);
    throw error;
  }
}

/**
 * What one repair pass did: every renamed id (old → new, in tree order; empty
 * when nothing needed repairing) and the number of sessions on disk whose
 * labels were rewritten to follow the rename.
 */
export interface LabelIdRepair {
  readonly renamed: ReadonlyMap<string, string>;
  readonly relabeled: number;
}

/**
 * UA12.42 — the load-time repair of label ids minted before UA12.40. createLabel
 * then gave a label whose name has no Latin letters («Срочно») the id "" and the
 * next one "-2"; both fail isValidLabelIdFormat and the labels config schema, so
 * config_validate reports them and the PreToolUse config guard refuses every
 * agent Write/Edit of labels/config.json until they are fixed (the CRUD still
 * works — loadLabelConfig never validates — which is why the config survives).
 *
 * "Optional" reads as conditional: the pass fires only when a stored id fails
 * isValidLabelIdFormat — the very condition the guard refuses — and is a no-op
 * (no write, no session pass) for a healthy config, like migrateLabelColors
 * above. A minted "-N" id keeps its number as `label-N`; any other invalid id
 * takes the UA12.40 base (`generateLabelSlug(name) || 'label'`); a taken target
 * shifts through the same `-<n>` suffix loop createLabel uses. The label's name,
 * color, children and position are untouched — only ids change, and sessions
 * carrying a renamed id (valued entries keep their raw value bytes) are
 * relabeled in the same pass.
 *
 * The workspaceId parameter is the storage-v2 address of the sessions
 * (UA12.41): sessions live under the immutable workspace ID, which a root path
 * does not derive. This function is async for that session pass — the sync
 * {@link loadLabelConfig} cannot host it — so the load boundary that has both
 * handles (server-core rpc/labels.ts labels LIST) calls it before reading.
 */
export async function repairLegacyLabelIds(
  workspaceRootPath: string,
  workspaceId: string
): Promise<LabelIdRepair> {
  const configPath = join(workspaceRootPath, LABEL_CONFIG_FILE);
  if (!existsSync(configPath)) return { renamed: new Map(), relabeled: 0 };

  let config: WorkspaceLabelConfig;
  try {
    config = readJsonFileSync<WorkspaceLabelConfig>(configPath);
  } catch (error) {
    debug('[repairLegacyLabelIds] Unreadable config, nothing to repair:', error);
    return { renamed: new Map(), relabeled: 0 };
  }

  // Dynamic requires: crud.ts imports this module statically, and the sessions
  // module is the same circular-dependency avoid deleteLabel uses (crud.ts).
  const { generateLabelSlug } = require('./crud.ts');
  const { listSessions, updateSessionMetadata } = require('../sessions/storage.ts');

  const taken = new Set(collectAllIds(config.labels));
  const renamed = new Map<string, string>();
  const renameTree = (labels: LabelConfig[]): void => {
    for (const label of labels) {
      if (!isValidLabelIdFormat(label.id)) {
        const minted = /^-(\d+)$/.exec(label.id);
        const base = minted ? `label-${minted[1]}` : generateLabelSlug(label.name) || 'label';
        let id = base;
        let suffix = 2;
        while (taken.has(id)) {
          id = `${base}-${suffix}`;
          suffix++;
        }
        taken.add(id);
        renamed.set(label.id, id);
        label.id = id;
      }
      if (label.children && label.children.length > 0) renameTree(label.children);
    }
  };
  renameTree(config.labels);

  if (renamed.size === 0) return { renamed, relabeled: 0 };

  saveLabelConfig(workspaceRootPath, config);

  let relabeled = 0;
  for (const session of listSessions(workspaceId)) {
    if (!session.labels || !session.labels.some((entry: string) => renamed.has(extractLabelId(entry)))) continue;
    const updated = session.labels.map((entry: string) => mapLabelEntryId(entry, renamed));
    await updateSessionMetadata(workspaceId, session.id, { labels: updated });
    relabeled++;
  }

  return { renamed, relabeled };
}

/**
 * Get the label tree (root-level labels with nested children).
 * Primary accessor for the UI — returns the tree structure as-is from config.
 */
export function listLabels(workspaceRootPath: string): LabelConfig[] {
  const config = loadLabelConfig(workspaceRootPath);
  return config.labels;
}

/**
 * Get all labels as a flat list (tree flattened depth-first).
 * Useful for lookups, session label validation, and non-hierarchical display.
 */
export function listLabelsFlat(workspaceRootPath: string): LabelConfig[] {
  const config = loadLabelConfig(workspaceRootPath);
  return flattenLabels(config.labels);
}

/**
 * Get a single label by ID (searches the entire tree).
 * Returns null if not found.
 */
export function getLabel(
  workspaceRootPath: string,
  labelId: string
): LabelConfig | null {
  const config = loadLabelConfig(workspaceRootPath);
  return findLabelById(config.labels, labelId) || null;
}

/**
 * Check if a label ID exists in this workspace (searches entire tree)
 */
export function isValidLabelId(
  workspaceRootPath: string,
  labelId: string
): boolean {
  const config = loadLabelConfig(workspaceRootPath);
  return !!findLabelById(config.labels, labelId);
}

/**
 * Validate label ID format.
 * Simple slug: lowercase alphanumeric + hyphens, no leading/trailing hyphens.
 * Examples: "bug", "frontend", "my-label"
 */
export function isValidLabelIdFormat(labelId: string): boolean {
  if (!labelId) return false;
  const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  return SLUG_PATTERN.test(labelId);
}


