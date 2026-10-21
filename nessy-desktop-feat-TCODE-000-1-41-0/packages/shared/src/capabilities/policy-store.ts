/**
 * Scoped plugin-capability policy store (W7 Step 4).
 *
 * Activation lives here, decoupled from the immutable install, so one installed
 * bundle can be enabled differently across scopes:
 *
 * - Global + private Workspace-project policy → `CONFIG_DIR/capabilities.json`.
 *   Private per-`(workspaceId, projectKey)` overrides live under
 *   `projectOverrides[workspaceId]` and are USER-owned: they apply even when the
 *   repository is untrusted (the user, not the repo, authored them).
 * - Workspace policy → `workspaces/<workspaceId>/capabilities.json`.
 * - The trusted active-repository overlay comes from `.nessy-agent/config.toml` and is
 *   applied ONLY when the project is trusted; an untrusted/unknown repository
 *   contributes no overlay.
 *
 * Precedence is `global < workspace < project`. An explicit `enabled:false` is a
 * terminal suppression at its layer. IDs and `ProjectKey`s are validated; a
 * record with a missing/invalid Workspace or project identity is dropped —
 * missing identity is never a wildcard. Plugin install/enable APIs MUST NOT write
 * a project file; only `recordGlobal`/`recordWorkspace`/`recordProjectOverride`
 * (all in managed storage) mutate policy.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  GLOBAL_CAPABILITY_POLICY_PATH,
  WORKSPACES_DIR,
  assertStorageId,
  getWorkspaceRootPath,
  resolveContainedPath,
} from '../workspaces/paths.ts';
import { atomicWriteConfigFileSync } from '../utils/durable-fs.ts';
import { isValidProjectKey, type ProjectKey } from '../projects/project-identity.ts';
import type {
  CapabilityPolicyRecord,
  CapabilityScopeRef,
  ResolvedCapabilityActivation,
} from './types.ts';
import type { ResolvedPluginActivation, PluginScopeActivationState } from './resolver.ts';

const POLICY_FILE_VERSION = 2 as const;

interface GlobalPolicyFile {
  version: number;
  records: CapabilityPolicyRecord[];
  projectOverrides: Record<string, CapabilityPolicyRecord[]>;
}

interface WorkspacePolicyFile {
  version: number;
  records: CapabilityPolicyRecord[];
}

/** Overlay layer contributed by a trusted repository's `.nessy-agent/config.toml`. */
export interface TrustedProjectOverlay {
  records: CapabilityPolicyRecord[];
}

export interface PolicyResolutionContext {
  workspaceId?: string;
  projectKey?: ProjectKey;
  /** Trusted overlay records; supply ONLY when the project is trusted. */
  trustedProjectOverlay?: TrustedProjectOverlay;
  /**
   * The managed tier's verdict for THIS target, already read from the managed
   * policy by the caller (`resolveManagedPluginActivation`).
   *
   * `settings-reference.md#enabledplugins` puts the managed scope above every
   * other `enabledPlugins` scope in BOTH directions — "A plugin set to `false`
   * here is blocked from installation at every scope and hidden from the
   * marketplace" and "Plugins force-enabled by managed settings can't be
   * disabled this way, since managed settings override local settings" — so it
   * is applied after all persisted layers and is terminal: `'force-enabled'`
   * cannot be disabled by a user, workspace or project record, and `'blocked'`
   * cannot be enabled by one.
   * Absent means the managed tier stated no opinion and the persisted layers
   * decide exactly as before.
   *
   * Passed IN rather than read here so this store keeps knowing nothing about
   * managed-settings schema — the same reason the trusted overlay arrives as
   * records instead of a path.
   */
  managedActivation?: 'force-enabled' | 'blocked';
}

export interface PolicyTarget {
  pluginKey?: string;
  pluginInstanceId?: string;
}

