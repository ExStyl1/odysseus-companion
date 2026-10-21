import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { PluginInstallService } from '../acquisition.ts';

/**
 * C3.260 — the ZIP half of the two repository routes this row built, and the
 * only part of the Azure DevOps work that is code rather than a URL shape.
 *
 * Azure DevOps publishes no tarball: its items route serves `$format=zip`, and
 * the page says so about that format in terms — *"Doesn't apply to zipped
 * content, which is always returned as a download"*
 * (`rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1`, fetched
 * 2026-09-12). Every other host in the acquisition pipeline serves a gzipped
 * tar, so this is the second archive format the repository path has ever had.
 *
 * **What could NOT be measured, and what this file does about it.**
 * `dev.azure.com` is blocked from this rig by the corporate proxy (503, an HTML
 * block page, 2026-09-12), so the zip's internal LAYOUT is unknown: the tar
 * hosts all wrap their content in exactly one directory, which is why `strip: 1`
 * is hard-coded for them, and guessing the same for a zip nobody has seen is
 * precisely the invention the read-don't-invent rule forbids. So the extractor
 * does not guess — `resolveExtractedRepositoryRoot` LOOKS — and the first two
 * cases below drive BOTH layouts through the real installer. Whichever one the
 * real host turns out to serve, it installs.
 */

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `c3260-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

const PLUGIN_JSON = JSON.stringify({
  schemaVersion: 1,
  kind: 'plugin',
  id: 'vault',
  name: 'Vault',
  version: '1.0.0',
  capabilities: [],
});

/**
 * A 40-hex ref, so the archive request has exactly ONE candidate: a non-sha ref
 * is tried as a branch and then as a tag, which would make every assertion about
 * "the zip we served" ambiguous.
 */
const COMMIT_REF = '0123456789abcdef0123456789abcdef01234567';

const AZURE_REPOSITORY_URL = 'https://dev.azure.com/contoso/tools/_git/plugins';

/** Stage an Azure DevOps repository install whose archive request answers `zip`. */
async function stageAzureZip(zip: Uint8Array) {
  const requested: string[] = [];
  const service = new PluginInstallService({
    baseTempDir: temporaryDirectory('staging'),
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      requested.push(String(input));
      return new Response(zip, { status: 200, headers: { 'content-type': 'application/zip' } });
    }) as unknown as typeof fetch,
    artifactAuthProvider: { fetchArtifact: (url, fetchImpl) => fetchImpl(url) },
  });
  const staged = await service.stageInstall(await service.createInstallPlanFromSource({
    kind: 'repository',
    repositoryUrl: AZURE_REPOSITORY_URL,
    ref: COMMIT_REF,
  }));
  temporaryRoots.push(staged.stageDirectory);
  return { staged, requested };
}

describe('repository zip acquisition (C3.260)', () => {
  it('installs a zip whose content is wrapped in one top-level directory', async () => {
    const { staged, requested } = await stageAzureZip(zipSync({
      'plugins-main/plugin.json': strToU8(PLUGIN_JSON),
      'plugins-main/README.md': strToU8('# vault\n'),
    } as Zippable));

    expect(requested).toHaveLength(1);
    expect(staged.diagnostics).toEqual([]);
    expect(readdirSync(staged.rawDirectory).sort()).toEqual(['README.md', 'plugin.json']);
    expect(JSON.parse(readFileSync(join(staged.rawDirectory, 'plugin.json'), 'utf-8')).id).toBe('vault');
  });

  it('installs a FLAT zip, where a hard-coded strip would have thrown the plugin away', async () => {
    const { staged } = await stageAzureZip(zipSync({
      'plugin.json': strToU8(PLUGIN_JSON),
      'commands/run.md': strToU8('# run\n'),
    } as Zippable));

    expect(staged.diagnostics).toEqual([]);
    expect(readdirSync(staged.rawDirectory).sort()).toEqual(['commands', 'plugin.json']);
    expect(existsSync(join(staged.rawDirectory, 'commands', 'run.md'))).toBe(true);
  });

  /**
   * The marker rule, which is the same signal `detectArchivePluginStrip` reads
   * for a tar. A plugin root at the TOP means the content was archived directly
   * even when several entries sit beside it, so the single-directory rule must
   * not get a chance to fire on one of them.
   */
  it('keeps the top level when a plugin root marker is on it', async () => {
    const { staged } = await stageAzureZip(zipSync({
      '.claude-plugin/plugin.json': strToU8(PLUGIN_JSON),
      'agents/reviewer.md': strToU8('---\nname: reviewer\n---\nreview\n'),
    } as Zippable));

    expect(staged.diagnostics).toEqual([]);
    expect(readdirSync(staged.rawDirectory).sort()).toEqual(['.claude-plugin', 'agents']);
  });

  it('applies a subdirectory inside whichever root it found', async () => {
    const zip = zipSync({
      'plugins-main/plugins/vault/plugin.json': strToU8(PLUGIN_JSON),
      'plugins-main/plugins/other/plugin.json': strToU8(PLUGIN_JSON),
      'plugins-main/README.md': strToU8('# monorepo\n'),
    } as Zippable);
    const service = new PluginInstallService({
      baseTempDir: temporaryDirectory('staging'),
      fetchImpl: (async () => new Response(zip, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      })) as unknown as typeof fetch,
      artifactAuthProvider: { fetchArtifact: (url, fetchImpl) => fetchImpl(url) },
    });
    const staged = await service.stageInstall(await service.createInstallPlanFromSource({
      kind: 'repository',
      repositoryUrl: AZURE_REPOSITORY_URL,
      ref: COMMIT_REF,
      subdirectory: 'plugins/vault',
    }));
    temporaryRoots.push(staged.stageDirectory);

    expect(staged.diagnostics).toEqual([]);
    expect(readdirSync(staged.rawDirectory)).toEqual(['plugin.json']);
  });

  /**
   * Containment is NOT re-written for this format: it goes through the same
   * `isUnsafeArchivePath` and `assertPathInside` the tar path and the market
   * skill path call, so no archive format reaching this pipeline can get a
   * weaker rule than another. The refusal is a typed diagnostic, not a thrown
   * stack.
   */
  it('refuses an entry that would escape the staging directory', async () => {
    const { staged } = await stageAzureZip(zipSync({
      'plugins-main/plugin.json': strToU8(PLUGIN_JSON),
      'plugins-main/../../escape.md': strToU8('owned\n'),
    } as Zippable));

    expect(staged.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.install.repository_fetch_failed');
    expect(readdirSync(staged.rawDirectory)).not.toContain('escape.md');
  });
});
