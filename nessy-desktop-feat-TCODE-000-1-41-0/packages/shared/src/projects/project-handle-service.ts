/**
 * Backend/Workspace-bound project handle registry (W8 Step 3).
 *
 * This is the SOLE raw project-path ingress. A renderer/remote caller never
 * supplies a `projectRoot`; it selects a directory once through
 * `validateProjectDirectory`, receives an opaque, Workspace-bound, expiring
 * handle, and thereafter references the project only by `projectHandleId`.
 *
 * Identity/trust are NOT reinvented here: canonicalization, fingerprint and key
 * derivation go through W6's single `resolveProjectIdentity()`, and whole-project
 * trust goes through W6's `ProjectTrustStore`. The service revalidates the
 * identity immediately before every handle use, so a replaced inode (delete +
 * recreate at the same path, or a symlink swap) invalidates the handle.
 *
 * A `process-only` identity (unstable filesystem) keeps trust session-only:
 * the ProjectTrustStore never persists it, so approval is required again after a
 * restart rather than falling back to a path-only grant.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  resolveProjectIdentity,
  type ProjectKey,
  type ResolveProjectIdentityOptions,
  type ResolvedProjectIdentity,
} from './project-identity.ts';
import { ProjectTrustStore } from '../capabilities/project-trust-store.ts';
import { emitCapabilityCatalogInvalidation } from '../capabilities/invalidation.ts';
import type { ProjectTrustState } from '../capabilities/types.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { isPathWithin } from '../workspaces/paths.ts';

/** Public-safe handle DTO (matches protocol `SafeProjectHandle`). */
export interface IssuedProjectHandle {
  id: string;
  workspaceId: string;
  /** User-selected project path already visible in session UI; not managed. */
  displayPath: string;
  /** Public decision: no decision is distinct from an explicit distrust. */
  trustState: 'unknown' | 'trusted' | 'untrusted';
  expiresAt: number;
}

/** Server-only resolved handle; never serialized whole. */
export interface ResolvedProjectHandle extends IssuedProjectHandle {
  canonicalPath: string;
  projectKey: ProjectKey;
  identityFingerprint: string;
  /** The precise stored trust decision, kept server-side (`none` possible). */
  trustDecision: ProjectTrustState;
  /** Trust decision revision; folded into the capability generation hash. */
  trustRevision: string;
  persistence: 'stable' | 'process-only';
}

interface HandleRecord {
  id: string;
  workspaceId: string;
  displayPath: string;
  canonicalPath: string;
  projectKey: ProjectKey;
  identityFingerprint: string;
  expiresAt: number;
  persistence: 'stable' | 'process-only';
}

export interface ProjectHandleServiceOptions {
  trustStore?: ProjectTrustStore;
  now?: () => number;
  /** Handle time-to-live (ms). */
  ttlMs?: number;
  newId?: () => string;
  /** Test seam forwarded to `resolveProjectIdentity`. */
  identityOptions?: ResolveProjectIdentityOptions;
  /** Managed roots are never valid external projects. */
  managedRootPaths?: string[];
  /** Test seams for candidate existence/type validation. */
  candidateRealpathSync?: (path: string) => string;
  candidateStatSync?: (path: string) => { isDirectory(): boolean };
}

export type ProjectDirectoryErrorCode =
  | 'project-directory-invalid'
  | 'project-directory-managed'
  /**
   * D1.363 — the folder a HANDLE was issued for is gone (moved, renamed or
   * replaced by a file). Distinct from `project-directory-invalid`, which is
   * raised on INGRESS for a path that was never usable: this one says an
   * already-issued handle can never be answered again, so the caller's question
   * is terminal rather than retryable.
   */
  | 'project-directory-missing';

/** Why a ref no longer resolves; see `describeUnresolvableRef`. */
export type UnresolvableProjectRefReason =
  | 'project-directory-missing'
  | 'project-handle-invalid';

export class ProjectDirectoryError extends Error {
  override readonly name = 'ProjectDirectoryError';

