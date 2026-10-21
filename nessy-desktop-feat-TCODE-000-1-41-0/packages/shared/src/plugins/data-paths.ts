/**
 * Context-scoped writable plugin data + runtime env contract (W7 Step 7).
 *
 * Writable data is isolated per stable (version-less) plugin key, then per
 * Workspace and optional project:
 *
 *   plugins/data/<encoded-plugin-key>/global
 *   plugins/data/<encoded-plugin-key>/workspaces/<workspaceId>
 *   plugins/data/<encoded-plugin-key>/workspaces/<workspaceId>/projects/<projectKey>
 *
 * All paths route through the W1 collision-free encoder and containment checks,
 * so traversal/symlink escape is rejected. Because the plugin key omits the
 * version, data survives version updates. An explicit plugin uninstall removes
 * the whole stable root so a later reinstall cannot inherit hidden runtime state.
 *
 * The runtime env contract exposes the immutable bundle root and the resolved
 * data path. Generic Pi plugins get `NESSY_PLUGIN_ROOT`/`PLUGIN_ROOT`,
 * `NESSY_PLUGIN_DATA`/`PLUGIN_DATA` and (when a validated project path exists)
 * `NESSY_PROJECT_DIR`. `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`/
 * `CLAUDE_PROJECT_DIR` are emitted solely by the explicit Claude-compat adapter.
 */

import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { isValidProjectKey, type ProjectKey } from '../projects/project-identity.ts';
import {
  PLUGIN_DATA_DIR,
  assertStorageId,
  getPluginDataRoot,
  resolveContainedPath,
} from '../workspaces/paths.ts';
import type { PluginKey, PluginRuntimeCompatibilityProfile } from './types.ts';

export interface PluginDataContext {
  /**
   * Managed Workspace ID. OMIT the field for a global (no-Workspace)
   * resolution — `''` is not a spelling of "omitted": it is a supplied id, and
   * it is refused rather than widened onto the shared `global` bucket.
   */
  workspaceId?: string;
  /** Canonical project key; only valid alongside a Workspace ID. */
  projectKey?: ProjectKey;
}

/**
 * Resolve the contained writable-data directory for a plugin in a given context.
 * An OMITTED Workspace identity resolves to the plugin's `global` bucket; a
 * project key without a Workspace is rejected (missing identity is never a
 * wildcard). A Workspace id that is present but empty is NOT missing identity —
 * see the note on the `undefined` checks below.
 */
export function resolvePluginDataPath(
  pluginKey: PluginKey,
  context: PluginDataContext = {},
  dataDir?: string,
): string {
  const root = dataDir === undefined ? getPluginDataRoot(pluginKey) : getPluginDataRoot(pluginKey, dataDir);

  // ABSENT vs AUTHORED-EMPTY, tested on `undefined` rather than on truthiness.
  //
  // `workspaceId` OMITTED is "no Workspace identity" and resolves to `global`.
  // `workspaceId: ''` is a value the CALLER SUPPLIED — an id that fails
  // validation — and it must never fall back to the absent-field default,
  // because here that default is WIDER: `global` is the one bucket every
  // Workspace shares. Under the old `if (!context.workspaceId)` the two
  // collapsed onto each other and `assertStorageId` never saw the value at all,
  // so an empty id silently widened a storage SCOPE.
  //
  // This is P2.185's family rule — a value the author WROTE is the empty set, a
  // field they OMITTED is not a value, and the empty value never takes the
  // absent-field default — applied for the first time to a storage scope rather
  // than to a permission set. The reader cannot represent an empty Workspace id
  // as a directory, so it fails closed through `assertStorageId`.
  //
  // P2.198 established that NO caller can reach this with `''` today: all four
  // production call sites are behind either `assertStorageId` or a non-empty
  // string ingress check (`isSafeCapabilityContextRef`). This is the boundary
  // made honest, not a live defect fixed — keep it that way by not reintroducing
  // a truthiness test here.
  const { workspaceId } = context;

  if (context.projectKey && workspaceId === undefined) {
    throw new Error('A project-scoped plugin data path requires a Workspace ID');
  }

  if (workspaceId === undefined) {
    return resolveContainedPath(root, 'global');
  }

  assertStorageId('workspace', workspaceId);
  if (!context.projectKey) {
    return resolveContainedPath(root, 'workspaces', workspaceId);
  }

  if (!isValidProjectKey(context.projectKey)) {
    throw new Error('Invalid project key for plugin data path');
  }
  return resolveContainedPath(root, 'workspaces', workspaceId, 'projects', context.projectKey);
}

