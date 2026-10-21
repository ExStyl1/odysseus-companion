import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { WorkspaceDefaultsInfo, WorkspaceInfo } from '@nessy-agent/core/types';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../config/paths.ts';
import { AtomicConfigWriteError, atomicWriteConfigFileSync, type ConfigWriteStep } from '../config/storage.ts';
import { getCredentialManager } from '../credentials/index.ts';
import {
  SESSIONS_DIR,
  assertStorageId,
  getWorkspaceRootPath,
  getWorkspaceSessionRootPath,
  isPathWithin,
  resolveContainedPath,
} from './paths.ts';
import { initializeWorkspaceAtRoot, loadWorkspaceConfig, saveWorkspaceConfig } from './storage.ts';
import { createPluginDataCleanupParticipant } from '../plugins/data-paths.ts';
import { CapabilityPolicyStore } from '../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../capabilities/trust-store.ts';
import { isValidProjectKey } from '../projects/project-identity.ts';
import type {
  ConnectRemoteWorkspaceInput,
  CreateWorkspaceOnRemoteInput,
  CreateWorkspaceRequest,
  RemoteWorkspaceBinding,
  ResolvedRemoteWorkspaceConnection,
  ResolvedWorkspace,
  StoredWorkspaceRef,
  UpdateWorkspaceSettingsInput,
  WorkspaceCleanupParticipant,
  WorkspaceConfig,
  WorkspaceCreationDefaults,
  WorkspaceDefaultProject,
  WorkspaceDeleteResult,
  UpdateRemoteWorkspaceInput,
} from './types.ts';

export type {
  ConnectRemoteWorkspaceInput,
  CreateWorkspaceOnRemoteInput,
  CreateWorkspaceRequest,
  RemoteWorkspaceBinding,
  ResolvedRemoteWorkspaceConnection,
  ResolvedWorkspace,
  UpdateWorkspaceSettingsInput,
  WorkspaceCleanupParticipant,
  WorkspaceCreationDefaults,
  WorkspaceDeleteResult,
  UpdateRemoteWorkspaceInput,
} from './types.ts';

type CleanupResource = WorkspaceDeleteResult['cleanupFailures'][number]['resource'];

export interface WorkspaceService {
  create(input: CreateWorkspaceRequest): Promise<WorkspaceInfo>;
  connectRemoteWorkspace(input: ConnectRemoteWorkspaceInput): Promise<WorkspaceInfo>;
  updateRemoteWorkspace(input: UpdateRemoteWorkspaceInput): Promise<WorkspaceInfo>;
  createWorkspaceOnRemote(input: CreateWorkspaceOnRemoteInput): Promise<WorkspaceInfo>;
  resolveRemoteWorkspaceConnection(workspaceId: string): Promise<ResolvedRemoteWorkspaceConnection>;
  list(): Promise<WorkspaceInfo[]>;
  /** Server-only resolved registry. Never serialize these records. */
  listResolved(): ResolvedWorkspace[];
  resolve(workspaceId: string): ResolvedWorkspace;
  updateSettings(workspaceId: string, input: UpdateWorkspaceSettingsInput): Promise<WorkspaceInfo>;
  /** Server-only mutation; callers must resolve a Workspace-bound project handle first. */
  setDefaultProject(workspaceId: string, project: WorkspaceDefaultProject | null): Promise<WorkspaceInfo>;
  rename(workspaceId: string, name: string): Promise<WorkspaceInfo>;
  delete(workspaceId: string): Promise<WorkspaceDeleteResult>;
}

export interface WorkspaceQuiescenceLease {
  release(): Promise<void>;
}

/** Stops new Workspace work and waits for all active Workspace runtimes. */
export interface WorkspaceQuiescence {
  acquire(workspaceId: string): Promise<WorkspaceQuiescenceLease>;
}

export interface WorkspaceCredentialManager {
  list(filter?: { workspaceId?: string }): Promise<unknown[]>;
  getRemoteServerToken?(workspaceId: string): Promise<string | null>;
  setRemoteServerToken?(workspaceId: string, token: string): Promise<void>;
  deleteRemoteServerToken?(workspaceId: string): Promise<boolean>;
  deleteWorkspaceCredentials?(workspaceId: string): Promise<void>;
}

export interface RemoteWorkspaceGateway {
  verifyConnection(input: { url: string; token: string; remoteWorkspaceId: string }): Promise<void>;
  createWorkspace(input: { url: string; token: string; name: string }): Promise<{ remoteWorkspaceId: string }>;
}

export const REMOTE_BINDING_MUTATION_STEPS = [
  'before-staged-credential-swap',
  'after-staged-credential-swap',
  'before-workspace-config-swap',
  'after-workspace-config-swap',
  'before-credential-store-swap',
  'after-credential-store-swap',
  'before-registry-swap',
  'after-registry-swap',
] as const;

export type RemoteBindingMutationStep = typeof REMOTE_BINDING_MUTATION_STEPS[number];

export interface WorkspaceDefaultProjectResolver {
  getProject(workspaceId: string, project: WorkspaceDefaultProject): Promise<{
    handleId: string;
    name?: string;
    trusted: boolean;
  } | null>;
}

export interface WorkspaceServiceOptions {
  configDir?: string;
  credentialManager?: WorkspaceCredentialManager;
  defaultProjectResolver?: WorkspaceDefaultProjectResolver;
  quiescence?: WorkspaceQuiescence;
  cleanupParticipants?: WorkspaceCleanupParticipant[];
  configWriteFailpoint?: (step: ConfigWriteStep) => void;
  remoteGateway?: RemoteWorkspaceGateway;
  remoteBindingFailpoint?: (step: RemoteBindingMutationStep) => void;
  /** Runs after the root is initialized but before the new Workspace is committed. */
  onWorkspaceCreated?: (workspace: ResolvedWorkspace) => Promise<void> | void;
}

interface RegistryState {
  document: Record<string, unknown>;
  refs: StoredWorkspaceRef[];
}

type DeleteJournalPhase = 'quiesced' | 'roots-staged' | 'registry-removed' | 'cleanup-committed';

interface DeleteJournal {
  transactionId: string;
  workspaceId: string;
  phase: DeleteJournalPhase;
  participantIds: string[];
  ref: StoredWorkspaceRef;
  refIndex: number;
  wasActive: boolean;
}

interface DeleteJournalRecovery {
  trashPath: string;
  journal: DeleteJournal;
  outcome: 'rollback' | 'commit';
}

interface RemoteBindingJournal {
  version: 1;
  transactionId: string;
  operation: 'create' | 'update';
  workspaceId: string;
  stagedCredentialWorkspaceId: string;
  newBinding: RemoteWorkspaceBinding;
  newConfig: WorkspaceConfig;
  ref?: StoredWorkspaceRef;
}

export class RemoteWorkspaceConnectionError extends Error {
  constructor(readonly code: 'missing-credential' | 'binding-update-in-progress' | 'remote-not-configured') {
    super(code === 'missing-credential'
      ? 'Remote Workspace credential is missing'
      : code === 'binding-update-in-progress'
        ? 'Remote Workspace binding update is in progress'
        : 'Workspace is not configured for a remote server');
    this.name = 'RemoteWorkspaceConnectionError';
  }
}

export class RemoteWorkspaceLocalCommitError extends Error {
  readonly retryable = true;