  constructor(readonly code: ProjectDirectoryErrorCode) {
    super(code);
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Reference that addresses a project by session or by an issued handle. */
export type ProjectHandleRef =
  | { workspaceId: string; sessionId: string }
  | { workspaceId: string; projectHandleId: string };

export class ProjectHandleService {
  private readonly trustStore: ProjectTrustStore;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly newId: () => string;
  private readonly identityOptions?: ResolveProjectIdentityOptions;
  private readonly managedRootPaths: string[];
  private readonly candidateRealpathSync: (path: string) => string;
  private readonly candidateStatSync: (path: string) => { isDirectory(): boolean };
  private readonly handles = new Map<string, HandleRecord>();
  /** Session → issued handle id, so a session ref resolves to a handle. */
  private readonly sessionHandles = new Map<string, string>();

  constructor(options: ProjectHandleServiceOptions = {}) {
    this.trustStore = options.trustStore ?? new ProjectTrustStore();
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.newId = options.newId ?? (() => randomUUID());
    this.identityOptions = options.identityOptions;
    this.candidateRealpathSync = options.candidateRealpathSync ?? realpathSync;
    this.candidateStatSync = options.candidateStatSync ?? (path => statSync(path));
    this.managedRootPaths = [
      resolve(CONFIG_DIR),
      ...(options.managedRootPaths ?? []).map(path => {
        try {
          return this.candidateRealpathSync(resolve(path));
        } catch {
          return resolve(path);
        }
      }),
    ];
  }

  /**
   * Sole raw-path ingress. Resolves canonical identity, reads the stored trust
   * decision and issues a Workspace-bound, expiring handle.
   */
  async validateProjectDirectory(workspaceId: string, projectPath: string): Promise<IssuedProjectHandle> {
    const canonicalCandidate = this.validateCandidateProjectPath(projectPath);
    const identity = await resolveProjectIdentity(canonicalCandidate, this.identityOptions);
    const id = this.issueId();
    const expiresAt = this.now() + this.ttlMs;
    this.handles.set(id, {
      id,
      workspaceId,
      displayPath: projectPath,
      canonicalPath: identity.canonicalPath,
      projectKey: identity.projectKey,
      identityFingerprint: identity.identityFingerprint,
      expiresAt,
      persistence: identity.persistence,
    });
    return this.toIssued(id, this.trustStore.resolve(identity).state, expiresAt, workspaceId, projectPath);
  }

  /** Bind a session to an already-issued handle (server-owned session state). */
  bindSession(workspaceId: string, sessionId: string, handleId: string): void {
    const record = this.handles.get(handleId);
    if (!record || record.workspaceId !== workspaceId) {
      throw new Error('Cannot bind session to an unknown or mismatched handle');
    }
    this.sessionHandles.set(sessionKey(workspaceId, sessionId), handleId);
  }

  unbindSession(workspaceId: string, sessionId: string): void {
    this.sessionHandles.delete(sessionKey(workspaceId, sessionId));
  }

  /**
   * Resolve a ref to a server-only handle, REVALIDATING identity immediately.
   * Returns null when the handle is unknown, expired, Workspace-mismatched, or
   * the on-disk identity fingerprint no longer matches (inode replaced).
   */
  async resolveHandle(ref: ProjectHandleRef): Promise<ResolvedProjectHandle | null> {
    const handleId = this.handleIdForRef(ref);
    if (!handleId) return null;
    const record = this.handles.get(handleId);
    if (!record) return null;
    if (record.workspaceId !== ref.workspaceId) return null;
    if (record.expiresAt <= this.now()) return null;

    // Revalidate candidate safety and current filesystem identity on every use.
    let canonicalCandidate: string;
    try {
      canonicalCandidate = this.validateCandidateProjectPath(record.displayPath);
    } catch {
      return null;
    }
    const identity = await resolveProjectIdentity(canonicalCandidate, this.identityOptions);
    if (identity.identityFingerprint !== record.identityFingerprint) return null;
    record.canonicalPath = identity.canonicalPath;

    const decision = this.trustStore.resolve(identity);
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      displayPath: record.displayPath,
      trustState: publicTrustState(decision.state),
      expiresAt: record.expiresAt,
      canonicalPath: identity.canonicalPath,
      projectKey: record.projectKey,
      identityFingerprint: record.identityFingerprint,
      trustDecision: decision.state,
      trustRevision: decision.revision,
      persistence: identity.persistence,
    };
  }

  /**
   * Record a whole-project trust decision for the ref's project and return the
   * refreshed handle. Process-only identities persist in memory only.
   */
  async setProjectTrust(ref: ProjectHandleRef, state: ProjectTrustState): Promise<IssuedProjectHandle> {
    const resolved = await this.resolveHandle(ref);
    if (!resolved) throw unresolvableRefError(this.describeUnresolvableRef(ref));
    const identity: ResolvedProjectIdentity = {
      canonicalPath: resolved.canonicalPath,
      projectKey: resolved.projectKey,
      identityFingerprint: resolved.identityFingerprint,
      persistence: resolved.persistence,
    };
    if (state === 'none') {
      // No decision to persist; nothing clears an existing grant here (the store
      // has no clear op) — callers set 'blocked' to explicitly distrust.
    } else {
      this.trustStore.record(identity, state);
      emitCapabilityCatalogInvalidation({
        scope: { kind: 'project-trust', projectKey: identity.projectKey },
        reason: state === 'trusted' ? 'project-trust-granted' : 'project-trust-revoked',
        effect: state === 'trusted' ? 'refresh-before-next-turn' : 'revoke-active-snapshot',
      });
    }
    const decision = this.trustStore.resolve(identity);
    return this.toIssued(
      resolved.id,
      decision.state,
      resolved.expiresAt,
      resolved.workspaceId,
      resolved.displayPath,
    );
  }

  /**
   * D1.363 — WHY a ref does not resolve, for callers that must tell a TERMINAL
   * answer from a retryable one.
   *
   * `resolveHandle` collapses five different causes into one `null` — unknown
   * handle, expired handle, Workspace mismatch, an unusable candidate path, a
   * changed identity fingerprint — and every caller of `setProjectTrust` used to
   * report all five as `project-handle-invalid`. Measured on the packaged 1.40.0
   * (measure sitting 5e, case `RS-80`): with the app's trust modal up, deleting
   * the folder under it made every click answer "Could not update project trust"
   * and NO click could ever succeed, because the folder is gone. An error a user
   * cannot get past is the defect; the cause is that the answer looked retryable.
   *
   * This reports `project-directory-missing` only for the one cause a click can
   * never fix — the handle exists and its own path no longer resolves to a
   * directory — and leaves every other cause spelled as before.
   */
  describeUnresolvableRef(ref: ProjectHandleRef): UnresolvableProjectRefReason {
    const handleId = this.handleIdForRef(ref);
    const record = handleId ? this.handles.get(handleId) : undefined;
    if (!record) return 'project-handle-invalid';
    return this.candidateDirectoryGone(record.displayPath)
      ? 'project-directory-missing'
      : 'project-handle-invalid';
  }

  /** True when the path no longer resolves to a directory at all. */
  private candidateDirectoryGone(displayPath: string): boolean {
    try {
      return !this.candidateStatSync(this.candidateRealpathSync(resolve(displayPath))).isDirectory();
    } catch {
      return true;
    }
  }

  private handleIdForRef(ref: ProjectHandleRef): string | undefined {
    if ('projectHandleId' in ref) return ref.projectHandleId;
    return this.sessionHandles.get(sessionKey(ref.workspaceId, ref.sessionId));
  }

  private validateCandidateProjectPath(projectPath: string): string {
    if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) {
      throw new ProjectDirectoryError('project-directory-invalid');
    }
    const lexicalPath = resolve(projectPath);
    if (this.isManagedPath(lexicalPath)) {
      throw new ProjectDirectoryError('project-directory-managed');
    }

    let canonicalPath: string;
    try {
      canonicalPath = this.candidateRealpathSync(lexicalPath);
      if (!this.candidateStatSync(canonicalPath).isDirectory()) {
        throw new ProjectDirectoryError('project-directory-invalid');
      }
    } catch (error) {
      if (error instanceof ProjectDirectoryError) throw error;
      throw new ProjectDirectoryError('project-directory-invalid');
    }

    if (this.isManagedPath(canonicalPath)) {
      throw new ProjectDirectoryError('project-directory-managed');
    }
    return canonicalPath;
  }