/**
 * Remove every managed writable-data bucket for one explicitly uninstalled
 * plugin. The target is derived only from the validated stable PluginKey and the
 * host-owned data root; bundle manifests never supply a deletion path.
 */
export async function removePluginData(
  pluginKey: PluginKey,
  dataDir: string = PLUGIN_DATA_DIR,
): Promise<void> {
  await rm(getPluginDataRoot(pluginKey, dataDir), { recursive: true, force: true });
}

export interface PluginRuntimePaths {
  /** Absolute path to the immutable, content-addressed normalized bundle root. */
  bundleRoot: string;
  /** Absolute path to the context-scoped writable data directory. */
  dataPath: string;
  /** Server-validated active project root, if any (never renderer-supplied). */
  projectPath?: string;
}

/**
 * The env contract for a trusted generic Pi plugin runtime (hook/command/stdio
 * MCP). Emits Nessy names plus the unbranded `PLUGIN_*` compatibility aliases —
 * never Claude aliases.
 *
 * `NESSY_PROJECT_DIR` (present only with a server-validated project path) is
 * emitted HERE rather than only in the Claude compat adapter, deliberately: it
 * is the name `claude.ts` rewrites `${CLAUDE_PROJECT_DIR}` to, the name
 * `schema.ts` (`PLUGIN_RUNTIME_PATH_ROOTS`) accepts as an LSP workspace root,
 * and the name `hook-command.ts` lists as an exec-form placeholder — and a
 * generic or Codex-profile bundle may legally declare `${NESSY_PROJECT_DIR}`.
 * `claudeCompatPluginEnv` keeps `CLAUDE_PROJECT_DIR` as the compat alias, so a
 * Claude bundle's rewritten token and its alias resolve to the same path.
 */
export function pluginRuntimeEnv(paths: PluginRuntimePaths): Record<string, string> {
  return {
    NESSY_PLUGIN_ROOT: paths.bundleRoot,
    PLUGIN_ROOT: paths.bundleRoot,
    NESSY_PLUGIN_DATA: paths.dataPath,
    PLUGIN_DATA: paths.dataPath,
    ...(paths.projectPath ? { NESSY_PROJECT_DIR: paths.projectPath } : {}),
  };
}

/**
 * Codex's Claude-compatibility aliases. Plugin state is redirected to the
 * exact managed data path; Codex does not receive a project-dir alias.
 */
export function codexCompatPluginEnv(paths: PluginRuntimePaths): Record<string, string> {
  return {
    CLAUDE_PLUGIN_ROOT: paths.bundleRoot,
    CLAUDE_PLUGIN_DATA: paths.dataPath,
    CLAUDE_CONFIG_DIR: paths.dataPath,
  };
}

/**
 * Additional env emitted ONLY by the explicit Claude-plugin compatibility
 * adapter. Never call this for generic Pi plugins. State is redirected to the
 * exact managed data path and `CLAUDE_PROJECT_DIR` is included
 * when a server-validated project path is present, so a Claude bundle's
 * rewritten `$NESSY_PROJECT_DIR` and its compat alias `$CLAUDE_PROJECT_DIR` both
 * resolve to the same validated path.
 */
export function claudeCompatPluginEnv(paths: PluginRuntimePaths): Record<string, string> {
  return {
    CLAUDE_PLUGIN_ROOT: paths.bundleRoot,
    CLAUDE_PLUGIN_DATA: paths.dataPath,
    CLAUDE_CONFIG_DIR: paths.dataPath,
    ...(paths.projectPath ? { CLAUDE_PROJECT_DIR: paths.projectPath } : {}),
  };
}

