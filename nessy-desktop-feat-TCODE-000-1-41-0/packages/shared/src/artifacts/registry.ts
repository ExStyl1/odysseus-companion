/**
 * UA1.16 — the per-workspace artifact registry: which session published which
 * t-artifacts page from which file, and which deletions are still owed.
 *
 * The SERVICE stays the source of truth for the list (`GET /api/artifacts/mine`,
 * UA1.19); this file only maps artifacts to sessions (`list_artifacts` shows a
 * session its own entries, UA1.18), gates an update target (an id not in this
 * registry is refused), and keeps a failed DELETE as a pending deletion that is
 * retried after the next sign-in (UA1.19) and never dropped silently.
 *
 * Where: `<workspaceRoot>/artifacts/registry.json`. A managed workspace root is
 * `<CONFIG_DIR>/workspaces/<id>` (`workspaces/service.ts` symbol
 * `getWorkspaceRootPath`), so the read floor's pattern is
 * {@link ARTIFACT_REGISTRY_DENIED_PATH_PATTERN} — UNPREFIXED for the same reason
 * `**\/credentials.enc` is (`NESSY_CONFIG_DIR` relocates the config dir) and
 * narrowed by the `workspaces/<id>` segments so a project's own
 * `artifacts/registry.json` stays readable. It sits in
 * `SAFE_MODE_CONFIG.deniedPaths` (`agent/mode-types.ts`) and, byte-identical, in
 * `apps/electron/resources/permissions/default.json` — on Pi and Claude no agent
 * reads or edits the registry through a tool; only this module writes it. On
 * codex the shipped floor never reaches the profile (F1.1057), so a command can
 * READ it; the WRITE is refused by codex's own sandbox, which carries
 * {@link ARTIFACT_REGISTRY_RELATIVE_PATH} beside the guarded records (UA12.8
 * follow-up: an added `pendingDelete` is deleted on the service with no card).
 * See the UA12.8 paragraph of `codexDenyReadEntryCount`
 * (`@nessy-agent/codex-responses-adapter` `config-writer-permissions.ts`).
 *
 * Written through `utils/durable-fs.ts` symbol `atomicWriteDurableFileSync`
 * (temp file + fsync + rename + directory fsync), mode 0600. A registry that
 * exists but does not parse is NOT overwritten: every reader and writer throws
 * {@link ArtifactRegistryError}, because rewriting it would drop the pending
 * deletions it may hold — the one record that must not be lost silently.
 *
 * O22 (waves.md, 2026-10-02): an entry carries an optional `kind` — `'file'`
 * (UA1.18), `'page'` (UA6.7) or `'chat'` (UA1.25); ABSENT reads as `'file'`, so
 * those rows add entries without reshaping this file.
 *
 * UA6.7 — a `'page'` row has no source session (`sourceSessionId: ''`: the user
 * published it from the Pages view, not a session, so `list_artifacts` never
 * shows it to a model and `publish_artifact` refuses it as an update target) and
 * carries the optional `page` facet: the page's stable id (the key the Pages
 * loaders join on — {@link findPageRegistryEntry}), its slug, whether the data
 * snapshot was inlined, and the digest of the page's `index.html` at the last
 * publish. This registry, not page.json, is where a page's publication lives:
 * page.json is agent-writable, this file is on the read floor (on Pi and Claude;
 * on codex it is write-refused, read kept: see `codexDenyReadEntryCount`, UA12.8).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteDurableFileSync } from '../utils/durable-fs.ts';
import type { ArtifactClientErrorKind, ArtifactRecord } from './t-artifacts-client.ts';

/** The read-floor pattern for every workspace's registry. Kept identical in both deniedPaths copies. */
export const ARTIFACT_REGISTRY_DENIED_PATH_PATTERN = '**/workspaces/*/artifacts/registry.json';

export type ArtifactKind = 'file' | 'page' | 'chat';

/** UA6.7 — what a `'page'` row records about the page it publishes. */
export interface ArtifactPageFacet {
  /** The page's stable id (`PageConfig.id`). */
  id: string;
  slug: string;
  /** Whether the data snapshot was inlined in the bytes sent. */
  includesData: boolean;
  /** sha256 hex of the page's `index.html` at that publish (drift against `PageConfig.contentDigest`). */
  contentDigest?: string;
}

