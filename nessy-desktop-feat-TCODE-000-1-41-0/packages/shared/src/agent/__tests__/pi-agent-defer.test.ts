/**
 * R7 Task 5 — `defer` as a PreToolUse hook decision for the headless surface.
 *
 * Contract (hooks.md "Defer a tool call for later", distilled in the spec's
 * § R7): honored only in non-interactive (headless) runs and only when the
 * turn contains a single tool call; the tool does not execute and the run
 * terminates success with stop_reason `tool_deferred` plus
 * `deferred_tool_use: {id, name, input}`; `reason`/`updatedInput`/
 * `additionalContext` are ignored for defer; interactive sessions log a
 * warning and ignore it; a resume re-fires PreToolUse for the same call and
 * the answer is delivered as `updatedInput` on an allow; a tool missing on
 * resume exits `tool_deferred_unavailable` with `is_error: true`.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../pi-harness/harness-tool-descriptor.ts';
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';
import type { PiDeferredToolCallV1 } from '../pi-harness/deferred-tool-call.ts';

function testPermissionService(): PiPermissionServicePort {
  return {
    async authorize(request) {
      const outcome = request.decision.outcome === 'deny' ? 'deny' : 'allow';
      const canonicalInput = (request.decision.outcome === 'allow' ? request.decision.canonicalInput : undefined)
        ?? request.canonicalInput;
      return parseAndFreezePiPermissionReceipt({
        version: 1,
        sessionKey: request.subject.sessionKey,
        binding: {
          provider: 'pi',
          surfaceVersion: request.subject.surfaceVersion,
          piName: request.subject.piName,
          bindingName: request.subject.bindingName,
          semanticId: request.subject.semanticId,
          descriptorId: request.subject.descriptorId,
        },
        manifest: {
          generation: request.subject.manifestGeneration,
          hash: request.subject.manifestHash,
          provenance: request.subject.manifestProvenance,
          responseEpoch: request.subject.responseEpoch,
        },
        decisionId: 'test-decision',
        outcome,
        canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(request.decision.outcome === 'deny' ? { reason: request.decision.reason } : {}),
      }, request.subject);
    },
  };
}

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: testPermissionService(),
    contextProfile: 'bare',
    ...overrides,
  };
}

function installManifest(agent: PiAgent, toolName: string): Record<string, unknown> {
  const generation = 'test-generation';
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'ws-test', sessionId: 'session-test' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName];
      return modelContractHash ? [{
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash,
      }] : [];
    }),
  };
  const manifest = finalizePiExecutionManifest(seed, []);
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === toolName);
  if (!tool) throw new Error(`missing test tool ${toolName}`);
  const runtime = {
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  } as unknown as CapabilityTurnRuntime;
  agent.setCapabilityTurnRuntime(runtime);
  (agent as any).activeExecutionManifest = manifest;
  return {
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
  };
}

interface DeferHarness {
  agent: PiAgent;
  sent: Array<Record<string, unknown>>;
  enqueued: Array<Record<string, unknown>>;
  deferredRecords: Array<PiDeferredToolCallV1 | undefined>;
  run(request: { toolName: string; input: Record<string, unknown>; toolCallId?: string }): Promise<void>;
}

function createDeferHarness(
  decision: Record<string, unknown> | undefined,
  configOverrides: Partial<BackendConfig> = {},
): DeferHarness {
  const deferredRecords: Array<PiDeferredToolCallV1 | undefined> = [];
  const agent = new PiAgent(createConfig({
    onToolCallDeferred: record => { deferredRecords.push(record); },
    ...configOverrides,
  } as Partial<BackendConfig>));
  agent.setPermissionMode('default');
  const sent: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  const realEnqueue = (agent as any).eventQueue.enqueue.bind((agent as any).eventQueue);
  (agent as any).eventQueue.enqueue = (event: Record<string, unknown>) => {
    enqueued.push(event);
    realEnqueue(event);
  };
  (agent as any).emitAutomationEvent = async () => ({
    matchedCount: decision ? 1 : 0,
    ...(decision ? { decision } : {}),
  });
  return {
    agent,
    sent,
    enqueued,
    deferredRecords,
    async run(request) {
      const identity = installManifest(agent, request.toolName);
      await (agent as any).handlePreToolUseRequest({
        requestId: 'req-defer-1',
        ...identity,
        ...request,
      });
    },
  };
}

describe('PiAgent PreToolUse defer (R7 Task 5)', () => {
  it('headless defer terminates success with tool_deferred + payload and the tool never executes', async () => {
    const harness = createDeferHarness({ decision: 'defer', reason: 'wait for human', updatedInput: { command: 'echo IGNORED' } });
    await harness.run({ toolName: 'Bash', input: { command: 'echo hi' }, toolCallId: 'call-defer-1' });

    // No pre_tool_use_response: the tool call never proceeds.
    expect(harness.sent.filter(message => message.type === 'pre_tool_use_response')).toHaveLength(0);
    // The run terminates with the documented payload; reason/updatedInput ignored.
    const complete = harness.enqueued.find(event => event.type === 'complete') as Record<string, any> | undefined;
    expect(complete?.terminalReason).toBe('tool_deferred');
    expect(complete?.deferredToolUse).toEqual({
      id: 'call-defer-1',
      name: 'Bash',
      input: { command: 'echo hi' },
    });
    expect(complete?.terminalIsError).toBeUndefined();
    // The durable record captures the call and the mode active at defer time.
    expect(harness.deferredRecords).toHaveLength(1);
    expect(harness.deferredRecords[0]).toMatchObject({
      schemaVersion: 1,
      toolUseId: 'call-defer-1',
      toolName: 'Bash',
      input: { command: 'echo hi' },
      permissionMode: 'default',
    });
    harness.agent.destroy();
  });

  it('interactive sessions warn and ignore defer — the call falls through the normal flow', async () => {
    const harness = createDeferHarness({ decision: 'defer' }, { isHeadless: false, skipConfigWatcher: true } as Partial<BackendConfig>);
    await harness.run({ toolName: 'Bash', input: { command: 'echo hi' } });

    const response = harness.sent.find(message => message.type === 'pre_tool_use_response') as Record<string, any> | undefined;
    expect(response).toBeDefined();
    expect(response?.action).not.toBe('block');
    expect(harness.enqueued.filter(event => event.type === 'complete')).toHaveLength(0);
    expect(harness.deferredRecords).toHaveLength(0);
    harness.agent.destroy();
  });

  it('multi-tool-call turns warn and fall through the normal flow', async () => {
    const harness = createDeferHarness({ decision: 'defer' });
    (harness.agent as any).lastAssistantToolCallCount = 2;
    await harness.run({ toolName: 'Bash', input: { command: 'echo hi' } });

    const response = harness.sent.find(message => message.type === 'pre_tool_use_response') as Record<string, any> | undefined;
    expect(response).toBeDefined();
    expect(harness.enqueued.filter(event => event.type === 'complete')).toHaveLength(0);
    expect(harness.deferredRecords).toHaveLength(0);
    harness.agent.destroy();
  });

  it('resume re-fires PreToolUse and an allow delivers the answer as updatedInput', async () => {
    // Restart-shaped resume: a fresh agent re-drives the same call; the hook
    // now answers allow + updatedInput, which reaches the tool as its input.
    const harness = createDeferHarness({ decision: 'allow', updatedInput: { command: 'echo resumed-answer' } });
    await harness.run({ toolName: 'Bash', input: { command: 'echo hi' }, toolCallId: 'call-defer-1' });

    const response = harness.sent.find(message => message.type === 'pre_tool_use_response') as Record<string, any> | undefined;
    expect(response?.action).toBe('modify');
    expect(response?.input).toEqual({ command: 'echo resumed-answer' });
    harness.agent.destroy();
  });

  it('a deferred tool missing on resume exits tool_deferred_unavailable with is_error', async () => {
    const harness = createDeferHarness(undefined);
    installManifest(harness.agent, 'Bash');
    const record: PiDeferredToolCallV1 = {
      schemaVersion: 1,
      toolUseId: 'call-gone-1',
      toolName: 'NoSuchToolAnymore',
      input: { command: 'echo hi' },
      permissionMode: 'default',
      deferredAt: Date.now(),
    };
    const handled = (harness.agent as any).resolveDeferredResume(record);
    expect(handled).toBe('unavailable');
    const complete = harness.enqueued.find(event => event.type === 'complete') as Record<string, any> | undefined;
    expect(complete?.terminalReason).toBe('tool_deferred_unavailable');
    expect(complete?.terminalIsError).toBe(true);
    expect(complete?.deferredToolUse).toEqual({
      id: 'call-gone-1',
      name: 'NoSuchToolAnymore',
      input: { command: 'echo hi' },
    });
    harness.agent.destroy();
  });

  it('a deferred tool still present on resume proceeds without a terminal event', async () => {
    const harness = createDeferHarness(undefined);
    installManifest(harness.agent, 'Bash');
    const record: PiDeferredToolCallV1 = {
      schemaVersion: 1,
      toolUseId: 'call-kept-1',
      toolName: 'Bash',
      input: { command: 'echo hi' },
      permissionMode: 'default',
      deferredAt: Date.now(),
    };
    expect((harness.agent as any).resolveDeferredResume(record)).toBe('available');
    expect(harness.enqueued.filter(event => event.type === 'complete')).toHaveLength(0);
    harness.agent.destroy();
  });
});
