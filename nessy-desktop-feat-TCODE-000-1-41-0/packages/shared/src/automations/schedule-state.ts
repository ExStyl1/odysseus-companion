/**
 * Durable per-matcher cursor of the last scheduled occurrence already accounted
 * for — the state the start/wake missed-run sweep reads.
 *
 * desktop-scheduled-tasks.md:74 — "When the app starts or your computer wakes,
 * Desktop checks whether each task missed any runs in the last seven days. If it
 * did, Desktop starts exactly one catch-up run for the most recently missed time
 * and discards anything older."
 *
 * The stored value is the OCCURRENCE time, never the run time. The nearest
 * existing timestamp — automation history's `ts` — is when the run started and
 * is compacted away after 20 entries per matcher, so a cursor read from it would
 * double-fire (a run that started late looks like a later occurrence) or
 * silently skip.
 *
 * Reads FAIL CLOSED: a missing, unreadable or malformed file reads as "no
 * cursors", and the planner treats an absent cursor as "seed it, do not fire",
 * so a corrupt state file can never turn into a burst of runs.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUTOMATIONS_SCHEDULE_STATE_FILE } from './constants.ts';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('automations-schedule-state');

/** matcher id -> epoch ms of the most recent occurrence already accounted for. */
export type ScheduleState = Record<string, number>;

export function resolveScheduleStatePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, AUTOMATIONS_SCHEDULE_STATE_FILE);
}

/**
 * Read the cursor map. Never throws; anything unexpected reads as empty.
 *
 * Entries whose value is not a finite number are dropped individually rather
 * than failing the whole file — one hand-edited key must not reset every other
 * task's cursor.
 */
export function readScheduleState(workspaceRootPath: string): ScheduleState {
  const path = resolveScheduleStatePath(workspaceRootPath);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    log.warn(`[schedule-state] unreadable, treating as empty: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cursors = (raw as { cursors?: unknown }).cursors;
  if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors)) return {};

  const state: ScheduleState = {};
  for (const [matcherId, value] of Object.entries(cursors as Record<string, unknown>)) {
    const at = typeof value === 'object' && value !== null
      ? (value as { lastFiredOccurrence?: unknown }).lastFiredOccurrence
      : value;
    if (typeof at === 'number' && Number.isFinite(at)) state[matcherId] = at;
  }
  return state;
}

/**
 * Replace the cursor map atomically at mode 0600 (temp + rename, the pattern
 * `cleanupAutoMemoryFile` uses). Never throws — a scheduler write failure must
 * not take down the tick that called it; the worst case is a cursor that stays
 * behind and a catch-up that is offered again on the next sweep, which the
 * `occ > cursor` comparison then makes a no-op once it succeeds.
 */
export function writeScheduleState(workspaceRootPath: string, state: ScheduleState): void {
  const path = resolveScheduleStatePath(workspaceRootPath);
  const payload = `${JSON.stringify({ schemaVersion: 1, cursors: state }, null, 2)}\n`;
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, payload, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    log.warn(`[schedule-state] write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Merge new cursors over the on-disk map and persist, returning what was
 * written. Read-modify-write rather than blind overwrite: the sweep and the
 * minute tick both stamp cursors, and a matcher neither of them looked at must
 * keep the value it had.
 */
export function mergeScheduleState(workspaceRootPath: string, cursors: ScheduleState): ScheduleState {
  if (Object.keys(cursors).length === 0) return readScheduleState(workspaceRootPath);
  const next = { ...readScheduleState(workspaceRootPath), ...cursors };
  writeScheduleState(workspaceRootPath, next);
  return next;
}
