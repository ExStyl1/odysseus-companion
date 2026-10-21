/**
 * UB3.9 (upstream v0.14.1/v0.15.1 `routeToolCall(…, intent)`, `toolCallId` on
 * `tool_execute_request`) — the Pi proxy route delivers the agent's stated
 * purpose to the pool.
 *
 * The chain, on the real wire: the subprocess's `tool_execute_request` now
 * carries the `toolCallId` of the Pi tool call it serves
 * (`pi-agent-server/src/index.ts`); `handleToolExecuteRequest` reads the
 * PreToolUse bridge (`preToolMetadataByCallId`, seeded at the
 * `pre_tool_use_request` capture) for that id and hands the intent to
 * `routeToolCall`, whose MCP branch puts it into the pool context.
 *
 * The rig is `pi-agent-handoff-route-staleness.test.ts`'s: the REAL handler
 * over the REAL readline wire, a manifest built by the real
 * `finalizePiExecutionManifest`, and `routeToolCall` stubbed to capture its
 * arguments. Positive: a request whose `toolCallId` matches a captured intent
 * routes WITH it. Negative (the control): the same request WITHOUT a
 * `toolCallId` routes with none — and the bridge entry is left for
 * `tool_execution_end` to delete, which this row does not own.
 */

import { describe, expect, it } from 'bun:test';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { finalizePiExecutionManifest } from '../pi-harness/harness-manifest.ts';
import { PI_STATIC_MODEL_CONTRACT_HASHES, PI_TOOL_BINDINGS, getHarnessToolDescriptor } from '../pi-harness/harness-tool-descriptor.ts';

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-ub39',
      name: 'UB3.9 Workspace',
      rootPath: '/tmp/nessy-ub39-ws',
      workspaceRootPath: '/tmp/nessy-ub39-ws',
      sessionRootPath: '/tmp/nessy-ub39-sessions/ws-ub39',
    } as never,
    session: {
      id: 'session-ub39',
      workspaceRootPath: '/tmp/nessy-ub39-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
    skipConfigWatcher: true,
    ...overrides,
  };
}

interface Rig {
  agent: PiAgent;
  pushChunk: (...messages: Array<Record<string, unknown>>) => Promise<void>;
  dispose: () => void;
}

function setupRig(): Rig {
  const agent = new PiAgent(createConfig());
  (agent as unknown as { send: (message: Record<string, unknown>) => void }).send = () => {};
  (agent as unknown as { debug: (message: string) => void }).debug = () => {};
  (agent as unknown as { subprocess: unknown }).subprocess = {};
  (agent as unknown as { emitAutomationEvent: () => Promise<void> }).emitAutomationEvent = async () => {};
  const input = new Readable({ read() {} });
  const readline = createInterface({ input, crlfDelay: Infinity });
  readline.on('line', (line: string) => {
    (agent as unknown as { handleLine: (line: string) => void }).handleLine(line);
  });
  return {
    agent,
    pushChunk: async (...messages) => {
      input.push(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    dispose: () => {
      readline.removeAllListeners();
      readline.close();
      input.push(null);
      (agent as unknown as { subprocess: unknown }).subprocess = null;
      agent.destroy();
    },
  };
}

/**
 * A rig whose manifest carries one static binding (any — the route stub
 * intercepts before real routing; only the identity checks read it) and whose
 * `routeToolCall` records the arguments it was handed.
 */
function rigWithCapturingRoute() {
  const rig = setupRig();
  const agent = rig.agent as unknown as Record<string, unknown>;
  const generation = 'ub39-generation';
  const binding = PI_TOOL_BINDINGS.find(candidate => candidate.bindingName === 'mcp__session__SubmitPlan');
  if (!binding) throw new Error('PI_TOOL_BINDINGS carries no mcp__session__SubmitPlan binding');
  const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName] ?? 'ub39-test-only-placeholder-unverified-by-finalize';
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'ws-ub39', sessionId: 'session-ub39' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [
      ...PI_TOOL_BINDINGS.flatMap(candidate => {
        const hash = PI_STATIC_MODEL_CONTRACT_HASHES[candidate.bindingName];
        return hash ? [{
          descriptor: getHarnessToolDescriptor(candidate.descriptorId),
          binding: candidate,
          source: { kind: 'piBuiltin' as const, bindingId: candidate.bindingName },
          modelContractHash: hash,
        }] : [];
      }),
      {
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash,
      },
    ],
  };
  const manifest = finalizePiExecutionManifest(seed, []);
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'SubmitPlan');
  if (!tool) throw new Error('the test manifest carries no SubmitPlan binding');
  const runtime = {
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  } as unknown as CapabilityTurnRuntime;
  (agent as unknown as { setCapabilityTurnRuntime: (runtime: CapabilityTurnRuntime) => void }).setCapabilityTurnRuntime(runtime);
  Object.defineProperty(agent, 'activeExecutionManifest', {
    get: () => manifest,
    set: () => {},
    configurable: true,
  });
  const routed: Array<{ toolName: string; args: Record<string, unknown>; intent?: string }> = [];
  agent.routeToolCall = async (toolName: string, args: Record<string, unknown>, _signal: unknown, intent?: string) => {
    routed.push({ toolName, args, intent });
    return { content: 'routed', isError: false };
  };
  const request = (overrides: Record<string, unknown> = {}) => ({
    type: 'tool_execute_request',
    requestId: 'ub39-proxy-call',
    toolName: tool.binding.bindingName,
    piName: tool.binding.piName,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    args: { planPath: '/tmp/ub39-plan.md' },
    ...overrides,
  });
  return { rig, routed, request };
}

describe('UB3.9 — the Pi proxy route carries the bridge intent to the pool', () => {
  it('positive: a request whose toolCallId matches a captured intent routes WITH it', async () => {
    const { rig, routed, request } = rigWithCapturingRoute();
    try {
      const agent = rig.agent as unknown as { preToolMetadataByCallId: Map<string, { intent?: string; displayName?: string; capturedAt: number }> };
      agent.preToolMetadataByCallId.set('call-ub39', { intent: 'find the outage thread', displayName: 'lookup', capturedAt: Date.now() });
      await rig.pushChunk(request({ toolCallId: 'call-ub39' }));
      expect(routed).toHaveLength(1);
      expect(routed[0]?.intent).toBe('find the outage thread');
      // The bridge entry survives the ROUTE: `tool_execution_end` owns the
      // deletion, and the transcript adapter still needs it there.
      expect(agent.preToolMetadataByCallId.has('call-ub39')).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it("negative (the control): the same request WITHOUT a toolCallId routes with no intent — byte-identical to before this row", async () => {
    const { rig, routed, request } = rigWithCapturingRoute();
    try {
      const agent = rig.agent as unknown as { preToolMetadataByCallId: Map<string, { intent?: string; capturedAt: number }> };
      agent.preToolMetadataByCallId.set('call-ub39', { intent: 'find the outage thread', capturedAt: Date.now() });
      await rig.pushChunk(request());
      expect(routed).toHaveLength(1);
      expect(routed[0]?.intent).toBeUndefined();

      // And an id the bridge never captured reads as absent, not as a crash.
      await rig.pushChunk(request({ toolCallId: 'call-never-captured', requestId: 'ub39-proxy-call-2' }));
      expect(routed).toHaveLength(2);
      expect(routed[1]?.intent).toBeUndefined();
    } finally {
      rig.dispose();
    }
  });
});
