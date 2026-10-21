/**
 * Session-scoped plugins — D1.69 (carried from runtime-parity-closure P6.419).
 *
 * Every plugin source this fork can install installs PERSISTENTLY: all nine
 * kinds in `source-resolver.ts` end at `PluginStoreV2.install`, which writes the
 * registry and places the bundle in the plugin cache. So a user could not try a
 * plugin for one session, and a directory being worked on could not shadow the
 * installed copy of itself without an install/uninstall round trip.
 *
 * ## Native-first, asked at every tier and answered here
 *
 * **Tier 1, claude:** the vendored SDK really does ship one —
 * `Options.plugins?: SdkPluginConfig[]`, documented *"Load plugins for this
 * session"*, and `SdkPluginConfig` is `{ type: 'local'; path: string }` and
 * nothing else (read at `claudeCodeVersion` 2.1.251; the binary's own
 * `--version` agrees). It is NOT adopted, and the reason is already written at
 * the one site that would change: `claude-agent.ts` passes `plugins: []` on
 * purpose, and `mcpReconciliationSucceeded` states that choice as a standing
 * condition — *"We pass `plugins: []` and every server in the payload is one we
 * built, so no name in our diff can be plugin-owned"*. Handing the SDK a plugin
 * directory would deliver that plugin's components twice (the host already
 * projects them) and falsify that condition for every session, not just one.
 * The URL half has no native mechanism there at all.
 *
 * **Tier 1, Pi and codex:** none.
 *
 * **Tier 2, the host:** this module. One mechanism, identical on all three
 * runtimes, because the capability snapshot is where every runtime's commands,
 * skills, agents, hooks and MCP servers come from already.
 *
 * ## The shape is copied, not invented
 *
 * `CreateSessionOptions.agents` (P6.317 (2)) is the same lifetime one
 * capability-kind down — *"the definitions live for the life of the created
 * session"*, nothing written to disk, and a name there displaces the same name
 * on disk. This is that, for a whole bundle. The ONE deliberate divergence:
 * session agents stay OUT of the capability snapshot, and a session plugin must
 * go IN, because the snapshot is the only path by which its components reach a
 * turn at all.
 *
 * ## What "session-only" means precisely
 *
 * Nothing reaches `PluginStoreV2`: no registry row, no cache placement, no
 * prune, no lease. The bundle lives in the staging directory
 * `materializeStagedBundle` created — whose own docblock is the guarantee we
 * rely on, *"Nothing here reaches the plugin store: the only writes are inside
 * `staged.stageDirectory`"* — and {@link releaseSessionScopedPlugins} removes
 * it. A crash leaves a directory under the OS temp root and nothing else.
 *
 * The identity is minted EXACTLY as `PluginStoreV2.install` mints it, from the
 * same `PluginCacheRef`, so:
 *
 * - the `pluginKey` of a session copy equals the `pluginKey` the installed copy
 *   has, which is what makes the shadow a plain key match rather than a new
 *   precedence rule; and
 * - `pluginInstanceId` keeps the `plugin://<marketplaceId>/<pluginId>@<version>`
 *   grammar that `capabilities/views.ts` PARSES to mint a plugin agent's scoped
 *   `@` name. A session-local spelling would have silently changed that name.
 *
 * A consequence, stated rather than hidden: a session bundle byte-identical to
 * an installed one produces the same instance id, because the id is a function
 * of the bytes. That is correct — everything derived from it (the scoped
 * mention, the data path, MCP wire names) is derived from bytes that really are
 * the same — and the overlay consumer keys its lease and its root path on which
 * map the instance came from, never on the id's spelling.
 */

import { rm } from 'node:fs/promises';
import { pluginKeyFor } from '../workspaces/paths.ts';
import { PluginInstallService } from './acquisition.ts';
import { computeNormalizedBundleHash, findUnsafeBundleSymlink } from './bundle-hash.ts';
import { materializeStagedBundle } from './management-service-v2.ts';
import type { PluginInstallStager } from './management-types.ts';
import { createPluginInstanceIdV2, type PluginInstalledEntryV2 } from './store-v2.ts';
import type { PluginCacheRef, PluginDiagnostic, PluginInstallSource, PluginInstanceId, PluginKey } from './types.ts';

/**
 * A plugin asked for at session start. Deliberately the two kinds D1.69 names —
 * a directory and a URL archive — and not the other seven `PluginInstallSource`
 * kinds: marketplace and repository sources describe something to INSTALL, and
 * an installed plugin is what this mechanism exists to work around.
 */
export type SessionScopedPluginSourceV1 =
  | { readonly kind: 'local-path'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string };

/** One loaded session plugin: the snapshot record plus where its bytes are. */
export interface SessionScopedPlugin {
  readonly entry: PluginInstalledEntryV2;
  /** The staged, normalized bundle root. NOT under the plugin store's cache. */
  readonly rootPath: string;
  /** Removed by {@link releaseSessionScopedPlugins}; owns `rootPath`. */
  readonly stageDirectory: string;
}

