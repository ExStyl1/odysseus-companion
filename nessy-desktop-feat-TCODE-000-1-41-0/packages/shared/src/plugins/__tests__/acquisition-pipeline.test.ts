/**
 * The bundle-acquisition pipeline end to end: plan → stage → normalize.
 *
 * These cases used to drive `PluginInstallService.installFromSource` from the
 * retired V1 `install-service.ts`, which ran exactly this sequence and then
 * committed to the V1 registry. F4 deleted the V1 commit half; the sequence
 * itself is what `PluginManagementServiceV2.install` runs before it commits to
 * `PluginStoreV2`, so every acquisition assertion below still describes the one
 * production path. What went with V1 is the commit half only — the installed
 * ENTRY, its cache layout, its `enabledScopes` and the V1 projection preview;
 * those live in `management-service-v2.test.ts` and `store-v2.test.ts` now, and
 * the rows here that had to reach the installed record already drive
 * `createManagedService` instead.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { c as createTar } from 'tar';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  PluginInstallService,
  type PluginArtifactAuthProvider,
  type PluginInstallPlanOptions,
  type PluginInstallServiceOptions,
  type PluginStagedNormalizationResult,
} from '../acquisition.ts';
import type {
  NessyPluginManifest,
  PluginCapability,
  PluginCompatibilityReport,
  PluginDiagnostic,
  PluginEcosystemFormat,
  PluginInstallPlan,
  PluginInstallSource,
  PluginStagedInstall,
} from '../types.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import {
  createDpSessionBroker,
  type DpSessionBroker,
} from '../../auth/dp/session-broker.ts';
import { createFakeDp } from '../../auth/dp/__tests__/fake-dp.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-acquisition-test-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

interface AcquisitionResult {
  ok: boolean;
  plan: PluginInstallPlan;
  staged: PluginStagedInstall;
  normalization?: PluginStagedNormalizationResult;
  manifest?: NessyPluginManifest;
  detectedFormat?: PluginEcosystemFormat;
  compatibility?: PluginCompatibilityReport;
  diagnostics: PluginDiagnostic[];
}

/**
 * Plan → stage → normalize, with V1's own short-circuit rule: an `error` in the
 * staging diagnostics, or a normalization that produced no manifest, is a
 * refusal. `PluginManagementServiceV2.materialize` applies the same rule before
 * it commits, so `ok` here means what it meant before — the bundle got far
 * enough to be committable.
 */
async function acquire(
  service: PluginInstallService,
  source: string | PluginInstallSource,
  options: PluginInstallPlanOptions & { baseTempDir?: string } = {},
): Promise<AcquisitionResult> {
  const plan = await service.createInstallPlanFromSource(source, options);
  const staged = await service.stageInstall(plan, options);
  if (staged.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return { ok: false, plan: staged.plan, staged, diagnostics: staged.diagnostics };
  }
  const normalization = await service.normalizeStagedInstall(staged);
  if (!normalization.manifest || normalization.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return { ok: false, plan: staged.plan, staged, normalization, diagnostics: staged.diagnostics };
  }
  return {
    ok: true,
    plan: staged.plan,
    staged,
    normalization,
    manifest: normalization.manifest,
    ...(normalization.detectedFormat ? { detectedFormat: normalization.detectedFormat } : {}),
    ...(normalization.compatibility ? { compatibility: normalization.compatibility } : {}),
    diagnostics: staged.diagnostics,
  };
}

function capabilitiesOfKind<K extends PluginCapability['kind']>(
  result: AcquisitionResult,
  kind: K,
): Extract<PluginCapability, { kind: K }>[] {
  return (result.manifest?.capabilities ?? [])
    .filter((capability): capability is Extract<PluginCapability, { kind: K }> => capability.kind === kind);
}

/** Where a normalized skill's file actually landed in the staged bundle. */
function skillPath(result: AcquisitionResult, index = 0): string {
  const skill = capabilitiesOfKind(result, 'skill')[index];
  return skill ? join(result.staged.normalizedDirectory, skill.skill.path) : '';
}