  private isManagedPath(path: string): boolean {
    return this.managedRootPaths.some(root => isPathWithin(root, path));
  }

  private toIssued(
    id: string,
    state: ProjectTrustState,
    expiresAt: number,
    workspaceId: string,
    displayPath: string,
  ): IssuedProjectHandle {
    return {
      id,
      workspaceId,
      displayPath,
      trustState: publicTrustState(state),
      expiresAt,
    };
  }

  /**
   * UA12.107 — the id of a handle being issued, and the one moment EVERY read passes through: `projects:get`/
   * `getOne`/`changed` answer through `resolveStoredProjectFolder`, which issues a fresh handle per foldered
   * project per read, and nothing reads the superseded ones again — without a sweep the record map grew with
   * the renderer's polling forever. Issuing therefore prunes the expired records (and the `sessionHandles`
   * entries bound only to them — a dead binding can never resolve and never re-binds usefully). Live handles
   * survive untouched. Named delta: an EXPIRED handle whose folder is now gone reads `project-handle-invalid`
   * (record gone) where `describeUnresolvableRef` could once name `project-directory-missing` — both refuse the
   * same way, and expiry already answered null on every resolution path.
   */
  private issueId(): string {
    this.pruneExpiredHandles();
    return this.newId();
  }

  private pruneExpiredHandles(): void {
    const now = this.now();
    const pruned = new Set<string>();
    for (const [id, record] of this.handles) {
      if (record.expiresAt <= now) {
        this.handles.delete(id);
        pruned.add(id);
      }
    }
    if (pruned.size === 0) return;
    for (const [key, handleId] of this.sessionHandles) {
      if (pruned.has(handleId)) this.sessionHandles.delete(key);
    }
  }