export interface CapabilityPolicyStoreOptions {
  globalPath?: string;
  now?: () => Date;
  /** Test seam: resolve a Workspace policy file path from an ID. */
  workspacePolicyPath?: (workspaceId: string) => string;
  /** Test seam: enumerate managed Workspaces whose policy files may contain records. */
  workspaceIds?: () => string[];
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

function parsePolicyRecord(raw: unknown): CapabilityPolicyRecord | null {
  if (!isRecord(raw)) return null;
  const scope = parseScope(raw.scope);
  if (!scope) return null;
  if (typeof raw.enabled !== 'boolean') return null;
  const pluginKey = typeof raw.pluginKey === 'string' && raw.pluginKey ? raw.pluginKey : undefined;
  const pluginInstanceId =
    typeof raw.pluginInstanceId === 'string' && raw.pluginInstanceId ? raw.pluginInstanceId : undefined;
  if (!pluginKey && !pluginInstanceId) return null;
  const capabilityId = typeof raw.capabilityId === 'string' && raw.capabilityId ? raw.capabilityId : undefined;
  let capabilities: Record<string, boolean> | undefined;
  if (isRecord(raw.capabilities)) {
    capabilities = {};
    for (const [key, value] of Object.entries(raw.capabilities)) {
      if (typeof value === 'boolean') capabilities[key] = value;
    }
  }
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date(0).toISOString();
  return {
    scope,
    ...(pluginKey ? { pluginKey } : {}),
    ...(pluginInstanceId ? { pluginInstanceId } : {}),
    ...(capabilityId ? { capabilityId } : {}),
    enabled: raw.enabled,
    ...(capabilities ? { capabilities } : {}),
    updatedAt,
  };
}

function recordMatchesTarget(record: CapabilityPolicyRecord, target: PolicyTarget): boolean {
  if (record.pluginInstanceId) return record.pluginInstanceId === target.pluginInstanceId;
  if (record.pluginKey) return record.pluginKey === target.pluginKey;
  return false;
}

export class CapabilityPolicyStore {
  private readonly globalPath: string;
  private readonly now: () => Date;
  private readonly workspacePolicyPath: (workspaceId: string) => string;
  private readonly workspaceIds: () => string[];

  constructor(options: CapabilityPolicyStoreOptions = {}) {
    this.globalPath = options.globalPath ?? GLOBAL_CAPABILITY_POLICY_PATH;
    this.now = options.now ?? (() => new Date());
    this.workspacePolicyPath =
      options.workspacePolicyPath
      ?? ((workspaceId: string) =>
        resolveContainedPath(getWorkspaceRootPath(assertStorageId('workspace', workspaceId)), 'capabilities.json'));
    this.workspaceIds = options.workspaceIds ?? listManagedWorkspaceIds;
  }

  readGlobal(): GlobalPolicyFile {
    const empty: GlobalPolicyFile = { version: POLICY_FILE_VERSION, records: [], projectOverrides: {} };
    const parsed = readJson(this.globalPath);
    if (!isRecord(parsed)) return empty;
    const records = Array.isArray(parsed.records)
      ? parsed.records.map(parsePolicyRecord).filter((r): r is CapabilityPolicyRecord => r !== null)
      : [];
    const projectOverrides: Record<string, CapabilityPolicyRecord[]> = {};
    if (isRecord(parsed.projectOverrides)) {
      for (const [workspaceId, raw] of Object.entries(parsed.projectOverrides)) {
        if (!isValidWorkspaceId(workspaceId) || !Array.isArray(raw)) continue;
        projectOverrides[workspaceId] = raw
          .map(parsePolicyRecord)
          .filter((r): r is CapabilityPolicyRecord => r !== null);
      }
    }
    return { version: POLICY_FILE_VERSION, records, projectOverrides };
  }

  readWorkspace(workspaceId: string): WorkspacePolicyFile {
    assertStorageId('workspace', workspaceId);
    const parsed = readJson(this.workspacePolicyPath(workspaceId));
    if (!isRecord(parsed)) return { version: POLICY_FILE_VERSION, records: [] };
    const records = Array.isArray(parsed.records)
      ? parsed.records.map(parsePolicyRecord).filter((r): r is CapabilityPolicyRecord => r !== null)
      : [];
    return { version: POLICY_FILE_VERSION, records };
  }