export interface SessionScopedPluginLoadResult {
  readonly plugins: readonly SessionScopedPlugin[];
  /** Non-empty with at least one error when `plugins` is short of `sources`. */
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface LoadSessionScopedPluginsOptions {
  /**
   * Test seam. Omitted, the default is the same `PluginInstallService` with the
   * same defaults `PluginManagementServiceV2` builds when its caller supplies
   * none — one staging implementation, not two.
   *
   * It is built WITHOUT a dp session broker, and the consequence is stated
   * rather than discovered: an archive whose host wants a dp-authenticated
   * fetch cannot be loaded session-only and has to be installed, where the
   * management service supplies the broker. A plain directory and a plain URL
   * archive — the two kinds this mechanism is for — need neither.
   */
  readonly installer?: PluginInstallStager;
  readonly baseTempDir?: string;
  readonly now?: () => number;
}

function sessionPluginDiagnostic(code: string, message: string): PluginDiagnostic {
  return { severity: 'error', code, message };
}

function toInstallSource(source: SessionScopedPluginSourceV1): PluginInstallSource {
  return source.kind === 'local-path'
    ? { kind: 'local-path', path: source.path }
    : { kind: 'url', url: source.url };
}

/**
 * This is caller JSON off an RPC — the same reason `createSession` CLONES
 * `options.agents` — so the two kinds are checked here rather than left to be
 * classified downstream. `createInstallPlanFromSource` would refuse a garbage
 * source too, but as an `unsupported` source with a message about install
 * syntax, which is the wrong sentence for a request that never asked to
 * install anything.
 */
function isUsableSource(source: SessionScopedPluginSourceV1 | undefined): boolean {
  if (!source || typeof source !== 'object') return false;
  if (source.kind === 'local-path') return typeof source.path === 'string' && source.path.length > 0;
  if (source.kind === 'url') return typeof source.url === 'string' && source.url.length > 0;
  return false;
}

/** What a diagnostic may name: the request, never a resolved or staged path. */
function describe(source: SessionScopedPluginSourceV1): string {
  return source.kind === 'local-path' ? source.path : source.url;
}

/**
 * Stage every source for one session. ALL-OR-NOTHING: the first failure
 * releases whatever was already staged and returns no plugins, because the
 * caller's contract is a refusal — a session asked to start with a plugin and
 * started without it is the one outcome the request rules out. That is the
 * posture `CreateSessionOptions.worktree` already states for the same reason
 * ("REFUSES rather than falling back").
 */
export async function loadSessionScopedPlugins(
  sources: readonly SessionScopedPluginSourceV1[],
  options: LoadSessionScopedPluginsOptions,
): Promise<SessionScopedPluginLoadResult> {
  const now = options.now ?? Date.now;
  const installer = options.installer ?? new PluginInstallService(
    options.baseTempDir ? { baseTempDir: options.baseTempDir } : {},
  );
  const loaded: SessionScopedPlugin[] = [];
  const diagnostics: PluginDiagnostic[] = [];

  for (const source of sources) {
    if (!isUsableSource(source)) {
      diagnostics.push(sessionPluginDiagnostic(
        'plugin.session_scoped.source_invalid',
        'A session plugin must be a local directory path or a URL.',
      ));
      await releaseSessionScopedPlugins(loaded);
      return { plugins: [], diagnostics };
    }
    const bundle = await materializeStagedBundle(
      installer,
      toInstallSource(source),
      options.baseTempDir,
    );
    if (!bundle.ok) {
      diagnostics.push(
        sessionPluginDiagnostic(
          'plugin.session_scoped.load_failed',
          `Session plugin ${describe(source)} could not be loaded.`,
        ),
        ...bundle.result.diagnostics,
      );
      await releaseSessionScopedPlugins(loaded);
      return { plugins: [], diagnostics };
    }

    const rootPath = bundle.staged.normalizedDirectory;
    // The same floor `PluginStoreV2.install` applies before it will place a
    // bundle. A session bundle is never placed, so nothing else would apply it.
    const unsafeSymlink = await findUnsafeBundleSymlink(rootPath);
    if (unsafeSymlink) {
      diagnostics.push(sessionPluginDiagnostic(
        'plugin.session_scoped.unsafe_bundle',
        `Session plugin ${describe(source)} contains an escaping or dangling symlink.`,
      ));
      await releaseSessionScopedPlugins(loaded);
      await rm(bundle.staged.stageDirectory, { recursive: true, force: true });
      return { plugins: [], diagnostics };
    }

    const marketplaceId = bundle.staged.plan.origin.marketplaceId ?? 'local';
    const pluginId = bundle.manifest.id;
    const version = bundle.manifest.version;
    const bundleHash = await computeNormalizedBundleHash(rootPath);
    const cacheRef: PluginCacheRef = { marketplaceId, pluginId, version, bundleHash };
    loaded.push({
      entry: {
        pluginInstanceId: createPluginInstanceIdV2(cacheRef),
        pluginKey: pluginKeyFor(marketplaceId, pluginId),
        marketplaceId,
        pluginId,
        version,
        bundleHash,
        cacheRef,
        manifest: bundle.manifest,
        origin: bundle.staged.plan.origin,
        installedAt: now(),
        // The staging diagnostics ride the entry the way an installed entry's
        // do; an ERROR would have failed the branch above.
        diagnostics: [...bundle.diagnostics],
        ...(bundle.compatibility ? { compatibility: bundle.compatibility } : {}),
      },
      rootPath,
      stageDirectory: bundle.staged.stageDirectory,
    });
  }

  return { plugins: loaded, diagnostics };
}

/** Remove every staged bundle. Best-effort and idempotent: a session ending is
 * not a place to fail, and a directory already gone is the normal case after a
 * crash-and-restart. */
export async function releaseSessionScopedPlugins(
  plugins: readonly SessionScopedPlugin[],
): Promise<void> {
  for (const plugin of plugins) {
    try {
      await rm(plugin.stageDirectory, { recursive: true, force: true });
    } catch {
      // Best-effort: the OS temp root owns it from here.
    }
  }
}

/**
 * Merge a session's plugins over the store's active entries.
 *
 * The SHADOW is a `pluginKey` match and nothing more: a session plugin with the
 * same key as an installed one REPLACES it for this resolve, which is
 * `sub-agents.md#choose-the-subagent-scope`'s displacement rule applied one
 * level up, and the shape `CreateSessionOptions.agents` already has.
 *
 * Everything downstream — projection candidates, the managed plugin allow/deny
 * gate, per-scope activation, trust — is computed from the merged list, so a
 * session plugin is subject to the SAME managed policy as an installed one. It
 * is merged here, and not later, for exactly that reason.
 */
export function mergeSessionScopedPlugins(
  storeActiveEntries: readonly PluginInstalledEntryV2[],
  sessionPlugins: readonly SessionScopedPlugin[],
): PluginInstalledEntryV2[] {
  if (sessionPlugins.length === 0) return [...storeActiveEntries];
  const shadowed = new Set<PluginKey>(sessionPlugins.map(plugin => plugin.entry.pluginKey));
  return [
    ...storeActiveEntries.filter(entry => !shadowed.has(entry.pluginKey)),
    ...sessionPlugins.map(plugin => plugin.entry),
  ].sort((a, b) => a.pluginInstanceId.localeCompare(b.pluginInstanceId));
}

/**
 * The host-wide register of which session is holding which session plugins.
 *
 * Module-level on purpose, and it is the pattern this package already uses for
 * the capability-invalidation bus: the capability resolver is built in the
 * storage runtime BEFORE any `SessionManager` exists, so a constructor
 * parameter would have to be threaded through both composition roots to let one
 * side write what the other reads. A session id is the key, so nothing here is
 * ambient state shared between sessions.
 */
const sessionScopedPlugins = new Map<string, readonly SessionScopedPlugin[]>();

export function registerSessionScopedPlugins(
  sessionId: string,
  plugins: readonly SessionScopedPlugin[],
): void {
  if (plugins.length === 0) {
    sessionScopedPlugins.delete(sessionId);
    return;
  }
  sessionScopedPlugins.set(sessionId, plugins);
}

/** The session's plugins, or an empty list — never `undefined`, so a consumer
 * cannot accidentally distinguish "no plugins" from "unknown session". */
export function sessionScopedPluginsFor(sessionId: string | undefined): readonly SessionScopedPlugin[] {
  if (!sessionId) return [];
  return sessionScopedPlugins.get(sessionId) ?? [];
}

/** Forget the session and remove its staged bundles. Safe to call twice. */
export async function releaseSessionScopedPluginsFor(sessionId: string): Promise<void> {
  const plugins = sessionScopedPlugins.get(sessionId);
  if (!plugins) return;
  sessionScopedPlugins.delete(sessionId);
  await releaseSessionScopedPlugins(plugins);
}

/**
 * Forget every session and remove every staged bundle. The host is going down,
 * so every session is ending; called from `SessionManager.cleanup()`, which is
 * the one place that knows that.
 */
export async function releaseAllSessionScopedPlugins(): Promise<void> {
  const all = [...sessionScopedPlugins.values()].flat();
  sessionScopedPlugins.clear();
  await releaseSessionScopedPlugins(all);
}

/** Which of these instance ids came from a session rather than the store. */
export function sessionScopedInstanceIds(
  plugins: readonly SessionScopedPlugin[],
): Map<PluginInstanceId, string> {
  return new Map(plugins.map(plugin => [plugin.entry.pluginInstanceId, plugin.rootPath]));
}