  /**
   * F1.1088 — drop a handle its caller issued only to READ the trust answer and will never resolve (the
   * Settings-provenance view, `rpc/settings.ts`): without this each view open left one record for the TTL (UA12.107's
   * sweep bounds it to a day, it does not end it). A handle a session is bound to, or one of another workspace, is
   * kept; an unknown id is a no-op. The folder-validation RPC hands its handle to the renderer, and the capability
   * context's restore path binds its handle to the session — both are used afterwards, so neither releases.
   */
  releaseHandle(workspaceId: string, handleId: string): void {
    const record = this.handles.get(handleId);
    if (!record || record.workspaceId !== workspaceId) return;
    for (const bound of this.sessionHandles.values()) if (bound === handleId) return;
    this.handles.delete(handleId);
  }
}

/**
 * The error `describeUnresolvableRef`'s verdict deserves. `project-handle-invalid`
 * stays a plain `Error` with exactly its old message, so every existing caller
 * and test reads what it read before.
 */
export function unresolvableRefError(reason: UnresolvableProjectRefReason): Error {
  return reason === 'project-directory-missing'
    ? new ProjectDirectoryError('project-directory-missing')
    : new Error('project-handle-invalid');
}

function publicTrustState(
  state: ProjectTrustState,
): IssuedProjectHandle['trustState'] {
  if (state === 'trusted') return 'trusted';
  if (state === 'blocked') return 'untrusted';
  return 'unknown';
}

function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

/** Convenience re-export of the identity result shape for handle consumers. */
export type { ResolvedProjectIdentity };

/** F1.11 — re-exported so the capability input builder reaches it through the import it already has. */
export { resolveMainCheckoutProjectKey } from './project-identity.ts';

/** A project entity's stored folder (`ProjectFolder` in `./types.ts`, restated so this module imports no entity types). */
export interface StoredProjectFolder {
  workingDirectory: string;
  projectKey?: string;
}

/** Why a stored project folder cannot be used now (UA5.3 / UA5.4). */
export type StoredProjectFolderProblem = 'project-folder-identity-changed' | 'project-folder-unavailable';

export type StoredProjectFolderResolution =
  | { ok: true; handle: ResolvedProjectHandle }
  | { ok: false; problem: StoredProjectFolderProblem; cause?: string };

/**
 * UA5.3 / UA5.4 — re-validate a project ENTITY's stored folder (spec §12 "Binding": "The host re-validates the folder
 * and compares the persisted `projectKey`: `project-folder-identity-changed` on a mismatch").
 *
 * The stored path comes from `projects/<slug>/config.json`, which an agent can write, so it is never trusted as a
 * path: it enters through {@link ProjectHandleService.validateProjectDirectory} — the one raw-path ingress, which
 * refuses managed, relative and unreadable candidates — and the resolved identity is compared with what was bound:
 * - a stored `projectKey` (a STABLE identity, `projectFolderFromHandle`) must equal the folder's key now;
 * - NO stored key is legal only when the folder still resolves to a process-only identity (whose key is never
 *   persisted). A stable folder with no stored key is `project-folder-identity-changed`: the folder writer always
 *   persists a stable key, so its absence beside a stable folder means the file was edited — the check cannot be
 *   skipped by deleting the key.
 * Residue (stated): a process-only folder has no persisted identity at all, so a stored path rewritten to ANOTHER
 * process-only folder (e.g. `$HOME`) passes this check; its trust is per process and starts `unknown`, so the session
 * that would use it raises the trust flow rather than inheriting trust.
 *
 * The answer's `handle` is a freshly issued handle of `workspaceId` (expiring like any other); a refusal names its
 * problem and never throws.
 */
export async function resolveStoredProjectFolder(
  service: Pick<ProjectHandleService, 'validateProjectDirectory' | 'resolveHandle'>,
  workspaceId: string,
  folder: StoredProjectFolder,
): Promise<StoredProjectFolderResolution> {
  let handle: ResolvedProjectHandle | null;
  try {
    const issued = await service.validateProjectDirectory(workspaceId, folder.workingDirectory);
    handle = await service.resolveHandle({ workspaceId, projectHandleId: issued.id });
  } catch (error) {
    return {
      ok: false,
      problem: 'project-folder-unavailable',
      cause: error instanceof ProjectDirectoryError ? error.code : error instanceof Error ? error.message : String(error),
    };
  }
  if (!handle) return { ok: false, problem: 'project-folder-unavailable', cause: 'project-handle-invalid' };
  const sameIdentity = folder.projectKey !== undefined
    ? handle.persistence === 'stable' && handle.projectKey === folder.projectKey
    : handle.persistence === 'process-only';
  return sameIdentity ? { ok: true, handle } : { ok: false, problem: 'project-folder-identity-changed' };
}
