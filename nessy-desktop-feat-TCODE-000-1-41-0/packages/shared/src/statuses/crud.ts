/**
 * Status CRUD Operations
 *
 * Create, Read, Update, Delete operations for status configurations.
 * Enforces business rules (fixed statuses, default statuses, uniqueness).
 */

import { loadStatusConfig, saveStatusConfig } from './storage.ts';
import type { StatusConfig, CreateStatusInput, UpdateStatusInput } from './types.ts';

/**
 * Generate URL-safe slug from label
 */
function generateStatusSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

/**
 * Create a new custom status
 * @throws Error if ID conflicts or validation fails
 */
export function createStatus(
  workspaceRootPath: string,
  input: CreateStatusInput
): StatusConfig {
  const config = loadStatusConfig(workspaceRootPath);

  // Generate unique ID
  let id = generateStatusSlug(input.label);
  let suffix = 2;
  while (config.statuses.some(s => s.id === id)) {
    id = `${generateStatusSlug(input.label)}-${suffix}`;
    suffix++;
  }

  const maxOrder = Math.max(...config.statuses.map(s => s.order), -1);

  const status: StatusConfig = {
    id,
    label: input.label,
    color: input.color,
    icon: input.icon,
    category: input.category,
    isFixed: false,
    isDefault: false,
    order: maxOrder + 1,
  };

  config.statuses.push(status);
  saveStatusConfig(workspaceRootPath, config);

  return status;
}

/**
 * Update a status (label, color, icon, category)
 * Cannot change ID or isFixed/isDefault flags
 * @throws Error if status is fixed and trying to change protected fields
 */
export function updateStatus(
  workspaceRootPath: string,
  statusId: string,
  updates: UpdateStatusInput
): StatusConfig {
  const config = loadStatusConfig(workspaceRootPath);
  const status = config.statuses.find(s => s.id === statusId);

  if (!status) {
    throw new Error(`Status '${statusId}' not found`);
  }

  // Fixed statuses cannot change category
  if (status.isFixed && updates.category && updates.category !== status.category) {
    throw new Error('Cannot change category of fixed status');
  }

  // Apply updates
  if (updates.label !== undefined) status.label = updates.label;
  if (updates.color !== undefined) status.color = updates.color;
  if (updates.icon !== undefined) status.icon = updates.icon;
  if (updates.category !== undefined) status.category = updates.category;

  saveStatusConfig(workspaceRootPath, config);
  return status;
}

/**
 * Delete a status
 * UA12.41 — sessions are addressed by the immutable workspace ID (storage v2), as labels/crud.ts deleteLabel;
 * the root path made listSessions throw "Invalid workspace storage ID". No live caller today: one that adds it
 * must also move sessions a host holds in memory (SessionManager.setSessionStatus), or their next persist
 * writes the deleted status back.
 * UA12.44 — the migration reads the STORED header (listRawSessionStatuses): reading through listSessions never
 * saw the deleted id — validateSessionStatus maps an unknown status to 'todo' at read time — so no header was
 * ever rewritten and the count was always 0.
 * @throws Error if status is fixed or default
 * @returns Number of sessions whose stored header was rewritten to 'todo'
 */
export async function deleteStatus(
  workspaceRootPath: string,
  statusId: string,
  workspaceId: string
): Promise<{ migrated: number }> {
  const config = loadStatusConfig(workspaceRootPath);
  const status = config.statuses.find(s => s.id === statusId);

  if (!status) {
    throw new Error(`Status '${statusId}' not found`);
  }

  if (status.isFixed) {
    throw new Error(`Cannot delete fixed status '${statusId}'`);
  }

  if (status.isDefault) {
    throw new Error(`Cannot delete default status '${statusId}'. Modify it instead.`);
  }

  // Remove from config
  config.statuses = config.statuses.filter(s => s.id !== statusId);
  saveStatusConfig(workspaceRootPath, config);

  // Migrate sessions using this status to 'todo'
  const migrated = await migrateSessionsFromDeletedStatus(workspaceId, statusId);

  return { migrated };
}

/**
 * Reorder statuses
 */
export function reorderStatuses(
  workspaceRootPath: string,
  orderedIds: string[]
): void {
  const config = loadStatusConfig(workspaceRootPath);

  // Validate all IDs exist
  const validIds = new Set(config.statuses.map(s => s.id));
  for (const id of orderedIds) {
    if (!validIds.has(id)) {
      throw new Error(`Invalid status ID: ${id}`);
    }
  }

  // Update order based on array position
  for (let i = 0; i < orderedIds.length; i++) {
    const status = config.statuses.find(s => s.id === orderedIds[i]);
    if (status) {
      status.order = i;
    }
  }

  saveStatusConfig(workspaceRootPath, config);
}

/**
 * Reset to default configuration
 * WARNING: Deletes all custom statuses
 * UA12.41 — sessions by workspace ID; no live caller (see deleteStatus).
 * UA12.44 — reads the STORED header status (listRawSessionStatuses): through listSessions an unknown
 * status already reads as 'todo', so no header was ever rewritten.
 */
export async function resetToDefaults(workspaceRootPath: string, workspaceId: string): Promise<void> {
  const { getDefaultStatusConfig } = require('./storage.ts');
  const config = getDefaultStatusConfig();
  saveStatusConfig(workspaceRootPath, config);

  // Migrate any sessions with now-invalid statuses
  const validIds = new Set(config.statuses.map((s: StatusConfig) => s.id));
  const { listRawSessionStatuses, updateSessionMetadata } = require('../sessions/storage.ts');

  for (const session of listRawSessionStatuses(workspaceId)) {
    if (session.sessionStatus && !validIds.has(session.sessionStatus)) {
      await updateSessionMetadata(workspaceId, session.sessionId, { sessionStatus: 'todo' });
    }
  }
}

/**
 * Migrate sessions from a deleted status to 'todo'
 * Called internally by deleteStatus()
 * UA12.44 — reads the STORED header (listRawSessionStatuses), not listSessions, whose read-time
 * validateSessionStatus maps the deleted id to 'todo' before this filter ever sees it.
 */
async function migrateSessionsFromDeletedStatus(
  workspaceId: string,
  deletedStatusId: string
): Promise<number> {
  // Import session storage functions
  const { listRawSessionStatuses, updateSessionMetadata } = require('../sessions/storage.ts');

  let migratedCount = 0;

  for (const session of listRawSessionStatuses(workspaceId)) {
    if (session.sessionStatus === deletedStatusId) {
      await updateSessionMetadata(workspaceId, session.sessionId, { sessionStatus: 'todo' });
      migratedCount++;
    }
  }

  return migratedCount;
}
