import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';
import {
  atomicWriteDurableFileSync,
  renameDurablySync,
} from '../utils/durable-fs.ts';
import {
  RECENT_PROJECTS_PATH,
  assertStorageId,
  isPathWithin,
} from '../workspaces/paths.ts';
import type { VerifiedStorageLayoutV2 } from '../workspaces/storage-readiness.ts';
import { isValidProjectKey } from './project-identity.ts';
import type {
  IssuedProjectHandle,
  ProjectHandleService,
  ResolvedProjectHandle,
} from './project-handle-service.ts';

const STORE_VERSION = 1;
const OPAQUE_ID = /^[A-Za-z0-9._-]+$/;

export interface StoredRecentProjectRecord {
  id: string;
  workspaceId: string;
  workingDirectory: string;
  projectKey?: string;
  lastUsedAt: number;
}

interface RecentProjectFile {
  version: typeof STORE_VERSION;
  records: StoredRecentProjectRecord[];
}

export interface RecentProjectSummary {
  id: string;
  displayPath: string;
  lastUsedAt: number;
}

export type RecentProjectDiagnostic =
  | { code: 'recent-project-store-corrupt' }
  | { code: 'recent-project-stale'; recentProjectId: string };

export type RecentProjectStoreErrorCode =
  | 'recent-project-not-found'
  | 'recent-project-stale'
  | 'recent-project-store-corrupt'
  | 'recent-project-store-write-failed';

export class RecentProjectStoreError extends Error {
  override readonly name = 'RecentProjectStoreError';

  constructor(readonly code: RecentProjectStoreErrorCode) {
    super(code);
  }
}

export interface RecentProjectStoreOptions {
  filePath?: string;
  now?: () => number;
  newId?: () => string;
  quarantineId?: () => string;
  onDiagnostic?: (diagnostic: RecentProjectDiagnostic) => void;
}

