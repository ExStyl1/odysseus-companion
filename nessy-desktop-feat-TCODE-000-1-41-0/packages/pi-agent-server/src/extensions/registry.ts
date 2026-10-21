import { createHash } from 'node:crypto';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { PiExecutionManifestV2 } from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import type { ToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import {
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
  getPiStaticModelContractHash,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import {
  deepFreezeCurated,
  type CuratedPiExtensionDescriptor,
  type CuratedPiResourceDescriptor,
} from './descriptor.ts';
import { guardCuratedPiExtensionFactory } from './guard.ts';
import { PI_LIFECYCLE_COMPONENT_ID } from './lifecycle-bridge.ts';
import { PI_DEFERRED_MCP_COMPONENT_ID } from './deferred-mcp-extension.ts';

export const PINNED_NESSY_FACTORIES: readonly CuratedPiExtensionDescriptor[] = Object.freeze([]);
export const PINNED_NESSY_RESOURCES: readonly CuratedPiResourceDescriptor[] = Object.freeze([]);

interface CuratedPiBuildManifest {
  readonly version: 1;
  readonly components: readonly {
    readonly id: 'nessy.prompt-extension' | typeof PI_LIFECYCLE_COMPONENT_ID | typeof PI_DEFERRED_MCP_COMPONENT_ID;
    readonly kind: 'builtin';
  }[];
  readonly extensions: readonly {
    readonly id: string;
    readonly upstream: CuratedPiExtensionDescriptor['upstream'];
    readonly tools: CuratedPiExtensionDescriptor['tools'];
    readonly events: readonly string[];
    readonly commands: readonly string[];
    readonly allowedApi: CuratedPiExtensionDescriptor['allowedApi'];
    readonly ui: CuratedPiExtensionDescriptor['ui'];
  }[];
  readonly resources: readonly Omit<CuratedPiResourceDescriptor, 'bundledContent'>[];
  readonly manifestHash: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate curated Pi ${label}`);
}

function validateExtensions(
  extensions: readonly CuratedPiExtensionDescriptor[],
  executionManifest: PiExecutionManifestV2 | undefined,
): void {
  assertUnique(extensions.map(extension => extension.id), 'extension id');
  const registeredPiNames: string[] = [];
  for (const extension of extensions) {
    if (!extension.id || typeof extension.factory !== 'function') throw new Error('Invalid curated Pi extension descriptor');
    assertUnique(extension.tools.map(tool => tool.piName), `${extension.id} tool`);
    assertUnique(extension.events, `${extension.id} event`);
    assertUnique(extension.commands, `${extension.id} command`);
    assertUnique(extension.allowedApi, `${extension.id} allowed API`);
    for (const tool of extension.tools) {
      registeredPiNames.push(tool.piName);
      const binding = PI_TOOL_BINDINGS.find(candidate => candidate.piName === tool.piName);
      if (!binding || binding.descriptorId !== tool.semanticId) {
        throw new Error(`Curated Pi binding mismatch for ${tool.piName}`);
      }
      if (getHarnessToolDescriptor(tool.semanticId).id !== tool.semanticId) {
        throw new Error(`Curated Pi semantic descriptor mismatch for ${tool.piName}`);
      }
      if (getPiStaticModelContractHash(binding.bindingName) !== tool.modelContractHash) {
        throw new Error(`Curated Pi static model contract mismatch for ${tool.piName}`);
      }
      if (executionManifest) {
        const manifestTool = executionManifest.tools.find(candidate => candidate.binding.piName === tool.piName);
        if (!manifestTool || manifestTool.binding.descriptorId !== tool.semanticId
          || manifestTool.modelContractHash !== tool.modelContractHash) {
          throw new Error(`Curated Pi session model contract mismatch for ${tool.piName}`);
        }
      }
    }
  }
  assertUnique(registeredPiNames, 'tool inventory');
}

export function createCuratedPiBuildManifest(
  extensions: readonly CuratedPiExtensionDescriptor[],
  resources: readonly CuratedPiResourceDescriptor[],
  executionManifest?: PiExecutionManifestV2,
): CuratedPiBuildManifest {
  validateExtensions(extensions, executionManifest);
  assertUnique(resources.map(resource => resource.id), 'resource id');
  const unsigned = {
    version: 1 as const,
    components: [
      { id: 'nessy.prompt-extension' as const, kind: 'builtin' as const },
      { id: PI_LIFECYCLE_COMPONENT_ID, kind: 'builtin' as const },
      { id: PI_DEFERRED_MCP_COMPONENT_ID, kind: 'builtin' as const },
    ],
    extensions: extensions.map(extension => ({
      id: extension.id,
      upstream: { ...extension.upstream },
      tools: extension.tools.map(tool => ({ ...tool })),
      events: [...extension.events],
      commands: [...extension.commands],
      allowedApi: [...extension.allowedApi],
      ui: extension.ui,
    })),
    resources: resources.map(resource => ({
      id: resource.id,
      kind: resource.kind,
      relativePath: resource.relativePath,
      sha256: resource.sha256,
      ...(resource.provenance ? { provenance: resource.provenance } : {}),
      ...(resource.skillMetadata ? { skillMetadata: { ...resource.skillMetadata } } : {}),
      ...(resource.signedAsset ? { signedAsset: { ...resource.signedAsset } } : {}),
    })),
  };
  return deepFreezeCurated({ ...unsigned, manifestHash: hash(unsigned) });
}

export function composeCuratedPiExtensionFactories(
  promptExtension: ExtensionFactory,
  lifecycleExtension: ExtensionFactory,
  deferredMcpExtension: ExtensionFactory | undefined,
  extensions: readonly CuratedPiExtensionDescriptor[],
  executionManifest?: PiExecutionManifestV2,
  toolExecutor?: ToolExecutor,
  responseEpoch?: number,
): readonly ExtensionFactory[] {
  if (!executionManifest && extensions.some(extension => extension.tools.length > 0)) {
    throw new Error('Curated Pi extension composition requires a session manifest');
  }
  createCuratedPiBuildManifest(extensions, PINNED_NESSY_RESOURCES, executionManifest);
  return Object.freeze([
    promptExtension,
    lifecycleExtension,
    ...(deferredMcpExtension ? [deferredMcpExtension] : []),
    ...extensions.map(extension => guardCuratedPiExtensionFactory(
      extension,
      executionManifest,
      toolExecutor,
      responseEpoch,
    )),
  ]);
}

export const CURATED_PI_BUILD_MANIFEST = createCuratedPiBuildManifest(
  PINNED_NESSY_FACTORIES,
  PINNED_NESSY_RESOURCES,
);
