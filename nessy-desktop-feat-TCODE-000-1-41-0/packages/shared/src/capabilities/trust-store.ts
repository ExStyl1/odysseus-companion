/**
 * Capability trust store (W7 Step 8).
 *
 * A fresh store at `CONFIG_DIR/capability-trust.json`. It never reads or imports
 * the old `PluginStore`-owned `trust.json`. Trust is keyed by
 * `capabilityId + executableHash + scopeRef`. Native project executables are
 * the only runtime consumer.
 *
 * Legacy plugin-scoped records remain parseable only for compatibility cleanup.
 * Installed plugins use install + activation policy as their authorization
 * boundary; the resolver and trust RPCs never consult or create these records.
 */

import { existsSync, readFileSync } from 'node:fs';
import { CAPABILITY_TRUST_PATH } from '../workspaces/paths.ts';
import { atomicWriteConfigFileSync } from '../utils/durable-fs.ts';
import { isValidProjectKey } from '../projects/project-identity.ts';
import type { CapabilityScopeRef } from './types.ts';

const TRUST_FILE_VERSION = 2 as const;

export interface CapabilityTrustKey {
  /** Present for plugin capabilities; native project hooks are path-free keys. */
  pluginInstanceId?: string;
  capabilityId: string;
  executableHash: string;
  scope: CapabilityScopeRef;
}

export interface CapabilityTrustRecord extends CapabilityTrustKey {
  grantedAt: string;
  grantedBy?: string;
  revokedAt?: string;
}

export type CapabilityTrustState = 'trusted' | 'review-required';

interface TrustFile {
  version: number;
  records: CapabilityTrustRecord[];
}

export interface CapabilityTrustStoreOptions {
  path?: string;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScope(raw: unknown): CapabilityScopeRef | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind === 'builtin' || kind === 'global') return { kind };
  if (kind === 'workspace') {
    if (typeof raw.workspaceId !== 'string' || !raw.workspaceId) return null;
    return { kind, workspaceId: raw.workspaceId };
  }
  if (kind === 'project') {
    if (typeof raw.workspaceId !== 'string' || !raw.workspaceId) return null;
    if (!isValidProjectKey(raw.projectKey)) return null;
    return { kind, workspaceId: raw.workspaceId, projectKey: raw.projectKey };
  }
  return null;
}

function scopeToken(scope: CapabilityScopeRef): string {
  return `${scope.kind}:${scope.workspaceId ?? ''}:${scope.projectKey ?? ''}`;
}

function trustKey(key: CapabilityTrustKey): string {
  const subject = key.pluginInstanceId ? `plugin:${key.pluginInstanceId}` : 'native-project';
  return [subject, key.capabilityId, key.executableHash, scopeToken(key.scope)].join('|');
}

function parseRecord(raw: unknown): CapabilityTrustRecord | null {
  if (!isRecord(raw)) return null;
  const scope = parseScope(raw.scope);
  if (!scope) return null;
  const { pluginInstanceId, capabilityId, executableHash, grantedAt, grantedBy, revokedAt } = raw;
  if (pluginInstanceId !== undefined && (typeof pluginInstanceId !== 'string' || !pluginInstanceId)) return null;
  if (pluginInstanceId === undefined && scope.kind !== 'project') return null;
  if (typeof capabilityId !== 'string' || !capabilityId) return null;
  if (typeof executableHash !== 'string' || !executableHash) return null;
  if (typeof grantedAt !== 'string' || !grantedAt) return null;
  return {
    ...(pluginInstanceId ? { pluginInstanceId } : {}),
    capabilityId,
    executableHash,
    scope,
    grantedAt,
    ...(typeof grantedBy === 'string' && grantedBy ? { grantedBy } : {}),
    ...(typeof revokedAt === 'string' && revokedAt ? { revokedAt } : {}),
  };
}

