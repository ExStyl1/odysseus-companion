/**
 * D1.69 — a plugin that lives for one session and is gone when it ends.
 *
 * The three clauses the row's `done_means` names are one per `describe` below:
 * a local directory that SHADOWS an installed same-named plugin for that
 * session only, a URL archive on the same lifetime, and a fetch failure that
 * surfaces as a plugin load error rather than a session quietly missing a
 * plugin it was asked for.
 *
 * One deliberate split in how the two source kinds are driven, stated so the
 * asymmetry is not read as an oversight: the LOCAL arm runs the real
 * plan → stage → normalize pipeline over a real directory, because that is the
 * half a stub would make vacuous. The URL arm drives an injected
 * `PluginInstallStager`, because what this module owns there is that a
 * `{ kind: 'url' }` request reaches the stager as one and that the resulting
 * bundle gets the session lifetime — the fetch, the archive guard and the
 * header rules are `acquisition.ts`'s and are covered by its own pipeline
 * suite, where they are not a stub either.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSessionScopedPlugins,
  mergeSessionScopedPlugins,
  registerSessionScopedPlugins,
  releaseAllSessionScopedPlugins,
  releaseSessionScopedPlugins,
  releaseSessionScopedPluginsFor,
  sessionScopedInstanceIds,
  sessionScopedPluginsFor,
  type SessionScopedPlugin,
} from '../session-scoped.ts';
import { pluginKeyFor } from '../../workspaces/paths.ts';
import type { PluginInstallStager } from '../management-types.ts';
import type { PluginInstalledEntryV2 } from '../store-v2.ts';
import type {
  NessyPluginManifest,
  PluginInstallPlan,
  PluginStagedInstall,
} from '../types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-scoped-plugin-'));
});

afterEach(async () => {
  await releaseAllSessionScopedPlugins();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function manifestFor(id: string, version = '1.0.0'): NessyPluginManifest {
  return {
    schemaVersion: 1,
    kind: 'plugin',
    id,
    name: id,
    version,
    capabilities: [
      { kind: 'skill', id: 'review', skill: { slug: 'review', path: 'skills/review/SKILL.md' } },
    ],
  };
}

/** A real bundle on disk — the same shape `acquisition-pipeline.test.ts` stages. */
function createLocalBundle(id: string, version = '1.0.0'): string {
  const bundle = join(tempDir, `${id}-plugin`);
  mkdirSync(join(bundle, 'skills', 'review'), { recursive: true });
  writeFileSync(join(bundle, 'skills', 'review', 'SKILL.md'), '# Review\n');
  writeFileSync(join(bundle, 'plugin.json'), JSON.stringify(manifestFor(id, version), null, 2));
  return bundle;
}

/**
 * What an INSTALLED copy of the same plugin looks like in the store. Only the
 * fields the shadow reads are meaningful; the identity is minted the way
 * `PluginStoreV2.install` mints it, which is the whole point of the assertion
 * that the two keys collide.
 */
function installedEntry(id: string, version = '9.9.9'): PluginInstalledEntryV2 {
  const bundleHash = 'a'.repeat(64);
  return {
    pluginInstanceId: `plugin://local/${id}@${version}#${bundleHash}`,
    pluginKey: pluginKeyFor('local', id),
    marketplaceId: 'local',
    pluginId: id,
    version,
    bundleHash,
    cacheRef: { marketplaceId: 'local', pluginId: id, version, bundleHash },
    manifest: manifestFor(id, version),
    origin: { source: 'local-path', resolvedAt: 1 },
    installedAt: 1,
    diagnostics: [],
  };
}

describe('D1.69 — a local directory loads for one session and shadows the installed copy', () => {
  it('mints the identity `PluginStoreV2.install` would, roots it at the staged bundle, and releases it', async () => {
    const bundle = createLocalBundle('local-toolkit');

    const loaded = await loadSessionScopedPlugins(
      [{ kind: 'local-path', path: bundle }],
      { baseTempDir: join(tempDir, 'stages') },
    );

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.plugins).toHaveLength(1);
    const plugin = loaded.plugins[0]!;

    // The key is the SAME one an installed copy carries. That equality is not
    // decoration: it is the entire shadow rule, so it is asserted against the
    // store's own mint rather than against a literal.
    expect(plugin.entry.pluginKey).toBe(installedEntry('local-toolkit').pluginKey);
    // ...and the instance id keeps the grammar `capabilities/views.ts` PARSES
    // to build a plugin agent's scoped `@` name.
    expect(plugin.entry.pluginInstanceId.startsWith('plugin://local/local-toolkit@1.0.0#')).toBe(true);
    expect(plugin.entry.version).toBe('1.0.0');

    // The bytes are in the staging directory, and the staging directory is real.
    expect(plugin.rootPath.startsWith(join(tempDir, 'stages'))).toBe(true);
    expect(existsSync(join(plugin.rootPath, 'plugin.json'))).toBe(true);

    registerSessionScopedPlugins('sess_a', loaded.plugins);
    expect(sessionScopedPluginsFor('sess_a')).toHaveLength(1);
    // The session next door is untouched — "for that session only", as a
    // reading rather than as a promise.
    expect(sessionScopedPluginsFor('sess_b')).toEqual([]);
    expect(sessionScopedInstanceIds(loaded.plugins).get(plugin.entry.pluginInstanceId))
      .toBe(plugin.rootPath);

    await releaseSessionScopedPluginsFor('sess_a');
    expect(sessionScopedPluginsFor('sess_a')).toEqual([]);
    expect(existsSync(plugin.stageDirectory)).toBe(false);
  });

  it('shadows an installed plugin by key, and leaves every other key alone', () => {
    const installed = [installedEntry('local-toolkit'), installedEntry('other-kit')];
    const session = [{
      entry: installedEntry('local-toolkit', '1.0.0'),
      rootPath: join(tempDir, 'stage', 'normalized'),
      stageDirectory: join(tempDir, 'stage'),
    }] satisfies SessionScopedPlugin[];

    const merged = mergeSessionScopedPlugins(installed, session);

    const toolkit = merged.filter(entry => entry.pluginId === 'local-toolkit');
    expect(toolkit).toHaveLength(1);
    expect(toolkit[0]?.version).toBe('1.0.0');
    // The control: the plugin the session said nothing about is still there,
    // at its installed version.
    const other = merged.filter(entry => entry.pluginId === 'other-kit');
    expect(other).toHaveLength(1);
    expect(other[0]?.version).toBe('9.9.9');

    // And with no session plugins the list is the store's, unchanged.
    expect(mergeSessionScopedPlugins(installed, [])).toEqual(installed);
  });
});

