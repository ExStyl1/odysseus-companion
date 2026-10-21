import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginKeyFor } from '../../workspaces/paths.ts';
import {
  claudeCompatPluginEnv,
  codexCompatPluginEnv,
  createPluginDataCleanupParticipant,
  pluginRuntimeEnv,
  pluginRuntimeEnvForProfile,
  removePluginData,
  resolvePluginDataPath,
} from '../data-paths.ts';

const PROJECT_KEY = `p_${'a'.repeat(32)}` as const;

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'plugin-data-paths-'));
}

describe('resolvePluginDataPath', () => {
  it('resolves global, workspace, and project buckets under one stable key', () => {
    const dir = dataDir();
    try {
      const key = pluginKeyFor('internal', 'toolkit');
      const global = resolvePluginDataPath(key, {}, dir);
      const ws = resolvePluginDataPath(key, { workspaceId: 'ws_01' }, dir);
      const project = resolvePluginDataPath(key, { workspaceId: 'ws_01', projectKey: PROJECT_KEY }, dir);

      expect(global.endsWith('/global')).toBe(true);
      expect(ws.endsWith(join('workspaces', 'ws_01'))).toBe(true);
      expect(project.endsWith(join('workspaces', 'ws_01', 'projects', PROJECT_KEY))).toBe(true);
      // All three share the same version-less key root.
      const root = global.slice(0, global.length - '/global'.length);
      expect(ws.startsWith(root)).toBe(true);
      expect(project.startsWith(root)).toBe(true);
      expect(global).not.toContain('..');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is version-less: the data path is identical across plugin versions', () => {
    const dir = dataDir();
    try {
      // pluginKeyFor takes only marketplace + plugin, never a version.
      const key = pluginKeyFor('internal', 'toolkit');
      const first = resolvePluginDataPath(key, { workspaceId: 'ws_01' }, dir);
      const afterUpgrade = resolvePluginDataPath(pluginKeyFor('internal', 'toolkit'), { workspaceId: 'ws_01' }, dir);
      expect(first).toBe(afterUpgrade);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Both cases below assert the MESSAGE, not merely that something threw, and
   * both carry the inputs a weaker guard would let through. P2.186 measured why:
   *
   * - Replacing `assertStorageId` here with a check that only refuses ids
   *   containing a path separator left this suite at **12/12 green** — while
   *   `..` then resolved ONTO the plugin data root (the parent of every
   *   workspace bucket and of `global/`) and `.` onto the `workspaces/` bucket
   *   itself.
   * - Deleting `isValidProjectKey` entirely also left it at **12/12 green**,
   *   because the one project key the case tried, `/etc/passwd`, is absolute
   *   and `resolveContainedPath` refused it under a DIFFERENT message. The
   *   validator the case is named for was never exercised.
   */
  it('rejects a project key without a Workspace, and an invalid project key, each under its own message', () => {
    const dir = dataDir();
    try {
      const key = pluginKeyFor('internal', 'toolkit');
      expect(() => resolvePluginDataPath(key, { projectKey: PROJECT_KEY }, dir))
        .toThrow('A project-scoped plugin data path requires a Workspace ID');
      // Naming the message is what makes this line about the project-key
      // validator: with the validator deleted the same input still throws, but
      // as `Path escapes managed storage root` from the containment layer.
      expect(() => resolvePluginDataPath(key, { workspaceId: 'ws_01', projectKey: '/etc/passwd' as never }, dir))
        .toThrow('Invalid project key for plugin data path');
      // Keys only the validator can refuse: each stays inside the root, so
      // containment never sees them.
      for (const projectKey of ['not-a-valid-key', 'p_short', `p_${'a'.repeat(31)}`, '..', '.']) {
        expect(() => resolvePluginDataPath(key, { workspaceId: 'ws_01', projectKey: projectKey as never }, dir))
          .toThrow('Invalid project key for plugin data path');
      }
      // The discriminator: a well-formed key resolves, so the refusals above are
      // about the key's shape and not about the field being present at all.
      expect(resolvePluginDataPath(key, { workspaceId: 'ws_01', projectKey: PROJECT_KEY }, dir))
        .toContain(join('projects', PROJECT_KEY));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects every traversal and self-reference in the Workspace ID, under the storage-ID guard', () => {
    const dir = dataDir();
    try {
      const key = pluginKeyFor('internal', 'toolkit');
      // `../escape` alone is not enough — a separator-only check refuses it and
      // still admits `..` and `.`, which are the two that actually escape the
      // bucket the cleanup participant deletes.
      for (const workspaceId of ['../escape', '..', '.', 'a/b', '/abs', '..%2fescape', ' x']) {
        expect(() => resolvePluginDataPath(key, { workspaceId }, dir))
          .toThrow('Invalid workspace storage ID');
      }
      // The containment half, asserted on IDENTITY rather than on "threw
      // nothing": an ordinary id resolves to exactly its own directory under the
      // workspaces bucket.
      const global = resolvePluginDataPath(key, {}, dir);
      const root = global.slice(0, global.length - '/global'.length);
      expect(resolvePluginDataPath(key, { workspaceId: 'ws_01' }, dir))
        .toBe(join(root, 'workspaces', 'ws_01'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * P2.198 — the fifth instance of the empty-means-absent family, and the first
   * that lands on a storage SCOPE rather than on a permission set. Under the old
   * `if (!context.workspaceId)` an empty id took the "no Workspace" branch and
   * returned the GLOBAL bucket — the one directory every Workspace shares —
   * while `assertStorageId` never saw the value at all.
   *
   * REACHABILITY, established before any of this was pinned (that order is the
   * point: the P2.186 lane reported this rather than fixing it precisely because
   * nobody had shown a caller could produce `''`). All FOUR production call
   * sites of `resolvePluginDataPath` are covered, and none can:
   *
   *  - `management-service-v2.ts:467` and `:501` are private helpers reached only
   *    from `configurationStatus`, `configure` and `clearConfiguration`, each of
   *    which runs `assertStorageId('workspace', workspaceId)` on the line above.
   *  - `storage-runtime.ts:975` (via `readPluginOptionEnvironment`) and `:1144`
   *    both sit inside `buildCapabilityResolutionInputsV2`, whose only caller is
   *    the resolver's input provider — so the id is always a
   *    `CapabilityContext.workspaceId`, and every non-test producer of one
   *    supplies a validated value: `resolveCapabilityContext` gates on
   *    `isSafeCapabilityContextRef` (whose first check is a NON-EMPTY string) and
   *    the RPC handlers additionally reject a falsy `ctx.workspaceId`;
   *    `SessionManager`'s five context literals read `managed.workspace.id`,
   *    which only ever comes from `WorkspaceService.resolve`/`listResolved` (both
   *    `assertStorageId`), or sit behind their own guard
   *    (`getWorkspacePendingAuth` returns early when `resolveWorkspace` fails).
   *
   * So these cases pin the BOUNDARY, not a live production defect. They are here
   * because an empty string is not a missing value whatever the callers do, and
   * because the next caller is the one that would have shipped the widening.
   */
  it('refuses an empty Workspace ID rather than widening onto the shared global bucket', () => {
    const dir = dataDir();
    try {
      const key = pluginKeyFor('internal', 'toolkit');

      // The defect itself, asserted on the storage-ID message so it cannot be
      // satisfied by some other layer refusing for some other reason.
      expect(() => resolvePluginDataPath(key, { workspaceId: '' }, dir))
        .toThrow('Invalid workspace storage ID');

      // An empty id carrying a project key must ALSO fail on the storage-ID
      // guard. This is the discriminator against the truthiness test: with
      // `!context.workspaceId` restored this input still throws, but as
      // `A project-scoped plugin data path requires a Workspace ID` — the wrong
      // proposition, blaming the absent Workspace for a bad one.
      expect(() => resolvePluginDataPath(key, { workspaceId: '', projectKey: PROJECT_KEY }, dir))
        .toThrow('Invalid workspace storage ID');

      // The control in the other direction, and the reason this is a
      // distinction rather than a blanket refusal: an OMITTED Workspace is still
      // absent identity and still resolves to `global`. A guard that refused
      // both empty and absent would fail here.
      //
      // Asserted against the data root and the literal bucket name — NOT against
      // a root recomputed by slicing `/global` back off this same string, which
      // is a tautology that holds for any return value.
      const global = resolvePluginDataPath(key, {}, dir);
      expect(global.startsWith(dir)).toBe(true);
      expect(global.endsWith('/global')).toBe(true);
      // ...and an omitted Workspace with a project key keeps its own message,
      // so the two refusals stay about different things.
      expect(() => resolvePluginDataPath(key, { projectKey: PROJECT_KEY }, dir))
        .toThrow('A project-scoped plugin data path requires a Workspace ID');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createPluginDataCleanupParticipant', () => {
  it('removes only the deleted workspace subtree, keeping global and other workspaces', async () => {
    const dir = dataDir();
    try {
      const key = pluginKeyFor('internal', 'toolkit');
      const global = resolvePluginDataPath(key, {}, dir);
      const wsA = resolvePluginDataPath(key, { workspaceId: 'ws_a' }, dir);
      const wsB = resolvePluginDataPath(key, { workspaceId: 'ws_b' }, dir);
      mkdirSync(global, { recursive: true });
      mkdirSync(wsA, { recursive: true });
      mkdirSync(wsB, { recursive: true });

      const participant = createPluginDataCleanupParticipant(dir);
      expect(participant.id).toBe('plugin-data');
      await participant.stage('ws_a', 'tx1');
      await participant.commit('tx1');

      expect(existsSync(wsA)).toBe(false);
      expect(existsSync(wsB)).toBe(true);
      expect(existsSync(global)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removePluginData', () => {
  it('removes only the requested stable plugin root', async () => {
    const dir = dataDir();
    try {
      const removedKey = pluginKeyFor('internal', 'removed');
      const retainedKey = pluginKeyFor('internal', 'retained');
      const removedData = resolvePluginDataPath(removedKey, { workspaceId: 'ws_a' }, dir);
      const retainedData = resolvePluginDataPath(retainedKey, { workspaceId: 'ws_a' }, dir);
      mkdirSync(removedData, { recursive: true });
      mkdirSync(retainedData, { recursive: true });

      await removePluginData(removedKey, dir);

      expect(existsSync(removedData)).toBe(false);
      expect(existsSync(retainedData)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plugin runtime env contract', () => {
  const paths = { bundleRoot: '/cache/bundle', dataPath: '/data/ws' };

  it('emits Nessy + unbranded aliases only, never Claude aliases', () => {
    const env = pluginRuntimeEnv(paths);
    expect(env).toEqual({
      NESSY_PLUGIN_ROOT: '/cache/bundle',
      PLUGIN_ROOT: '/cache/bundle',
      NESSY_PLUGIN_DATA: '/data/ws',
      PLUGIN_DATA: '/data/ws',
    });
    expect('CLAUDE_PLUGIN_ROOT' in env).toBe(false);
    expect('CLAUDE_PLUGIN_DATA' in env).toBe(false);
  });

  it('emits Claude aliases only through the explicit compat adapter', () => {
    expect(claudeCompatPluginEnv(paths)).toEqual({
      CLAUDE_PLUGIN_ROOT: '/cache/bundle',
      CLAUDE_PLUGIN_DATA: '/data/ws',
      CLAUDE_CONFIG_DIR: '/data/ws',
    });
  });

  it('emits Claude root/data/project aliases when a validated project path is present', () => {
    expect(claudeCompatPluginEnv({ ...paths, projectPath: '/workspace/project' })).toEqual({
      CLAUDE_PLUGIN_ROOT: '/cache/bundle',
      CLAUDE_PLUGIN_DATA: '/data/ws',
      CLAUDE_CONFIG_DIR: '/data/ws',
      CLAUDE_PROJECT_DIR: '/workspace/project',
    });
  });

  it('emits exactly the Codex-documented Claude-compat aliases (root/data), never project', () => {
    expect(codexCompatPluginEnv(paths)).toEqual({
      CLAUDE_PLUGIN_ROOT: '/cache/bundle',
      CLAUDE_PLUGIN_DATA: '/data/ws',
      CLAUDE_CONFIG_DIR: '/data/ws',
    });
    expect(codexCompatPluginEnv({ ...paths, projectPath: '/workspace/project' })).toEqual({
      CLAUDE_PLUGIN_ROOT: '/cache/bundle',
      CLAUDE_PLUGIN_DATA: '/data/ws',
      CLAUDE_CONFIG_DIR: '/data/ws',
    });
  });
});

describe('pluginRuntimeEnvForProfile', () => {
  const paths = { bundleRoot: '/cache/bundle', dataPath: '/data/ws', projectPath: '/workspace/project' };

  it('selects exactly the profile-documented aliases (generic/codex/claude)', () => {
    // `NESSY_PROJECT_DIR` is a GENERIC name (schema.ts accepts it as a path
    // root, hook-command.ts as an exec-form placeholder), so every profile
    // carries it when a validated project path exists; `CLAUDE_PROJECT_DIR`
    // stays Claude-compat-only.
    expect(pluginRuntimeEnvForProfile('generic-plugin-env-v1', paths)).toEqual({
      NESSY_PLUGIN_ROOT: '/cache/bundle',
      PLUGIN_ROOT: '/cache/bundle',
      NESSY_PLUGIN_DATA: '/data/ws',
      PLUGIN_DATA: '/data/ws',
      NESSY_PROJECT_DIR: '/workspace/project',
    });
    expect(pluginRuntimeEnvForProfile('codex-plugin-env-v1', paths)).toEqual({
      NESSY_PLUGIN_ROOT: '/cache/bundle',
      PLUGIN_ROOT: '/cache/bundle',
      NESSY_PLUGIN_DATA: '/data/ws',
      PLUGIN_DATA: '/data/ws',
      NESSY_PROJECT_DIR: '/workspace/project',
      CLAUDE_PLUGIN_ROOT: '/cache/bundle',
      CLAUDE_PLUGIN_DATA: '/data/ws',
      CLAUDE_CONFIG_DIR: '/data/ws',
    });
    expect(pluginRuntimeEnvForProfile('claude-plugin-env-v1', paths)).toEqual({
      NESSY_PLUGIN_ROOT: '/cache/bundle',
      PLUGIN_ROOT: '/cache/bundle',
      NESSY_PLUGIN_DATA: '/data/ws',
      PLUGIN_DATA: '/data/ws',
      NESSY_PROJECT_DIR: '/workspace/project',
      CLAUDE_PLUGIN_ROOT: '/cache/bundle',
      CLAUDE_PLUGIN_DATA: '/data/ws',
      CLAUDE_CONFIG_DIR: '/data/ws',
      CLAUDE_PROJECT_DIR: '/workspace/project',
    });
  });

  it('fails closed for an unknown/missing profile: never falls back to universal aliases', () => {
    expect(() => pluginRuntimeEnvForProfile('unknown-profile-v9' as never, paths)).toThrow();
  });
});
