import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative } from 'node:path';
import {
  deepFreezeCurated,
  type CuratedPiResourceDescriptor,
  type VerifiedSignedBundleRootCapability,
} from './descriptor.ts';

export type LoadedCuratedPiResource = CuratedPiResourceDescriptor & {
  readonly content: string;
  readonly verifiedSignedAsset?: {
    readonly rootPath: string;
    readonly entryPath: string;
  };
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertRelativePath(value: string): void {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0')
    || posix.normalize(value) !== value || value === '..' || value.startsWith('../')) {
    throw new Error(`Invalid relative resource path: ${value}`);
  }
}

function inside(rootPath: string, entryPath: string): boolean {
  const child = relative(rootPath, entryPath);
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child);
}

export function loadCuratedPiResources(
  descriptors: readonly CuratedPiResourceDescriptor[],
  capability?: VerifiedSignedBundleRootCapability,
): readonly LoadedCuratedPiResource[] {
  if (new Set(descriptors.map(resource => resource.id)).size !== descriptors.length) {
    throw new Error('Duplicate curated Pi resource id');
  }
  const loaded = descriptors.map((resource) => {
    assertRelativePath(resource.relativePath);
    if (resource.kind === 'skill' && resource.bundledContent !== undefined) {
      throw new Error(`Curated Pi skill requires a signed asset: ${resource.id}`);
    }
    if (resource.kind === 'skill' && (!resource.skillMetadata?.name || !resource.skillMetadata.description)) {
      throw new Error(`Curated Pi skill requires descriptor-owned metadata: ${resource.id}`);
    }
    const sources = Number(resource.bundledContent !== undefined) + Number(resource.signedAsset !== undefined);
    if (sources !== 1) throw new Error(`Curated Pi resource ${resource.id} must have exactly one source`);
    let content: string;
    let verifiedSignedAsset: LoadedCuratedPiResource['verifiedSignedAsset'];
    if (resource.bundledContent !== undefined) {
      content = resource.bundledContent;
    } else {
      if (!capability) throw new Error(`Missing verified signed bundle-root capability for ${resource.id}`);
      const asset = resource.signedAsset!;
      assertRelativePath(asset.bundleRelativeRoot);
      assertRelativePath(asset.entryFile);
      const resolved = capability.read({
        bundleRelativeRoot: asset.bundleRelativeRoot,
        entryFile: asset.entryFile,
        expectedTreeSha256: asset.treeSha256,
      });
      if (resolved.treeSha256 !== asset.treeSha256) throw new Error(`Signed resource tree digest mismatch: ${resource.id}`);
      const rootPath = realpathSync(resolved.rootPath);
      const entryPath = realpathSync(resolved.entryPath);
      if (!inside(rootPath, entryPath)) throw new Error(`Signed resource root escape: ${resource.id}`);
      content = resolved.content;
      verifiedSignedAsset = { rootPath, entryPath };
    }
    if (digest(content) !== resource.sha256) throw new Error(`Curated Pi resource digest mismatch: ${resource.id}`);
    return { ...resource, content, ...(verifiedSignedAsset ? { verifiedSignedAsset } : {}) };
  });
  return deepFreezeCurated(loaded);
}

export function createCuratedResourceOverrides(
  descriptors: readonly CuratedPiResourceDescriptor[],
  capability?: VerifiedSignedBundleRootCapability,
) {
  if (capability !== undefined && typeof capability.read !== 'function') {
    throw new Error('Invalid verified signed bundle-root capability');
  }
  const resources = loadCuratedPiResources(descriptors, capability);
  const resourceBaseDir = (resource: LoadedCuratedPiResource): string | undefined => {
    if (!resource.verifiedSignedAsset) return undefined;
    return resource.kind === 'skill'
      ? dirname(resource.verifiedSignedAsset.entryPath)
      : resource.verifiedSignedAsset.rootPath;
  };
  const sourceInfo = (resource: LoadedCuratedPiResource) => ({
    path: resource.verifiedSignedAsset?.entryPath ?? `nessy-bundle:${resource.relativePath}`,
    source: resource.provenance ?? `nessy:${resource.id}`,
    scope: 'temporary' as const,
    origin: 'top-level' as const,
    ...(resourceBaseDir(resource) ? { baseDir: resourceBaseDir(resource) } : {}),
  });
  return {
    skillsOverride: () => ({
      skills: resources.filter(resource => resource.kind === 'skill').map(resource => ({
        name: resource.skillMetadata!.name,
        description: resource.skillMetadata!.description,
        filePath: resource.verifiedSignedAsset!.entryPath,
        baseDir: dirname(resource.verifiedSignedAsset!.entryPath),
        sourceInfo: sourceInfo(resource),
        disableModelInvocation: resource.skillMetadata!.disableModelInvocation,
      })),
      diagnostics: [],
    }),
    promptsOverride: () => ({
      prompts: resources.filter(resource => resource.kind === 'prompt').map(resource => ({
        name: resource.id,
        description: resource.id,
        content: resource.content,
        sourceInfo: sourceInfo(resource),
        filePath: `nessy-bundle:${resource.relativePath}`,
      })),
      diagnostics: [],
    }),
    themesOverride: () => ({ themes: [], diagnostics: [] }),
    agentsFilesOverride: () => ({
      agentsFiles: resources
        .filter(resource => resource.kind === 'agent-instruction' || resource.kind === 'context')
        .map(resource => ({
          path: `nessy-bundle:${resource.relativePath}`,
          content: resource.content,
          sourceInfo: sourceInfo(resource),
        })),
    }),
  };
}