/**
 * A probe whose VALUES are never read: only the KEY names leave the derivation
 * below. `projectPath` is non-empty because the two `*_PROJECT_DIR` keys are
 * conditional on it being truthy.
 */
const PLUGIN_RUNTIME_ENV_KEY_PROBE: PluginRuntimePaths = {
  bundleRoot: '/',
  dataPath: '/',
  projectPath: '/',
};

/**
 * Every environment name the HOST itself injects into a plugin runtime process,
 * derived from the three builders above rather than retyped — a name added to a
 * builder is in this set on the same commit, and a name removed leaves it.
 *
 * Consumers need the names without an env to read them out of.
 * `agent/bash-validator.ts` is the first: a command hook may name its own plugin
 * root, which is the documented mechanism (`plugins-reference.md`
 * § Environment variables, quoted at `plugins/schema.ts`: "Claude Code provides
 * three variables for referencing paths"; the Codex row of this repo's
 * AGENTS.md cites `learn.chatgpt.com/docs/hooks.md` § Plugin-bundled hooks for
 * `PLUGIN_ROOT`/`PLUGIN_DATA` plus the `CLAUDE_*` compatibility spellings we
 * emit alongside them). Anything a plugin's own manifest can author —
 * `CLAUDE_PLUGIN_OPTION_*` (`user-config-substitution.ts`) — is deliberately
 * NOT here: this set is exactly the host-computed values.
 */
export const PLUGIN_RUNTIME_ENV_KEYS: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.keys(pluginRuntimeEnv(PLUGIN_RUNTIME_ENV_KEY_PROBE)),
    ...Object.keys(codexCompatPluginEnv(PLUGIN_RUNTIME_ENV_KEY_PROBE)),
    ...Object.keys(claudeCompatPluginEnv(PLUGIN_RUNTIME_ENV_KEY_PROBE)),
  ]),
]);

/**
 * Select the plugin runtime env by its normalized compatibility profile ONLY —
 * never by adapterId/origin/format. An unknown or unrecognized profile FAILS
 * CLOSED (throws) rather than falling back to universal aliases.
 */
export function pluginRuntimeEnvForProfile(
  profile: PluginRuntimeCompatibilityProfile,
  paths: PluginRuntimePaths,
): Record<string, string> {
  switch (profile) {
    case 'generic-plugin-env-v1':
      return pluginRuntimeEnv(paths);
    case 'codex-plugin-env-v1':
      return { ...pluginRuntimeEnv(paths), ...codexCompatPluginEnv(paths) };
    case 'claude-plugin-env-v1':
      return { ...pluginRuntimeEnv(paths), ...claudeCompatPluginEnv(paths) };
    default:
      throw new Error(`plugin-runtime-compatibility-profile-unrecognized:${String(profile)}`);
  }
}

/**
 * `plugins-reference.md` § File locations, `bin/`: "Executables added to the
 * Bash tool PATH. Files here are invokable as bare commands in any Bash tool
 * call while the plugin is enabled."
 */
const PLUGIN_BIN_DIR_NAME = 'bin';

/** Any runtime registration that names the plugin bundle it came out of. */
export interface PluginRuntimeRootCarrier {
  readonly pluginRuntime?: { readonly rootPath: string } | undefined;
}

/**
 * The runnable-capability arrays of one turn's `AgentRuntimeView` that carry a
 * `pluginRuntime`. Declared structurally rather than imported so the plugin
 * layer keeps not depending on the capability layer; `AgentRuntimeView` is
 * assignable to it.
 */
export interface EnabledPluginRuntimeCapabilities {
  readonly skills?: readonly PluginRuntimeRootCarrier[];
  readonly mcpServers?: readonly PluginRuntimeRootCarrier[];
  readonly hooks?: readonly PluginRuntimeRootCarrier[];
  readonly commands?: readonly PluginRuntimeRootCarrier[];
  readonly promptCommands?: readonly PluginRuntimeRootCarrier[];
  readonly outputStyles?: readonly PluginRuntimeRootCarrier[];
  readonly lspServers?: readonly PluginRuntimeRootCarrier[];
  /**
   * Monitors carry `pluginRuntime` too (`resolver.ts` —
   * `RuntimeMonitorRegistrationBase`), and Claude's `experimental.monitors`
   * command form is the shape most likely to ship a `bin/`. Omitting it left a
   * plugin whose only runnable capability is a monitor without its `bin/` on
   * PATH, which the documented "while the plugin is enabled" does not allow.
   */
  readonly monitors?: readonly PluginRuntimeRootCarrier[];
}

