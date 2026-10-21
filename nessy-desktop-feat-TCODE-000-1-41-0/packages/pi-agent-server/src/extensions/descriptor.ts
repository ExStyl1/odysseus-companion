import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export type CuratedPiApiCapability = 'registerTool' | 'on' | 'registerCommand';

export interface CuratedPiExtensionToolDescriptor {
  readonly semanticId: string;
  readonly piName: string;
  readonly modelContractHash: string;
}

export interface CuratedPiExtensionDescriptor {
  readonly id: string;
  readonly upstream: {
    readonly repository: string;
    readonly revision: string;
    readonly license: string;
  };
  readonly factory: ExtensionFactory;
  readonly tools: readonly CuratedPiExtensionToolDescriptor[];
  readonly events: readonly string[];
  readonly commands: readonly string[];
  readonly allowedApi: readonly CuratedPiApiCapability[];
  readonly ui: 'none' | 'nessy-port';
}

export interface CuratedPiResourceDescriptor {
  readonly id: string;
  readonly kind: 'skill' | 'prompt' | 'agent-instruction' | 'context';
  readonly relativePath: string;
  readonly sha256: string;
  readonly provenance?: string;
  readonly skillMetadata?: {
    readonly name: string;
    readonly description: string;
    readonly disableModelInvocation: boolean;
  };
  readonly bundledContent?: string;
  readonly signedAsset?: {
    readonly bundleRelativeRoot: string;
    readonly entryFile: string;
    readonly treeSha256: string;
  };
}

export interface VerifiedSignedBundleRootCapability {
  read(input: {
    readonly bundleRelativeRoot: string;
    readonly entryFile: string;
    readonly expectedTreeSha256: string;
  }): {
    readonly rootPath: string;
    readonly entryPath: string;
    readonly treeSha256: string;
    readonly content: string;
  };
}

export function deepFreezeCurated<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeCurated(child);
  return Object.freeze(value);
}