export interface ArtifactPendingDelete {
  /** When the DELETE was first asked for (ISO). */
  requestedAt: string;
  /** The kind of the last failure (`needs-login`, `network`, …) — never a message. */
  lastErrorKind?: ArtifactClientErrorKind;
}

export interface ArtifactRegistryEntry {
  id: string;
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  retentionDays: number;
  sourceSessionId: string;
  /** As the session named it (relative to its cwd where possible) — never file content. */
  sourcePath: string;
  /** sha256 hex of the bytes last sent. */
  contentDigest: string;
  pendingDelete?: ArtifactPendingDelete;
  /** O22 — absent = `'file'`; read it through {@link artifactEntryKind}. */
  kind?: ArtifactKind;
  /** UA1.18 — size and line count of the bytes last sent, for the update card's size/line diff (absent on older entries). */
  byteLength?: number;
  lineCount?: number;
  /** UA6.7 — `'page'` rows only. */
  page?: ArtifactPageFacet;
}

interface ArtifactRegistryDocument {
  version: 1;
  entries: ArtifactRegistryEntry[];
}

export class ArtifactRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactRegistryError';
  }
}

/**
 * UA12.8 follow-up — the registry's place below the workspace root, `/`-separated. Also read by
 * `codexWorkspaceRecordNames` (`agent/codex-agent.ts`), which keeps it write-refused on codex.
 */
export const ARTIFACT_REGISTRY_RELATIVE_PATH = 'artifacts/registry.json';

export function artifactRegistryPath(workspaceRoot: string): string {
  return join(workspaceRoot, ...ARTIFACT_REGISTRY_RELATIVE_PATH.split('/'));
}

export function artifactEntryKind(entry: Pick<ArtifactRegistryEntry, 'kind'>): ArtifactKind {
  return entry.kind ?? 'file';
}

const KINDS: ReadonlySet<string> = new Set(['file', 'page', 'chat']);

function isEntry(value: unknown): value is ArtifactRegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && typeof entry.url === 'string'
    && typeof entry.title === 'string'
    && typeof entry.createdAt === 'string'
    && typeof entry.updatedAt === 'string'
    && (entry.expiresAt === null || typeof entry.expiresAt === 'string')
    && typeof entry.retentionDays === 'number'
    && typeof entry.sourceSessionId === 'string'
    && typeof entry.sourcePath === 'string'
    && typeof entry.contentDigest === 'string'
    && (entry.kind === undefined || (typeof entry.kind === 'string' && KINDS.has(entry.kind)))
    && (entry.page === undefined || isPageFacet(entry.page));
}

function isPageFacet(value: unknown): value is ArtifactPageFacet {
  if (typeof value !== 'object' || value === null) return false;
  const facet = value as Record<string, unknown>;
  return typeof facet.id === 'string'
    && typeof facet.slug === 'string'
    && typeof facet.includesData === 'boolean'
    && (facet.contentDigest === undefined || typeof facet.contentDigest === 'string');
}

/**
 * UA6.7 — the registry row of the page `pageId`: the live one when there is one, else the newest one still owed a
 * deletion (shown as "deletion pending"), else `undefined`. Pure over `entries`, so a loader reads the file once.
 * A row past its `expiresAt` is not live: the service answers 404 for it and it cannot be renewed (UA1.16), so the
 * page reads as private again and its next publish is a new link — never a PUT to a page that is gone.
 */
export function findPageRegistryEntry(
  entries: readonly ArtifactRegistryEntry[],
  pageId: string,
  now: Date = new Date(),
): ArtifactRegistryEntry | undefined {
  const rows = entries.filter(entry => artifactEntryKind(entry) === 'page' && entry.page?.id === pageId);
  const expired = (entry: ArtifactRegistryEntry) => entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now.getTime();
  const newest = (list: ArtifactRegistryEntry[]) => list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return newest(rows.filter(entry => !entry.pendingDelete && !expired(entry))) ?? newest(rows.filter(entry => entry.pendingDelete));
}