  /** Upsert a global-scope policy record. */
  recordGlobal(record: Omit<CapabilityPolicyRecord, 'scope' | 'updatedAt'>): void {
    const file = this.readGlobal();
    const entry: CapabilityPolicyRecord = { ...record, scope: { kind: 'global' }, updatedAt: this.now().toISOString() };
    file.records = upsert(file.records, entry);
    this.writeGlobal(file);
  }

  /** Upsert a private per-(workspace, project) override held in GLOBAL storage. */
  recordProjectOverride(
    workspaceId: string,
    projectKey: ProjectKey,
    record: Omit<CapabilityPolicyRecord, 'scope' | 'updatedAt'>,
  ): void {
    assertStorageId('workspace', workspaceId);
    if (!isValidProjectKey(projectKey)) throw new Error('Invalid project key for policy override');
    const file = this.readGlobal();
    const entry: CapabilityPolicyRecord = {
      ...record,
      scope: { kind: 'project', workspaceId, projectKey },
      updatedAt: this.now().toISOString(),
    };
    file.projectOverrides[workspaceId] = upsert(file.projectOverrides[workspaceId] ?? [], entry);
    this.writeGlobal(file);
  }

  /** Upsert a Workspace-scope policy record in managed Workspace storage. */
  recordWorkspace(workspaceId: string, record: Omit<CapabilityPolicyRecord, 'scope' | 'updatedAt'>): void {
    assertStorageId('workspace', workspaceId);
    const file = this.readWorkspace(workspaceId);
    const entry: CapabilityPolicyRecord = {
      ...record,
      scope: { kind: 'workspace', workspaceId },
      updatedAt: this.now().toISOString(),
    };
    file.records = upsert(file.records, entry);
    this.writeWorkspace(workspaceId, file);
  }

  /**
   * Remove every managed activation record for an uninstalled plugin. This is
   * intentionally destructive: reinstalling identical bytes must still start
   * disabled and require a fresh user decision. Trusted repository overlays
   * are not mutated because they belong to the repository, not managed state.
   */
  purgePlugin(pluginKey: string, pluginInstanceIds: readonly string[] = []): number {
    if (!pluginKey) throw new Error('Plugin key is required for policy purge');
    const instanceIds = new Set(pluginInstanceIds.filter(Boolean));
    const shouldRemove = (record: CapabilityPolicyRecord) => (
      record.pluginKey === pluginKey
      || (record.pluginInstanceId !== undefined && instanceIds.has(record.pluginInstanceId))
    );
    let removed = 0;

    const global = this.readGlobal();
    const retainedGlobal = global.records.filter(record => !shouldRemove(record));
    removed += global.records.length - retainedGlobal.length;
    global.records = retainedGlobal;
    for (const [workspaceId, records] of Object.entries(global.projectOverrides)) {
      const retained = records.filter(record => !shouldRemove(record));
      removed += records.length - retained.length;
      if (retained.length > 0) global.projectOverrides[workspaceId] = retained;
      else delete global.projectOverrides[workspaceId];
    }
    if (removed > 0) this.writeGlobal(global);

    for (const workspaceId of new Set(this.workspaceIds())) {
      if (!isValidWorkspaceId(workspaceId)) continue;
      const workspace = this.readWorkspace(workspaceId);
      const retained = workspace.records.filter(record => !shouldRemove(record));
      const workspaceRemoved = workspace.records.length - retained.length;
      if (workspaceRemoved > 0) {
        removed += workspaceRemoved;
        this.writeWorkspace(workspaceId, { ...workspace, records: retained });
      }
    }
    return removed;
  }

