import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { PiExecutionManifestV2 } from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import type { ToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import { hashProjectedPiToolDefinition } from '../harness/tool-manifest.ts';
import type { CuratedPiExtensionDescriptor } from './descriptor.ts';

type Handler = (...args: any[]) => unknown;

function sameSet(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some(value => !expected.includes(value))) {
    throw new Error(`Missing or unexpected curated Pi ${label}`);
  }
}

function closedContext(): ExtensionContext {
  const target = Object.freeze(Object.create(null));
  return new Proxy(target, {
    get(_target, property) {
      throw new Error(`Denied curated Pi ExtensionContext property: ${String(property)}`);
    },
    getPrototypeOf: () => null,
  }) as ExtensionContext;
}

export function guardCuratedPiExtensionFactory(
  descriptor: CuratedPiExtensionDescriptor,
  executionManifest?: PiExecutionManifestV2,
  toolExecutor?: ToolExecutor,
  responseEpoch?: number,
): ExtensionFactory {
  return async (rawApi) => {
    if (!executionManifest && descriptor.tools.length > 0) {
      throw new Error(`Missing Pi execution manifest for curated extension ${descriptor.id}`);
    }
    const tools = new Map<string, ToolDefinition<any, any>>();
    const events: Array<{ name: string; handler: Handler }> = [];
    const commands = new Map<string, Record<string, unknown>>();
    const allowed = new Set(descriptor.allowedApi);
    const api: Record<string, unknown> = Object.create(null);

    if (allowed.has('registerTool')) {
      api.registerTool = (definition: ToolDefinition<any, any>) => {
        if (tools.has(definition.name)) throw new Error(`Duplicate curated Pi tool registration: ${definition.name}`);
        tools.set(definition.name, definition);
      };
    }
    if (allowed.has('on')) {
      api.on = (name: string, handler: Handler) => {
        if (!descriptor.events.includes(name)) throw new Error(`Denied curated Pi event: ${name}`);
        if (events.some(event => event.name === name)) throw new Error(`Duplicate curated Pi event registration: ${name}`);
        events.push({ name, handler });
      };
    }
    if (allowed.has('registerCommand')) {
      api.registerCommand = (name: string, options: Record<string, unknown>) => {
        if (!descriptor.commands.includes(name)) throw new Error(`Denied curated Pi command: ${name}`);
        if (commands.has(name)) throw new Error(`Duplicate curated Pi command registration: ${name}`);
        commands.set(name, options);
      };
    }

    const facade = new Proxy(Object.freeze(api), {
      get(target, property, receiver) {
        if (typeof property !== 'string' || !Object.hasOwn(target, property)) {
          throw new Error(`Denied curated Pi ExtensionAPI property: ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
      getPrototypeOf: () => null,
    }) as unknown as ExtensionAPI;

    await descriptor.factory(facade);
    sameSet([...tools.keys()], descriptor.tools.map(tool => tool.piName), 'tool registration');
    sameSet(events.map(event => event.name), descriptor.events, 'event registration');
    sameSet([...commands.keys()], descriptor.commands, 'command registration');

    for (const expected of descriptor.tools) {
      const manifestTool = executionManifest!.tools.find(tool => tool.binding.piName === expected.piName);
      const definition = tools.get(expected.piName);
      if (!manifestTool || !definition
        || hashProjectedPiToolDefinition(executionManifest!, manifestTool, definition) !== expected.modelContractHash) {
        throw new Error(`Curated Pi model contract mismatch for ${expected.piName}`);
      }
    }

    for (const expected of descriptor.tools) {
      const definition = tools.get(expected.piName)!;
      rawApi.registerTool({
        ...definition,
        async execute(executionId, canonicalInput, abortSignal) {
          if (!toolExecutor || !executionManifest || responseEpoch === undefined) {
            throw new Error(`Curated Pi tool ${expected.piName} requires the session ToolExecutor`);
          }
          const receipt = await toolExecutor.execute({
            executionId,
            sessionKey: executionManifest.sessionKey,
            manifestIdentity: {
              generation: executionManifest.snapshotGeneration,
              manifestHash: executionManifest.manifestHash,
              responseEpoch,
            },
            semanticId: expected.semanticId,
            canonicalInput,
            source: 'pi',
            presentedName: expected.piName,
            abortSignal: abortSignal ?? new AbortController().signal,
          });
          if (receipt.outcome !== 'success') {
            throw new Error(receipt.reason ?? receipt.result.error ?? receipt.result.content);
          }
          return {
            content: [{ type: 'text', text: receipt.result.content }],
            details: receipt.result.structuredContent,
          };
        },
      });
    }
    for (const event of events) {
      rawApi.on(event.name as never, ((value: unknown) => event.handler(value, closedContext())) as never);
    }
    for (const [name, options] of commands) {
      const handler = options.handler;
      rawApi.registerCommand(name, {
        ...options,
        handler: (args: unknown) => {
          if (typeof handler !== 'function') throw new Error(`Missing curated Pi command handler: ${name}`);
          return (handler as Handler)(args, closedContext());
        },
      } as never);
    }
  };
}
