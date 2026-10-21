/**
 * Persistent project-trust store (W6).
 *
 * Persists path-free whole-project trust grants to `CONFIG_DIR/project-trust.json`
 * keyed by canonical `ProjectKey`. A stored record carries ONLY the project key,
 * the root-identity fingerprint, the decision state/source/revision and a
 * timestamp — never an absolute path.
 *
 * Matching rules (see resolve()):
 * - Folder selection alone creates no grant.
 * - A stored grant matches only when BOTH the project key and the current root
 *   identity fingerprint match, so replacing the inode at the same realpath (a
 *   different fingerprint) invalidates trust.
 * - Only `stable` identities may enter the persistent store. `process-only`
 *   decisions live in memory and expire with the process.
 *
 * All reads validate every record and silently drop malformed keys/records
 * (missing fields, wrong types, or a key that looks like an absolute path).
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PROJECT_TRUST_PATH } from '../workspaces/paths.ts';
import { atomicWriteConfigFileSync } from '../utils/durable-fs.ts';
import { isValidProjectKey, type ProjectKey, type ResolvedProjectIdentity } from '../projects/project-identity.ts';
import type {
  ProjectTrustDecisionState,
  ProjectTrustSource,
  ProjectTrustState,
} from './types.ts';

const TRUST_FILE_VERSION = 2 as const;
const DECISION_STATES = new Set<ProjectTrustDecisionState>(['trusted', 'blocked']);
const SOURCES = new Set<ProjectTrustSource>(['user', 'inherited', 'policy']);

export interface ProjectTrustRecord {
  projectKey: ProjectKey;
  identityFingerprint: string;
  state: ProjectTrustDecisionState;
  source: ProjectTrustSource;
  revision: string;
  updatedAt: string;
}

export interface ProjectTrustDecision {
  state: ProjectTrustState;
  source: ProjectTrustSource | null;
  revision: string;
  persistence: 'stable' | 'process-only';
}

const NONE_DECISION: ProjectTrustDecision = {
  state: 'none',
  source: null,
  revision: '',
  persistence: 'stable',
};

interface TrustFile {
  version: number;
  projects: Record<string, ProjectTrustRecord>;
}

export interface ProjectTrustStoreOptions {
  path?: string;
  now?: () => Date;
  newRevision?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(key: string, raw: unknown): ProjectTrustRecord | null {
  if (!isValidProjectKey(key) || !isRecord(raw)) return null;
  const { projectKey, identityFingerprint, state, source, revision, updatedAt } = raw;
  if (projectKey !== key) return null;
  if (typeof identityFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(identityFingerprint)) return null;
  if (typeof state !== 'string' || !DECISION_STATES.has(state as ProjectTrustDecisionState)) return null;
  if (typeof source !== 'string' || !SOURCES.has(source as ProjectTrustSource)) return null;
  if (typeof revision !== 'string' || !revision) return null;
  if (typeof updatedAt !== 'string' || !updatedAt) return null;
  return {
    projectKey,
    identityFingerprint,
    state: state as ProjectTrustDecisionState,
    source: source as ProjectTrustSource,
    revision,
    updatedAt,
  };
}

/**
 * Read/write project-trust grants. One instance may be shared across the
 * process; persisted grants are re-read on demand so external edits are seen.
 */
export class ProjectTrustStore {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly newRevision: () => string;
  private readonly processOnly = new Map<ProjectKey, ProjectTrustRecord>();

  constructor(options: ProjectTrustStoreOptions = {}) {
    this.path = options.path ?? PROJECT_TRUST_PATH;
    this.now = options.now ?? (() => new Date());
    this.newRevision = options.newRevision ?? (() => randomUUID());
  }

  /**
   * Resolve the current decision for a freshly-resolved identity. Returns
   * `none` unless a stored (or in-memory) grant matches BOTH the key and the
   * current fingerprint.
   */
  resolve(identity: ResolvedProjectIdentity): ProjectTrustDecision {
    if (identity.persistence === 'process-only') {
      const record = this.processOnly.get(identity.projectKey);
      if (record && record.identityFingerprint === identity.identityFingerprint) {
        return { state: record.state, source: record.source, revision: record.revision, persistence: 'process-only' };
      }
      return { ...NONE_DECISION, persistence: 'process-only' };
    }

    const record = this.readFile().projects[identity.projectKey];
    if (record && record.identityFingerprint === identity.identityFingerprint) {
      return { state: record.state, source: record.source, revision: record.revision, persistence: 'stable' };
    }
    return NONE_DECISION;
  }

  /**
   * Record (or clear) a trust decision. Stable identities persist atomically
   * with mode 0600, merge-preserving other projects' records. Process-only
   * identities are kept in memory only.
   */
  record(
    identity: ResolvedProjectIdentity,
    state: ProjectTrustDecisionState,
    source: ProjectTrustSource = 'user',
  ): ProjectTrustDecision {
    const entry: ProjectTrustRecord = {
      projectKey: identity.projectKey,
      identityFingerprint: identity.identityFingerprint,
      state,
      source,
      revision: this.newRevision(),
      updatedAt: this.now().toISOString(),
    };

    if (identity.persistence === 'process-only') {
      this.processOnly.set(identity.projectKey, entry);
      return { state, source, revision: entry.revision, persistence: 'process-only' };
    }

    const file = this.readFile();
    file.projects[identity.projectKey] = entry;
    this.writeFile(file);
    return { state, source, revision: entry.revision, persistence: 'stable' };
  }

  private readFile(): TrustFile {
    const empty: TrustFile = { version: TRUST_FILE_VERSION, projects: {} };
    if (!existsSync(this.path)) return empty;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch {
      return empty;
    }
    if (!isRecord(parsed) || !isRecord(parsed.projects)) return empty;

    const projects: Record<string, ProjectTrustRecord> = {};
    for (const [key, raw] of Object.entries(parsed.projects)) {
      const record = parseRecord(key, raw);
      if (record) projects[key] = record;
    }
    return { version: TRUST_FILE_VERSION, projects };
  }

  private writeFile(file: TrustFile): void {
    atomicWriteConfigFileSync(this.path, JSON.stringify({ ...file, version: TRUST_FILE_VERSION }, null, 2));
  }
}