  /**
   * Resolve the effective activation for a target across all layers in
   * precedence order. The trusted overlay is applied only when supplied.
   */
  resolve(target: PolicyTarget, context: PolicyResolutionContext = {}): ResolvedCapabilityActivation {
    const global = this.readGlobal();
    const layers: CapabilityPolicyRecord[] = [...global.records];

    if (context.workspaceId) {
      layers.push(...this.readWorkspace(context.workspaceId).records);
      if (context.projectKey && context.trustedProjectOverlay) {
        layers.push(...context.trustedProjectOverlay.records);
      }
      // User-owned private project override is the narrowest persisted layer
      // and applies even when the repository overlay is withheld as untrusted.
      if (context.projectKey) {
        layers.push(
          ...projectOverrideLayers(
            global.projectOverrides[context.workspaceId] ?? [], context, // F1.11 — a worktree's main checkout first
          ),
        );
      }
    }

    let enabled = false;
    let suppressed = false;
    let sawAny = false;
    const capabilities: Record<string, boolean> = {};

    for (const record of layers) {
      if (!recordMatchesTarget(record, target)) continue;
      // A capabilityId-scoped record is a pure per-capability toggle: it feeds
      // the capabilities map only and never activates or suppresses the plugin
      // itself (resolveScopes likewise ignores it for whole-plugin state).
      if (record.capabilityId) {
        capabilities[record.capabilityId] = record.enabled;
        continue;
      }
      sawAny = true;
      if (record.capabilities) Object.assign(capabilities, record.capabilities);
      if (record.enabled === false) {
        // Terminal suppression: cannot be re-enabled by a lower layer.
        suppressed = true;
        enabled = false;
      } else if (!suppressed) {
        enabled = true;
      }
    }

    // The managed tier outranks every persisted layer
    // (`settings-reference.md#enabledplugins`), so it is applied last and in
    // both directions. A force-enable keeps whatever
    // per-capability map the layers built — the administrator activated the
    // plugin, not every component of it, and a per-capability toggle is the
    // user's own narrowing INSIDE an activation rather than a way to undo it.
    if (context.managedActivation === 'blocked') {
      return { enabled: false, suppressed: true, capabilities };
    }
    if (context.managedActivation === 'force-enabled') {
      return { enabled: true, suppressed: false, capabilities };
    }

    if (!sawAny) return { enabled: false, suppressed: false, capabilities: {} };
    return { enabled, suppressed, capabilities };
  }

  /**
   * Report the DIRECT per-scope activation for a whole-plugin target (U4 defect
   * fix). Unlike `resolve` (which merges layers into one precedence verdict for
   * the current context) each scope is reported independently as
   * `'enabled' | 'disabled' | 'unset'`, so a row menu can label
   * Enable-vs-Disable per scope. Pure READ of the SAME persisted layers `resolve`
   * reads — no new store, no mutation. `project` is `'ineligible'` when the
   * context carries no `projectKey`. Whole-plugin records only
   * (`capabilityId`-scoped overrides are ignored here).
   *
   * `managed` reports the managed tier the same way, so a row menu can say WHY
   * Disable is unavailable instead of offering an action `resolve` would then
   * override.
   */
  resolveScopes(target: PolicyTarget, context: PolicyResolutionContext = {}): ResolvedPluginActivation {
    const global = this.readGlobal();

    const directState = (records: readonly CapabilityPolicyRecord[]): PluginScopeActivationState => {
      let state: PluginScopeActivationState = 'unset';
      for (const record of records) {
        if (record.capabilityId) continue; // whole-plugin activation only
        if (!recordMatchesTarget(record, target)) continue;
        state = record.enabled === false ? 'disabled' : 'enabled';
      }
      return state;
    };

    const globalState = directState(global.records);
    const workspaceState = context.workspaceId
      ? directState(this.readWorkspace(context.workspaceId).records)
      : 'unset';

    let projectState: PluginScopeActivationState | 'ineligible' = 'ineligible';
    if (context.workspaceId && context.projectKey) {
      const overlayRecords = context.trustedProjectOverlay?.records ?? [];
      const overrideRecords = projectOverrideLayers(
        global.projectOverrides[context.workspaceId] ?? [], context, // F1.11 — a worktree's main checkout first
      );
      // Overrides are the narrower/last layer, mirroring `resolve`'s ordering.
      projectState = directState([...overlayRecords, ...overrideRecords]);
    }

    return {
      global: globalState,
      workspace: workspaceState,
      project: projectState,
      ...(context.managedActivation === undefined
        ? {}
        : { managed: context.managedActivation === 'force-enabled' ? 'enabled' as const : 'disabled' as const }),
    };
  }