describe('the acquisition pipeline', () => {
  it('stages and normalizes local native plugin.json bundles', async () => {
    const localPlugin = createSkillBundle('local-toolkit');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('local-toolkit');
    // A local bundle carries no marketplace of its own; `PluginStoreV2` is what
    // assigns the `local` marketplace id at commit (`management-service-v2.test.ts`).
    expect(result.plan.origin.source).toBe('local-path');
    expect(result.plan.origin.marketplaceId).toBeUndefined();
    expect(existsSync(join(result.staged.rawDirectory, 'plugin.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.staged.normalizedDirectory, 'plugin.json'), 'utf-8')).id).toBe('local-toolkit');
    expect(skillPath(result)).toContain('/normalized/skills/review/SKILL.md');
    expect(existsSync(skillPath(result))).toBe(true);
  });

  it('an author\'s defaultEnabled:false survives normalization', async () => {
    // `plugins-reference.md` § Default enablement: "Set `defaultEnabled: false`
    // in `plugin.json` to ship a plugin that installs disabled." The field was
    // parsed by the adapter and then destroyed by `normalizeNessyPluginManifest`,
    // which rebuilds the manifest field by field, so a plugin shipped opt-in
    // installed ENABLED — the opposite of what the author asked for.
    const localPlugin = createSkillBundle('opt-in-toolkit');
    writeFileSync(
      join(localPlugin, 'plugin.json'),
      JSON.stringify({ ...manifest('opt-in-toolkit'), defaultEnabled: false }, null, 2),
    );
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    // The field was parsed by the adapter and then destroyed by
    // `normalizeNessyPluginManifest`. That it reaches the store at all is this
    // pipeline's job, and that is all this asserts. Whether it SUPPRESSES the
    // install-time enable is `management-service-v2.ts`'s, and since P6.386 it
    // does: that file's install path now parks a `defaultEnabled: false` bundle
    // disabled unless an already-enabled plugin requires it, asserted in
    // `management-service-v2.test.ts`. This comment said the field was "inert on
    // the V2 install path and no test covers it" until then.
    expect(result.manifest?.defaultEnabled).toBe(false);
  });

  it('an absent defaultEnabled stays absent rather than being defaulted to a value', async () => {
    const localPlugin = createSkillBundle('opt-out-toolkit');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    expect(result.manifest?.defaultEnabled).toBeUndefined();
  });

  it('normalizes local Codex .codex-plugin/plugin.json bundles into skill, mcp and hook capabilities', async () => {
    const localPlugin = createCodexBundle('codex-toolkit');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('codex-toolkit');
    expect(result.manifest?.compatibility?.rawExternalKind).toBe('codex-plugin');
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.format.codex_json_unreadable');
    expect(capabilitiesOfKind(result, 'skill')[0]?.skill).toEqual(expect.objectContaining({
      slug: 'review',
      path: 'skills/review/SKILL.md',
    }));
    expect(existsSync(skillPath(result))).toBe(true);
    expect(capabilitiesOfKind(result, 'mcp')[0]?.mcp).toEqual(expect.objectContaining({
      serverName: 'linear',
      transport: 'stdio',
      command: 'node',
      args: ['mcp.js'],
      env: { TOKEN: 'test' },
    }));
    expect(capabilitiesOfKind(result, 'hook')[0]?.hook).toEqual(expect.objectContaining({
      id: 'policy',
      event: 'PreToolUse',
      type: 'command',
      command: 'node hooks/policy.js',
      cwd: 'hooks',
    }));
    // W7 Step 5: generic Codex top-level settings/assets blocks never become
    // capabilities accidentally — they are retained for catalog only.
    expect(capabilitiesOfKind(result, 'setting')).toEqual([]);
    expect(capabilitiesOfKind(result, 'asset')).toEqual([]);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.format.codex_extension_not_capability',
    );
  });

  it('surfaces the codex adapter\'s own deferred compatibility entries instead of a recomputed empty list (D12)', async () => {
    const localPlugin = createCodexBundle('codex-deferred');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    // The Codex adapter itself computes `deferred` entries for the top-level
    // settings/assets blocks it cannot project as capabilities (A2/A4). The
    // The pipeline must surface THIS adapter-owned report rather than
    // recompute one from `manifest.capabilities`, which has no visibility
    // into deferred (non-capability) external fields and always reports []
    // for `deferred`.
    expect(result.compatibility?.state).toBe('partial');
    expect(result.compatibility?.deferred.length).toBeGreaterThan(0);
    expect(result.compatibility?.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'plugin.deferred.codex_settings' }),
      expect.objectContaining({ reasonCode: 'plugin.deferred.codex_assets' }),
    ]));
  });

  it('installs a curated-shaped Codex fixture from local path without depending on real ~/.codex state', async () => {
    const localPlugin = createCodexBundle('curated-superpowers');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('curated-superpowers');
    // The bundle is staged out of the app's own staging root, never read in
    // place out of a real `~/.codex` tree.
    expect(result.staged.rawDirectory).toContain('/stages/nessy-plugin-stage-');
    expect(result.staged.rawDirectory).not.toContain('/.codex/');
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.format.codex_json_unreadable');
    expect(capabilitiesOfKind(result, 'skill')[0]?.skill.slug).toBe('review');
    expect(existsSync(skillPath(result))).toBe(true);
    expect(capabilitiesOfKind(result, 'mcp')[0]?.mcp.serverName).toBe('linear');
    // W7 Step 5: the curated bundle's top-level assets/interface blocks are
    // retained for catalog only, not projected as capabilities.
    expect(capabilitiesOfKind(result, 'asset')).toEqual([]);
  });

  it('installs the A1 codex-core fixture through the format-adapters/codex.ts facade unchanged (A4 regression)', async () => {
    const fixtureRoot = join(import.meta.dir, 'fixtures', 'format-adapters', 'codex-core');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: fixtureRoot });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('sample-codex-core');
    expect(result.manifest?.compatibility?.rawExternalKind).toBe('codex-plugin');
    expect(result.compatibility).toEqual({
      format: 'codex',
      state: 'supported',
      supportedKinds: expect.arrayContaining(['skill', 'mcp', 'hook']),
      deferred: [],
      blocked: [],
    });
    expect(capabilitiesOfKind(result, 'skill')[0]?.skill.slug).toBe('hello-skill');
    expect(skillPath(result)).toContain('/normalized/skills/hello-skill/SKILL.md');
    expect(existsSync(skillPath(result))).toBe(true);
    expect(capabilitiesOfKind(result, 'mcp')[0]?.mcp.serverName).toBe('sample-tools');
    expect(capabilitiesOfKind(result, 'hook')[0]?.hook).toEqual(expect.objectContaining({
      event: 'PreToolUse',
      type: 'command',
    }));
  });

  it('installs the A1 claude-core fixture through the format-adapters/claude.ts facade (A5)', async () => {
    const fixtureRoot = join(import.meta.dir, 'fixtures', 'format-adapters', 'claude-core');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: fixtureRoot });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('sample-claude-core');
    expect(result.manifest?.compatibility?.rawExternalKind).toBe('claude-plugin');
    // The pipeline surfaces the Claude adapter's OWN compatibility report
    // (A7/D12) instead of recomputing one from manifest.capabilities' raw
    // PluginCapabilityKind — so this uses the adapter's external-facing
    // "command" label (Claude's own vocabulary), not the internal
    // "prompt-command" capability kind.
    expect(result.compatibility).toEqual({
      format: 'claude',
      state: 'supported',
      supportedKinds: expect.arrayContaining(['skill', 'mcp', 'hook', 'command', 'agent']),
      deferred: [],
      blocked: [],
    });
    expect(capabilitiesOfKind(result, 'skill')[0]?.skill.slug).toBe('sample-skill');
    expect(skillPath(result)).toContain('/normalized/skills/sample-skill/SKILL.md');
    expect(existsSync(skillPath(result))).toBe(true);
    expect(capabilitiesOfKind(result, 'mcp').map(capability => capability.mcp.serverName)).toEqual(
      expect.arrayContaining(['sample-stdio-tools', 'sample-http-tools']),
    );
    expect(capabilitiesOfKind(result, 'hook')[0]?.hook).toEqual(expect.objectContaining({
      event: 'PreToolUse',
      type: 'command',
    }));
  });

  it('fails local bundle installs before commit when file-backed capabilities are missing', async () => {
    const localPlugin = join(tempDir, 'missing-skill-plugin');
    mkdirSync(localPlugin, { recursive: true });
    writeFileSync(join(localPlugin, 'plugin.json'), JSON.stringify(manifest('missing-skill'), null, 2));
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.missing_skill_path');
  });

  it('rejects local plugin bundles containing symlinks before commit', async () => {
    const localPlugin = createSkillBundle('symlink-toolkit');
    const outsideFile = join(tempDir, 'outside-secret.txt');
    writeFileSync(outsideFile, 'outside');
    symlinkSync(outsideFile, join(localPlugin, 'outside-link'));
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.local_path_symlink_unsupported');
  });

  it('rejects legacy string marketplace refs without network lookup', async () => {
    const requestedUrls: string[] = [];
    const service = createService(asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return new Response('unexpected request', { status: 500 });
    }));

    const result = await acquire(service, 'legacy-toolkit');

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'plugin.source.unsupported',
      'plugin.install.unknown_artifact',
    ]));
    expect(requestedUrls).toEqual([]);
  });

  it('installs npm-backed marketplace packages without executing marketplace commands', async () => {
    const bundle = createCodexBundle('npm-toolkit');
    const archive = await createArchiveFromDirectory(bundle, 'npm-toolkit.tgz');
    const archiveBytes = readFileSync(archive);
    const integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
    const service = createService(routeFetch({
      'https://registry.example.com/%40ai%2Fnpm-toolkit': Response.json({
        versions: {
          '1.0.0': {
            dist: {
              tarball: 'https://registry.example.com/npm-toolkit-1.0.0.tgz',
              integrity,
            },
          },
        },
      }),
      'https://registry.example.com/npm-toolkit-1.0.0.tgz': binaryResponse(archiveBytes),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-npm-package',
      packageName: '@ai/npm-toolkit',
      version: '1.0.0',
      registry: 'https://registry.example.com',
      marketplace: {
        itemId: 'npm-toolkit',
        listKind: 'plugins',
        itemKind: 'plugin',
        name: 'NPM Toolkit',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('npm-toolkit');
    expect(result.plan.origin.marketplaceId).toBe('nessy-marketplace');
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.format.codex_json_unreadable');
    expect(JSON.stringify(result.plan.source)).not.toContain('install.sh');
    const marketplaceSnapshot = JSON.parse(readFileSync(join(result.staged.normalizedDirectory ?? '', 'marketplace.json'), 'utf-8'));
    expect(marketplaceSnapshot.marketplace).toMatchObject({
      itemId: 'npm-toolkit',
      name: 'NPM Toolkit',
    });
  });

  it('resolves an advertised version to its CI build stamp and names both', async () => {
    // F3. The marketplace advertises 1.0.9 for
    // @ai-office/nessy-extension-nestor-nessy-default-extension; the real
    // Artifactory publishes no plain 1.0.9, only the CI stamp for that release.
    // An exact key lookup failed the install on a version the catalog itself
    // advertised.
    const bundle = createCodexBundle('stamped-extension');
    const archive = await createArchiveFromDirectory(bundle, 'stamped.tgz');
    const archiveBytes = readFileSync(archive);
    const service = createService(routeFetch({
      'https://registry.example.com/%40ai%2Fstamped': Response.json(REAL_REGISTRY_METADATA_SHAPE),
      'https://registry.example.com/stamped-1.0.9-source.tgz': binaryResponse(archiveBytes),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-npm-package',
      packageName: '@ai/stamped',
      version: '1.0.9',
      registry: 'https://registry.example.com',
      derivedCoordinates: true,
      marketplace: { itemId: 'stamped', listKind: 'plugins', itemKind: 'plugin', name: 'Stamped' },
    });

    expect(result.ok).toBe(true);
    const resolved = result.diagnostics.find(d => d.code === 'plugin.install.npm_version_resolved');
    expect(resolved?.severity).toBe('info');
    expect(resolved?.details).toMatchObject({
      requested: '1.0.9',
      resolved: '1.0.9-source.20260716152955.45c8ba6c7514',
      rule: 'widened-within-base',
    });
  });

  it('pins the resolved version and digest so a later repair reproduces that exact artifact', async () => {
    // E6, end to end through the production install and repair boundary.
    //
    // The record used to keep the ADVERTISED "1.0.9". Between install and
    // repair the registry publishes a NEWER stamp of the same base, and A2's
    // `widened-within-base` takes the highest — so repair silently rebuilt the
    // plugin from a different artifact than the one on disk.
    const firstStamp = '1.0.9-source.20260716152955.45c8ba6c7514';
    const laterStamp = '1.0.9-source.20260801090000.aaaaaaaaaaaa';
    const firstBytes = readFileSync(await createArchiveFromDirectory(createSkillBundle('pinned'), 'pinned-first.tgz'));
    const laterBytes = readFileSync(await createArchiveFromDirectory(createSkillBundle('pinned-later'), 'pinned-later.tgz'));
    const firstIntegrity = `sha512-${createHash('sha512').update(firstBytes).digest('base64')}`;
    const laterIntegrity = `sha512-${createHash('sha512').update(laterBytes).digest('base64')}`;
    const metadataUrl = 'https://registry.example.com/%40ai-office%2Fpinned';
    const firstTarball = 'https://registry.example.com/pinned-first.tgz';
    const laterTarball = 'https://registry.example.com/pinned-later.tgz';
    const published: Record<string, { dist: { tarball: string; integrity: string } }> = {
      [firstStamp]: { dist: { tarball: firstTarball, integrity: firstIntegrity } },
    };
    const downloaded: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      const key = url.toString();
      if (key === metadataUrl) return Response.json({ versions: published });
      if (key === firstTarball || key === laterTarball) {
        downloaded.push(key);
        return binaryResponse(key === firstTarball ? firstBytes : laterBytes);
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });

    const seenSources: PluginInstallSource[] = [];
    const { service, store } = createManagedService(fetchImpl, 'pinned', {
      onPlanSource: source => seenSources.push(source),
    });

    const installed = await service.install({
      kind: 'marketplace-npm-package',
      packageName: '@ai-office/pinned',
      version: '1.0.9',
      registry: 'https://registry.example.com',
      derivedCoordinates: true,
      marketplace: { itemId: 'pinned', listKind: 'plugins', itemKind: 'plugin', name: 'Pinned' },
    });
    expect(installed.ok).toBe(true);

    // The record names what was installed, not what was advertised — and it
    // carries the digest of that artifact, so the install is byte-pinned.
    const entry = (await store.readInstalledRegistry()).plugins[0];
    expect(entry?.origin.provenance).toMatchObject({
      version: firstStamp,
      advertisedVersion: '1.0.9',
      integrity: firstIntegrity,
    });

    // The registry moves on: a newer stamp of the SAME advertised base.
    published[laterStamp] = { dist: { tarball: laterTarball, integrity: laterIntegrity } };

    const repaired = await service.repair(installed.installed!.pluginKey);

    expect(repaired.ok).toBe(true);
    expect(seenSources.at(-1)).toMatchObject({
      kind: 'marketplace-npm-package',
      packageName: '@ai-office/pinned',
      version: firstStamp,
      integrity: firstIntegrity,
    });
    // The bytes, not merely the string: repair re-downloaded the original.
    expect(downloaded).toEqual([firstTarball, firstTarball]);
  });

  it('warns about a disagreeing repository on a derived coordinate, and never refuses on it', async () => {
    // A8, re-shaped. The original row wanted a REFUSAL unless the resolved
    // package's `repository.url` corresponds to the listing `path`. Measured
    // across the live catalog that gate is unsatisfiable: of the 88 derived
    // rows `repository.url` is EMPTY on 68, so it would refuse 68 of 88 and
    // undo most of A2's measured 12 → 116. The 6 populated disagreements are
    // verifiably the correct packages — an inherited template repository.
    const listingPath = 'https://gitlab.tcsbank.ru/nfs-support/nessy-extensions/-/tree/master/nessy-default-extension';
    const cases: Array<{ name: string; repository: unknown; derived: boolean; warns: boolean }> = [
      // The 68: the common case, and it must be silent.
      { name: 'empty', repository: { type: '', url: '' }, derived: true, warns: false },
      { name: 'absent', repository: undefined, derived: true, warns: false },
      // The 12 that agree — including the `git+…​.git` spelling.
      { name: 'agreeing', repository: { type: 'git', url: 'git+https://gitlab.tcsbank.ru/nfs-support/nessy-extensions.git' }, derived: true, warns: false },
      // The 6: correct packages carrying the template repo they were copied from.
      { name: 'disagreeing', repository: { type: 'git', url: 'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions' }, derived: true, warns: true },
      // A row that published its own install command stated its identity.
      { name: 'published-command', repository: { type: 'git', url: 'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions' }, derived: false, warns: false },
    ];

    for (const { name, repository, derived, warns } of cases) {
      const bundle = createCodexBundle(`a8-${name}`);
      const archiveBytes = readFileSync(await createArchiveFromDirectory(bundle, `a8-${name}.tgz`));
      const service = createService(routeFetch({
        [`https://registry.example.com/%40ai-office%2Fa8-${name}`]: Response.json({
          versions: {
            '1.0.0': {
              ...(repository === undefined ? {} : { repository }),
              dist: {
                tarball: `https://registry.example.com/a8-${name}.tgz`,
                integrity: `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`,
              },
            },
          },
        }),
        [`https://registry.example.com/a8-${name}.tgz`]: binaryResponse(archiveBytes),
      }), { baseTempDir: join(tempDir, `a8-${name}`, 'stages') });

      const result = await acquire(service, {
        kind: 'marketplace-npm-package',
        packageName: `@ai-office/a8-${name}`,
        version: '1.0.0',
        registry: 'https://registry.example.com',
        ...(derived ? { derivedCoordinates: true } : {}),
        marketplace: { itemId: `a8-${name}`, listKind: 'plugins', itemKind: 'plugin', name, sourceUrl: listingPath },
      });

      // Every arm installs. That is the whole re-shape.
      expect(result.ok).toBe(true);
      const mismatch = result.diagnostics.find(diagnostic => diagnostic.code === 'plugin.install.derived_repository_mismatch');
      expect(!!mismatch).toBe(warns);
      if (mismatch) {
        expect(mismatch.severity).toBe('warning');
        expect(mismatch.details).toMatchObject({
          declaredRepository: 'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
          listingPath,
        });
      }
    }
  });

  it('reports blocked entries for a native plugin.json that declares an unsupported capability directly', async () => {
    const localPlugin = createSkillBundle('native-unsupported');
    const raw = JSON.parse(readFileSync(join(localPlugin, 'plugin.json'), 'utf-8'));
    raw.capabilities.push({
      kind: 'unsupported',
      id: 'legacy-widget',
      unsupported: { externalKind: 'legacy-widget', reasonCode: 'plugin.unsupported.legacy_widget' },
    });
    writeFileSync(join(localPlugin, 'plugin.json'), JSON.stringify(raw, null, 2));
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    expect(result.detectedFormat).toBe('nessy');
    expect(result.compatibility).toEqual({
      format: 'nessy',
      state: 'partial',
      supportedKinds: ['skill'],
      deferred: [],
      blocked: [{ externalKind: 'legacy-widget', reasonCode: 'plugin.unsupported.legacy_widget' }],
    });
  });

  it('installs npm-backed legacy Nessy extension packages as native plugins', async () => {
    const bundle = createLegacyNessyExtensionBundle('nessy-default-extension');
    const archive = await createArchiveFromDirectory(bundle, 'nessy-default-extension.tgz');
    const archiveBytes = readFileSync(archive);
    const integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
    const service = createService(routeFetch({
      'https://registry.example.com/%40ai-office%2Fnessy-extension-nestor-nessy-default-extension': Response.json({
        versions: {
          '1.0.7': {
            dist: {
              tarball: 'https://registry.example.com/nessy-default-extension-1.0.7.tgz',
              integrity,
            },
          },
        },
      }),
      'https://registry.example.com/nessy-default-extension-1.0.7.tgz': binaryResponse(archiveBytes),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-npm-package',
      packageName: '@ai-office/nessy-extension-nestor-nessy-default-extension',
      version: '1.0.7',
      registry: 'https://registry.example.com',
      marketplace: {
        itemId: 'nestor-nessy-cli-extensions-nessy-default-extension-9bcdc6a2',
        listKind: 'plugins',
        itemKind: 'mcp',
        name: 'nessy-default-extension',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('nessy-default-extension');
    expect(result.manifest?.compatibility?.rawExternalKind).toBe('nessy-extension');
    expect(capabilitiesOfKind(result, 'mcp')[0]?.mcp).toEqual(expect.objectContaining({
      serverName: 'dpWiki',
      transport: 'stdio',
      command: 'dp',
      args: ['ai', 'mcp', 'wixie'],
    }));
  });

  it('rejects npm packages when integrity does not match', async () => {
    const bundle = createCodexBundle('npm-integrity');
    const archive = await createArchiveFromDirectory(bundle, 'npm-integrity.tgz');
    const archiveBytes = readFileSync(archive);
    const service = createService(routeFetch({
      'https://registry.example.com/%40ai%2Fnpm-integrity': Response.json({
        versions: {
          '1.0.0': {
            dist: {
              tarball: 'https://registry.example.com/npm-integrity-1.0.0.tgz',
              integrity: 'sha512-invalid',
            },
          },
        },
      }),
      'https://registry.example.com/npm-integrity-1.0.0.tgz': binaryResponse(archiveBytes),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-npm-package',
      packageName: '@ai/npm-integrity',
      version: '1.0.0',
      registry: 'https://registry.example.com',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.integrity_mismatch');
  });

  it('verifies the published npm digest and refuses one it cannot evaluate', async () => {
    // A9. `verifyIntegrity` used to `return undefined` for any algorithm
    // outside sha256/384/512, and `undefined` is the caller's "no problem
    // found" — so `md5-…`, and even a CORRECT `sha1-…` digest, passed silently.
    // Probed anonymously against the real registry 2026-07-31: all 8 published
    // versions of @ai-office/nessy-extension-nestor-nessy-default-extension
    // carry both `dist.integrity` (sha512) and `dist.shasum` (sha1 hex), so a
    // digest we cannot read is a metadata fault, not a reason to skip the check.
    const cases: Array<{
      id: string;
      dist: (bytes: Buffer) => Record<string, string>;
      ok: boolean;
      code?: string;
      algorithm?: string;
    }> = [
      {
        id: 'digest-md5',
        dist: bytes => ({ integrity: `md5-${createHash('md5').update(bytes).digest('base64')}` }),
        ok: false,
        code: 'plugin.install.integrity_algorithm_unsupported',
        algorithm: 'md5',
      },
      {
        id: 'digest-sha1',
        dist: bytes => ({ integrity: `sha1-${createHash('sha1').update(bytes).digest('base64')}` }),
        ok: false,
        code: 'plugin.install.integrity_algorithm_unsupported',
        algorithm: 'sha1',
      },
      {
        id: 'digest-shasum-ok',
        dist: bytes => ({ shasum: createHash('sha1').update(bytes).digest('hex') }),
        ok: true,
      },
      {
        id: 'digest-shasum-bad',
        dist: () => ({ shasum: '0'.repeat(40) }),
        ok: false,
        code: 'plugin.install.integrity_mismatch',
        algorithm: 'sha1',
      },
      {
        id: 'digest-absent',
        dist: () => ({}),
        ok: true,
        code: 'plugin.install.integrity_unverified',
      },
    ];

    for (const testCase of cases) {
      const bundle = createCodexBundle(testCase.id);
      const archive = await createArchiveFromDirectory(bundle, `${testCase.id}.tgz`);
      const archiveBytes = readFileSync(archive);
      const tarball = `https://registry.example.com/${testCase.id}-1.0.0.tgz`;
      const service = createService(routeFetch({
        [`https://registry.example.com/%40ai%2F${testCase.id}`]: Response.json({
          versions: { '1.0.0': { dist: { tarball, ...testCase.dist(archiveBytes) } } },
        }),
        [tarball]: binaryResponse(archiveBytes),
      }));

      const result = await acquire(service, {
        kind: 'marketplace-npm-package',
        packageName: `@ai/${testCase.id}`,
        version: '1.0.0',
        registry: 'https://registry.example.com',
      });

      expect({ id: testCase.id, ok: result.ok }).toEqual({ id: testCase.id, ok: testCase.ok });
      if (testCase.code) {
        const diagnostic = result.diagnostics.find(entry => entry.code === testCase.code);
        expect({ id: testCase.id, found: Boolean(diagnostic) }).toEqual({ id: testCase.id, found: true });
        if (testCase.algorithm) expect(diagnostic?.details?.algorithm).toBe(testCase.algorithm);
      }
    }
  });

  it('installs self-contained GitLab marketplace skills as skill-only plugins', async () => {
    const requestedUrls: string[] = [];
    const service = createService(asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return new Response('# Review\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });
    }));

    const result = await acquire(service, {
      kind: 'marketplace-gitlab-skill',
      url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/review/SKILL.md',
      ref: 'main',
      path: 'skills/review/SKILL.md',
      pluginId: 'marketplace-skill-review',
      skillSlug: 'review',
      name: 'Review',
    });

    expect(requestedUrls).toEqual([
      'https://gitlab.example.com/group/repo/-/raw/main/skills/review/SKILL.md',
    ]);
    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('marketplace-skill-review');
    expect(capabilitiesOfKind(result, 'skill')[0]?.skill.slug).toBe('review');
    expect(existsSync(skillPath(result))).toBe(true);
  });

  it('downloads internal GitLab marketplace skills through GitLab API with DP auth headers', async () => {
    const requested: Array<{ url: string; privateToken?: string | null; authorization?: string | null }> = [];
    const authUrls: string[] = [];
    const artifactAuthProvider: PluginArtifactAuthProvider = {
      async fetchArtifact(url, fetchImpl) {
        authUrls.push(url.toString());
        return fetchImpl(url, { headers: { 'PRIVATE-TOKEN': 'dp-token' } });
      },
    };
    const service = createService(asFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requested.push({
        url: url.toString(),
        privateToken: headers.get('PRIVATE-TOKEN'),
        authorization: headers.get('Authorization'),
      });
      return new Response('---\nname: Review\n---\n# Review\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }), { artifactAuthProvider });

    const result = await acquire(service, {
      kind: 'marketplace-gitlab-skill',
      url: 'https://gitlab.tcsbank.ru/group/repo/-/blob/main/skills/review/SKILL.md',
      ref: 'main',
      path: 'skills/review/SKILL.md',
      pluginId: 'marketplace-skill-review',
      skillSlug: 'review',
      name: 'Review',
    });

    expect(result.ok).toBe(true);
    expect(authUrls).toEqual([
      'https://gitlab.tcsbank.ru/api/v4/projects/group%2Frepo/repository/files/skills%2Freview%2FSKILL.md/raw?ref=main',
    ]);
    expect(requested).toEqual([
      {
        url: 'https://gitlab.tcsbank.ru/api/v4/projects/group%2Frepo/repository/files/skills%2Freview%2FSKILL.md/raw?ref=main',
        privateToken: 'dp-token',
        authorization: null,
      },
    ]);
  });

  it('uses the injected DP broker and preserves OAuth GitLab headers', async () => {
    const fake = createFakeDp({ loggedIn: true, token: 'oauth_dp_test' });
    const delegate = createDpSessionBroker({
      resolveBinary: () => fake.binary,
    });
    let brokerCallbackActive = false;
    const broker: DpSessionBroker = {
      ...delegate,
      async withAccessToken(operation, options) {
        return delegate.withAccessToken(async (token) => {
          brokerCallbackActive = true;
          try {
            return await operation(token);
          } finally {
            brokerCallbackActive = false;
          }
        }, options);
      },
    };
    let authenticatedFetchObserved = false;
    const service = createService(asFetch(async (_url, init) => {
      expect(brokerCallbackActive).toBe(true);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer oauth_dp_test');
      expect(headers.get('PRIVATE-TOKEN')).toBeNull();
      authenticatedFetchObserved = true;
      return new Response('---\nname: Review\n---\n# Review\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }), {
      dpSessionBroker: broker,
    });

    const result = await acquire(service, {
      kind: 'marketplace-gitlab-skill',
      url: 'https://gitlab.tcsbank.ru/group/repo/-/blob/main/skills/review/SKILL.md',
      ref: 'main',
      path: 'skills/review/SKILL.md',
      pluginId: 'marketplace-skill-review',
      skillSlug: 'review',
      name: 'Review',
    });

    expect(result.ok).toBe(true);
    expect(authenticatedFetchObserved).toBe(true);
  });

  it('rejects GitLab marketplace skills when GitLab returns an HTML login page', async () => {
    const service = createService(asFetch(async () => new Response('<!DOCTYPE html><form action="/users/auth/devplatform"></form>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })));

    const result = await acquire(service, {
      kind: 'marketplace-gitlab-skill',
      url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/whiteboard/SKILL.md',
      pluginId: 'marketplace-skill-whiteboard',
      skillSlug: 'whiteboard',
      name: 'whiteboard',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.gitlab_skill_unexpected_html');
  });

  it('rejects single-file GitLab skills with unavailable relative references', async () => {
    const service = createService(asFetch(async () => new Response('# Review\n\nSee [guide](guide.md).\n', {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    })));

    const result = await acquire(service, {
      kind: 'marketplace-gitlab-skill',
      url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/review/SKILL.md',
      pluginId: 'marketplace-skill-review',
      skillSlug: 'review',
      name: 'Review',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.gitlab_skill_references_not_available');
  });

  it('installs multi-file market skills from the v2 per-file snapshot with digest verification', async () => {
    const skillMd = Buffer.from('# Review\n\nSee [runner](scripts/run.sh).\n');
    const script = Buffer.from('#!/bin/sh\necho ok\n');
    const sha = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const listing = {
      files: [
        { path: 'SKILL.md', size: skillMd.length, digest: sha(skillMd), executable: false, downloadUrl: '/v2/skills/skl_1/snapshots/snp_1/content?path=SKILL.md' },
        { path: 'scripts/run.sh', size: script.length, digest: sha(script), executable: true, downloadUrl: '/v2/skills/skl_1/snapshots/snp_1/content?path=scripts%2Frun.sh' },
      ],
    };
    const requestedUrls: string[] = [];
    const service = createService(asFetch(async (url: string | URL | Request) => {
      const requested = url.toString();
      requestedUrls.push(requested);
      if (requested.includes('/files')) {
        return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const bytes = requested.includes('run.sh') ? script : skillMd;
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }));

    const result = await acquire(service, {
      kind: 'marketplace-skill-files',
      filesUrl: 'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/files',
      pluginId: 'marketplace-skill-review',
      skillSlug: 'review',
      name: 'Review',
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('marketplace-skill-review');
    // Every file request stays on the market API base (the /api prefix is
    // NOT lost when resolving the /v2/... downloadUrl).
    expect(requestedUrls.filter(url => url.includes('/content?'))).toEqual([
      'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/content?path=SKILL.md',
      'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/content?path=scripts%2Frun.sh',
    ]);
  });

  it('takes a market skill in ONE archive request instead of the listing plus one per file', async () => {
    // F4. `downloadMarketplaceSkillArchive` landed with a definition and its own
    // client test and NO production caller, so every market skill install still
    // paid 1 listing + N file requests. Driven through the production stager
    // (`PluginManagementServiceV2.install`).
    //
    // Shapes measured live 2026-07-31 on `skl_v1_225cfdef…`: the release's
    // `artifact.archive.digest`, the `archive.zip` ETag and sha256 of the
    // 84899-byte body are the same hex, the archive is rooted AT the skill
    // (`SKILL.md` at top, 6 entries, no `manifest.json`) and carries unix modes,
    // and that skill's tree is 6 files — so 7 requests become 1.
    const { archive, digest } = whiteboardArchive();

    // Positive control that this stub CAN still produce the N+1 shape: the same
    // routes serve the listing and the per-file content, and the second half of
    // this test takes them.
    const marketFetch = (release: () => Response) => {
      const requested: string[] = [];
      return {
        requested,
        fetchImpl: asFetch(async (url: string | URL | Request) => {
          const target = url.toString();
          requested.push(target);
          if (target.includes('/releases/latest')) return release();
          if (target.endsWith('/archive.zip')) {
            return new Response(archive, {
              status: 200,
              headers: { 'content-type': 'application/zip', etag: `"${digest}"` },
            });
          }
          if (target.includes('/files')) return Response.json({ files: whiteboardListing() });
          return new Response(whiteboardFiles[pathOf(target)] ?? Buffer.alloc(0), { status: 200 });
        }),
      };
    };
    const release = (withArchive: boolean) => Response.json({
      skillId: 'skl_1',
      snapshotId: 'snp_1',
      artifactId: 'art_1',
      artifact: {
        skillId: 'skl_1',
        snapshotId: 'snp_1',
        artifactId: 'art_1',
        lifecycle: 'active',
        ...(withArchive
          ? {
            archive: {
              digest: `sha256:${digest}`,
              size: archive.byteLength,
              mediaType: 'application/zip',
              downloadPath: '/v2/skills/skl_1/artifacts/art_1/download',
            },
          }
          : {}),
      },
    });
    const source = {
      kind: 'marketplace-skill-files' as const,
      filesUrl: 'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/files',
      pluginId: 'marketplace-skill-whiteboard',
      skillSlug: 'whiteboard',
      name: 'Whiteboard',
    };

    const archived = marketFetch(() => release(true));
    const one = createManagedService(archived.fetchImpl, 'f4-archive');
    const installed = await one.service.install(source);

    expect(installed.ok).toBe(true);
    // THE row: one artifact request, and it is the archive. Not the listing,
    // and not one request per file.
    expect(archived.requested.filter(url => url.endsWith('/archive.zip')))
      .toEqual(['https://market.example.com/api/v1/skills/skl_1/archive.zip']);
    expect(archived.requested.filter(url => url.includes('/files') || url.includes('/content?'))).toEqual([]);
    // The digest came from the release, which is a SEPARATE response from the
    // archive — so it pins which artifact arrived, not merely that the transfer
    // was intact.
    expect(archived.requested.filter(url => url.includes('/releases/latest')))
      .toEqual(['https://market.example.com/api/v2/skills/skl_1/releases/latest']);

    const entry = (await one.store.readInstalledRegistry()).plugins[0]!;
    expect(entry.origin.provenance).toMatchObject({ snapshotId: 'snp_1', artifactId: 'art_1' });
    // The whole tree arrived, nesting and the executable bit included.
    const skillRoot = join(one.store.cachePathFor(entry.cacheRef), 'skills', 'whiteboard');
    expect(readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8')).toBe('# Whiteboard\n');
    expect(readFileSync(join(skillRoot, 'scripts', 'lib', 'render.py'), 'utf-8')).toBe('print("ok")\n');
    expect(statSync(join(skillRoot, 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(statSync(join(skillRoot, 'scripts', 'lib', 'render.py')).mode & 0o111).toBe(0);

    // Control: a market that names no archive still installs, over the per-file
    // listing — 1 + N requests on the very same stub.
    const perFile = marketFetch(() => release(false));
    const many = createManagedService(perFile.fetchImpl, 'f4-per-file');

    expect((await many.service.install(source)).ok).toBe(true);
    expect(perFile.requested.filter(url => url.endsWith('/archive.zip'))).toEqual([]);
    expect(perFile.requested.filter(url => url.includes('/content?')).length).toBe(whiteboardListing().length);
  });

  it('refuses a market skill archive that fails its digest, escapes staging, or has no SKILL.md — and never falls back to N+1', async () => {
    // F4's failure half. A fetched archive that does not verify is a REFUSAL,
    // not a quiet downgrade to the per-file path: otherwise anyone able to
    // corrupt the archive response silently buys back the N+1 shape.
    const good = whiteboardArchive();
    const traversal = zipSync({ '../escape.md': strToU8('evil\n') });
    const noEntrypoint = zipSync({ 'README.md': strToU8('# Nope\n') });
    const cases: Array<{ label: string; body: Uint8Array; digest: string; expectCode: string }> = [
      {
        label: 'digest mismatch',
        body: good.archive,
        digest: 'f'.repeat(64),
        expectCode: 'plugin.install.skill_archive_fetch_failed',
      },
      {
        // Refused by the extractor as a whole. Measured: yauzl's own
        // `validateFileName` rejects the `..` segment before the entry is
        // emitted, so this case cannot single out `isUnsafeArchivePath` /
        // `assertPathInside` — what it pins is that a traversal-shaped archive
        // installs NOTHING and does not reopen the per-file path.
        label: 'path traversal',
        body: traversal,
        digest: sha256Hex(traversal),
        expectCode: 'plugin.install.skill_archive_fetch_failed',
      },
      {
        label: 'no entrypoint',
        body: noEntrypoint,
        digest: sha256Hex(noEntrypoint),
        expectCode: 'plugin.install.skill_files_entrypoint_missing',
      },
    ];

    for (const { label, body, digest, expectCode } of cases) {
      const requested: string[] = [];
      const { service, store } = createManagedService(asFetch(async (url: string | URL | Request) => {
        const target = url.toString();
        requested.push(target);
        if (target.includes('/releases/latest')) {
          return Response.json({
            skillId: 'skl_1',
            snapshotId: 'snp_1',
            artifactId: 'art_1',
            artifact: {
              skillId: 'skl_1',
              snapshotId: 'snp_1',
              artifactId: 'art_1',
              archive: { digest: `sha256:${digest}`, downloadPath: '/v2/skills/skl_1/artifacts/art_1/download' },
            },
          });
        }
        if (target.endsWith('/archive.zip')) {
          return new Response(body, { status: 200, headers: { 'content-type': 'application/zip' } });
        }
        if (target.includes('/files')) return Response.json({ files: whiteboardListing() });
        return new Response(whiteboardFiles[pathOf(target)] ?? Buffer.alloc(0), { status: 200 });
      }), `f4-refusal-${label.replace(/\s+/g, '-')}`);

      const result = await service.install({
        kind: 'marketplace-skill-files',
        filesUrl: 'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/files',
        pluginId: 'marketplace-skill-whiteboard',
        skillSlug: 'whiteboard',
        name: 'Whiteboard',
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(expectCode);
      expect(requested.filter(url => url.includes('/files') || url.includes('/content?'))).toEqual([]);
      expect((await store.readInstalledRegistry()).plugins).toEqual([]);
    }
  });

  it('records the immutable snapshot a market skill install took, and says so when it cannot', async () => {
    // F3. `getMarketplaceSkillSnapshot` had zero production callers, so an
    // installed market skill carried no revision identity and could never be
    // told stale. Driven through the PRODUCTION stager: the only production
    // `stageInstall` / `normalizeStagedInstall` caller is
    // `PluginManagementServiceV2`, so a row whose effect must reach the
    // installed record is driven from there rather than from `acquire`.
    const skillMd = Buffer.from('# Review\n');
    const digest = `sha256:${createHash('sha256').update(skillMd).digest('hex')}`;
    const releasesUrl = 'https://market.example.com/api/v2/skills/skl_1/releases/latest';
    // Field names and shape taken from the live endpoint, probed anonymously
    // 2026-07-31 on skl_v1_225cfdef…: contentDigest is the SNAPSHOT hash and
    // artifact.archive.digest is the archive body hash — they differ.
    const release = {
      skillId: 'skl_1',
      snapshotId: 'snp_1',
      artifactId: 'art_1',
      sourceCommit: '3123b04834ac645441d52a44e991de451919fbdf',
      artifact: {
        skillId: 'skl_1',
        snapshotId: 'snp_1',
        artifactId: 'art_1',
        contentDigest: `sha256:${'d'.repeat(64)}`,
        lifecycle: 'active',
      },
    };
    const listing = {
      files: [{ path: 'SKILL.md', size: skillMd.length, digest, downloadUrl: '/v2/skills/skl_1/snapshots/snp_1/content?path=SKILL.md' }],
    };
    const marketFetch = (releaseResponse: () => Response) => asFetch(async (url: string | URL | Request) => {
      const requested = url.toString();
      if (requested === releasesUrl) return releaseResponse();
      if (requested.includes('/files')) {
        return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(skillMd, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    });
    const source = {
      kind: 'marketplace-skill-files' as const,
      filesUrl: 'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/files',
      pluginId: 'marketplace-skill-review',
      skillSlug: 'review',
      name: 'Review',
    };

    const { service, store } = createManagedService(
      marketFetch(() => Response.json(release)),
      'recorded',
    );
    const installed = await service.install(source);

    expect(installed.ok).toBe(true);
    expect((await store.readInstalledRegistry()).plugins[0]?.origin.provenance).toMatchObject({
      snapshotId: 'snp_1',
      artifactId: 'art_1',
      contentDigest: `sha256:${'d'.repeat(64)}`,
      sourceCommit: '3123b04834ac645441d52a44e991de451919fbdf',
      snapshotLifecycle: 'active',
    });

    // A market that cannot name a release still installs — but not silently.
    const missing = createManagedService(
      marketFetch(() => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })),
      'unrecorded',
    );
    const withoutSnapshot = await missing.service.install(source);

    expect(withoutSnapshot.ok).toBe(true);
    expect(withoutSnapshot.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.install.skill_snapshot_unrecorded');
    expect((await missing.store.readInstalledRegistry()).plugins[0]?.origin.provenance?.snapshotId)
      .toBeUndefined();
  });

  it('fails closed on market snapshot digest mismatch, unsafe paths and foreign origins', async () => {
    const bytes = Buffer.from('# Review\n');
    const sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const cases: Array<{ listing: unknown; expectCode: string }> = [
      {
        listing: { files: [{ path: 'SKILL.md', digest: `sha256:${'0'.repeat(64)}`, downloadUrl: '/v2/x/content?path=SKILL.md' }] },
        expectCode: 'plugin.install.skill_files_digest_mismatch',
      },
      {
        listing: { files: [{ path: '../escape.md', digest: sha, downloadUrl: '/v2/x/content?path=SKILL.md' }] },
        expectCode: 'plugin.install.skill_files_unsafe_path',
      },
      {
        listing: { files: [{ path: 'SKILL.md', digest: sha, downloadUrl: 'https://evil.example.com/steal' }] },
        expectCode: 'plugin.install.skill_files_foreign_origin',
      },
      {
        listing: { files: [{ path: 'README.md', digest: sha, downloadUrl: '/v2/x/content?path=README.md' }] },
        expectCode: 'plugin.install.skill_files_entrypoint_missing',
      },
    ];

    for (const { listing, expectCode } of cases) {
      const service = createService(asFetch(async (url: string | URL | Request) => {
        if (url.toString().includes('/files')) {
          return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }));
      const result = await acquire(service, {
        kind: 'marketplace-skill-files',
        filesUrl: 'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/files',
        pluginId: 'marketplace-skill-review',
        skillSlug: 'review',
        name: 'Review',
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(expectCode);
    }
  });

  it('reports a market skill install to the marketplace, only to the marketplace, and never fails on it', async () => {
    // F5. `reportSkillsRegistryInstallation` landed with zero production
    // callers, so every desktop install stayed invisible to the marketplace's
    // own counters. Measured 2026-07-31 by the client commit: an ANONYMOUS POST
    // answers 401 without counting, so the bearer is the whole point — and
    // `filesUrl` comes from a catalog row, so the host it names must not be
    // able to attract that bearer.
    const skillMd = Buffer.from('# Review\n');
    const digest = `sha256:${createHash('sha256').update(skillMd).digest('hex')}`;
    const posts: Array<{ url: string; method?: string; authorization: string | null }> = [];
    const marketFetch = (host: string, reportResponse: () => Response) => asFetch(
      async (url: string | URL | Request, init?: RequestInit) => {
        const requested = url.toString();
        if ((init?.method ?? 'GET') === 'POST') {
          posts.push({
            url: requested,
            ...(init?.method ? { method: init.method } : {}),
            authorization: new Headers(init?.headers).get('authorization'),
          });
          return reportResponse();
        }
        if (requested.includes('/releases/latest')) {
          return Response.json({ skillId: 'skl_1', snapshotId: 'snp_1', artifactId: 'art_1' });
        }
        if (requested.includes('/files')) {
          return Response.json({
            files: [{ path: 'SKILL.md', digest, downloadUrl: `${host}/v2/skills/skl_1/snapshots/snp_1/content?path=SKILL.md` }],
          });
        }
        return new Response(skillMd, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      },
    );
    const sourceFor = (host: string) => ({
      kind: 'marketplace-skill-files' as const,
      filesUrl: `${host}/v2/skills/skl_1/snapshots/snp_1/files`,
      pluginId: 'marketplace-skill-review',
      skillSlug: 'review',
      name: 'Review',
    });
    // Never the real credentials file: a test must have no real JWT to leak.
    const marketplaceAccessToken = () => 'test-jwt';

    const market = 'https://skills-market.t-tech.team/api';
    const counted = createManagedService(
      marketFetch(market, () => Response.json({ counted: true, installCount: 3 })),
      'f5-counted',
      { installService: { marketplaceAccessToken } },
    );
    expect((await counted.service.install(sourceFor(market))).ok).toBe(true);

    expect(posts).toEqual([{
      url: 'https://skills-market.t-tech.team/api/v2/registry/entries/agent-skill/skl_1/installations',
      method: 'POST',
      authorization: 'Bearer test-jwt',
    }]);
    // The token is in the header and nowhere else.
    expect(posts[0]?.url).not.toContain('test-jwt');

    // A registry on another host gets no report and, above all, no bearer.
    posts.length = 0;
    const foreign = 'https://registry.example.com/api';
    const elsewhere = createManagedService(
      marketFetch(foreign, () => Response.json({ counted: true, installCount: 1 })),
      'f5-foreign',
      { installService: { marketplaceAccessToken } },
    );
    expect((await elsewhere.service.install(sourceFor(foreign))).ok).toBe(true);
    expect(posts).toEqual([]);

    // A counter that is down cannot take the install with it.
    posts.length = 0;
    const brokenCounter = createManagedService(
      marketFetch(market, () => { throw new Error('counter offline'); }),
      'f5-broken',
      { installService: { marketplaceAccessToken } },
    );
    const stillInstalled = await brokenCounter.service.install(sourceFor(market));
    expect(stillInstalled.ok).toBe(true);
    expect(stillInstalled.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(posts).toHaveLength(1);
  });

  it('installs a Codex plugin archive pinned to a GitHub commit', async () => {
    const bundle = createCodexBundle('honey');
    const archive = await createArchiveFromDirectory(bundle, 'honey-main.tgz');
    const commit = '3e530617e7ddee634b943ba99aa3aa08185cf0fd';
    const service = createService(routeFetch({
      [`https://github.com/Green-PT/honey-for-devs/archive/${commit}.tar.gz`]: binaryResponse(readFileSync(archive)),
    }));

    const result = await acquire(service, {
      kind: 'repository',
      repositoryUrl: 'https://github.com/Green-PT/honey-for-devs',
      ref: commit,
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('honey');
    expect(result.manifest?.compatibility?.rawExternalKind).toBe('codex-plugin');
  });

  it('sends DP auth headers for allowlisted GitLab repository artifact fetches only', async () => {
    const internalBundle = createCodexBundle('internal-repository');
    const internalArchive = await createArchiveFromDirectory(internalBundle, 'internal-repository-main.tgz');
    const externalBundle = createCodexBundle('external-repository');
    const externalArchive = await createArchiveFromDirectory(externalBundle, 'external-repository-main.tgz');
    const requests: Array<{ url: string; privateToken?: string | null; authorization?: string | null }> = [];
    const authUrls: string[] = [];
    const artifactAuthProvider: PluginArtifactAuthProvider = {
      async fetchArtifact(url, fetchImpl) {
        authUrls.push(url.toString());
        return fetchImpl(
          url,
          url.hostname === 'gitlab.tcsbank.ru'
            ? { headers: { 'PRIVATE-TOKEN': 'dp-token' } }
            : undefined,
        );
      },
    };
    const routes: Record<string, Response> = {
      'https://gitlab.tcsbank.ru/api/v4/projects/group%2Finternal-repository': Response.json({ default_branch: 'main' }),
      'https://gitlab.tcsbank.ru/api/v4/projects/group%2Finternal-repository/repository/archive.tar.gz?sha=main': binaryResponse(readFileSync(internalArchive)),
      'https://gitlab.example.com/api/v4/projects/group%2Fexternal-repository': Response.json({ default_branch: 'main' }),
      'https://gitlab.example.com/api/v4/projects/group%2Fexternal-repository/repository/archive.tar.gz?sha=main': binaryResponse(readFileSync(externalArchive)),
    };
    const service = createService(asFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: url.toString(),
        privateToken: headers.get('PRIVATE-TOKEN'),
        authorization: headers.get('Authorization'),
      });
      const response = routes[url.toString()];
      return response?.clone() ?? new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }), { artifactAuthProvider });

    const internalResult = await acquire(service, {
      kind: 'repository',
      repositoryUrl: 'https://gitlab.tcsbank.ru/group/internal-repository',
    });
    const externalResult = await acquire(service, {
      kind: 'repository',
      repositoryUrl: 'https://gitlab.example.com/group/external-repository',
    });

    expect(internalResult.ok).toBe(true);
    expect(externalResult.ok).toBe(true);
    expect(authUrls).toEqual([
      'https://gitlab.tcsbank.ru/api/v4/projects/group%2Finternal-repository',
      'https://gitlab.tcsbank.ru/api/v4/projects/group%2Finternal-repository/repository/archive.tar.gz?sha=main',
      'https://gitlab.example.com/api/v4/projects/group%2Fexternal-repository',
      'https://gitlab.example.com/api/v4/projects/group%2Fexternal-repository/repository/archive.tar.gz?sha=main',
    ]);
    expect(requests).toEqual([
      {
        url: 'https://gitlab.tcsbank.ru/api/v4/projects/group%2Finternal-repository',
        privateToken: 'dp-token',
        authorization: null,
      },
      {
        url: 'https://gitlab.tcsbank.ru/api/v4/projects/group%2Finternal-repository/repository/archive.tar.gz?sha=main',
        privateToken: 'dp-token',
        authorization: null,
      },
      {
        url: 'https://gitlab.example.com/api/v4/projects/group%2Fexternal-repository',
        privateToken: null,
        authorization: null,
      },
      {
        url: 'https://gitlab.example.com/api/v4/projects/group%2Fexternal-repository/repository/archive.tar.gz?sha=main',
        privateToken: null,
        authorization: null,
      },
    ]);
  });

  it('installs a GitLab subdirectory through the archive API route and refuses a sign-in page', async () => {
    // A3. Probed anonymously 2026-07-31: the Rails WEB route
    // `…/-/archive/master/….tar.gz` answers 302 `text/html` → `/users/sign_in`,
    // and the tar extractor then reports a corrupt archive. Positive control on
    // the same host and minute: the API route answers 404 `application/json`.
    // The old fixture asserted only that PRIVATE-TOKEN was attached and pinned
    // the WEB URLs, so it could not fail the way production did.
    const repository = createNestedRepository('gitlab-subdir', 'plugins/toolkit');
    const archiveBytes = readFileSync(await createArchiveFromDirectory(repository, 'gitlab-subdir.tar.gz'));
    const apiArchiveUrl = 'https://gitlab.tcsbank.ru/api/v4/projects/group%2Fnested/repository/archive.tar.gz?sha=main&path=plugins%2Ftoolkit';
    const webArchiveUrl = 'https://gitlab.tcsbank.ru/group/nested/-/archive/main/nested-main.tar.gz';
    const signInPage = () => new Response(
      '<!DOCTYPE html>\n<html><body>You are being <a href="/users/sign_in">redirected</a>.</body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
    const service = createService(asFetch(async (url: string | URL | Request) => {
      const key = url.toString();
      if (key === apiArchiveUrl) return binaryResponse(archiveBytes);
      // Every other GitLab route on this host behaves the way the live one does.
      return signInPage();
    }));

    const result = await acquire(service, {
      kind: 'repository',
      repositoryUrl: 'https://gitlab.tcsbank.ru/group/nested',
      ref: 'main',
      subdirectory: 'plugins/toolkit',
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('gitlab-subdir');

    // The negative arm: the WEB route the code used to build.
    const webOnly = createService(asFetch(async (url: string | URL | Request) => (
      url.toString() === webArchiveUrl ? binaryResponse(archiveBytes) : signInPage()
    )));
    const refused = await acquire(webOnly, {
      kind: 'repository',
      repositoryUrl: 'https://gitlab.tcsbank.ru/group/nested',
      ref: 'main',
      subdirectory: 'plugins/toolkit',
    });

    expect(refused.ok).toBe(false);
    expect(refused.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.install.artifact_unexpected_html');
  });

  it('installs an archive whether the plugin is at the top of the archive or wrapped in a folder', async () => {
    // `plugin-marketplaces.md` § Zip archives (fetched 2026-08-24): "When you
    // build the zip, you can zip the plugin's contents directly or zip the plugin
    // folder itself. Claude Code looks for `.claude-plugin/` at the top of the
    // archive, then inside a single top-level folder, so both layouts install."
    const contentsAtTop = await createContentsArchive(createSkillBundle('layout-contents'), 'layout-contents.tgz');
    const folderWrapped = await createArchiveFromDirectory(createSkillBundle('layout-folder'), 'layout-folder.tgz');
    const service = createService(routeFetch({
      'https://market.example/layout-contents.tgz': binaryResponse(readFileSync(contentsAtTop)),
      'https://market.example/layout-folder.tgz': binaryResponse(readFileSync(folderWrapped)),
    }));

    const contents = await acquire(service, { kind: 'marketplace-url', url: 'https://market.example/layout-contents.tgz' });
    expect(contents.ok).toBe(true);
    expect(contents.manifest?.id).toBe('layout-contents');
    expect(existsSync(join(contents.staged.rawDirectory, 'plugin.json'))).toBe(true);

    const folder = await acquire(service, { kind: 'marketplace-url', url: 'https://market.example/layout-folder.tgz' });
    expect(folder.ok).toBe(true);
    expect(folder.manifest?.id).toBe('layout-folder');
    expect(existsSync(join(folder.staged.rawDirectory, 'plugin.json'))).toBe(true);
  });

  it('refuses an archive download that redirects to a non-public URL, and never fetches the refused hop', async () => {
    // `plugin-marketplaces.md` § Zip archives, `url` field (fetched 2026-08-24):
    // "Every redirect hop must satisfy the same rules, or Claude Code refuses the
    // download."
    const attempted: string[] = [];
    const service = createService(asFetch(async (url: string | URL | Request) => {
      const key = url.toString();
      attempted.push(key);
      if (key === 'https://market.example/redirector.tgz') {
        return new Response(null, { status: 302, headers: { location: 'http://market.example/evil.tgz' } });
      }
      return new Response('should not be fetched', { status: 500 });
    }));

    const result = await acquire(service, { kind: 'marketplace-url', url: 'https://market.example/redirector.tgz' });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.artifact_redirect_unsafe');
    // The http:// hop is refused BEFORE it is fetched.
    expect(attempted).toEqual(['https://market.example/redirector.tgz']);
  });

  it('follows a redirect to a public https archive and installs it', async () => {
    const archiveBytes = readFileSync(await createArchiveFromDirectory(createSkillBundle('redirected'), 'redirected.tgz'));
    const service = createService(asFetch(async (url: string | URL | Request) => {
      const key = url.toString();
      if (key === 'https://market.example/start.tgz') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example/real.tgz' } });
      }
      if (key === 'https://cdn.example/real.tgz') return binaryResponse(archiveBytes);
      return new Response('unexpected', { status: 500 });
    }));

    const result = await acquire(service, { kind: 'marketplace-url', url: 'https://market.example/start.tgz' });

    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('redirected');
  });

  it('drops artifact auth once a redirect leaves the archive URL\'s origin', async () => {
    // P2.103, `plugin-marketplaces.md`
    // #when-claude-code-skips-a-headershelper-command-or-drops-its-output
    // (fetched 2026-08-26): "**Redirect leaves the origin**: when a download is
    // redirected off the archive URL's origin, Claude Code drops the `headers`
    // values and command output of both the marketplace `url` source and the
    // plugin entry."
    //
    // The direction that was actually broken is the inbound one: the provider
    // decided per hop from that hop's own hostname, so an EXTERNAL archive URL
    // redirecting INTO the internal host had the user's token attached to a
    // request the archive's author chose. Kills removing the origin comparison.
    const archiveBytes = readFileSync(
      await createArchiveFromDirectory(createSkillBundle('inbound'), 'inbound.tgz'),
    );
    const authUrls: string[] = [];
    const artifactAuthProvider: PluginArtifactAuthProvider = {
      async fetchArtifact(url, fetchImpl, init) {
        authUrls.push(url.toString());
        return fetchImpl(url, { ...init, headers: { 'PRIVATE-TOKEN': 'dp-token' } });
      },
    };
    const seen: Array<{ url: string; privateToken: string | null }> = [];
    const service = createService(asFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const key = url.toString();
      seen.push({ url: key, privateToken: new Headers(init?.headers).get('PRIVATE-TOKEN') });
      if (key === 'https://market.example/start.tgz') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://gitlab.tcsbank.ru/internal/archive.tgz' },
        });
      }
      if (key === 'https://gitlab.tcsbank.ru/internal/archive.tgz') return binaryResponse(archiveBytes);
      return new Response('unexpected', { status: 500 });
    }), { artifactAuthProvider });

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://market.example/start.tgz',
    });

    expect(result.ok).toBe(true);
    // The provider is consulted for the ORIGINAL origin only.
    expect(authUrls).toEqual(['https://market.example/start.tgz']);
    expect(seen).toEqual([
      { url: 'https://market.example/start.tgz', privateToken: 'dp-token' },
      { url: 'https://gitlab.tcsbank.ru/internal/archive.tgz', privateToken: null },
    ]);
  });

  it('keeps artifact auth across a SAME-origin redirect', async () => {
    // POSITIVE CONTROL for the boundary: dropping auth unconditionally would
    // break the internal-GitLab archive the manual-redirect path exists to
    // serve. Kills replacing the origin comparison with "never authenticate a
    // hop after the first".
    const archiveBytes = readFileSync(
      await createArchiveFromDirectory(createSkillBundle('sameorigin'), 'sameorigin.tgz'),
    );
    const authUrls: string[] = [];
    const artifactAuthProvider: PluginArtifactAuthProvider = {
      async fetchArtifact(url, fetchImpl, init) {
        authUrls.push(url.toString());
        return fetchImpl(url, { ...init, headers: { 'PRIVATE-TOKEN': 'dp-token' } });
      },
    };
    const seen: Array<{ url: string; privateToken: string | null }> = [];
    const service = createService(asFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const key = url.toString();
      seen.push({ url: key, privateToken: new Headers(init?.headers).get('PRIVATE-TOKEN') });
      if (key === 'https://gitlab.tcsbank.ru/a/one.tgz') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://gitlab.tcsbank.ru/a/two.tgz' },
        });
      }
      if (key === 'https://gitlab.tcsbank.ru/a/two.tgz') return binaryResponse(archiveBytes);
      return new Response('unexpected', { status: 500 });
    }), { artifactAuthProvider });

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://gitlab.tcsbank.ru/a/one.tgz',
    });

    expect(result.ok).toBe(true);
    expect(authUrls).toEqual([
      'https://gitlab.tcsbank.ru/a/one.tgz',
      'https://gitlab.tcsbank.ru/a/two.tgz',
    ]);
    expect(seen.map(entry => entry.privateToken)).toEqual(['dp-token', 'dp-token']);
  });

  it('rejects archives with path traversal entries before commit', async () => {
    const archive = createTraversalArchive('package/../evil.txt');
    const service = createService(routeFetch({
      'https://market.example/traversal.tar': binaryResponse(archive),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://market.example/traversal.tar',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.archive_fetch_failed');
    expect(result.diagnostics.map(diagnostic => diagnostic.message).join('\n')).toContain('escape plugin staging directory');
  });

  it('rejects an artifact larger than the documented 256 MiB cap before buffering or writing it', async () => {
    // `plugin-marketplaces.md` § Zip archives (fetched 2026-08-24): "Claude Code
    // refuses archives larger than 256 MiB." One byte over is refused.
    const service = createService(routeFetch({
      'https://market.example/oversized.tgz': new Response('small', {
        status: 200,
        headers: {
          'content-length': String(256 * 1024 * 1024 + 1),
          'content-type': 'application/gzip',
        },
      }),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://market.example/oversized.tgz',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.artifact_too_large');
  });

  it('accepts an archive at the 256 MiB cap that the old 64 MiB cap would have refused', async () => {
    // The boundary the page draws: 256 MiB exactly is "not larger than", so it is
    // NOT refused as too large — it fails later on the body not being a real
    // archive, a different diagnostic. A declared length this size proves the cap
    // was raised from 64 MiB, since the old cap would have refused it up front.
    const service = createService(routeFetch({
      'https://market.example/atcap.tgz': new Response('not-a-real-archive', {
        status: 200,
        headers: {
          'content-length': String(256 * 1024 * 1024),
          'content-type': 'application/gzip',
        },
      }),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://market.example/atcap.tgz',
    });

    expect(result.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('plugin.install.artifact_too_large');
  });

  it('rejects an archive whose declared extracted size exceeds the staging limit', async () => {
    const service = createService(routeFetch({
      'https://market.example/tar-bomb.tar': binaryResponse(createTarHeader('package/large.bin', 256 * 1024 * 1024 + 1)),
    }));

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://market.example/tar-bomb.tar',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.archive_fetch_failed');
    expect(result.diagnostics.map(diagnostic => diagnostic.message).join('\n')).toContain('extraction limits');
  });

  it('rejects normalized archive bundles with symlinks escaping the bundle root', async () => {
    const bundle = createSkillBundle('archive-symlink');
    const pluginJsonPath = join(bundle, 'plugin.json');
    const outsideFile = join(tempDir, 'outside-plugin.json');
    const outsideBytes = readFileSync(pluginJsonPath);
    writeFileSync(outsideFile, outsideBytes);
    rmSync(pluginJsonPath);
    symlinkSync(outsideFile, pluginJsonPath);
    const archive = await createArchiveFromDirectory(bundle, 'archive-symlink.tgz');
    let adapterCalled = false;
    const service = createService(routeFetch({
      'https://market.example/archive-symlink.tgz': binaryResponse(readFileSync(archive)),
    }), {
      formatAdapters: [{
        id: 'must-not-run',
        detect() {
          adapterCalled = true;
          return true;
        },
        normalize() {
          throw new Error('unsafe raw bundle reached adapter');
        },
      }],
    });

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://market.example/archive-symlink.tgz',
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.install.bundle_symlink_unsafe',
    );
    expect(adapterCalled).toBe(false);
    expect(readFileSync(outsideFile)).toEqual(outsideBytes);
  });

  it('does not stage plain marketplace GitLab blobs as synthetic skills', async () => {
    const requestedUrls: string[] = [];
    const service = createService(asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return new Response('# README\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    }));

    const result = await acquire(service, {
      kind: 'marketplace-url',
      url: 'https://gitlab.example/group/repo/-/blob/main/README.md',
    });

    expect(result.ok).toBe(false);
    expect(requestedUrls).toEqual([
      'https://gitlab.example/group/repo/-/blob/main/README.md',
    ]);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.archive_fetch_failed');
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^plugin\\.install\\.gitlab_skill_/),
    ]));
  });

  // The V1 companion of this row — "stores project scope context for
  // marketplace skill installs" — asserted `enabledScopes[0]` on the V1
  // installed entry and a `.agents/skills` target path in the V1 projection
  // plan. Both are V1 concepts: V2 records activation as a policy target and
  // never copies a skill anywhere (`projection-candidates.ts` header), so the
  // behaviour now lives in `management-service-v2.test.ts`'s "uses global,
  // Workspace and private project policy targets" row instead.

  it('wraps agent-proposed sources with provenance and confirmation metadata', async () => {
    const service = createService(routeFetch({}));

    const result = await service.createInstallPlanFromAgentProposal({
      label: 'Agent suggested local plugin',
      rationale: 'Needed for this workspace',
      requestedScope: 'workspace',
      source: { kind: 'local-path', path: '/tmp/local-plugin' },
    });

    expect(result.source).toMatchObject({
      kind: 'agent-proposed',
      label: 'Agent suggested local plugin',
      source: { kind: 'local-path', path: '/tmp/local-plugin' },
      rationale: 'Needed for this workspace',
    });
    expect(result.plan.source.kind).toBe('agent-proposed');
    expect(result.plan.origin).toMatchObject({
      source: 'agent-proposed',
      localPath: '/tmp/local-plugin',
      provenance: {
        label: 'Agent suggested local plugin',
        rationale: 'Needed for this workspace',
      },
    });
    expect(result.confirmationSummary.join('\n')).toContain('Marketplace install commands are display metadata only');
  });

  it('wraps a standalone SKILL.md file into a staged minimal Nessy bundle installed into the immutable cache', async () => {
    const skillFile = join(tempDir, 'standalone-skill', 'SKILL.md');
    mkdirSync(join(tempDir, 'standalone-skill'), { recursive: true });
    writeFileSync(skillFile, '# Standalone Skill\n\nA standalone skill markdown file with no plugin manifest.\n');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: skillFile });

    expect(result.ok).toBe(true);
    // A local bundle carries no marketplace of its own; `PluginStoreV2` is what
    // assigns the `local` marketplace id at commit (`management-service-v2.test.ts`).
    expect(result.plan.origin.source).toBe('local-path');
    expect(result.plan.origin.marketplaceId).toBeUndefined();
    expect(result.manifest?.capabilities).toEqual([
      expect.objectContaining({
        kind: 'skill',
        skill: expect.objectContaining({ path: 'skills/standalone-skill/SKILL.md' }),
      }),
    ]);
    expect(existsSync(join(result.staged.normalizedDirectory, 'skills/standalone-skill/SKILL.md'))).toBe(true);
    expect(result.detectedFormat).toBe('nessy');
    expect(result.compatibility).toMatchObject({
      format: 'nessy',
      state: 'supported',
      supportedKinds: ['skill'],
    });
  });

  it('normalizes a declared setting into a setting capability with a supported compatibility report', async () => {
    const localPlugin = createSettingBundle('preview');
    const service = createService(routeFetch({}));

    const result = await acquire(service, { kind: 'local-path', path: localPlugin });

    expect(result.ok).toBe(true);
    expect(capabilitiesOfKind(result, 'setting')).toEqual([
      expect.objectContaining({
        id: 'enabled',
        setting: {
          key: 'preview.enabled',
          valueType: 'boolean',
          defaultValue: true,
        },
      }),
    ]);
    expect(result.compatibility?.state).toBe('supported');
    expect(result.compatibility?.supportedKinds).toContain('setting');
    expect(result.compatibility?.deferred.some(entry => entry.externalKind === 'setting')).toBe(false);
  });
});

async function createArchiveFromDirectory(sourceDirectory: string, name: string): Promise<string> {
  const archivePath = join(tempDir, name);
  await createTar({
    gzip: true,
    cwd: join(sourceDirectory, '..'),
    file: archivePath,
  }, [basename(sourceDirectory)]);
  return archivePath;
}

/**
 * The "zip the plugin's contents directly" layout (`plugin-marketplaces.md`
 * § Zip archives): the plugin root's entries sit at the archive top with no
 * wrapping folder, so nothing should be stripped. (`createArchiveFromDirectory`
 * above builds the other documented layout — the plugin folder itself.)
 */
async function createContentsArchive(sourceDirectory: string, name: string): Promise<string> {
  const archivePath = join(tempDir, name);
  await createTar({
    gzip: true,
    cwd: sourceDirectory,
    file: archivePath,
  }, readdirSync(sourceDirectory));
  return archivePath;
}

function routeFetch(routes: Record<string, Response>): typeof fetch {
  return asFetch(async (url: string | URL | Request) => {
    const response = routes[url.toString()];
    if (!response) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response.clone();
  });
}

/**
 * F4 fixture. The live shape of a market skill archive: rooted AT the skill
 * (`SKILL.md` at the top, no `manifest.json` — which is exactly why the MCPB
 * extractor cannot take it), nested directories, and unix modes carrying the
 * executable bit.
 */
const whiteboardFiles: Record<string, Buffer> = {
  'SKILL.md': Buffer.from('# Whiteboard\n'),
  'scripts/run.sh': Buffer.from('#!/bin/sh\necho ok\n'),
  'scripts/lib/render.py': Buffer.from('print("ok")\n'),
};

function whiteboardArchive(): { archive: Uint8Array; digest: string } {
  const archive = zipSync({
    'SKILL.md': whiteboardFiles['SKILL.md']!,
    'scripts/run.sh': [whiteboardFiles['scripts/run.sh']!, { os: 3, attrs: 0o100755 << 16 }],
    'scripts/lib/render.py': whiteboardFiles['scripts/lib/render.py']!,
  } as Zippable);
  return { archive, digest: sha256Hex(archive) };
}

function whiteboardListing(): Array<Record<string, unknown>> {
  return Object.entries(whiteboardFiles).map(([path, bytes]) => ({
    path,
    size: bytes.byteLength,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    executable: path.endsWith('.sh'),
    downloadUrl: `/v2/skills/skl_1/snapshots/snp_1/content?path=${encodeURIComponent(path)}`,
  }));
}

function pathOf(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function binaryResponse(bytes: Buffer): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/gzip' },
  });
}

function createTraversalArchive(entryName: string): Buffer {
  const content = Buffer.from('evil\n');
  const header = createTarHeader(entryName, content.length);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header.subarray(0, 512), content, padding, Buffer.alloc(1024, 0)]);
}

function createTarHeader(entryName: string, declaredSize: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(entryName, 0, 100, 'utf-8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(declaredSize.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return Buffer.concat([header, Buffer.alloc(1024, 0)]);
}

/**
 * The PRODUCTION install boundary. `PluginManagementServiceV2` reaches this same
 * acquisition service through the `PluginInstallStager` seam and then commits to
 * `PluginStoreV2`. A row whose effect must survive to the installed RECORD has
 * to be driven from here; `acquire` above stops before the commit.
 */
function createManagedService(
  fetchImpl: typeof fetch,
  namespace: string,
  options: {
    onPlanSource?: (source: PluginInstallSource) => void;
    installService?: Partial<PluginInstallServiceOptions>;
  } = {},
): { service: PluginManagementServiceV2; store: PluginStoreV2 } {
  const root = join(tempDir, namespace);
  const real = createService(fetchImpl, { baseTempDir: join(root, 'stages'), ...options.installService });
  const store = new PluginStoreV2({ rootDirectory: join(root, 'plugins') });
  return {
    store,
    service: installs.track(new PluginManagementServiceV2({
      store,
      policyStore: new CapabilityPolicyStore({ globalPath: join(root, 'capabilities.json') }),
      trustStore: new CapabilityTrustStore({ path: join(root, 'capability-trust.json') }),
      baseTempDir: join(root, 'stages'),
      installer: {
        createInstallPlanFromSource: source => {
          options.onPlanSource?.(source as PluginInstallSource);
          return real.createInstallPlanFromSource(source);
        },
        stageInstall: (plan, stageOptions) => real.stageInstall(plan, stageOptions),
        normalizeStagedInstall: staged => real.normalizeStagedInstall(staged),
      },
    })),
  };
}

/**
 * A broker that never leaves the process.
 *
 * `acquisition.ts` falls back to the MODULE-LEVEL `dpSessionBroker`
 * when none is injected, and that one is the real thing: it resolves the `dp`
 * binary, spawns it, and reads `~/.nessy/dp_auth_creds.json`. Any test whose
 * URL is on the DP-allowlisted host and that forgets to inject therefore
 * reaches the developer's real credentials — silently passing on a machine
 * that has them, and in CI spawning a `dp` that never answers. That is exactly
 * how `installs a GitLab subdirectory through the archive API route` timed out
 * at 5001 ms in CI while passing locally, and why the runner reported
 * `killed 1 dangling process`.
 *
 * Defaulting it here rather than per-test means no future test can make that
 * mistake; the one test that exercises the real broker still passes its own
 * through `options`.
 */
const HERMETIC_DP_BROKER: DpSessionBroker = {
  async probe() { return { state: 'ready', token: 'test-dp-token' } as never; },
  async ensure() { return { state: 'ready', token: 'test-dp-token' } as never; },
  async withAccessToken(operation) { return operation('test-dp-token'); },
  subscribe() { return () => {}; },
  cancel() { return false; },
  dispose() {},
};

function createService(fetchImpl: typeof fetch, options: Partial<PluginInstallServiceOptions> = {}): PluginInstallService {
  return new PluginInstallService({
    baseTempDir: join(tempDir, 'stages'),
    fetchImpl,
    now: () => 10_000,
    dpSessionBroker: HERMETIC_DP_BROKER,
    ...options,
  });
}

function asFetch(fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<unknown>): typeof fetch {
  return fetchImpl as unknown as typeof fetch;
}

function createSkillBundle(id: string): string {
  const localPlugin = join(tempDir, `${id}-plugin`);
  mkdirSync(join(localPlugin, 'skills', 'review'), { recursive: true });
  writeFileSync(join(localPlugin, 'skills', 'review', 'SKILL.md'), '# Review\n');
  writeFileSync(join(localPlugin, 'plugin.json'), JSON.stringify(manifest(id), null, 2));
  return localPlugin;
}

function createSettingBundle(id: string): string {
  const localPlugin = join(tempDir, `${id}-plugin`);
  mkdirSync(localPlugin, { recursive: true });
  writeFileSync(join(localPlugin, 'plugin.json'), JSON.stringify(settingManifest(id), null, 2));
  return localPlugin;
}

function createCodexBundle(id: string): string {
  const localPlugin = join(tempDir, `${id}-plugin`);
  mkdirSync(join(localPlugin, '.codex-plugin'), { recursive: true });
  mkdirSync(join(localPlugin, 'skills', 'review'), { recursive: true });
  mkdirSync(join(localPlugin, 'hooks'), { recursive: true });
  mkdirSync(join(localPlugin, 'assets'), { recursive: true });
  writeFileSync(join(localPlugin, 'skills', 'review', 'SKILL.md'), '# Review\n');
  writeFileSync(join(localPlugin, 'hooks', 'policy.js'), 'console.log("{}")\n');
  writeFileSync(join(localPlugin, 'assets', 'logo.svg'), '<svg />\n');
  writeFileSync(join(localPlugin, 'assets', 'schema.json'), '{}\n');
  writeFileSync(join(localPlugin, '.mcp.json'), JSON.stringify({
    mcpServers: {
      linear: {
        command: 'node',
        args: ['mcp.js'],
        env: { TOKEN: 'test' },
      },
    },
  }, null, 2));
  writeFileSync(join(localPlugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: id,
    version: '1.0.0',
    description: 'Codex style plugin',
    skills: './skills/',
    mcpServers: './.mcp.json',
    hooks: {
      pre_tool_use: [
        {
          id: 'policy',
          command: 'node hooks/policy.js',
          cwd: './hooks/',
        },
      ],
    },
    settings: {
      mode: {
        valueType: 'string',
        defaultValue: 'safe',
      },
    },
    assets: {
      schema: {
        path: './assets/schema.json',
        role: 'data',
      },
    },
    interface: {
      displayName: 'Codex Toolkit',
      logo: './assets/logo.svg',
    },
    apps: './.app.json',
  }, null, 2));
  return localPlugin;
}

/** A repository whose plugin bundle lives under a subdirectory, as `git-subdir` entries do. */
function createNestedRepository(id: string, subdirectory: string): string {
  const repositoryRoot = join(tempDir, `${id}-repo`);
  const bundleRoot = join(repositoryRoot, subdirectory);
  mkdirSync(join(bundleRoot, 'skills', 'review'), { recursive: true });
  writeFileSync(join(bundleRoot, 'skills', 'review', 'SKILL.md'), '# Review\n');
  writeFileSync(join(bundleRoot, 'plugin.json'), JSON.stringify(manifest(id), null, 2));
  writeFileSync(join(repositoryRoot, 'README.md'), '# Nested\n');
  return repositoryRoot;
}

function createLegacyNessyExtensionBundle(name: string): string {
  const localPlugin = join(tempDir, `${name}-plugin`);
  mkdirSync(localPlugin, { recursive: true });
  writeFileSync(join(localPlugin, 'nessy-extension.json'), JSON.stringify({
    name,
    version: '1.0.7',
    mcpServers: {
      dpWiki: {
        command: 'dp',
        args: ['ai', 'mcp', 'wixie'],
      },
    },
  }, null, 2));
  return localPlugin;
}

function manifest(id: string): NessyPluginManifest {
  return {
    schemaVersion: 1,
    kind: 'plugin',
    id,
    name: id,
    version: '1.0.0',
    capabilities: [
      {
        kind: 'skill',
        id: 'review',
        skill: {
          slug: 'review',
          path: 'skills/review/SKILL.md',
        },
      },
    ],
  };
}

function settingManifest(id: string, version = '1.0.0'): NessyPluginManifest {
  return {
    schemaVersion: 1,
    kind: 'plugin',
    id,
    name: id,
    version,
    capabilities: [
      {
        kind: 'setting',
        id: 'enabled',
        setting: {
          key: `${id}.enabled`,
          valueType: 'boolean',
          defaultValue: true,
        },
      },
    ],
  };
}


/**
 * The published version set of
 * `@ai-office/nessy-extension-nestor-nessy-default-extension`, read from
 * `artifactory.tcsbank.ru/api/npm/npm-all` on 2026-07-31. There is no plain
 * `1.0.9`, and `dist-tags.latest` is a build stamp.
 *
 * `dist` here carries the tarball only: this shape exists to exercise version
 * SELECTION. Every real version also publishes `integrity` (sha512) and
 * `shasum` (sha1 hex) — the digest matrix above covers those arms.
 */
const REAL_REGISTRY_METADATA_SHAPE = {
  'dist-tags': { beta: '1.0.3-beta.0', latest: '1.0.9-source.20260716152955.45c8ba6c7514' },
  versions: {
    '1.0.3-beta.0': { dist: { tarball: 'https://registry.example.com/stamped-1.0.3-beta.0.tgz' } },
    '1.0.3-beta.0.nessy.1': { dist: { tarball: 'https://registry.example.com/stamped-1.0.3-beta.0.nessy.1.tgz' } },
    '1.0.3-beta.0.nessy.1-nessy.1': { dist: { tarball: 'https://registry.example.com/stamped-a.tgz' } },
    '1.0.3-beta.0.nessy.1-nessy.2': { dist: { tarball: 'https://registry.example.com/stamped-b.tgz' } },
    '1.0.6': { dist: { tarball: 'https://registry.example.com/stamped-1.0.6.tgz' } },
    '1.0.7': { dist: { tarball: 'https://registry.example.com/stamped-1.0.7.tgz' } },
    '1.0.7-source.20260616140806.cb4784c35c5c': { dist: { tarball: 'https://registry.example.com/stamped-1.0.7-source.tgz' } },
    '1.0.9-source.20260716152955.45c8ba6c7514': { dist: { tarball: 'https://registry.example.com/stamped-1.0.9-source.tgz' } },
  },
};

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();