export class CapabilityTrustStore {
  private readonly path: string;
  private readonly now: () => Date;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: CapabilityTrustStoreOptions = {}) {
    this.path = options.path ?? CAPABILITY_TRUST_PATH;
    this.now = options.now ?? (() => new Date());
  }

  /** Grant trust for an exact instance/capability/hash/scope key. */
  grant(key: CapabilityTrustKey, grantedBy?: string): CapabilityTrustRecord {
    if (!key.pluginInstanceId && (
      key.scope.kind !== 'project'
      || !key.scope.workspaceId
      || !key.scope.projectKey
    )) {
      throw new Error('Native executable trust requires an exact project scope');
    }
    const file = this.readFile();
    const record: CapabilityTrustRecord = {
      ...key,
      grantedAt: this.now().toISOString(),
      ...(grantedBy ? { grantedBy } : {}),
    };
    const id = trustKey(key);
    file.records = [...file.records.filter(r => trustKey(r) !== id), record];
    this.writeFile(file);
    return record;
  }

  /** Revoke a prior grant. Returns the revoked record or null when absent. */
  revoke(key: CapabilityTrustKey): CapabilityTrustRecord | null {
    const file = this.readFile();
    const id = trustKey(key);
    const index = file.records.findIndex(r => trustKey(r) === id);
    if (index < 0) return null;
    const existing = file.records[index];
    if (!existing) return null;
    const revoked: CapabilityTrustRecord = { ...existing, revokedAt: this.now().toISOString() };
    file.records[index] = revoked;
    this.writeFile(file);
    return revoked;
  }

  isTrusted(key: CapabilityTrustKey): boolean {
    const id = trustKey(key);
    return this.readFile().records.some(r => trustKey(r) === id && !r.revokedAt);
  }

  resolve(key: CapabilityTrustKey): CapabilityTrustState {
    return this.isTrusted(key) ? 'trusted' : 'review-required';
  }

  /**
   * Serialize plugin lifecycle and trust-consent mutations through one process
   * authority. Callers must keep active-instance validation and the final
   * grant/revoke/purge inside this boundary.
   */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Drop all grants, including revoked history, for uninstalled plugin instances. */
  purgePluginInstances(pluginInstanceIds: readonly string[]): number {
    const ids = new Set(pluginInstanceIds.filter(Boolean));
    if (ids.size === 0) return 0;
    const file = this.readFile();
    const retained = file.records.filter(record => (
      !record.pluginInstanceId || !ids.has(record.pluginInstanceId)
    ));
    const removed = file.records.length - retained.length;
    if (removed > 0) this.writeFile({ ...file, records: retained });
    return removed;
  }

  /**
   * Journaled Workspace-deletion participant (id `capability-trust`, W7 Step 4).
   * On commit it drops every Workspace-scoped executable-trust grant for the
   * deleted Workspace (workspace and project scopes carry the Workspace ID);
   * global/builtin grants and whole-project trust survive.
   */
  cleanupParticipant(): {
    id: 'capability-trust';
    stage(workspaceId: string, transactionId: string): Promise<void>;
    commit(transactionId: string): Promise<void>;
    rollback(transactionId: string): Promise<void>;
  } {
    const staged = new Map<string, string>();
    return {
      id: 'capability-trust',
      stage: async (workspaceId, transactionId) => {
        staged.set(transactionId, workspaceId);
      },
      commit: async (transactionId) => {
        await this.runExclusive(async () => {
          const workspaceId = staged.get(transactionId);
          if (!workspaceId) return;
          const file = this.readFile();
          const next = file.records.filter(r => r.scope.workspaceId !== workspaceId);
          if (next.length !== file.records.length) {
            this.writeFile({ ...file, records: next });
          }
          staged.delete(transactionId);
        });
      },
      rollback: async (transactionId) => {
        staged.delete(transactionId);
      },
    };
  }

  private readFile(): TrustFile {
    const empty: TrustFile = { version: TRUST_FILE_VERSION, records: [] };
    if (!existsSync(this.path)) return empty;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch {
      return empty;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) return empty;
    const records = parsed.records.map(parseRecord).filter((r): r is CapabilityTrustRecord => r !== null);
    return { version: TRUST_FILE_VERSION, records };
  }

  private writeFile(file: TrustFile): void {
    atomicWriteConfigFileSync(this.path, JSON.stringify({ ...file, version: TRUST_FILE_VERSION }, null, 2));
  }
}