  constructor(readonly remoteWorkspaceId: string) {
    super('Remote Workspace was created, but the local binding could not be committed. Retry by reconnecting it.');
    this.name = 'RemoteWorkspaceLocalCommitError';
  }
}

const CREATION_DEFAULT_KEYS = new Set([
  'model',
  'defaultLlmConnection',
  'enabledSourceSlugs',
  'permissionMode',
  'cyclablePermissionModes',
  'thinkingLevel',
  'colorTheme',
]);

const MUTABLE_DEFAULT_KEYS = new Set([
  ...CREATION_DEFAULT_KEYS,
]);

export function normalizeWorkspaceName(input: string): string {
  const name = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 80) throw new Error('Workspace name must be 1–80 characters');
  if (/[\u0000-\u001f\u007f/\\]/u.test(name)) throw new Error('Workspace name contains unsupported characters');
  return name;
}

export function workspaceNameKey(input: string): string {
  return normalizeWorkspaceName(input).toLocaleLowerCase('en-US');
}

export function createWorkspaceService(options: WorkspaceServiceOptions = {}): WorkspaceService {
  return new CanonicalWorkspaceService(options);
}

/**
 * The transactional plugin/policy/trust Workspace-cleanup participants (W7 Step 4).
 * Their ids are exactly `plugin-data`, `capability-policy` and `capability-trust`
 * so `resourceForParticipant` classifies cleanup failures correctly. W9 wires
 * these into the production `WorkspaceService` composition; whole-project trust
 * (keyed only by ProjectKey) is deliberately NOT a participant — it survives
 * Workspace deletion.
 */
export function defaultWorkspaceCleanupParticipants(): WorkspaceCleanupParticipant[] {
  return [
    createPluginDataCleanupParticipant(),
    new CapabilityPolicyStore().cleanupParticipant(),
    new CapabilityTrustStore().cleanupParticipant(),
  ];
}

export class CanonicalWorkspaceService implements WorkspaceService {
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly workspacesDir: string;
  private readonly sessionsDir: string;
  private readonly remoteTransactionsDir: string;
  private readonly credentialManager: WorkspaceCredentialManager;
  private readonly remoteGateway: RemoteWorkspaceGateway | undefined;
  private readonly remoteBindingFailpoint: ((step: RemoteBindingMutationStep) => void) | undefined;
  private readonly defaultProjectResolver: WorkspaceDefaultProjectResolver | undefined;
  private readonly quiescence: WorkspaceQuiescence | undefined;
  private readonly cleanupParticipants: WorkspaceCleanupParticipant[];
  private readonly configWriteFailpoint: ((step: ConfigWriteStep) => void) | undefined;
  private readonly onWorkspaceCreated: WorkspaceServiceOptions['onWorkspaceCreated'];
  private readonly recovery: Promise<void>;
  private readonly recoveringWorkspaceIds = new Set<string>();
  private readonly remoteBindingWorkspaceIds = new Set<string>();
  private recoveryError: unknown;

  constructor(options: WorkspaceServiceOptions = {}) {
    this.configDir = options.configDir ?? CONFIG_DIR;
    this.configPath = join(this.configDir, 'config.json');
    this.workspacesDir = join(this.configDir, 'workspaces');
    this.sessionsDir = join(this.configDir, 'sessions');
    this.remoteTransactionsDir = join(this.configDir, '.remote-bindings');
    this.credentialManager = options.credentialManager ?? getCredentialManager();
    this.remoteGateway = options.remoteGateway;
    this.remoteBindingFailpoint = options.remoteBindingFailpoint;
    this.defaultProjectResolver = options.defaultProjectResolver;
    this.quiescence = options.quiescence;
    this.cleanupParticipants = options.cleanupParticipants ?? [];
    this.configWriteFailpoint = options.configWriteFailpoint;
    this.onWorkspaceCreated = options.onWorkspaceCreated;
    // Delete-journal reconciliation is intentionally invoked synchronously: resolve()
    // must fail closed immediately while asynchronous participant recovery runs.
    const deleteRecovery = this.recoverDeleteJournals();
    this.recovery = this.recoverRemoteBindingJournals().then(() => deleteRecovery).then(
      () => { this.recoveringWorkspaceIds.clear(); },
      error => {
        this.recoveryError = error;
        throw error;
      },
    );
    void this.recovery.catch(() => {});
  }