  /** Journaled Workspace-deletion participant (id `capability-policy`). */
  cleanupParticipant(): {
    id: 'capability-policy';
    stage(workspaceId: string, transactionId: string): Promise<void>;
    commit(transactionId: string): Promise<void>;
    rollback(transactionId: string): Promise<void>;
  } {
    const staged = new Map<string, string>();
    return {
      id: 'capability-policy',
      stage: async (workspaceId, transactionId) => {
        assertStorageId('workspace', workspaceId);
        staged.set(transactionId, workspaceId);
      },
      commit: async (transactionId) => {
        const workspaceId = staged.get(transactionId);
        if (!workspaceId) return;
        // Drop the Workspace's private project overrides from global policy;
        // whole-project trust (keyed only by ProjectKey) survives elsewhere.
        const file = this.readGlobal();
        if (file.projectOverrides[workspaceId]) {
          delete file.projectOverrides[workspaceId];
          this.writeGlobal(file);
        }
        staged.delete(transactionId);
      },
      rollback: async (transactionId) => {
        staged.delete(transactionId);
      },
    };
  }

  private writeGlobal(file: GlobalPolicyFile): void {
    atomicWriteConfigFileSync(this.globalPath, JSON.stringify({ ...file, version: POLICY_FILE_VERSION }, null, 2));
  }

  private writeWorkspace(workspaceId: string, file: WorkspacePolicyFile): void {
    atomicWriteConfigFileSync(
      this.workspacePolicyPath(workspaceId),
      JSON.stringify({ ...file, version: POLICY_FILE_VERSION }, null, 2),
    );
  }
}

function upsert(records: CapabilityPolicyRecord[], entry: CapabilityPolicyRecord): CapabilityPolicyRecord[] {
  const key = policyRecordKey(entry);
  return [...records.filter(r => policyRecordKey(r) !== key), entry];
}

function policyRecordKey(record: CapabilityPolicyRecord): string {
  return [
    record.scope.kind,
    record.scope.workspaceId ?? '',
    record.scope.projectKey ?? '',
    record.pluginInstanceId ?? '',
    record.pluginKey ?? '',
    record.capabilityId ?? '',
  ].join('|');
}

function isValidWorkspaceId(value: string): boolean {
  try {
    assertStorageId('workspace', value);
    return true;
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function listManagedWorkspaceIds(): string[] {
  try {
    return readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isValidWorkspaceId(entry.name))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

/**
 * F1.11 (origin D1.367, option (b)) — the user-owned project override records one resolution reads, in layer
 * order: the MAIN CHECKOUT's records first when the project is inside a linked git worktree
 * (`mainCheckoutProjectKey`, from `resolveMainCheckoutProjectKey`), then the project's OWN records, which are
 * therefore the narrower layer. So a plugin enabled for the repository is enabled in each of its worktrees, a
 * worktree's own record narrows it there alone, and a record written from the checkout reaches every worktree.
 *
 * Deliberately NOT extended to the trusted repository overlay: that layer comes from the worktree's own checked-out
 * files and is already the worktree's. And trust is not read here at all — it stays per directory.
 */
function projectOverrideLayers(
  records: readonly CapabilityPolicyRecord[],
  context: PolicyResolutionContext,
): CapabilityPolicyRecord[] {
  const forKey = (key: ProjectKey | undefined) => (key
    ? records.filter(r => r.scope.kind === 'project' && r.scope.projectKey === key)
    : []);
  const inherited = context.mainCheckoutProjectKey !== context.projectKey ? forKey(context.mainCheckoutProjectKey) : [];
  return [...inherited, ...forKey(context.projectKey)];
}

// F1.11 — declared here by interface merging so every line above keeps its number (this file is cited by line).
export interface PolicyResolutionContext {
  /**
   * The `ProjectKey` of the main checkout when `projectKey` is a directory inside a linked git worktree. Its
   * project override records are read BEFORE the project's own (see `projectOverrideLayers`). Server-derived only.
   */
  mainCheckoutProjectKey?: ProjectKey;
}
