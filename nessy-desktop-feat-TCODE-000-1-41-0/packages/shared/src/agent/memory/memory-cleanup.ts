/**
 * Scheduled auto-memory cleanup ("dream" pass).
 *
 * Rewrites ONLY agent-written memory entries — bullet entries whose last line
 * carries the `<!-- nessy:auto:YYYY-MM-DD -->` marker appended by the
 * `remember` session tool (`packages/session-tools-core/src/handlers/remember.ts`).
 * Unmarked (human-written) content is never touched and stays byte-identical
 * across a pass. Two deterministic rules:
 *
 *   1. duplicate collapse — a marked entry duplicating unmarked content is
 *      dropped; among marked duplicates the newest-dated entry wins;
 *   2. age expiry — marked entries older than the threshold are dropped.
 *
 * Ambiguity always keeps the line: unparseable marker dates, markers anywhere
 * but the end of an entry, CR line endings, and oversized files are all left
 * as-is. Pattern reference (shape only, no code): `pi-hermes-memory`
 * consolidation loop — see docs/architecture/pi-extension-adoption-scorecard.md.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AUTO_MEMORY_MARKER_REGEX_SOURCE,
  getProjectMemoryFilePath,
  getSessionMemoryFilePath,
  getUserMemoryFilePath,
  stripAutoMemoryMarkers,
} from './memory-store.ts';
import { getWorkspaceRootPath, getWorkspaceSessionRootPath } from '../../workspaces/paths.ts';

export const AUTO_MEMORY_DEFAULT_MAX_AGE_DAYS = 30;
/** Files larger than this are left untouched (bounded work; ambiguity keeps). */
export const AUTO_MEMORY_CLEANUP_MAX_BYTES = 256 * 1024;
/** Daily throttle for the scheduled pass. */
export const AUTO_MEMORY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on session directories swept per pass. */
export const AUTO_MEMORY_CLEANUP_MAX_SESSIONS = 200;
export const AUTO_MEMORY_CLEANUP_STAMP_FILE = 'memory-cleanup.json';

const DAY_MS = 24 * 60 * 60 * 1000;
const markerReSource = (): string => AUTO_MEMORY_MARKER_REGEX_SOURCE; // F1.846 — read at use, never at module load: memory-store ↔ this file is an import cycle
let trailingMarkerRe: RegExp | undefined; const trailingMarkerRegex = (): RegExp => (trailingMarkerRe ??= new RegExp(`[ \\t]*${markerReSource()}[ \\t]*$`));

export interface AutoMemoryCleanupOptions {
  /** Marked entries older than this many days are expired. */
  maxAgeDays?: number;
  /** Clock override for tests. */
  now?: number;
}

export interface AutoMemoryCleanupResult {
  changed: boolean;
  removedExpired: number;
  removedDuplicates: number;
}

interface EntryGroup {
  /** First and last line index of the bullet entry (continuations included). */
  start: number;
  end: number;
  /** Marker-free, whitespace-collapsed, lowercased entry text for dedup. */
  key: string;
  marked: boolean;
  /** Marker date in ms; null when unparseable (never expires). */
  dateMs: number | null;
}

function normalizeKey(lines: string[]): string {
  return stripAutoMemoryMarkers(lines.join(' ')).replace(/\s+/g, ' ').trim().toLowerCase();
}

function countMarkers(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    count += (line.match(new RegExp(markerReSource(), 'g')) ?? []).length;
  }
  return count;
}