describe('D1.69 — a URL archive gets the same lifetime', () => {
  it('asks the stager for a `url` source and gives the result a session lifetime', async () => {
    const staged = join(tempDir, 'url-stage');
    const normalized = join(staged, 'normalized');
    mkdirSync(join(normalized, 'skills', 'review'), { recursive: true });
    writeFileSync(join(normalized, 'skills', 'review', 'SKILL.md'), '# Review\n');
    writeFileSync(join(normalized, 'plugin.json'), JSON.stringify(manifestFor('zip-kit'), null, 2));

    const seen: string[] = [];
    const installer: PluginInstallStager = {
      createInstallPlanFromSource: async source => {
        seen.push(source.kind);
        return {
          state: 'staged',
          planId: 'plan-1',
          source,
          origin: { source: 'archive-url', resolvedAt: 1 },
          diagnostics: [],
          createdAt: 1,
          lifecycle: [],
        } as unknown as PluginInstallPlan;
      },
      stageInstall: async plan => ({
        state: 'staged',
        plan,
        stageDirectory: staged,
        rawDirectory: join(staged, 'raw'),
        normalizedDirectory: normalized,
        stagedAt: 1,
        diagnostics: [],
      } as unknown as PluginStagedInstall),
      normalizeStagedInstall: async () => ({ manifest: manifestFor('zip-kit'), diagnostics: [] }),
    };

    const loaded = await loadSessionScopedPlugins(
      [{ kind: 'url', url: 'https://example.invalid/kit.zip' }],
      { installer, now: () => 5 },
    );

    expect(seen).toEqual(['url']);
    expect(loaded.plugins).toHaveLength(1);
    expect(loaded.plugins[0]?.entry.pluginId).toBe('zip-kit');
    expect(loaded.plugins[0]?.rootPath).toBe(normalized);
    expect(loaded.plugins[0]?.entry.installedAt).toBe(5);

    await releaseSessionScopedPlugins(loaded.plugins);
    expect(existsSync(staged)).toBe(false);
  });
});

describe('D1.69 — a load failure is a plugin load error, not a session missing a plugin', () => {
  it('returns no plugins and an error diagnostic for a source that cannot be staged', async () => {
    const loaded = await loadSessionScopedPlugins(
      [{ kind: 'local-path', path: join(tempDir, 'no-such-bundle') }],
      { baseTempDir: join(tempDir, 'stages') },
    );

    expect(loaded.plugins).toEqual([]);
    expect(loaded.diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true);
    expect(loaded.diagnostics[0]?.code).toBe('plugin.session_scoped.load_failed');
    // The request, never a resolved or staged path.
    expect(loaded.diagnostics[0]?.message).toContain('no-such-bundle');
  });

  it('is ALL-OR-NOTHING: a good bundle before a bad one is released, not kept', async () => {
    const good = createLocalBundle('first-kit');

    const loaded = await loadSessionScopedPlugins(
      [
        { kind: 'local-path', path: good },
        { kind: 'local-path', path: join(tempDir, 'no-such-bundle') },
      ],
      { baseTempDir: join(tempDir, 'stages') },
    );

    // The caller's contract is a refusal, so a partial load would be the one
    // outcome the request rules out — and a kept staging directory would be a
    // leak nobody owns, because no session was ever registered for it.
    expect(loaded.plugins).toEqual([]);
    expect(loaded.diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true);
    expect(existsSync(join(tempDir, 'stages')) ? readdirSync(join(tempDir, 'stages')) : [])
      .toEqual([]);
  });
});

describe('D1.69 — the request is caller JSON, so its shape is checked here', () => {
  it('refuses a source that is neither a directory nor a URL, and stages nothing', async () => {
    const loaded = await loadSessionScopedPlugins(
      [{ kind: 'local-path', path: '' }],
      { baseTempDir: join(tempDir, 'stages') },
    );

    expect(loaded.plugins).toEqual([]);
    expect(loaded.diagnostics[0]?.code).toBe('plugin.session_scoped.source_invalid');
    // The refusal happens BEFORE the stager is asked, so there is no base temp
    // directory at all — the control for "it refused rather than failed later".
    expect(existsSync(join(tempDir, 'stages'))).toBe(false);
  });
});