export class RecentProjectStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly quarantineId: () => string;
  private readonly onDiagnostic: ((diagnostic: RecentProjectDiagnostic) => void) | undefined;

  constructor(layout: VerifiedStorageLayoutV2, options: RecentProjectStoreOptions = {}) {
    if (
      !layout
      || layout.storageLayoutVersion !== 2
      || typeof layout.verificationId !== 'string'
      || !layout.verificationId
    ) {
      throw new Error('verified-storage-layout-required');
    }
    this.filePath = resolve(options.filePath ?? RECENT_PROJECTS_PATH);
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID());
    this.quarantineId = options.quarantineId ?? (() => randomUUID());
    this.onDiagnostic = options.onDiagnostic;
    this.readRecords();
  }

  listRecentProjects(workspaceId: string): RecentProjectSummary[] {
    const id = assertStorageId('workspace', workspaceId);
    return this.readRecords()
      .filter(record => record.workspaceId === id)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .map(toSummary);
  }

  recordValidatedProject(project: ResolvedProjectHandle): RecentProjectSummary {
    assertRecordableProject(project);
    const records = this.readRecords();
    const existing = records.find(record => (
      record.workspaceId === project.workspaceId
      && (
        (project.persistence === 'stable' && record.projectKey === project.projectKey)
        || record.workingDirectory === project.displayPath
      )
    ));
    const id = existing?.id ?? this.nextOpaqueId(records);
    const record: StoredRecentProjectRecord = {
      id,
      workspaceId: assertStorageId('workspace', project.workspaceId),
      workingDirectory: project.displayPath,
      ...(project.persistence === 'stable' ? { projectKey: project.projectKey } : {}),
      lastUsedAt: this.now(),
    };
    this.writeRecords(existing
      ? records.map(candidate => candidate.id === existing.id ? record : candidate)
      : [...records, record]);
    return toSummary(record);
  }

  /**
   * P6.800 — record a DIRECTORY as its own project root.
   *
   * The row this exists for: a **permanent** worktree survives the sweep by
   * name (P6.336 (b)) and is still reachable only through the session that made
   * it, because nothing ever records its path as a project. The picker lists
   * what is in this store, and a worktree enters no branch of
   * `mutateWorkingDirectory` that resolves a project handle — the create path
   * mutates with `intent: 'keep'`, and only `intent: 'bind'` produces the
   * `ResolvedProjectHandle` {@link recordValidatedProject} demands. "Kept and
   * unreachable in practice" is exactly the shape P6.22 fixed for kept
   * worktrees, one layer down.
   *
   * So this is {@link recordValidatedProject} with the validation attached
   * rather than assumed: the directory goes through the SAME
   * `validateProjectDirectory` + `resolveHandle` pair every other project takes,
   * so a managed root, a file, a vanished path or a `$CONFIG_DIR` path is
   * refused here for the same reasons and by the same code. Nothing about
   * worktrees is encoded — a worktree is a directory, and the caller is what
   * knows it is one.
   *
   * TOTAL, and never throwing, which is the whole reason it is a method rather
   * than three lines at the call site: registering a project is a convenience
   * on top of creating a worktree, and a store that is corrupt, unwritable or
   * handed a path that no longer validates must not take the worktree down with
   * it. `null` is the honest "not recorded", and the caller needs no guard.
   *
   * NOT paired with a remove. A worktree deleted later leaves a stale record,
   * and the store already has the answer for that: `issueRecentProjectHandle`
   * quarantines a record whose directory no longer validates and reports
   * `recent-project-stale`. Adding a second removal path would be a second
   * mechanism for a state the first one already reaches.
   */
  async recordProjectDirectory(
    input: { workspaceId: string; directory: string },
    handles: ProjectHandleService,
  ): Promise<RecentProjectSummary | null> {
    try {
      const workspaceId = assertStorageId('workspace', input.workspaceId);
      const issued = await handles.validateProjectDirectory(workspaceId, input.directory);
      const resolved = await handles.resolveHandle({ workspaceId, projectHandleId: issued.id });
      if (!resolved) return null;
      return this.recordValidatedProject(resolved);
    } catch {
      return null;
    }
  }

  async issueRecentProjectHandle(
    input: { workspaceId: string; recentProjectId: string },
    handles: ProjectHandleService,
  ): Promise<IssuedProjectHandle> {
    return this.issueStoredProjectHandle(input, handles, false);
  }

  async issueDefaultProjectHandle(
    input: { workspaceId: string; recentProjectId: string },
    handles: ProjectHandleService,
  ): Promise<IssuedProjectHandle> {
    return this.issueStoredProjectHandle(input, handles, true);
  }

  private async issueStoredProjectHandle(
    input: { workspaceId: string; recentProjectId: string },
    handles: ProjectHandleService,
    rejectIdentityChange: boolean,
  ): Promise<IssuedProjectHandle> {
    const workspaceId = assertStorageId('workspace', input.workspaceId);
    const records = this.readRecords();
    const record = records.find(candidate => (
      candidate.workspaceId === workspaceId
      && candidate.id === input.recentProjectId
    ));
    if (!record) throw new RecentProjectStoreError('recent-project-not-found');

    let issued: IssuedProjectHandle;
    let resolved: ResolvedProjectHandle | null;
    try {
      issued = await handles.validateProjectDirectory(workspaceId, record.workingDirectory);
      resolved = await handles.resolveHandle({ workspaceId, projectHandleId: issued.id });
    } catch {
      this.quarantineStaleRecord(record, records);
      throw new RecentProjectStoreError('recent-project-stale');
    }
    if (!resolved) {
      this.quarantineStaleRecord(record, records);
      throw new RecentProjectStoreError('recent-project-stale');
    }

    // The identity-change hint applies to STABLE resolutions only. A
    // process-only resolution (the home directory per the glossary.md:231
    // carve-out, or an unstable filesystem) derives a fresh per-process salted
    // key, so a stored key — e.g. a pre-carve-out $HOME record — can never
    // match it again; that is key omission, not an identity change. The store
    // already treats process-only records as key-less everywhere else
    // (`recordValidatedProject` omits `projectKey`; the update below deletes
    // it), so the record self-heals instead of being quarantined or rejected.
    const staleHint = !!record.projectKey
      && resolved.persistence === 'stable'
      && record.projectKey !== resolved.projectKey;
    if (staleHint && rejectIdentityChange) {
      this.quarantineStaleRecord(record, records);
      throw new RecentProjectStoreError('recent-project-stale');
    }
    if (staleHint) this.writeQuarantineRecord(record);
    const updated: StoredRecentProjectRecord = {
      ...record,
      workingDirectory: record.workingDirectory,
      ...(resolved.persistence === 'stable'
        ? { projectKey: resolved.projectKey }
        : { projectKey: undefined }),
      lastUsedAt: this.now(),
    };
    if (updated.projectKey === undefined) delete updated.projectKey;
    this.writeRecords(records.map(candidate => candidate.id === record.id ? updated : candidate));
    if (staleHint) {
      this.emitDiagnostic({ code: 'recent-project-stale', recentProjectId: record.id });
    }
    return issued;
  }

  cleanupParticipant(): {
    id: 'recent-projects';
    stage(workspaceId: string, transactionId: string): Promise<void>;
    commit(transactionId: string): Promise<void>;
    rollback(transactionId: string): Promise<void>;
  } {
    const staged = new Map<string, string>();
    return {
      id: 'recent-projects',
      stage: async (workspaceId, transactionId) => {
        staged.set(transactionId, assertStorageId('workspace', workspaceId));
      },
      commit: async transactionId => {
        const workspaceId = staged.get(transactionId);
        if (!workspaceId) return;
        const records = this.readRecords();
        const retained = records.filter(record => record.workspaceId !== workspaceId);
        if (retained.length !== records.length) this.writeRecords(retained);
        staged.delete(transactionId);
      },
      rollback: async transactionId => {
        staged.delete(transactionId);
      },
    };
  }

  private readRecords(): StoredRecentProjectRecord[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return parseFile(parsed).records;
    } catch {
      this.quarantineCorruptStore();
      return [];
    }
  }

  private writeRecords(records: StoredRecentProjectRecord[]): void {
    const file: RecentProjectFile = { version: STORE_VERSION, records };
    try {
      atomicWriteDurableFileSync(this.filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
    } catch {
      throw new RecentProjectStoreError('recent-project-store-write-failed');
    }
  }

  private quarantineCorruptStore(): void {
    if (!existsSync(this.filePath)) return;
    try {
      renameDurablySync(this.filePath, this.quarantinePath());
    } catch {
      throw new RecentProjectStoreError('recent-project-store-corrupt');
    }
    this.emitDiagnostic({ code: 'recent-project-store-corrupt' });
  }

  private quarantineStaleRecord(
    record: StoredRecentProjectRecord,
    records: StoredRecentProjectRecord[],
  ): void {
    this.writeQuarantineRecord(record);
    this.writeRecords(records.filter(candidate => candidate.id !== record.id));
    this.emitDiagnostic({ code: 'recent-project-stale', recentProjectId: record.id });
  }

  private writeQuarantineRecord(record: StoredRecentProjectRecord): void {
    const file: RecentProjectFile = { version: STORE_VERSION, records: [record] };
    try {
      atomicWriteDurableFileSync(
        this.quarantinePath(),
        JSON.stringify(file, null, 2),
        { mode: 0o600, noReplace: true },
      );
    } catch (error) {
      if (error instanceof RecentProjectStoreError) throw error;
      throw new RecentProjectStoreError('recent-project-store-write-failed');
    }
  }

  private quarantinePath(): string {
    const id = this.quarantineId();
    if (!OPAQUE_ID.test(id)) throw new RecentProjectStoreError('recent-project-store-corrupt');
    return resolve(dirname(this.filePath), `.${basename(this.filePath)}.quarantine.${id}`);
  }

  private nextOpaqueId(records: StoredRecentProjectRecord[]): string {
    const id = this.newId();
    if (!OPAQUE_ID.test(id) || records.some(record => record.id === id)) {
      throw new Error('recent-project-id-invalid');
    }
    return id;
  }

  private emitDiagnostic(diagnostic: RecentProjectDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {}
  }
}