function parseMarkerDate(stamp: string): number | null {
  const ms = Date.parse(`${stamp}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

function parseEntryGroups(lines: string[]): EntryGroup[] {
  const groups: EntryGroup[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith('- ')) {
      i++;
      continue;
    }
    const start = i;
    i++;
    // Continuation lines are two-space indented (the `remember` writer's shape).
    while (i < lines.length && /^ {2}/.test(lines[i]!)) i++;
    const end = i - 1;
    const groupLines = lines.slice(start, end + 1);
    const trailing = groupLines[groupLines.length - 1]!.match(trailingMarkerRegex());
    // Marked only when the single marker sits at the very end of the entry; a
    // marker anywhere else in the group is ambiguous — keep the entry.
    const marked = trailing !== null && countMarkers(groupLines) === 1;
    groups.push({
      start,
      end,
      key: normalizeKey(groupLines),
      marked,
      dateMs: marked ? parseMarkerDate(trailing![1]!) : null,
    });
  }
  return groups;
}

/**
 * Pure cleanup pass over one memory file's content. Idempotent; unmarked lines
 * are copied through byte-identical (only marked entry lines — plus the single
 * blank separator line the writer put above a removed entry — are dropped).
 */
export function cleanupAutoMemoryContent(
  content: string,
  options: AutoMemoryCleanupOptions = {},
): { content: string } & AutoMemoryCleanupResult {
  const unchanged = { content, changed: false, removedExpired: 0, removedDuplicates: 0 };
  if (!content) return unchanged;
  if (content.length > AUTO_MEMORY_CLEANUP_MAX_BYTES || content.includes('\r')) return unchanged;

  const now = options.now ?? Date.now();
  const maxAgeMs = (options.maxAgeDays ?? AUTO_MEMORY_DEFAULT_MAX_AGE_DAYS) * DAY_MS;

  const lines = content.split('\n');
  const groups = parseEntryGroups(lines);
  const markedGroups = groups.filter((group) => group.marked);
  if (markedGroups.length === 0) return unchanged;

  const groupLineIndexes = new Set<number>();
  for (const group of groups) {
    for (let index = group.start; index <= group.end; index++) groupLineIndexes.add(index);
  }

  // Keys of everything cleanup may never touch: unmarked entries and loose lines.
  const unmarkedKeys = new Set<string>();
  for (const group of groups) {
    if (!group.marked) unmarkedKeys.add(group.key);
  }
  lines.forEach((line, index) => {
    if (groupLineIndexes.has(index)) return;
    const key = normalizeKey([line]);
    if (key) unmarkedKeys.add(key);
  });

  // Winner per key among marked entries: newest marker date, then earliest position.
  const winners = new Map<string, EntryGroup>();
  for (const group of markedGroups) {
    const current = winners.get(group.key);
    if (!current || (group.dateMs ?? -Infinity) > (current.dateMs ?? -Infinity)) {
      winners.set(group.key, group);
    }
  }

  let removedExpired = 0;
  let removedDuplicates = 0;
  const removeLineIndexes = new Set<number>();
  for (const group of markedGroups) {
    if (unmarkedKeys.has(group.key) || winners.get(group.key) !== group) {
      removedDuplicates++;
    } else if (group.dateMs !== null && now - group.dateMs > maxAgeMs) {
      removedExpired++;
    } else {
      continue;
    }
    for (let index = group.start; index <= group.end; index++) removeLineIndexes.add(index);
    // The writer separates entries with one blank line; it goes with the entry.
    const before = group.start - 1;
    if (before >= 0 && !groupLineIndexes.has(before) && lines[before]!.trim() === '') {
      removeLineIndexes.add(before);
    }
  }
  if (removeLineIndexes.size === 0) return unchanged;

  const next = lines.filter((_, index) => !removeLineIndexes.has(index)).join('\n');
  return { content: next, changed: next !== content, removedExpired, removedDuplicates };
}

/**
 * Apply the cleanup pass to a file with an atomic 0600 rewrite (no-op when
 * missing/unchanged).
 *
 * Deliberately NOT stamped with `modified` (R56), and the omission is a
 * decision rather than an oversight: `memory.md:398` scopes the field to "when
 * Claude writes a memory file" and gives it the purpose "how current the fact
 * is". This sweep is deterministic housekeeping that only DELETES expired or
 * duplicated agent-written lines — advancing the timestamp here would claim
 * freshness on a day when no fact changed. It is equally frontmatter-blind by
 * design: every unmarked line, including a frontmatter block, is copied through
 * byte-identically.
 */
export function cleanupAutoMemoryFile(
  filePath: string,
  options: AutoMemoryCleanupOptions = {},
): AutoMemoryCleanupResult {
  if (!existsSync(filePath)) return { changed: false, removedExpired: 0, removedDuplicates: 0 };

  const existing = readFileSync(filePath, 'utf-8');
  const result = cleanupAutoMemoryContent(existing, options);
  if (!result.changed) {
    return { changed: false, removedExpired: 0, removedDuplicates: 0 };
  }

  // Atomic replace, matching appendMemoryFile (memory-store.ts).
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, result.content, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, filePath);
  chmodSync(filePath, 0o600);
  return { changed: true, removedExpired: result.removedExpired, removedDuplicates: result.removedDuplicates };
}

export interface ScheduledAutoMemoryCleanupOptions extends AutoMemoryCleanupOptions {
  /** Immutable workspace storage ID (scopes session memory and the throttle stamp). */
  workspaceId: string;
  /** Project directory whose MEMORY.md is swept (usually the workspace root path). */
  workingDirectory?: string;
  /** Override for tests; defaults to the managed user config dir. */
  userConfigDir?: string;
  /** Override for tests; defaults to `<managed workspace dir>/memory-cleanup.json`. */
  stampFilePath?: string;
}

export interface ScheduledAutoMemoryCleanupResult {
  /** False when the daily throttle skipped this tick. */
  ran: boolean;
  filesChanged: number;
  removedExpired: number;
  removedDuplicates: number;
}

function isCleanupDue(stampFilePath: string, now: number): boolean {
  try {
    const raw = JSON.parse(readFileSync(stampFilePath, 'utf-8')) as { lastRunAt?: unknown };
    if (typeof raw.lastRunAt !== 'number') return true;
    return Math.abs(now - raw.lastRunAt) >= AUTO_MEMORY_CLEANUP_INTERVAL_MS;
  } catch {
    return true; // missing/corrupt stamp -> due
  }
}

function listSessionMemoryFiles(workspaceId: string): string[] {
  let entries;
  try {
    entries = readdirSync(getWorkspaceSessionRootPath(workspaceId), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (files.length >= AUTO_MEMORY_CLEANUP_MAX_SESSIONS) break;
    try {
      files.push(getSessionMemoryFilePath(workspaceId, entry.name));
    } catch {
      // Directory name fails storage-ID validation — skip it.
    }
  }
  return files;
}

/**
 * Daily-throttled cleanup sweep over the user, project, and per-session
 * auto-memory files of one workspace. Deterministic code — no agent run.
 */
export function runScheduledAutoMemoryCleanup(
  options: ScheduledAutoMemoryCleanupOptions,
): ScheduledAutoMemoryCleanupResult {
  const now = options.now ?? Date.now();
  const stampFilePath = options.stampFilePath
    ?? join(getWorkspaceRootPath(options.workspaceId), AUTO_MEMORY_CLEANUP_STAMP_FILE);

  if (!isCleanupDue(stampFilePath, now)) {
    return { ran: false, filesChanged: 0, removedExpired: 0, removedDuplicates: 0 };
  }

  // Stamp the ATTEMPT before sweeping: a failing sweep must not retry on every
  // minute tick — it logs upstream and waits for the next daily window.
  mkdirSync(dirname(stampFilePath), { recursive: true });
  writeFileSync(stampFilePath, `${JSON.stringify({ lastRunAt: now })}\n`, 'utf-8');

  const targets = [
    getUserMemoryFilePath(options.userConfigDir),
    ...(options.workingDirectory ? [getProjectMemoryFilePath(options.workingDirectory)] : []),
    ...listSessionMemoryFiles(options.workspaceId),
  ];

  let filesChanged = 0;
  let removedExpired = 0;
  let removedDuplicates = 0;
  for (const filePath of targets) {
    try {
      const result = cleanupAutoMemoryFile(filePath, { maxAgeDays: options.maxAgeDays, now });
      if (result.changed) filesChanged++;
      removedExpired += result.removedExpired;
      removedDuplicates += result.removedDuplicates;
    } catch {
      // Per-file failure keeps that file as-is and the sweep moving.
    }
  }

  return { ran: true, filesChanged, removedExpired, removedDuplicates };
}