/** Every entry; a missing file is an empty registry, an unreadable one throws. */
export function readArtifactRegistry(workspaceRoot: string): ArtifactRegistryEntry[] {
  const path = artifactRegistryPath(workspaceRoot);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new ArtifactRegistryError('The artifact registry could not be read; it was left untouched.');
  }
  const document = parsed as Partial<ArtifactRegistryDocument> | null;
  if (!document || document.version !== 1 || !Array.isArray(document.entries) || !document.entries.every(isEntry)) {
    throw new ArtifactRegistryError('The artifact registry has an unexpected shape; it was left untouched.');
  }
  return document.entries;
}

function writeArtifactRegistry(workspaceRoot: string, entries: ArtifactRegistryEntry[]): void {
  const document: ArtifactRegistryDocument = { version: 1, entries };
  atomicWriteDurableFileSync(artifactRegistryPath(workspaceRoot), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

export function findArtifactRegistryEntry(workspaceRoot: string, id: string): ArtifactRegistryEntry | undefined {
  return readArtifactRegistry(workspaceRoot).find(entry => entry.id === id);
}

/** The calling session's entries — what `list_artifacts` shows (UA1.18). */
export function listSessionArtifacts(workspaceRoot: string, sessionId: string): ArtifactRegistryEntry[] {
  return readArtifactRegistry(workspaceRoot).filter(entry => entry.sourceSessionId === sessionId);
}

export interface RecordArtifactPublishInput {
  record: ArtifactRecord;
  sourceSessionId: string;
  sourcePath: string;
  contentDigest: string;
  kind?: ArtifactKind;
  /** UA1.18 — size and line count of the bytes sent. */
  byteLength?: number;
  lineCount?: number;
  /** UA6.7 — `'page'` rows only. */
  page?: ArtifactPageFacet;
  /** Test seam. */
  now?: Date;
}

/** A create: a new entry (or the same id re-recorded, which replaces it). */
export function recordArtifactPublish(workspaceRoot: string, input: RecordArtifactPublishInput): ArtifactRegistryEntry {
  const entries = readArtifactRegistry(workspaceRoot);
  const now = (input.now ?? new Date()).toISOString();
  const entry: ArtifactRegistryEntry = {
    id: input.record.id,
    url: input.record.url,
    title: input.record.title,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.record.expiresAt,
    retentionDays: input.record.retentionDays,
    sourceSessionId: input.sourceSessionId,
    sourcePath: input.sourcePath,
    contentDigest: input.contentDigest,
    ...(input.kind !== undefined && input.kind !== 'file' ? { kind: input.kind } : {}),
    ...(input.byteLength !== undefined ? { byteLength: input.byteLength } : {}),
    ...(input.lineCount !== undefined ? { lineCount: input.lineCount } : {}),
    ...(input.page !== undefined ? { page: { ...input.page } } : {}),
  };
  writeArtifactRegistry(workspaceRoot, [...entries.filter(existing => existing.id !== entry.id), entry]);
  return entry;
}

export interface RecordArtifactUpdateInput {
  record: ArtifactRecord;
  /**
   * Whether the request carried `retention_days`. Without it the service keeps
   * the old expiry, so the entry keeps its `expiresAt` and `retentionDays` — the
   * host never computes an expiry of its own.
   */
  retentionSent: boolean;
  contentDigest?: string;
  sourcePath?: string;
  /** UA1.18 — size and line count of the bytes sent by this update. */
  byteLength?: number;
  lineCount?: number;
  /** UA6.7 — a `'page'` row's facet after this update (replaces the old one). */
  page?: ArtifactPageFacet;
  now?: Date;
}

/** An update (PUT or PATCH) of an entry this workspace holds; throws when the id is unknown. */
export function recordArtifactUpdate(workspaceRoot: string, input: RecordArtifactUpdateInput): ArtifactRegistryEntry {
  const entries = readArtifactRegistry(workspaceRoot);
  const index = entries.findIndex(entry => entry.id === input.record.id);
  if (index < 0) throw new ArtifactRegistryError('This artifact is not in this workspace\'s registry.');
  const previous = entries[index]!;
  const retentionKnown = input.retentionSent && Number.isSafeInteger(input.record.retentionDays);
  const updated: ArtifactRegistryEntry = {
    ...previous,
    url: input.record.url,
    title: input.record.title || previous.title,
    updatedAt: (input.now ?? new Date()).toISOString(),
    expiresAt: retentionKnown ? input.record.expiresAt : previous.expiresAt,
    retentionDays: retentionKnown ? input.record.retentionDays : previous.retentionDays,
    ...(input.contentDigest !== undefined ? { contentDigest: input.contentDigest } : {}),
    ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
    ...(input.byteLength !== undefined ? { byteLength: input.byteLength } : {}),
    ...(input.lineCount !== undefined ? { lineCount: input.lineCount } : {}),
    ...(input.page !== undefined ? { page: { ...input.page } } : {}),
  };
  const next = [...entries];
  next[index] = updated;
  writeArtifactRegistry(workspaceRoot, next);
  return updated;
}

/** A DELETE that failed: kept, marked, retried later (UA1.19). Throws when the id is unknown. */
export function markArtifactPendingDelete(
  workspaceRoot: string,
  id: string,
  lastErrorKind?: ArtifactClientErrorKind,
  now: Date = new Date(),
): ArtifactRegistryEntry {
  const entries = readArtifactRegistry(workspaceRoot);
  const index = entries.findIndex(entry => entry.id === id);
  if (index < 0) throw new ArtifactRegistryError('This artifact is not in this workspace\'s registry.');
  const previous = entries[index]!;
  const updated: ArtifactRegistryEntry = {
    ...previous,
    pendingDelete: {
      requestedAt: previous.pendingDelete?.requestedAt ?? now.toISOString(),
      ...(lastErrorKind !== undefined ? { lastErrorKind } : {}),
    },
  };
  const next = [...entries];
  next[index] = updated;
  writeArtifactRegistry(workspaceRoot, next);
  return updated;
}

/** A DELETE that succeeded (or a `gone` answer): the entry leaves the registry. */
export function removeArtifactRegistryEntry(workspaceRoot: string, id: string): boolean {
  const entries = readArtifactRegistry(workspaceRoot);
  const next = entries.filter(entry => entry.id !== id);
  if (next.length === entries.length) return false;
  writeArtifactRegistry(workspaceRoot, next);
  return true;
}

export function listPendingArtifactDeletes(workspaceRoot: string): ArtifactRegistryEntry[] {
  return readArtifactRegistry(workspaceRoot).filter(entry => entry.pendingDelete !== undefined);
}

/**
 * UA1.19 — a DELETE that failed for a reason a later attempt can fix (`needs-login`, `network`, …): mark the entry
 * pending as {@link markArtifactPendingDelete} does, or — for a page this workspace's registry does not hold (published
 * from another workspace, another machine or the service's own CLI, and listed by `/mine`) — insert a minimal entry
 * that carries only the pending deletion, so it is never dropped silently. Such an entry has no source session
 * (`sourceSessionId: ''`, `sourcePath: ''`, `contentDigest: ''`): `list_artifacts` never shows it to a model, and
 * `publish_artifact` refuses it as an update target (`artifact-publishing.ts` `runArtifactPublish`).
 */
export function keepArtifactPendingDelete(
  workspaceRoot: string,
  record: Pick<ArtifactRecord, 'id' | 'url' | 'title' | 'expiresAt' | 'retentionDays'>,
  lastErrorKind?: ArtifactClientErrorKind,
  now: Date = new Date(),
): ArtifactRegistryEntry {
  const entries = readArtifactRegistry(workspaceRoot);
  if (entries.some(entry => entry.id === record.id)) {
    return markArtifactPendingDelete(workspaceRoot, record.id, lastErrorKind, now);
  }
  const at = now.toISOString();
  const entry: ArtifactRegistryEntry = {
    id: record.id,
    url: record.url,
    title: record.title,
    createdAt: at,
    updatedAt: at,
    expiresAt: record.expiresAt,
    // -1 = not known (the list answer did not say); never 0, which the service reads as "unlimited".
    retentionDays: Number.isSafeInteger(record.retentionDays) && record.retentionDays >= 0 ? record.retentionDays : -1,
    sourceSessionId: '',
    sourcePath: '',
    contentDigest: '',
    pendingDelete: { requestedAt: at, ...(lastErrorKind !== undefined ? { lastErrorKind } : {}) },
  };
  writeArtifactRegistry(workspaceRoot, [...entries, entry]);
  return entry;
}