function parseFile(value: unknown): RecentProjectFile {
  if (!isObject(value) || value.version !== STORE_VERSION || !Array.isArray(value.records)) {
    throw new Error('invalid-recent-project-store');
  }
  const records = value.records.map(parseRecord);
  if (new Set(records.map(record => record.id)).size !== records.length) {
    throw new Error('invalid-recent-project-store');
  }
  return { version: STORE_VERSION, records };
}

function parseRecord(value: unknown): StoredRecentProjectRecord {
  if (
    !isObject(value)
    || typeof value.id !== 'string'
    || !OPAQUE_ID.test(value.id)
    || typeof value.workspaceId !== 'string'
    || typeof value.workingDirectory !== 'string'
    || !isAbsolute(value.workingDirectory)
    || isPathWithin(CONFIG_DIR, value.workingDirectory)
    || typeof value.lastUsedAt !== 'number'
    || !Number.isFinite(value.lastUsedAt)
    || (value.projectKey !== undefined && !isValidProjectKey(value.projectKey))
  ) {
    throw new Error('invalid-recent-project-store');
  }
  assertStorageId('workspace', value.workspaceId);
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    workingDirectory: value.workingDirectory,
    ...(value.projectKey !== undefined ? { projectKey: value.projectKey } : {}),
    lastUsedAt: value.lastUsedAt,
  };
}

function assertRecordableProject(project: ResolvedProjectHandle): void {
  if (
    !project
    || !isAbsolute(project.displayPath)
    || !isAbsolute(project.canonicalPath)
    || isPathWithin(CONFIG_DIR, project.displayPath)
    || isPathWithin(CONFIG_DIR, project.canonicalPath)
    || !isValidProjectKey(project.projectKey)
  ) {
    throw new Error('recent-project-invalid');
  }
}

function toSummary(record: StoredRecentProjectRecord): RecentProjectSummary {
  return {
    id: record.id,
    displayPath: record.workingDirectory,
    lastUsedAt: record.lastUsedAt,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
