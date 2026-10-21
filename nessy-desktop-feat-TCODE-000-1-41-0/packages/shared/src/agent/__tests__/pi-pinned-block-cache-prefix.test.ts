/**
 * L3 on Pi, at the delivery boundary — and the #862 invariant it must not break.
 *
 * Two things are asserted on the same captured `{ type: 'prompt' }` RPC, which
 * is the exact wire the subprocess receives:
 *
 * 1. The pinned capability block rides the FIRST turn's user message and not the
 *    second's. Pi keeps the conversation subprocess-side and re-sends it, so the
 *    first turn's copy is still in the model's input on every later turn.
 * 2. `systemPrompt` is byte-identical across the two turns. Pi folds only STABLE
 *    blocks into that prefix because a per-minute re-stamp invalidates pi-ai's
 *    cached system prefix and every downstream history entry (#862). This change
 *    moves content OUT of the user tail and puts nothing into the prefix, and
 *    this is what proves it.
 *
 * `buildVolatileContextParts` consumes the one-shot mode-change signal and must
 * run exactly once per turn (`packages/shared/AGENTS.md`), so the call count is
 * asserted too rather than assumed.
 */
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { expect, test } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef } from '../../capabilities/resolver.ts';

const MEMORY_BODY = Array.from({ length: 598 }, () => 'Remembered project fact.').join(' ');

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-pinned-prefix',
      name: 'Pinned Prefix Workspace',
      rootPath: '/tmp/nessy-pinned-prefix',
      workspaceRootPath: '/tmp/nessy-pinned-prefix',
      sessionRootPath: '/tmp/nessy-pinned-prefix-sessions/ws-pinned-prefix',
    } as never,
    session: {
      id: 'pinned-prefix-session',
      workspaceRootPath: '/tmp/nessy-pinned-prefix',
      createdAt: 0,
      lastUsedAt: 0,
    } as never,
    isHeadless: true,
  } as BackendConfig;
}

function runtimeWithMemory(generation: string): CapabilityTurnRuntime {
  const resource: NativeResourceRef = {
    source: 'project',
    scope: { kind: 'project', workspaceId: 'ws-pinned-prefix' },
    resourceId: 'MEMORY.md',
    absolutePath: '/tmp/nessy-pinned-prefix/.agents/MEMORY.md',
    revision: '1',
    contentHash: 'e'.repeat(64),
  };
  return {
    provider: 'pi',
    view: {
      generation,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [],
      memory: [{ key: 'memory::project::pinned::MEMORY.md', resource, readOnly: false }],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(value: unknown) { return (value as NativeResourceRef).absolutePath; },
      async readText() { return MEMORY_BODY; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

test('the block rides turn 1 only, and the cached system prefix never moves', async () => {
  const agent = new PiAgent(createConfig());
  agent.setCapabilityTurnRuntime(runtimeWithMemory('gen-1'));

  const sent: Array<Record<string, unknown>> = [];
  const internals = agent as unknown as Record<string, unknown>;
  internals.ensureSubprocess = async () => {};
  internals.send = (message: Record<string, unknown>) => { sent.push(message); };
  internals.emitAutomationEvent = async () => {};
  internals.syncExecutionManifestForCurrentTurn = async () => ({
    snapshotGeneration: 'generation-1',
    manifestHash: 'hash-1',
    tools: [],
    deferredMcp: { candidatePiNames: [] },
  });
  const queue = (internals as Record<string, Record<string, unknown>>).eventQueue!;
  queue.reset = () => {};
  queue.drain = async function* () { yield { type: 'complete' }; };

  // Count the one-shot volatile builder: exactly once per turn, never twice.
  const promptBuilder = internals.promptBuilder as { buildVolatileContextParts: (...args: never[]) => string[] };
  const realVolatile = promptBuilder.buildVolatileContextParts.bind(promptBuilder);
  let volatileCalls = 0;
  promptBuilder.buildVolatileContextParts = ((...args: never[]) => {
    volatileCalls += 1;
    return realVolatile(...args);
  }) as typeof promptBuilder.buildVolatileContextParts;

  try {
    for await (const _ of agent.chat('first turn')) { /* drain */ }
    for await (const _ of agent.chat('second turn')) { /* drain */ }
  } finally {
    agent.destroy();
  }

  const prompts = sent.filter(message => message.type === 'prompt');
  expect(prompts).toHaveLength(2);

  // 1. The block is paid for once.
  expect(prompts[0]!.message as string).toContain(MEMORY_BODY);
  expect(prompts[1]!.message as string).not.toContain(MEMORY_BODY);

  // 2. #862: the cacheable system prefix is identical on both turns.
  expect(prompts[1]!.systemPrompt).toEqual(prompts[0]!.systemPrompt);
  expect(prompts[0]!.systemPrompt as string).not.toContain(MEMORY_BODY);

  // 3. The one-shot volatile builder ran exactly once per turn.
  expect(volatileCalls).toBe(2);
});
