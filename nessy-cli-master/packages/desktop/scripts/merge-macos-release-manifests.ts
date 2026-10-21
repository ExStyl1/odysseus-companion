#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

type ReleaseFile = {
  url: string;
  sha512: string;
  size: number;
};

type ReleaseManifest = {
  version: string;
  files: ReleaseFile[];
  path: string;
  sha512: string;
  releaseDate: string;
};

const architectures = ['arm64', 'x64'] as const;

function parseManifest(contents: string, path: string): ReleaseManifest {
  const manifest = yaml.load(contents) as ReleaseManifest;
  if (!manifest?.version || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid macOS release manifest: ${path}`);
  }
  return manifest;
}

async function refreshFileMetadata(
  releaseDir: string,
  file: ReleaseFile,
): Promise<ReleaseFile> {
  const path = join(releaseDir, file.url);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return {
    ...file,
    sha512: hash.digest('base64'),
    size: (await stat(path)).size,
  };
}

export async function mergeMacosReleaseManifests(
  releaseDir: string,
): Promise<void> {
  const entries = await readdir(releaseDir);
  const manifestGroups = new Map<string, Map<string, string>>();

  for (const entry of entries) {
    const match = entry.match(/^(.+-mac)-(arm64|x64)\.yml$/);
    if (!match) continue;

    const [, baseName, architecture] = match;
    const group = manifestGroups.get(baseName) ?? new Map<string, string>();
    group.set(architecture, join(releaseDir, entry));
    manifestGroups.set(baseName, group);
  }

  if (manifestGroups.size === 0) {
    throw new Error(
      `No architecture-specific macOS manifests in ${releaseDir}`,
    );
  }

  for (const [baseName, paths] of manifestGroups) {
    const manifests = await Promise.all(
      architectures.map(async (architecture) => {
        const path = paths.get(architecture);
        if (!path) {
          throw new Error(`Missing ${architecture} manifest for ${baseName}`);
        }
        return {
          architecture,
          path,
          manifest: parseManifest(await readFile(path, 'utf8'), path),
        };
      }),
    );

    const [primary] = manifests;
    const files = manifests.flatMap(({ architecture, manifest }) => {
      if (manifest.version !== primary.manifest.version) {
        throw new Error(`macOS manifest versions do not match for ${baseName}`);
      }

      for (const extension of ['zip', 'dmg']) {
        if (
          !manifest.files.some(({ url }) =>
            url.endsWith(`-${architecture}.${extension}`),
          )
        ) {
          throw new Error(
            `Missing ${architecture} ${extension} in ${baseName}`,
          );
        }
      }
      return manifest.files;
    });

    const refreshedFiles = await Promise.all(
      files.map((file) => refreshFileMetadata(releaseDir, file)),
    );
    const primaryFile = refreshedFiles.find(
      ({ url }) => url === primary.manifest.path,
    );
    if (!primaryFile) {
      throw new Error(`Missing primary macOS artifact for ${baseName}`);
    }

    const merged = {
      ...primary.manifest,
      files: refreshedFiles,
      sha512: primaryFile.sha512,
    };
    await writeFile(
      join(releaseDir, `${baseName}.yml`),
      yaml.dump(merged, { lineWidth: -1 }),
    );
    await Promise.all(manifests.map(({ path }) => unlink(path)));
  }
}

if (import.meta.main) {
  const releaseDir = process.argv[2];
  if (!releaseDir) {
    throw new Error('Usage: merge-macos-release-manifests.ts <release-dir>');
  }
  await mergeMacosReleaseManifests(releaseDir);
}