/**
 * The bundle roots of the plugins that may actually run this turn.
 *
 * The view is the enablement boundary: `toAgentRuntime` admits an entry only
 * when `isRunnable` holds (enabled, trusted, supported), so a plugin the user
 * switched off contributes no root and therefore no PATH entry.
 */
export function enabledPluginBundleRoots(
  view: EnabledPluginRuntimeCapabilities | undefined,
): string[] {
  if (!view) return [];
  const roots = new Set<string>();
  const groups: readonly (readonly PluginRuntimeRootCarrier[] | undefined)[] = [
    view.skills,
    view.mcpServers,
    view.hooks,
    view.commands,
    view.promptCommands,
    view.outputStyles,
    view.lspServers,
    view.monitors,
  ];
  for (const group of groups) {
    for (const entry of group ?? []) {
      const rootPath = entry.pluginRuntime?.rootPath;
      if (rootPath) roots.add(rootPath);
    }
  }
  return [...roots].sort();
}

/** The existing `<bundleRoot>/bin` directories of the given bundles, deduped. */
function pluginBinDirectories(bundleRoots: Iterable<string>): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const bundleRoot of bundleRoots) {
    if (!bundleRoot) continue;
    const directory = join(bundleRoot, PLUGIN_BIN_DIR_NAME);
    if (seen.has(directory)) continue;
    seen.add(directory);
    // A bundle without a bin/ must not put a non-existent directory on PATH.
    if (existsSync(directory)) directories.push(directory);
  }
  return directories;
}

/**
 * `basePath` with every enabled bundle's `bin/` APPENDED, or `undefined` when
 * there is nothing to add.
 *
 * Appended, never prepended: a plugin must not be able to shadow a system
 * binary of the same name by shipping a file called `git`, `node` or `sh`. The
 * base is concatenated byte-for-byte so the host's own PATH shape is untouched.
 */
export function appendPluginBinPath(
  basePath: string | undefined,
  bundleRoots: Iterable<string>,
): string | undefined {
  const directories = pluginBinDirectories(bundleRoots);
  if (directories.length === 0) return undefined;
  const base = basePath ?? '';
  const appended = directories.join(delimiter);
  return base.length === 0 ? appended : `${base}${delimiter}${appended}`;
}

/**
 * Journaled Workspace-deletion participant (id `plugin-data`, W7 Step 4).
 *
 * On commit it removes `workspaces/<workspaceId>` (and its project subtree)
 * under every plugin's version-less data root. Global plugin data and other
 * Workspaces are untouched, and whole-project trust — keyed only by ProjectKey —
 * survives elsewhere.
 */
export function createPluginDataCleanupParticipant(dataDir: string = PLUGIN_DATA_DIR): {
  id: 'plugin-data';
  stage(workspaceId: string, transactionId: string): Promise<void>;
  commit(transactionId: string): Promise<void>;
  rollback(transactionId: string): Promise<void>;
} {
  const staged = new Map<string, string>();
  return {
    id: 'plugin-data',
    stage: async (workspaceId, transactionId) => {
      assertStorageId('workspace', workspaceId);
      staged.set(transactionId, workspaceId);
    },
    commit: async (transactionId) => {
      const workspaceId = staged.get(transactionId);
      if (!workspaceId) return;
      if (existsSync(dataDir)) {
        for (const encodedKey of readdirSync(dataDir)) {
          const target = resolveContainedPath(dataDir, encodedKey, 'workspaces', workspaceId);
          await rm(target, { recursive: true, force: true });
        }
      }
      staged.delete(transactionId);
    },
    rollback: async (transactionId) => {
      staged.delete(transactionId);
    },
  };
}
