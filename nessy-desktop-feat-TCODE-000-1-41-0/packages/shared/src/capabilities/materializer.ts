import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeNormalizedBundleHash } from '../plugins/bundle-hash.ts';
import type { PluginBundleResourceRef } from '../plugins/types.ts';
import { resolveContainedPath } from '../workspaces/paths.ts';
import type { RuntimeCredentialBinding, ResolvedRuntimeCredential } from '../credentials/types.ts';
import type {
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  NativeResourceRef,
} from './resolver.ts';

/**
 * `revoked` is a SECURITY verdict: the snapshot lease is dead (released or
 * revoked) and nothing pinned to it may be resolved. `credential-not-ready` is
 * routine: the lease is perfectly live, the credential simply is not usable yet
 * — an empty OAuth slot, a rotated revision, an expired token.
 *
 * They used to share the string `capability-snapshot-revoked`, which is how an
 * un-authorized plugin's empty slot read as a revoked snapshot and took down
 * every send in a workspace. A consumer that wants to degrade one must not have
 * to degrade the other.
 */
export type CapabilityMaterializationFailure =
  | 'revoked'
  | 'credential-not-ready'
  | 'stale'
  | 'missing';

export class CapabilityMaterializationError extends Error {
  override readonly name = 'CapabilityMaterializationError';
  constructor(
    readonly code: CapabilityMaterializationFailure,
    /**
     * The revision the credential store reports RIGHT NOW; carried on
     * `credential-not-ready` only. A revision is non-secret by construction —
     * that is why `RuntimeCredentialBinding` exists — and it is what lets a
     * consumer tell "the pin this snapshot captured is behind the store"
     * (re-resolvable) from "the record is absent or expired" (not).
     */
    readonly currentRevision?: number,
  ) {
    super(`capability-snapshot-${code}`);
  }
}

export interface CapabilitySnapshotMaterializer {
  assertActive(): void;
  verifyPlugin(pluginInstanceId: string): Promise<void>;
  resolvePath(resource: NativeResourceRef | PluginBundleResourceRef): Promise<string>;
  readText(resource: NativeResourceRef | PluginBundleResourceRef): Promise<string>;
  readRelativeText?(resource: NativeResourceRef | PluginBundleResourceRef, relativePath: string): Promise<{
    content: string;
    contentHash: string;
  }>;
  /**
   * The directory a resource's siblings are resolved against — for a skill,
   * "the directory containing the skill's SKILL.md file" and, for a plugin
   * skill, its own subdirectory rather than the plugin root
   * (`code.claude.com/docs/en/skills.md`).
   *
   * Lives on the materializer, not on a caller, so the `${NESSY_SKILL_DIR}` /
   * `${CLAUDE_SKILL_DIR}` value and `readRelativeText`'s containment root are
   * the same path by construction, and so the stat still happens behind the
   * lease check.
   */
  resolveSkillDirectory?(resource: NativeResourceRef | PluginBundleResourceRef): Promise<string>;
  resolveCredential(binding: RuntimeCredentialBinding): ResolvedRuntimeCredential;
}

export interface CapabilitySnapshotMaterializerOptions {
  resolveCredential?: (binding: RuntimeCredentialBinding) => ResolvedRuntimeCredential;
  onStale?: () => void;
  /** Injectable for tests; production uses `computeNormalizedBundleHash`. */
  computeBundleHash?: (root: string) => Promise<string>;
}