  async create(input: CreateWorkspaceRequest): Promise<WorkspaceInfo> {
    await this.recovery;
    assertCreateInput(input);
    const name = normalizeWorkspaceName(input.name);
    const defaults = normalizeCreationDefaults(input.defaults);
    const registry = this.readRegistry();
    this.assertUniqueName(registry.refs, name);

    const id = randomUUID();
    const workspaceRootPath = this.getWorkspaceRootPath(id);
    if (existsSync(workspaceRootPath)) {
      throw new Error('Managed workspace path already exists');
    }

    const now = Date.now();
    const config: WorkspaceConfig = {
      id,
      name,
      ...(defaults ? { defaults } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const ref: StoredWorkspaceRef = { id, lastAccessedAt: now };

    try {
      initializeWorkspaceAtRoot(workspaceRootPath, config);
      const resolved: ResolvedWorkspace = {
        id,
        workspaceRootPath,
        sessionRootPath: this.getSessionRootPath(id),
        config,
        lastAccessedAt: ref.lastAccessedAt,
      };
      await this.onWorkspaceCreated?.(resolved);
      this.writeRegistry(registry.document, [...registry.refs, ref]);
    } catch (error) {
      try { rmSync(workspaceRootPath, { recursive: true, force: true }); } catch {}
      throw error;
    }

    return this.toWorkspaceInfo({
      id,
      workspaceRootPath,
      sessionRootPath: this.getSessionRootPath(id),
      config,
      lastAccessedAt: ref.lastAccessedAt,
    });
  }

  async connectRemoteWorkspace(input: ConnectRemoteWorkspaceInput): Promise<WorkspaceInfo> {
    await this.recovery;
    const gateway = this.requireRemoteGateway();
    const name = normalizeWorkspaceName(input.name);
    const binding = normalizeRemoteBinding(input.url, input.remoteWorkspaceId);
    const token = normalizeRemoteToken(input.token);
    const registry = this.readRegistry();
    const existingRef = registry.refs.find(ref => workspaceNameKey(this.resolveRef(ref).config.name) === workspaceNameKey(name));
    if (existingRef) {
      const existing = this.resolveRef(existingRef);
      if (!sameRemoteBinding(existing.config.remoteServer, binding)) {
        throw new Error('Workspace name already exists');
      }
      return this.updateRemoteWorkspace({
        workspaceId: existing.id,
        url: binding.url,
        remoteWorkspaceId: binding.remoteWorkspaceId,
        token,
      });
    }
    await verifyRemoteConnection(gateway, { ...binding, token });

    const id = randomUUID();
    const now = Date.now();
    const ref: StoredWorkspaceRef = { id, lastAccessedAt: now };
    const config: WorkspaceConfig = {
      id,
      name,
      remoteServer: binding,
      createdAt: now,
      updatedAt: now,
    };
    const journal = this.newRemoteBindingJournal('create', id, binding, config, ref);
    this.remoteBindingWorkspaceIds.add(id);

    try {
      this.writeRemoteBindingJournal(journal);
      await this.writeStagedRemoteToken(journal, token);
      this.remoteBindingFailpoint?.('before-workspace-config-swap');
      initializeWorkspaceAtRoot(this.getWorkspaceRootPath(id), config);
      this.remoteBindingFailpoint?.('after-workspace-config-swap');
      await this.onWorkspaceCreated?.({
        id,
        workspaceRootPath: this.getWorkspaceRootPath(id),
        sessionRootPath: this.getSessionRootPath(id),
        config,
        lastAccessedAt: ref.lastAccessedAt,
      });
      await this.commitRemoteToken(journal, token);
      this.remoteBindingFailpoint?.('before-registry-swap');
      this.writeRegistry(registry.document, [...registry.refs, ref]);
      this.remoteBindingFailpoint?.('after-registry-swap');
      await this.cleanupRemoteBindingJournal(journal);
      return this.toWorkspaceInfo(this.resolveRef(ref));
    } catch (error) {
      const outcome = await this.recoverRemoteBindingJournal(journal);
      if (outcome === 'committed') return this.toWorkspaceInfo(this.resolveRef(ref));
      throw error;
    } finally {
      this.remoteBindingWorkspaceIds.delete(id);
    }
  }

  async updateRemoteWorkspace(input: UpdateRemoteWorkspaceInput): Promise<WorkspaceInfo> {
    await this.recovery;
    const workspaceId = assertStorageId('workspace', input.workspaceId);
    const resolved = this.resolve(workspaceId);
    const oldBinding = resolved.config.remoteServer;
    if (!oldBinding) throw new RemoteWorkspaceConnectionError('remote-not-configured');
    const newBinding = normalizeRemoteBinding(input.url, input.remoteWorkspaceId);
    const endpointChanged = !sameRemoteBinding(oldBinding, newBinding);
    if (endpointChanged && input.token === undefined) {
      throw new Error('A fresh remote token is required when the remote endpoint or Workspace changes');
    }
    if (input.token === undefined) return this.toWorkspaceInfo(resolved);

    const token = normalizeRemoteToken(input.token);
    await verifyRemoteConnection(this.requireRemoteGateway(), { ...newBinding, token });
    if (this.remoteBindingWorkspaceIds.has(workspaceId)) {
      throw new RemoteWorkspaceConnectionError('binding-update-in-progress');
    }
    const newConfig: WorkspaceConfig = { ...resolved.config, remoteServer: newBinding };
    const journal = this.newRemoteBindingJournal('update', workspaceId, newBinding, newConfig);
    this.remoteBindingWorkspaceIds.add(workspaceId);

    try {
      this.writeRemoteBindingJournal(journal);
      await this.writeStagedRemoteToken(journal, token);
      await this.commitRemoteToken(journal, token);
      this.remoteBindingFailpoint?.('before-workspace-config-swap');
      saveWorkspaceConfig(resolved.workspaceRootPath, newConfig);
      this.remoteBindingFailpoint?.('after-workspace-config-swap');
      await this.cleanupRemoteBindingJournal(journal);
      return this.toWorkspaceInfo({ ...resolved, config: newConfig });
    } catch (error) {
      const outcome = await this.recoverRemoteBindingJournal(journal);
      if (outcome === 'committed') {
        return this.toWorkspaceInfo({ ...resolved, config: newConfig });
      }
      throw error;
    } finally {
      this.remoteBindingWorkspaceIds.delete(workspaceId);
    }
  }

  async createWorkspaceOnRemote(input: CreateWorkspaceOnRemoteInput): Promise<WorkspaceInfo> {
    await this.recovery;
    const gateway = this.requireRemoteGateway();
    const name = normalizeWorkspaceName(input.name);
    const url = normalizeRemoteUrl(input.url);
    const token = normalizeRemoteToken(input.token);
    const registry = this.readRegistry();
    this.assertUniqueName(registry.refs, name);

    let remoteWorkspaceId: string;
    try {
      const created = await gateway.createWorkspace({ url, token, name });
      remoteWorkspaceId = normalizeRemoteWorkspaceId(created.remoteWorkspaceId);
    } catch {
      throw new Error('Remote Workspace creation failed');
    }

    try {
      return await this.connectRemoteWorkspace({ name, url, token, remoteWorkspaceId });
    } catch {
      throw new RemoteWorkspaceLocalCommitError(remoteWorkspaceId);
    }
  }

  async resolveRemoteWorkspaceConnection(workspaceId: string): Promise<ResolvedRemoteWorkspaceConnection> {
    await this.recovery;
    const id = assertStorageId('workspace', workspaceId);
    if (this.remoteBindingWorkspaceIds.has(id) || this.hasRemoteBindingJournal(id)) {
      throw new RemoteWorkspaceConnectionError('binding-update-in-progress');
    }
    const resolved = this.resolve(id);
    const binding = resolved.config.remoteServer;
    if (!binding) throw new RemoteWorkspaceConnectionError('remote-not-configured');
    const token = await this.requireRemoteCredentials().getRemoteServerToken(id);
    if (!token) throw new RemoteWorkspaceConnectionError('missing-credential');
    return { localWorkspaceId: id, ...binding, token };
  }

  async list(): Promise<WorkspaceInfo[]> {
    await this.recovery;
    const registry = this.readRegistry();
    return Promise.all(registry.refs.map(ref => this.toWorkspaceInfo(this.resolveRef(ref))));
  }

  listResolved(): ResolvedWorkspace[] {
    if (this.recoveryError) throw this.recoveryError;
    return this.readRegistry().refs.map(ref => this.resolveRef(ref));
  }

  resolve(workspaceId: string): ResolvedWorkspace {
    const id = assertStorageId('workspace', workspaceId);
    if (this.recoveryError) throw this.recoveryError;
    if (this.recoveringWorkspaceIds.has(id)) {
      throw new Error('Workspace delete recovery is in progress');
    }
    const registry = this.readRegistry();
    const ref = registry.refs.find(candidate => candidate.id === id);
    if (!ref) throw new Error('Workspace is not registered');
    return this.resolveRef(ref);
  }

  async updateSettings(workspaceId: string, input: UpdateWorkspaceSettingsInput): Promise<WorkspaceInfo> {
    await this.recovery;
    const resolved = this.resolve(workspaceId);
    const config: WorkspaceConfig = {
      ...resolved.config,
      defaults: { ...resolved.config.defaults },
    };

    for (const [key, value] of Object.entries(input.defaults ?? {})) {
      if (!MUTABLE_DEFAULT_KEYS.has(key)) throw new Error(`Unsupported Workspace default: ${key}`);
      if (
        key === 'colorTheme'
        && value !== undefined
        && value !== 'default'
        && (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
      ) {
        throw new Error('Invalid Workspace color theme');
      }
      (config.defaults as Record<string, unknown>)[key] = value;
    }
    for (const key of input.clearDefaults ?? []) {
      if (!MUTABLE_DEFAULT_KEYS.has(key)) throw new Error(`Unsupported Workspace default: ${key}`);
      delete (config.defaults as Record<string, unknown>)[key];
    }
    if (input.localMcpEnabled !== undefined) {
      config.localMcpServers = { enabled: input.localMcpEnabled };
    }

    saveWorkspaceConfig(resolved.workspaceRootPath, config);
    return this.toWorkspaceInfo({ ...resolved, config });
  }

  async setDefaultProject(workspaceId: string, project: WorkspaceDefaultProject | null): Promise<WorkspaceInfo> {
    await this.recovery;
    const resolved = this.resolve(workspaceId);
    const config: WorkspaceConfig = {
      ...resolved.config,
      defaults: { ...resolved.config.defaults },
    };
    if (project) config.defaults!.defaultProject = normalizeDefaultProject(project);
    else delete config.defaults!.defaultProject;
    saveWorkspaceConfig(resolved.workspaceRootPath, config);
    return this.toWorkspaceInfo({ ...resolved, config });
  }

  async rename(workspaceId: string, name: string): Promise<WorkspaceInfo> {
    await this.recovery;
    const id = assertStorageId('workspace', workspaceId);
    const normalizedName = normalizeWorkspaceName(name);
    const registry = this.readRegistry();
    const ref = registry.refs.find(candidate => candidate.id === id);
    if (!ref) throw new Error('Workspace is not registered');
    this.assertUniqueName(registry.refs, normalizedName, id);

    const resolved = this.resolveRef(ref);
    const config = { ...resolved.config, name: normalizedName };
    saveWorkspaceConfig(resolved.workspaceRootPath, config);
    return this.toWorkspaceInfo({ ...resolved, config });
  }

  async delete(workspaceId: string): Promise<WorkspaceDeleteResult> {
    await this.recovery;
    const id = assertStorageId('workspace', workspaceId);
    const registry = this.readRegistry();
    const ref = registry.refs.find(candidate => candidate.id === id);
    if (!ref) throw new Error('Workspace is not registered');
    const resolved = this.resolveRef(ref);
    if (!isPathWithin(this.getSessionsRoot(), resolved.sessionRootPath)) {
      throw new Error('Managed session path escapes Workspace storage');
    }
    if (!this.quiescence) {
      throw new Error('Workspace quiescence is required for deletion');
    }

    const transactionId = randomUUID();
    const trashPath = resolveContainedPath(this.configDir, '.trash', transactionId);
    const stagedWorkspacePath = resolveContainedPath(trashPath, 'workspace');
    const stagedSessionRootPath = resolveContainedPath(trashPath, 'sessions');
    const cleanupFailures: WorkspaceDeleteResult['cleanupFailures'] = [];
    const journal: DeleteJournal = {
      transactionId,
      workspaceId: id,
      phase: 'quiesced',
      participantIds: this.cleanupParticipants.map(participant => participant.id),
      ref,
      refIndex: registry.refs.indexOf(ref),
      wasActive: registry.document.activeWorkspaceId === id,
    };
    const participants = this.participantsForJournal(journal);
    let lease: WorkspaceQuiescenceLease | undefined;
    let rootsStaged = false;
    let registryRemoved = false;
    let cleanupStagingStarted = false;
    let result: WorkspaceDeleteResult;

    try {
      lease = await this.quiescence.acquire(id);
      cleanupStagingStarted = true;
      this.writeJournal(trashPath, journal);

      for (const participant of participants) {
        await participant.stage(id, transactionId);
      }

      mkdirSync(trashPath, { recursive: true });
      renameSync(resolved.workspaceRootPath, stagedWorkspacePath);
      rootsStaged = true;
      // Sessions live under the disjoint global sessions root; stage that root in the same
      // transaction. A fresh Workspace with zero sessions has no root — that is a no-op.
      if (existsSync(resolved.sessionRootPath)) {
        renameSync(resolved.sessionRootPath, stagedSessionRootPath);
      }
      this.writeJournal(trashPath, { ...journal, phase: 'roots-staged' });

      const refs = registry.refs.filter(candidate => candidate.id !== id);
      const document = {
        ...registry.document,
        workspaceRefs: refs,
        ...(registry.document.activeWorkspaceId === id ? { activeWorkspaceId: refs[0]?.id ?? null } : {}),
      };
      const registryParentSyncFailed = this.writeRegistry(document, refs);
      registryRemoved = true;
      if (registryParentSyncFailed) {
        cleanupFailures.push(cleanupFailure('runtime', 'registry-parent-sync-failed'));
      }
      this.writeJournal(trashPath, { ...journal, phase: 'registry-removed' });

      for (const participant of participants) {
        await participant.commit(transactionId);
      }
      this.writeJournal(trashPath, { ...journal, phase: 'cleanup-committed' });
      await this.cleanupCredentials(id, cleanupFailures);

      try {
        rmSync(trashPath, { recursive: true, force: true });
      } catch {
        cleanupFailures.push(cleanupFailure('workspace-data', 'trash-cleanup-failed'));
      }
      result = { deleted: true, cleanupFailures };
    } catch {
      cleanupFailures.push(cleanupFailure('runtime', 'workspace-delete-failed'));
      let registryRestored = !registryRemoved;
      let registryRestoreUnconfirmed = false;
      if (registryRemoved) {
        try {
          const registryDurabilityUnconfirmed = this.writeRegistry(registry.document, registry.refs);
          if (registryDurabilityUnconfirmed) {
            registryRestoreUnconfirmed = true;
            cleanupFailures.push(cleanupFailure('runtime', 'registry-restore-unconfirmed'));
          } else {
            registryRestored = true;
          }
        } catch {
          cleanupFailures.push(cleanupFailure('runtime', 'registry-restore-failed'));
        }
      }

      if (registryRestoreUnconfirmed) {
        result = { deleted: false, cleanupFailures };
      } else if (!registryRestored) {
        for (const participant of participants) {
          try {
            await participant.commit(transactionId);
          } catch {
            cleanupFailures.push(cleanupFailure(resourceForParticipant(participant), 'cleanup-commit-failed'));
          }
        }
        await this.cleanupCredentials(id, cleanupFailures);
        try {
          rmSync(trashPath, { recursive: true, force: true });
        } catch {
          cleanupFailures.push(cleanupFailure('workspace-data', 'trash-cleanup-failed'));
        }
        result = { deleted: true, cleanupFailures };
      } else {
        let rootsRestored = !rootsStaged;
        if (rootsStaged) {
          if (!existsSync(resolved.workspaceRootPath) && existsSync(stagedWorkspacePath)) {
            try {
              renameSync(stagedWorkspacePath, resolved.workspaceRootPath);
            } catch {}
          }
          if (!existsSync(resolved.sessionRootPath) && existsSync(stagedSessionRootPath)) {
            try {
              renameSync(stagedSessionRootPath, resolved.sessionRootPath);
            } catch {}
          }
          rootsRestored = existsSync(resolved.workspaceRootPath)
            && !existsSync(stagedWorkspacePath)
            && !existsSync(stagedSessionRootPath);
          if (!rootsRestored) {
            cleanupFailures.push(cleanupFailure('workspace-data', 'workspace-restore-failed'));
          }
        }
        if (rootsRestored) {
          if (cleanupStagingStarted) {
            for (const participant of [...participants].reverse()) {
              try {
                await participant.rollback(transactionId);
              } catch {
                cleanupFailures.push(cleanupFailure(resourceForParticipant(participant), 'cleanup-rollback-failed'));
              }
            }
          }
          try {
            rmSync(trashPath, { recursive: true, force: true });
          } catch {
            cleanupFailures.push(cleanupFailure('workspace-data', 'trash-cleanup-failed'));
          }
        }
        result = { deleted: false, cleanupFailures };
      }
    }

    if (lease) {
      try {
        await lease.release();
      } catch {
        result.cleanupFailures.push(cleanupFailure('runtime', 'quiescence-release-failed'));
      }
    }
    return result;
  }

  private newRemoteBindingJournal(
    operation: RemoteBindingJournal['operation'],
    workspaceId: string,
    newBinding: RemoteWorkspaceBinding,
    newConfig: WorkspaceConfig,
    ref?: StoredWorkspaceRef,
  ): RemoteBindingJournal {
    const transactionId = randomUUID();
    return {
      version: 1,
      transactionId,
      operation,
      workspaceId,
      stagedCredentialWorkspaceId: `__remote-binding-${transactionId}`,
      newBinding,
      newConfig,
      ...(ref ? { ref } : {}),
    };
  }

  private remoteBindingTransactionPath(transactionId: string): string {
    return resolveContainedPath(this.remoteTransactionsDir, assertStorageId('workspace', transactionId));
  }

  private writeRemoteBindingJournal(journal: RemoteBindingJournal): void {
    const transactionPath = this.remoteBindingTransactionPath(journal.transactionId);
    try {
      atomicWriteConfigFileSync(
        join(transactionPath, 'journal.json'),
        JSON.stringify(journal, null, 2),
      );
    } catch (error) {
      if (error instanceof AtomicConfigWriteError) return;
      rmSync(transactionPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async writeStagedRemoteToken(journal: RemoteBindingJournal, token: string): Promise<void> {
    this.remoteBindingFailpoint?.('before-staged-credential-swap');
    await this.requireRemoteCredentials().setRemoteServerToken(journal.stagedCredentialWorkspaceId, token);
    this.remoteBindingFailpoint?.('after-staged-credential-swap');
  }

  private async commitRemoteToken(journal: RemoteBindingJournal, token: string): Promise<void> {
    this.remoteBindingFailpoint?.('before-credential-store-swap');
    await this.requireRemoteCredentials().setRemoteServerToken(journal.workspaceId, token);
    this.remoteBindingFailpoint?.('after-credential-store-swap');
  }

  private async cleanupRemoteBindingJournal(journal: RemoteBindingJournal): Promise<void> {
    await this.deleteRemoteTokenIfPresent(journal.stagedCredentialWorkspaceId);
    rmSync(this.remoteBindingTransactionPath(journal.transactionId), { recursive: true, force: true });
  }

  private async recoverRemoteBindingJournals(): Promise<void> {
    if (!existsSync(this.remoteTransactionsDir)) return;
    for (const entry of readdirSync(this.remoteTransactionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const journal = this.readRemoteBindingJournal(
        join(this.remoteBindingTransactionPath(entry.name), 'journal.json'),
        entry.name,
      );
      this.remoteBindingWorkspaceIds.add(journal.workspaceId);
      try {
        await this.recoverRemoteBindingJournal(journal);
      } finally {
        this.remoteBindingWorkspaceIds.delete(journal.workspaceId);
      }
    }
  }

  private readRemoteBindingJournal(path: string, transactionId: string): RemoteBindingJournal {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RemoteBindingJournal>;
      if (
        value.version !== 1
        || value.transactionId !== transactionId
        || (value.operation !== 'create' && value.operation !== 'update')
        || typeof value.workspaceId !== 'string'
        || typeof value.stagedCredentialWorkspaceId !== 'string'
        || !value.newBinding
        || !value.newConfig
      ) throw new Error();
      const workspaceId = assertStorageId('workspace', value.workspaceId);
      const stagedCredentialWorkspaceId = assertStorageId('workspace', value.stagedCredentialWorkspaceId);
      const newBinding = normalizeRemoteBinding(value.newBinding.url, value.newBinding.remoteWorkspaceId);
      if (
        value.newConfig.id !== workspaceId
        || value.newConfig.remoteServer?.url !== newBinding.url
        || value.newConfig.remoteServer.remoteWorkspaceId !== newBinding.remoteWorkspaceId
      ) throw new Error();
      if (value.operation === 'create' && (!value.ref || value.ref.id !== workspaceId)) throw new Error();
      return {
        version: 1,
        transactionId,
        operation: value.operation,
        workspaceId,
        stagedCredentialWorkspaceId,
        newBinding,
        newConfig: value.newConfig,
        ...(value.ref ? { ref: value.ref } : {}),
      };
    } catch {
      throw new Error('Remote Workspace binding journal is corrupt');
    }
  }

  private async recoverRemoteBindingJournal(
    journal: RemoteBindingJournal,
  ): Promise<'committed' | 'rolled-back'> {
    const transactionPath = this.remoteBindingTransactionPath(journal.transactionId);
    if (!existsSync(join(transactionPath, 'journal.json'))) {
      return 'rolled-back';
    }
    const registry = this.readRegistry();
    const registered = registry.refs.some(ref => ref.id === journal.workspaceId);
    const workspaceRootPath = this.getWorkspaceRootPath(journal.workspaceId);
    const credentials = this.requireRemoteCredentials();
    const stagedToken = await credentials.getRemoteServerToken(journal.stagedCredentialWorkspaceId);
    const committedToken = await credentials.getRemoteServerToken(journal.workspaceId);

    if (journal.operation === 'create') {
      if (!registered) {
        await this.deleteRemoteTokenIfPresent(journal.workspaceId);
        await this.deleteRemoteTokenIfPresent(journal.stagedCredentialWorkspaceId);
        rmSync(workspaceRootPath, { recursive: true, force: true });
        rmSync(transactionPath, { recursive: true, force: true });
        return 'rolled-back';
      }
      const config = loadWorkspaceConfig(workspaceRootPath);
      if (!config || !sameRemoteBinding(config.remoteServer, journal.newBinding) || !committedToken) {
        throw new Error('Remote Workspace binding recovery requires manual repair');
      }
      if (stagedToken && committedToken !== stagedToken) {
        throw new Error('Remote Workspace binding recovery requires manual repair');
      }
      await this.cleanupRemoteBindingJournal(journal);
      return 'committed';
    }

    if (!registered) throw new Error('Remote Workspace binding recovery requires manual repair');
    const current = loadWorkspaceConfig(workspaceRootPath);
    if (!current) throw new Error('Remote Workspace binding recovery requires manual repair');
    if (stagedToken && committedToken === stagedToken) {
      if (!sameRemoteBinding(current.remoteServer, journal.newBinding)) {
        saveWorkspaceConfig(workspaceRootPath, journal.newConfig);
      }
      await this.cleanupRemoteBindingJournal(journal);
      return 'committed';
    }
    if (!stagedToken && committedToken && sameRemoteBinding(current.remoteServer, journal.newBinding)) {
      rmSync(transactionPath, { recursive: true, force: true });
      return 'committed';
    }
    if (sameRemoteBinding(current.remoteServer, journal.newBinding)) {
      throw new Error('Remote Workspace binding recovery requires manual repair');
    }
    await this.cleanupRemoteBindingJournal(journal);
    return 'rolled-back';
  }

  private hasRemoteBindingJournal(workspaceId: string): boolean {
    if (!existsSync(this.remoteTransactionsDir)) return false;
    return readdirSync(this.remoteTransactionsDir, { withFileTypes: true }).some(entry => {
      if (!entry.isDirectory()) return false;
      try {
        return this.readRemoteBindingJournal(
          join(this.remoteBindingTransactionPath(entry.name), 'journal.json'),
          entry.name,
        ).workspaceId === workspaceId;
      } catch {
        return true;
      }
    });
  }

  private requireRemoteGateway(): RemoteWorkspaceGateway {
    if (!this.remoteGateway) throw new Error('Remote Workspace operations are unavailable');
    return this.remoteGateway;
  }

  private requireRemoteCredentials(): Required<Pick<
    WorkspaceCredentialManager,
    'getRemoteServerToken' | 'setRemoteServerToken' | 'deleteRemoteServerToken'
  >> {
    const { getRemoteServerToken, setRemoteServerToken, deleteRemoteServerToken } = this.credentialManager;
    if (!getRemoteServerToken || !setRemoteServerToken || !deleteRemoteServerToken) {
      throw new Error('Remote Workspace credential storage is unavailable');
    }
    return {
      getRemoteServerToken: getRemoteServerToken.bind(this.credentialManager),
      setRemoteServerToken: setRemoteServerToken.bind(this.credentialManager),
      deleteRemoteServerToken: deleteRemoteServerToken.bind(this.credentialManager),
    };
  }

  private async deleteRemoteTokenIfPresent(workspaceId: string): Promise<void> {
    const credentials = this.requireRemoteCredentials();
    if (await credentials.getRemoteServerToken(workspaceId) === null) return;
    if (!await credentials.deleteRemoteServerToken(workspaceId)) {
      throw new Error('Remote Workspace credential cleanup failed');
    }
  }

  private readRegistry(): RegistryState {
    if (!existsSync(this.configPath)) {
      return {
        document: {
          storageLayoutVersion: STORAGE_LAYOUT_VERSION,
          workspaceRefs: [],
          activeWorkspaceId: null,
          activeSessionId: null,
        },
        refs: [],
      };
    }

    let document: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      document = value as Record<string, unknown>;
    } catch {
      throw new Error('Workspace registry is corrupt');
    }

    if ('workspaces' in document) throw new Error('Workspace registry is corrupt');
    const rawRefs = document.workspaceRefs;
    if (!Array.isArray(rawRefs)) throw new Error('Workspace registry is corrupt');

    const seenIds = new Set<string>();
    const refs = rawRefs.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Workspace registry is corrupt');
      const { id, lastAccessedAt } = raw as Record<string, unknown>;
      if (
        typeof id !== 'string'
        || typeof lastAccessedAt !== 'number'
        || !Number.isInteger(lastAccessedAt)
        || lastAccessedAt < 0
      ) {
        throw new Error('Workspace registry is corrupt');
      }
      let storageId: string;
      try {
        storageId = assertStorageId('workspace', id);
      } catch {
        throw new Error('Workspace registry is corrupt');
      }
      if (seenIds.has(storageId)) throw new Error('Workspace registry is corrupt');
      seenIds.add(storageId);
      return { id: storageId, lastAccessedAt };
    });
    return { document, refs };
  }

  /** Returns true when the atomic rename committed but parent fsync reported an error. */
  private writeRegistry(document: Record<string, unknown>, refs: StoredWorkspaceRef[]): boolean {
    try {
      atomicWriteConfigFileSync(
        this.configPath,
        JSON.stringify({ ...document, workspaceRefs: refs }, null, 2),
        this.configWriteFailpoint,
      );
      return false;
    } catch (error) {
      if (error instanceof AtomicConfigWriteError) return true;
      throw error;
    }
  }

  private resolveRef(ref: StoredWorkspaceRef): ResolvedWorkspace {
    const workspaceRootPath = this.getWorkspaceRootPath(ref.id);
    const configPath = join(workspaceRootPath, 'config.json');
    if (!existsSync(workspaceRootPath) || !existsSync(configPath)) {
      throw new Error('Registered workspace data is missing');
    }
    const config = loadWorkspaceConfig(workspaceRootPath);
    if (!config) throw new Error('Registered workspace data is corrupt');
    if (config.id !== ref.id) throw new Error('Registered workspace data does not match registry');

    return {
      id: ref.id,
      workspaceRootPath,
      sessionRootPath: this.getSessionRootPath(ref.id),
      config,
      lastAccessedAt: ref.lastAccessedAt,
    };
  }

  private getWorkspaceRootPath(workspaceId: string): string {
    if (this.configDir === CONFIG_DIR) return getWorkspaceRootPath(workspaceId);
    return resolveContainedPath(this.workspacesDir, assertStorageId('workspace', workspaceId));
  }

  /**
   * Sessions live in the global managed sessions root, partitioned by immutable Workspace ID
   * (`SESSIONS_DIR/<workspaceId>`), never nested under the Workspace root. This mirrors the
   * central `getWorkspaceSessionRootPath` resolver for a custom (test-only) `configDir`.
   */
  private getSessionsRoot(): string {
    return this.configDir === CONFIG_DIR ? SESSIONS_DIR : this.sessionsDir;
  }

  private getSessionRootPath(workspaceId: string): string {
    if (this.configDir === CONFIG_DIR) return getWorkspaceSessionRootPath(workspaceId);
    return resolveContainedPath(this.sessionsDir, assertStorageId('workspace', workspaceId));
  }

  private assertUniqueName(refs: StoredWorkspaceRef[], name: string, excludedId?: string): void {
    const nameKey = workspaceNameKey(name);
    for (const ref of refs) {
      if (ref.id === excludedId) continue;
      if (workspaceNameKey(this.resolveRef(ref).config.name) === nameKey) {
        throw new Error('Workspace name already exists');
      }
    }
  }

  private async toWorkspaceInfo(resolved: ResolvedWorkspace): Promise<WorkspaceInfo> {
    const hasRemoteCredential = resolved.config.remoteServer && this.credentialManager.getRemoteServerToken
      ? Boolean(await this.credentialManager.getRemoteServerToken(resolved.id))
      : false;
    const defaults = toWorkspaceDefaultsInfo(resolved.config.defaults) ?? {};
    const defaultProject = resolved.config.defaults?.defaultProject;
    if (defaultProject && this.defaultProjectResolver) {
      const project = await this.defaultProjectResolver.getProject(resolved.id, defaultProject);
      if (project) {
        defaults.defaultProject = {
          handleId: project.handleId,
          ...(project.name ? { name: project.name } : {}),
          trusted: project.trusted,
        };
      }
    }
    return {
      id: resolved.id,
      name: resolved.config.name,
      lastAccessedAt: resolved.lastAccessedAt,
      iconUrl: `workspace-icon://${resolved.id}`,
      ...(resolved.config.remoteServer ? {
        remoteServer: {
          url: resolved.config.remoteServer.url,
          remoteWorkspaceId: resolved.config.remoteServer.remoteWorkspaceId,
        },
      } : {}),
      ...(Object.keys(defaults).length ? { defaults } : {}),
      hasCredential: hasRemoteCredential,
    };
  }

  private async cleanupCredentials(
    workspaceId: string,
    cleanupFailures?: WorkspaceDeleteResult['cleanupFailures'],
  ): Promise<void> {
    if (!this.credentialManager.deleteWorkspaceCredentials) {
      cleanupFailures?.push(cleanupFailure('credentials', 'credential-cleanup-unavailable'));
      return;
    }
    try {
      await this.credentialManager.deleteWorkspaceCredentials(workspaceId);
    } catch {
      cleanupFailures?.push(cleanupFailure('credentials', 'credential-cleanup-failed'));
    }
  }

  private async cleanupRecoveredCredentials(workspaceId: string): Promise<void> {
    if (!this.credentialManager.deleteWorkspaceCredentials) {
      throw new Error('Workspace credential cleanup is unavailable during recovery');
    }
    try {
      await this.credentialManager.deleteWorkspaceCredentials(workspaceId);
    } catch {
      throw new Error('Workspace credential cleanup failed during recovery');
    }
  }

  private participantsForJournal(journal: DeleteJournal): WorkspaceCleanupParticipant[] {
    const seenIds = new Set<string>();
    return journal.participantIds.map(id => {
      if (!id || seenIds.has(id)) throw new Error('Workspace delete journal is corrupt');
      seenIds.add(id);
      const matches = this.cleanupParticipants.filter(participant => participant.id === id);
      if (matches.length !== 1) throw new Error('Workspace delete recovery requires manual repair');
      return matches[0]!;
    });
  }

  private writeJournal(trashPath: string, journal: DeleteJournal): void {
    atomicWriteConfigFileSync(join(trashPath, 'journal.json'), JSON.stringify(journal, null, 2));
  }

  private recoverDeleteJournals(): Promise<void> {
    const recoveries = this.reconcileDeleteJournals();
    for (const recovery of recoveries) {
      this.recoveringWorkspaceIds.add(recovery.journal.workspaceId);
    }
    return this.completeDeleteRecoveries(recoveries);
  }

  private reconcileDeleteJournals(): DeleteJournalRecovery[] {
    const trashRoot = resolveContainedPath(this.configDir, '.trash');
    if (!existsSync(trashRoot)) return [];

    const recoveredIds = new Set<string>();
    const recoveries: DeleteJournalRecovery[] = [];
    for (const entry of readdirSync(trashRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const trashPath = resolveContainedPath(trashRoot, assertStorageId('workspace', entry.name));
      const journalPath = join(trashPath, 'journal.json');
      if (!existsSync(journalPath)) continue;

      const journal = this.readDeleteJournal(journalPath, entry.name);
      if (recoveredIds.has(journal.workspaceId)) throw new Error('Workspace delete journal is corrupt');
      recoveredIds.add(journal.workspaceId);
      this.participantsForJournal(journal);

      const registry = this.readRegistry();
      const registered = registry.refs.some(ref => ref.id === journal.workspaceId);
      const workspaceRootPath = this.getWorkspaceRootPath(journal.workspaceId);
      const stagedWorkspacePath = resolveContainedPath(trashPath, 'workspace');
      const rootExists = existsSync(workspaceRootPath);
      const stagedRootExists = existsSync(stagedWorkspacePath);

      if (registered) {
        if (journal.phase === 'cleanup-committed' || rootExists === stagedRootExists) {
          throw new Error('Workspace delete recovery requires manual repair');
        }
        if (stagedRootExists) renameSync(stagedWorkspacePath, workspaceRootPath);
        this.restoreStagedSessionRoot(trashPath, journal.workspaceId);
        recoveries.push({ trashPath, journal, outcome: 'rollback' });
        continue;
      }

      if (journal.phase === 'quiesced' || rootExists || !stagedRootExists) {
        throw new Error('Workspace delete recovery requires manual repair');
      }
      recoveries.push({ trashPath, journal, outcome: 'commit' });
    }
    return recoveries;
  }

  private readDeleteJournal(journalPath: string, transactionId: string): DeleteJournal {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(journalPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      value = parsed as Record<string, unknown>;
    } catch {
      throw new Error('Workspace delete journal is corrupt');
    }

    if (value.transactionId !== transactionId || typeof value.workspaceId !== 'string') {
      throw new Error('Workspace delete journal is corrupt');
    }
    let workspaceId: string;
    try {
      workspaceId = assertStorageId('workspace', value.workspaceId);
    } catch {
      throw new Error('Workspace delete journal is corrupt');
    }
    const phase = value.phase;
    if (!isDeleteJournalPhase(phase)) throw new Error('Workspace delete journal is corrupt');

    const rawParticipantIds = value.participantIds;
    if (
      !Array.isArray(rawParticipantIds)
      || rawParticipantIds.some(id => typeof id !== 'string' || !id)
      || new Set(rawParticipantIds).size !== rawParticipantIds.length
    ) {
      throw new Error('Workspace delete journal is corrupt');
    }
    const participantIds = rawParticipantIds as string[];

    if (!value.ref || typeof value.ref !== 'object' || Array.isArray(value.ref)) {
      throw new Error('Workspace delete journal is corrupt');
    }
    const rawRef = value.ref as Record<string, unknown>;
    if (
      rawRef.id !== workspaceId
      || typeof rawRef.lastAccessedAt !== 'number'
      || !Number.isInteger(rawRef.lastAccessedAt)
      || rawRef.lastAccessedAt < 0
    ) {
      throw new Error('Workspace delete journal is corrupt');
    }
    const ref: StoredWorkspaceRef = { id: workspaceId, lastAccessedAt: rawRef.lastAccessedAt };
    const refIndex = value.refIndex;
    if (typeof refIndex !== 'number' || !Number.isInteger(refIndex) || refIndex < 0) {
      throw new Error('Workspace delete journal is corrupt');
    }
    const wasActive = value.wasActive;
    if (typeof wasActive !== 'boolean') {
      throw new Error('Workspace delete journal is corrupt');
    }

    return {
      transactionId,
      workspaceId,
      phase,
      participantIds,
      ref,
      refIndex,
      wasActive,
    };
  }

  private async completeDeleteRecoveries(recoveries: DeleteJournalRecovery[]): Promise<void> {
    for (const recovery of recoveries) {
      const participants = this.participantsForJournal(recovery.journal);
      if (recovery.outcome === 'rollback') {
        await this.rollbackRecoveredDelete(recovery, participants);
      } else {
        await this.commitRecoveredDelete(recovery, participants);
      }
    }
  }

  private async rollbackRecoveredDelete(
    recovery: DeleteJournalRecovery,
    participants: WorkspaceCleanupParticipant[],
  ): Promise<void> {
    for (const participant of [...participants].reverse()) {
      await participant.rollback(recovery.journal.transactionId);
    }
    rmSync(recovery.trashPath, { recursive: true, force: true });
  }

  private async commitRecoveredDelete(
    recovery: DeleteJournalRecovery,
    participants: WorkspaceCleanupParticipant[],
  ): Promise<void> {
    if (recovery.journal.phase !== 'cleanup-committed') {
      try {
        for (const participant of participants) {
          await participant.commit(recovery.journal.transactionId);
        }
      } catch {
        await this.restoreRecoveredDelete(recovery, participants);
        return;
      }
      try {
        this.writeJournal(recovery.trashPath, { ...recovery.journal, phase: 'cleanup-committed' });
      } catch {}
    }
    await this.cleanupRecoveredCredentials(recovery.journal.workspaceId);
    rmSync(recovery.trashPath, { recursive: true, force: true });
  }

  private async restoreRecoveredDelete(
    recovery: DeleteJournalRecovery,
    participants: WorkspaceCleanupParticipant[],
  ): Promise<void> {
    const registry = this.readRegistry();
    if (!registry.refs.some(ref => ref.id === recovery.journal.workspaceId)) {
      const ref = recovery.journal.ref;
      const refs = [...registry.refs];
      if (recovery.journal.refIndex > refs.length) {
        throw new Error('Workspace delete recovery requires manual repair');
      }
      refs.splice(recovery.journal.refIndex, 0, ref);
      const registryDurabilityUnconfirmed = this.writeRegistry({
        ...registry.document,
        workspaceRefs: refs,
        ...(recovery.journal.wasActive ? { activeWorkspaceId: recovery.journal.workspaceId } : {}),
      }, refs);
      if (registryDurabilityUnconfirmed) {
        throw new Error('Workspace registry recovery durability is unconfirmed');
      }
    }

    const workspaceRootPath = this.getWorkspaceRootPath(recovery.journal.workspaceId);
    const stagedWorkspacePath = resolveContainedPath(recovery.trashPath, 'workspace');
    if (!existsSync(stagedWorkspacePath) || existsSync(workspaceRootPath)) {
      throw new Error('Workspace delete recovery requires manual repair');
    }
    renameSync(stagedWorkspacePath, workspaceRootPath);
    this.restoreStagedSessionRoot(recovery.trashPath, recovery.journal.workspaceId);
    for (const participant of [...participants].reverse()) {
      await participant.rollback(recovery.journal.transactionId);
    }
    rmSync(recovery.trashPath, { recursive: true, force: true });
  }

  /**
   * Moves a staged disjoint session root (`<trash>/sessions`) back to the global
   * `SESSIONS_DIR/<workspaceId>` location during rollback recovery. Absent staged
   * sessions are a no-op (fresh Workspaces stage no session root).
   */
  private restoreStagedSessionRoot(trashPath: string, workspaceId: string): void {
    const stagedSessionRootPath = resolveContainedPath(trashPath, 'sessions');
    if (!existsSync(stagedSessionRootPath)) return;
    const sessionRootPath = this.getSessionRootPath(workspaceId);
    if (existsSync(sessionRootPath)) {
      throw new Error('Workspace delete recovery requires manual repair');
    }
    mkdirSync(this.getSessionsRoot(), { recursive: true });
    renameSync(stagedSessionRootPath, sessionRootPath);
  }
}

function isDeleteJournalPhase(value: unknown): value is DeleteJournalPhase {
  return value === 'quiesced'
    || value === 'roots-staged'
    || value === 'registry-removed'
    || value === 'cleanup-committed';
}

function normalizeRemoteUrl(input: string): string {
  if (typeof input !== 'string') throw new Error('Remote server URL must be a string');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Remote server URL is invalid');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Remote server URL must use ws or wss');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Remote server URL contains unsupported credentials, query, or fragment');
  }
  return url.toString();
}

function normalizeRemoteWorkspaceId(input: string): string {
  if (typeof input !== 'string') throw new Error('Remote Workspace ID must be a string');
  const value = input.trim();
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Remote Workspace ID is invalid');
  }
  return value;
}

function normalizeRemoteToken(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Remote server token is required');
  return input;
}

function normalizeRemoteBinding(url: string, remoteWorkspaceId: string): RemoteWorkspaceBinding {
  return {
    url: normalizeRemoteUrl(url),
    remoteWorkspaceId: normalizeRemoteWorkspaceId(remoteWorkspaceId),
  };
}

function sameRemoteBinding(
  left: RemoteWorkspaceBinding | undefined,
  right: RemoteWorkspaceBinding,
): boolean {
  return left?.url === right.url && left.remoteWorkspaceId === right.remoteWorkspaceId;
}

async function verifyRemoteConnection(
  gateway: RemoteWorkspaceGateway,
  input: { url: string; token: string; remoteWorkspaceId: string },
): Promise<void> {
  try {
    await gateway.verifyConnection(input);
  } catch {
    throw new Error('Remote Workspace connection verification failed');
  }
}

function assertCreateInput(input: CreateWorkspaceRequest): void {
  if (!input || typeof input !== 'object') throw new Error('Workspace creation input is invalid');
  for (const key of Object.keys(input)) {
    if (key !== 'name' && key !== 'defaults') throw new Error('Workspace creation accepts only name and defaults');
  }
  if (typeof input.name !== 'string') throw new Error('Workspace name must be a string');
}

function normalizeCreationDefaults(defaults: WorkspaceCreationDefaults | undefined): WorkspaceConfig['defaults'] | undefined {
  if (!defaults) return undefined;
  if (typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('Workspace defaults are invalid');
  for (const key of Object.keys(defaults)) {
    if (key === 'workingDirectory') throw new Error('Workspace defaults must not include workingDirectory');
    if (!CREATION_DEFAULT_KEYS.has(key)) throw new Error('Workspace defaults contain an unsupported field');
  }
  return { ...defaults };
}

function normalizeDefaultProject(project: WorkspaceDefaultProject): WorkspaceDefaultProject {
  if (typeof project.workingDirectory !== 'string' || !isAbsolute(project.workingDirectory) || project.workingDirectory.includes('\0')) {
    throw new Error('Workspace default project is invalid');
  }
  if (project.projectKey !== undefined && !isValidProjectKey(project.projectKey)) {
    throw new Error('Workspace default project identity is invalid');
  }
  return {
    workingDirectory: project.workingDirectory,
    ...(project.projectKey ? { projectKey: project.projectKey } : {}),
  };
}

function toWorkspaceDefaultsInfo(defaults: WorkspaceConfig['defaults']): WorkspaceDefaultsInfo | undefined {
  if (!defaults) return undefined;
  const info: WorkspaceDefaultsInfo = {};
  if (defaults.model !== undefined) info.model = defaults.model;
  if (defaults.defaultLlmConnection !== undefined) info.defaultLlmConnection = defaults.defaultLlmConnection;
  if (defaults.enabledSourceSlugs !== undefined) info.enabledSourceSlugs = [...defaults.enabledSourceSlugs];
  if (defaults.permissionMode !== undefined) info.permissionMode = defaults.permissionMode;
  if (defaults.cyclablePermissionModes !== undefined) info.cyclablePermissionModes = [...defaults.cyclablePermissionModes];
  if (defaults.thinkingLevel !== undefined) info.thinkingLevel = defaults.thinkingLevel;
  if (defaults.colorTheme !== undefined) info.colorTheme = defaults.colorTheme;
  return Object.keys(info).length ? info : undefined;
}

function cleanupFailure(resource: CleanupResource, code: string): WorkspaceDeleteResult['cleanupFailures'][number] {
  return { resource, code, message: 'Workspace cleanup did not complete.' };
}

function resourceForParticipant(participant: WorkspaceCleanupParticipant): CleanupResource {
  const resources: readonly CleanupResource[] = [
    'workspace-data',
    'session-data',
    'credentials',
    'runtime',
    'plugin-data',
    'capability-policy',
    'capability-trust',
    'recent-projects',
  ];
  return resources.includes(participant.id as CleanupResource) ? participant.id as CleanupResource : 'runtime';
}
