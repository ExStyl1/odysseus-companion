import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { mergeMacosReleaseManifests } from './merge-macos-release-manifests.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createReleaseDir(missingDmg = false): Promise<string> {
  const releaseDir = await mkdtemp(join(tmpdir(), 'macos-manifests-'));
  tempDirs.push(releaseDir);

  for (const architecture of ['arm64', 'x64']) {
    const files = [
      {
        url: `Nessy-CLI-Desktop-${architecture}.zip`,
        sha512: `${architecture}-zip`,
        size: 1,
      },
      ...(!missingDmg || architecture !== 'x64'
        ? [
            {
              url: `Nessy-CLI-Desktop-${architecture}.dmg`,
              sha512: `${architecture}-dmg`,
              size: 1,
            },
          ]
        : []),
    ];

    for (const file of files) {
      await writeFile(join(releaseDir, file.url), 'artifact');
    }

    await writeFile(
      join(releaseDir, `latest-mac-${architecture}.yml`),
      yaml.dump({
        version: '1.2.3',
        files,
        path: files[0].url,
        sha512: files[0].sha512,
        releaseDate: '2026-08-14T00:00:00.000Z',
      }),
    );
  }

  return releaseDir;
}

describe('mergeMacosReleaseManifests', () => {
  it('merges arm64 and x64 ZIP and DMG entries', async () => {
    const releaseDir = await createReleaseDir();

    await mergeMacosReleaseManifests(releaseDir);

    const manifest = yaml.load(
      await readFile(join(releaseDir, 'latest-mac.yml'), 'utf8'),
    ) as { files: Array<{ url: string }> };
    expect(manifest.files.map(({ url }) => url)).toEqual([
      'Nessy-CLI-Desktop-arm64.zip',
      'Nessy-CLI-Desktop-arm64.dmg',
      'Nessy-CLI-Desktop-x64.zip',
      'Nessy-CLI-Desktop-x64.dmg',
    ]);
    expect(manifest.files.every(({ sha512 }) => sha512.length > 80)).toBe(true);
    expect(await readdir(releaseDir)).not.toContain('latest-mac-arm64.yml');
  });

  it('rejects a release without both DMGs', async () => {
    const releaseDir = await createReleaseDir(true);

    await expect(mergeMacosReleaseManifests(releaseDir)).rejects.toThrow(
      'Missing x64 dmg',
    );
  });
});