export function createCapabilitySnapshotMaterializer(
  resolver: CapabilityResolver,
  snapshot: EffectiveCapabilitySnapshot,
  options: CapabilitySnapshotMaterializerOptions = {},
): CapabilitySnapshotMaterializer {
  const pluginRoots = pluginRuntimeRoots(snapshot);
  const pluginHashes = new Map(
    snapshot.installedPlugins.map(plugin => [plugin.activeInstanceId, plugin.bundleHash]),
  );

  const assertActive = () => {
    if (!resolver.isLeaseActive(snapshot.leaseId)) {
      throw new CapabilityMaterializationError('revoked');
    }
  };

  const stale = (): never => {
    options.onStale?.();
    throw new CapabilityMaterializationError('stale');
  };

  const resolvePath = async (
    resource: NativeResourceRef | PluginBundleResourceRef,
  ): Promise<string> => {
    assertActive();
    if ('pluginInstanceId' in resource) {
      const root = pluginRoots.get(resource.pluginInstanceId);
      if (!root) throw new CapabilityMaterializationError('missing');
      await verifyPlugin(resource.pluginInstanceId);
      return resolveContainedPath(root, resource.relativePath);
    }

    const contentPath = nativeContentPath(resource.absolutePath);
    if (!contentPath) throw new CapabilityMaterializationError('missing');
    const revision = String(statSync(contentPath).mtimeMs);
    const contentHash = createHash('sha256').update(readFileSync(contentPath)).digest('hex');
    assertActive();
    if (revision !== resource.revision || contentHash !== resource.contentHash) stale();
    return resource.absolutePath;
  };

  const computeBundleHash = options.computeBundleHash ?? computeNormalizedBundleHash;
  /**
   * Bundles verified during THIS lease. `verifyPlugin` is reached once per MCP
   * server and again per source resource, and each call re-hashed the entire
   * bundle — for a plugin carrying a materialized `npx` dependency graph that is
   * a full recursive hash of ~160 packages, repeated per server, inside the
   * turn's critical path.
   *
   * Scope is deliberately one materializer instance = one snapshot lease = one
   * turn. A new lease re-verifies, so a tampered bundle is still caught at the
   * boundary that matters; only the intra-lease repetition is removed.
   *
   * Only SUCCESS is remembered. A stale or missing bundle must re-throw on every
   * call rather than be cached as a decision.
   */
  const verifiedPlugins = new Set<string>();

  const verifyPlugin = async (pluginInstanceId: string): Promise<void> => {
    // Runs even on a memo hit: lease revocation is a different question from
    // bundle integrity, and callers rely on this throwing after a revoke.
    assertActive();
    if (verifiedPlugins.has(pluginInstanceId)) return;
    const root = pluginRoots.get(pluginInstanceId);
    const expected = pluginHashes.get(pluginInstanceId);
    if (!root || !expected) throw new CapabilityMaterializationError('missing');
    const actual = await computeBundleHash(root);
    assertActive();
    if (actual !== expected) stale();
    verifiedPlugins.add(pluginInstanceId);
  };

  /** The one rule for "what directory does this resource's siblings live in". */
  const containerDirectory = async (
    resource: NativeResourceRef | PluginBundleResourceRef,
  ): Promise<string> => {
    const primaryPath = await resolvePath(resource);
    return statSync(primaryPath).isDirectory() ? primaryPath : dirname(primaryPath);
  };

  return {
    assertActive,
    verifyPlugin,
    resolvePath,
    async resolveSkillDirectory(resource) {
      assertActive();
      const directory = await containerDirectory(resource);
      assertActive();
      return directory;
    },
    async readText(resource) {
      assertActive();
      if ('pluginInstanceId' in resource) {
        const root = pluginRoots.get(resource.pluginInstanceId);
        if (!root) throw new CapabilityMaterializationError('missing');
        const path = resolveContainedPath(root, resource.relativePath);
        const content = readFileSync(nativeContentPath(path) ?? path, 'utf-8');
        await verifyPlugin(resource.pluginInstanceId);
        return content;
      }
      const contentPath = nativeContentPath(resource.absolutePath);
      if (!contentPath) throw new CapabilityMaterializationError('missing');
      const content = readFileSync(contentPath);
      const revision = String(statSync(contentPath).mtimeMs);
      const contentHash = createHash('sha256').update(content).digest('hex');
      assertActive();
      if (revision !== resource.revision || contentHash !== resource.contentHash) stale();
      return content.toString('utf-8');
    },
    async readRelativeText(resource, relativePath) {
      assertActive();
      const primaryRoot = await containerDirectory(resource);
      const target = resolveContainedPath(primaryRoot, relativePath);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new CapabilityMaterializationError('missing');
      }
      const bytes = readFileSync(target);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('capability-snapshot-non-text');
      }
      if ('pluginInstanceId' in resource) await verifyPlugin(resource.pluginInstanceId);
      else await resolvePath(resource);
      assertActive();
      return {
        content,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    resolveCredential(binding) {
      // The lease check stays on BOTH sides and stays `revoked`: a dead
      // snapshot must never resolve a credential, and that verdict must not
      // share a code with "this credential is not usable yet".
      assertActive();
      const result = options.resolveCredential?.(binding) ?? { ready: false, revision: 0 };
      if (
        !result.ready
        || result.revision !== binding.expectedRevision
        || (result.credential?.expiresAt !== undefined && result.credential.expiresAt <= Date.now())
      ) {
        throw new CapabilityMaterializationError('credential-not-ready', result.revision);
      }
      assertActive();
      return result;
    },
  };
}

function nativeContentPath(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!statSync(path).isDirectory()) return path;
  for (const name of ['SKILL.md', 'config.json']) {
    const candidate = join(path, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function pluginRuntimeRoots(snapshot: EffectiveCapabilitySnapshot): Map<string, string> {
  return new Map(
    snapshot.installedPlugins.flatMap(plugin => plugin.bundleRootPath
      ? [[plugin.activeInstanceId, plugin.bundleRootPath] as const]
      : []),
  );
}
