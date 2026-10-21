import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig, type CapabilityTurnRuntime } from '../backend/types.ts';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../pi-harness/harness-tool-descriptor.ts';
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';
import { parsePermissionDslV1, type PermissionDslV1 } from '../pi-harness/permission-dsl.ts';

function testPermissionService(approvedInput?: Record<string, unknown>): PiPermissionServicePort {
  return {
    async authorize(request) {
      const outcome = request.decision.outcome === 'deny' ? 'deny' : 'allow';
      const canonicalInput = approvedInput
        ?? (request.decision.outcome === 'allow' ? request.decision.canonicalInput : undefined)
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
        ...(request.decision.additionalContext ? { additionalContext: request.decision.additionalContext } : {}),
      }, request.subject);
    },
  };
}

function createConfig(permissionServicePort: PiPermissionServicePort = testPermissionService()): BackendConfig {
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
    permissionServicePort,
    contextProfile: 'bare',
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function runPreTool(
  decision: Record<string, unknown> | undefined,
  request: { toolName: string; input: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const agent = new PiAgent(createConfig());
  agent.setPermissionMode('bypassPermissions');
  const sent: Array<Record<string, unknown>> = [];

  (agent as any).send = (message: Record<string, unknown>) => {
    sent.push(message);
  };
  (agent as any).emitAutomationEvent = async () => ({
    matchedCount: decision ? 1 : 0,
    ...(decision ? { decision } : {}),
  });
  const identity = installManifest(agent, request.toolName);

  await (agent as any).handlePreToolUseRequest({
    requestId: 'req-1',
    ...identity,
    ...request,
  });

  agent.destroy();
  return sent.at(-1) ?? {};
}

async function runPreToolWithPermissionResponse(
  options: { updatedInput?: Record<string, unknown> },
  request: { toolName: string; input: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const agent = new PiAgent(createConfig(testPermissionService(options.updatedInput)));
  agent.setPermissionMode('default');
  const sent: Array<Record<string, unknown>> = [];

  (agent as any).send = (message: Record<string, unknown>) => {
    sent.push(message);
  };
  (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
  const identity = installManifest(agent, request.toolName);

  await (agent as any).handlePreToolUseRequest({
    requestId: 'req-1',
    ...identity,
    ...request,
  });

  agent.destroy();
  return sent.at(-1) ?? {};
}

describe('PiAgent PreToolUse hook decisions', () => {
  it('honors hook block decisions', async () => {
    const response = await runPreTool(
      { decision: 'block', reason: 'blocked by hook' },
      { toolName: 'Bash', input: { command: 'echo hi' } },
    );

    expect(response).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'block',
      reason: 'blocked by hook',
      receipt: { outcome: 'deny', decisionId: 'test-decision' },
    });
  });

  it('honors hook updatedInput decisions', async () => {
    const response = await runPreTool(
      { updatedInput: { command: 'echo rewritten' } },
      { toolName: 'Bash', input: { command: 'echo original' } },
    );

    expect(response).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'modify',
      input: { command: 'echo rewritten' },
      receipt: { outcome: 'allow', decisionId: 'test-decision' },
    });
  });

  it('fails closed when the Pi permission service is missing', async () => {
    const config = createConfig();
    delete config.permissionServicePort;
    const agent = new PiAgent(config);
    agent.setPermissionMode('bypassPermissions');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    const identity = installManifest(agent, 'Read');

    await (agent as any).handlePreToolUseRequest({
      requestId: 'missing-service',
      ...identity,
      toolName: 'Read',
      input: { file_path: '/tmp/example' },
    });

    expect(sent.at(-1)).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'block',
      reason: 'Pi permission authority is unavailable.',
    });
    agent.destroy();
  });

  it('fails closed when the request carries no manifest response epoch', async () => {
    // The receipt must be bound to the requesting session-build epoch; a
    // request that does not state it cannot be authorized (the host-side
    // subprocess counter is a different axis and silently diverges).
    const agent = new PiAgent(createConfig());
    agent.setPermissionMode('bypassPermissions');
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
    (agent as any).emitAutomationEvent = async () => ({ matchedCount: 0 });
    const { manifestResponseEpoch: _omitted, ...identity } = installManifest(agent, 'Read');

    await (agent as any).handlePreToolUseRequest({
      requestId: 'missing-epoch',
      ...identity,
      toolName: 'Read',
      input: { file_path: '/tmp/example' },
    });

    expect(sent.at(-1)).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'block',
      reason: 'Pi permission request is missing its manifest response epoch.',
    });
    agent.destroy();
  });

  it('honors permission response updatedInput decisions', async () => {
    const response = await runPreToolWithPermissionResponse(
      { updatedInput: { command: 'npm ci --offline' } },
      { toolName: 'Bash', input: { command: 'npm install left-pad' } },
    );

    expect(response).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'modify',
      input: { command: 'npm ci --offline' },
    });
  });

  it('threads hook additionalContext into the Pi permission response', async () => {
    const response = await runPreTool(
      { additionalContext: 'Tell the model why this tool was allowed.' },
      { toolName: 'Bash', input: { command: 'echo hi' } },
    );

    expect(response).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'allow',
      additionalContext: 'Tell the model why this tool was allowed.',
    });
  });

  it('keeps the deny-path floor even when a hook allows the tool', async () => {
    const response = await runPreTool(
      { decision: 'allow', updatedInput: { file_path: '/tmp/allowed.txt' } },
      { toolName: 'Read', input: { file_path: `${homedir()}/.ssh/id_rsa` } },
    );

    expect(response).toMatchObject({
      type: 'pre_tool_use_response',
      action: 'block',
    });
    expect(String(response.reason ?? '')).toContain('Sensitive path blocked');
  });

  it('emits no decision when the subprocess response epoch changes during a hook await', async () => {
    const agent = new PiAgent(createConfig());
    agent.setPermissionMode('bypassPermissions');
    const sent: Array<Record<string, unknown>> = [];
    const entered = deferred<void>();
    const hook = deferred<{ matchedCount: number }>();
    const state = agent as any;
    state.send = (message: Record<string, unknown>) => { sent.push(message); };
    state.emitAutomationEvent = () => { entered.resolve(); return hook.promise; };
    const identity = installManifest(agent, 'Read');

    const pending = state.handlePreToolUseRequest({
      requestId: 'stale-epoch',
      ...identity,
      toolName: 'Read',
      input: { file_path: '/tmp/example' },
    });
    await entered.promise;
    state.subprocessResponseEpoch += 1;
    hook.resolve({ matchedCount: 0 });
    await pending;

    expect(sent.filter(message => message.type === 'pre_tool_use_response')).toEqual([]);
    agent.destroy();
  });
});

/**
 * One agent across repeated pre-tool requests so the per-turn hook deny
 * loop-guard state accumulates like it does against a live subprocess.
 */
function createLoopHarness(
  decision: Record<string, unknown> | (() => Record<string, unknown>) | undefined,
  toolName: string,
) {
  const agent = new PiAgent(createConfig());
  agent.setPermissionMode('bypassPermissions');
  const sent: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  const state = agent as any;
  state.send = (message: Record<string, unknown>) => { sent.push(message); };
  state.emitAutomationEvent = async (event: string) => {
    const resolved = typeof decision === 'function' ? decision() : decision;
    return {
      matchedCount: resolved && event === 'PreToolUse' ? 1 : 0,
      ...(resolved && event === 'PreToolUse' ? { decision: resolved } : {}),
    };
  };
  const originalEnqueue = state.eventQueue.enqueue.bind(state.eventQueue);
  state.eventQueue.enqueue = (event: Record<string, unknown>) => {
    enqueued.push(event);
    originalEnqueue(event);
  };
  const identity = installManifest(agent, toolName);
  let requestCounter = 0;
  const run = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    requestCounter += 1;
    await state.handlePreToolUseRequest({
      requestId: `loop-req-${requestCounter}`,
      ...identity,
      toolName,
      input,
    });
    return sent.filter(message => message.type === 'pre_tool_use_response').at(-1) ?? {};
  };
  return { agent, state, sent, enqueued, run };
}

describe('PiAgent PreToolUse hook deny loop-guard', () => {
  const hookDeny = { decision: 'deny', reason: 'always denied by hook' };
  const input = { command: 'echo hi' };

  it('escalates a hook that always re-denies: final notice at the cap, then a visible stop', async () => {
    const { agent, state, sent, enqueued, run } = createLoopHarness(hookDeny, 'Bash');

    // Below the cap the deny reason is untouched (single/normal denies unaffected).
    expect(await run(input)).toMatchObject({ action: 'block', reason: 'always denied by hook' });
    expect(await run(input)).toMatchObject({ action: 'block', reason: 'always denied by hook' });

    // At the cap (3rd deny) the reply carries one bounded final-notice reminder.
    const third = await run(input);
    expect(third.action).toBe('block');
    expect(String(third.reason)).toContain('always denied by hook');
    expect(String(third.reason)).toContain('Final notice');

    // Past the cap the turn stops through the existing stop path with a
    // visible diagnostic — the subprocess still gets its pending reply first.
    const fourth = await run(input);
    expect(fourth.action).toBe('block');
    expect(String(fourth.reason)).toContain('Stopping the turn to break the hook retry loop');
    const errorEvent = enqueued.find(event => event.type === 'error');
    expect(String(errorEvent?.message ?? '')).toContain('Stopping the turn to break the hook retry loop');
    expect(state.abortReason).toBe(AbortReason.HookLoopCap);
    expect(sent.at(-1)).toMatchObject({ type: 'abort' });
    agent.destroy();
  });

  it('resets the deny counter at the turn boundary', async () => {
    const { agent, state, run } = createLoopHarness(hookDeny, 'Bash');

    await run(input);
    await run(input);
    // Turn boundary: chatImpl calls this before adapter.startTurn().
    state.resetPreToolHookLoopGuard();

    // Counter restarted: two more denies stay untouched; the cap needs 3 again.
    expect(await run(input)).toMatchObject({ action: 'block', reason: 'always denied by hook' });
    expect(await run(input)).toMatchObject({ action: 'block', reason: 'always denied by hook' });
    const third = await run(input);
    expect(String(third.reason)).toContain('Final notice');
    expect(state.abortReason).toBeUndefined();
    agent.destroy();
  });

  it('never caps different inputs denied under one generic reason', async () => {
    // The primary key includes the input hash: a hook denying DIFFERENT
    // commands with one generic reason (e.g. rate limiting) must not
    // accumulate while the model legitimately explores alternatives.
    const { agent, state, run } = createLoopHarness(
      { decision: 'deny', reason: 'Rate limited' },
      'Bash',
    );

    for (const command of ['echo one', 'echo two', 'echo three']) {
      const response = await run({ command });
      expect(response).toMatchObject({ action: 'block', reason: 'Rate limited' });
    }
    expect(state.abortReason).toBeUndefined();
    agent.destroy();
  });

  it('backstops dynamic deny reasons with the per-tool total cap', async () => {
    // A hook whose reason differs on every deny (timestamps, counters) never
    // repeats a primary (tool, input, reason) key — only the per-tool total
    // can see this loop. Final notice at 10, stop on the 11th.
    let attempt = 0;
    const { agent, state, enqueued, run } = createLoopHarness(
      () => ({ decision: 'deny', reason: `Denied at tick ${++attempt}` }),
      'Bash',
    );

    for (let deny = 1; deny <= 9; deny += 1) {
      const response = await run(input);
      expect(response.action).toBe('block');
      expect(String(response.reason)).not.toContain('Final notice');
    }
    const tenth = await run(input);
    expect(tenth.action).toBe('block');
    expect(String(tenth.reason)).toContain('Final notice');
    const eleventh = await run(input);
    expect(eleventh.action).toBe('block');
    expect(String(eleventh.reason)).toContain('Stopping the turn to break the hook deny loop');
    const errorEvent = enqueued.find(event => event.type === 'error');
    expect(String(errorEvent?.message ?? '')).toContain('denied "Bash" 11 times this turn');
    expect(state.abortReason).toBe(AbortReason.HookLoopCap);
    agent.destroy();
  });

  it('never counts centralized-gate blocks toward the hook loop cap', async () => {
    // The deniedPaths floor authors this block, not the hook — repeated
    // retries must never trip the hook loop cap or stop the turn.
    const { agent, state, run } = createLoopHarness(hookDeny, 'Read');
    const sensitiveInput = { file_path: `${homedir()}/.ssh/id_rsa` };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await run(sensitiveInput);
      expect(response.action).toBe('block');
      expect(String(response.reason)).toContain('Sensitive path blocked');
      expect(String(response.reason)).not.toContain('Final notice');
    }
    expect(state.abortReason).toBeUndefined();
    agent.destroy();
  });
});

/**
 * R15 band harness: drives handlePreToolUseRequest with per-event hook
 * decisions, a capturing permission service (so "the prompt was shown" is
 * observable as the decision outcome the service received), and optional
 * managed-DSL / interaction-required seeding.
 */
interface BandHarnessOptions {
  mode?: 'default' | 'bypassPermissions' | 'dontAsk' | 'acceptEdits';
  hookDecisions?: Partial<Record<string, Record<string, unknown>>>;
  managedDsl?: PermissionDslV1;
  interactionRequired?: string[];
  noManifest?: boolean;
}

function createBandHarness(options: BandHarnessOptions) {
  const authorizedDecisions: Array<Record<string, unknown>> = [];
  const basePermissionService = testPermissionService();
  const permissionService: PiPermissionServicePort = {
    async authorize(authorizeRequest) {
      authorizedDecisions.push(authorizeRequest.decision as unknown as Record<string, unknown>);
      return basePermissionService.authorize(authorizeRequest);
    },
  };
  const agent = new PiAgent(createConfig(permissionService));
  agent.setPermissionMode(options.mode ?? 'default');
  const sent: Array<Record<string, unknown>> = [];
  const events: Array<{ event: string; input: Record<string, unknown> }> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  const debugLines: string[] = [];
  const state = agent as any;
  state.send = (message: Record<string, unknown>) => { sent.push(message); };
  const originalDebug = state.debug.bind(agent);
  state.debug = (message: string) => { debugLines.push(message); originalDebug(message); };
  state.emitAutomationEvent = async (event: string, input: Record<string, unknown>) => {
    events.push({ event, input });
    const decision = options.hookDecisions?.[event];
    return { matchedCount: decision ? 1 : 0, ...(decision ? { decision } : {}) };
  };
  const originalEnqueue = state.eventQueue.enqueue.bind(state.eventQueue);
  state.eventQueue.enqueue = (event: Record<string, unknown>) => {
    enqueued.push(event);
    originalEnqueue(event);
  };
  if (options.interactionRequired) {
    state.getMcpPreToolUseContext = () => ({
      nonSourceMcpServerNames: [],
      interactionRequiredToolNames: options.interactionRequired,
    });
  }
  if (options.managedDsl) {
    state.permissionManager.setCapabilityPermissionLayers([], 'test-generation', true, options.managedDsl);
  }
  let requestCounter = 0;
  const run = async (request: { toolName: string; input: Record<string, unknown> }): Promise<Record<string, unknown>> => {
    requestCounter += 1;
    const identity = options.noManifest
      ? { manifestResponseEpoch: 0 }
      : installManifest(agent, request.toolName);
    await state.handlePreToolUseRequest({
      requestId: `band-req-${requestCounter}`,
      ...identity,
      ...request,
    });
    return sent.filter(message => message.type === 'pre_tool_use_response').at(-1) ?? sent.at(-1) ?? {};
  };
  return { agent, state, run, sent, events, authorizedDecisions, enqueued, debugLines, options };
}

async function runPreToolThroughBand(
  options: BandHarnessOptions,
  request: { toolName: string; input: Record<string, unknown> },
): Promise<{
  response: Record<string, unknown>;
  events: Array<{ event: string; input: Record<string, unknown> }>;
  authorizedDecisions: Array<Record<string, unknown>>;
  state: any;
  enqueued: Array<Record<string, unknown>>;
}> {
  const harness = createBandHarness(options);
  // The interrupt path legitimately sends an `abort` after the response, so
  // `run` picks the pre_tool_use_response rather than whatever came last.
  const response = await harness.run(request);
  harness.agent.destroy();
  return {
    response,
    events: harness.events,
    authorizedDecisions: harness.authorizedDecisions,
    state: harness.state,
    enqueued: harness.enqueued,
  };
}

describe('PiAgent PermissionRequest band', () => {
  // Mode `ask` prompts for this command (git push matches the mutation set).
  const promptingRequest = { toolName: 'Bash', input: { command: 'git push origin main' } };

  it('PermissionRequest allow skips the prompt the gate decided to show', async () => {
    const { response, events, authorizedDecisions } = await runPreToolThroughBand(
      { hookDecisions: { PermissionRequest: { decision: 'allow' } } },
      promptingRequest,
    );

    const band = events.filter(entry => entry.event === 'PermissionRequest');
    expect(band).toHaveLength(1);
    // Documented payload: tool_name, tool_input, permission_mode — no tool_use_id.
    expect(band[0]!.input).toMatchObject({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      permission_mode: 'default',
    });
    expect('tool_use_id' in band[0]!.input).toBe(false);
    // The permission service saw an ALLOW — the human was never prompted.
    expect(authorizedDecisions).toHaveLength(1);
    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'allow' });
    expect(response).toMatchObject({ type: 'pre_tool_use_response', action: 'allow' });
  });

  it('PermissionRequest deny blocks with the message', async () => {
    const { response, authorizedDecisions } = await runPreToolThroughBand(
      { hookDecisions: { PermissionRequest: { decision: 'deny', reason: 'the band says no' } } },
      promptingRequest,
    );

    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'deny' });
    expect(response).toMatchObject({ type: 'pre_tool_use_response', action: 'block' });
    expect(String(response.reason ?? '')).toContain('the band says no');
  });

  it('PermissionRequest deny with interrupt aborts the turn through the hard-abort path', async () => {
    const { response, state, enqueued } = await runPreToolThroughBand(
      { hookDecisions: { PermissionRequest: { decision: 'deny', reason: 'stop everything', interrupt: true } } },
      promptingRequest,
    );

    expect(response).toMatchObject({ action: 'block' });
    expect(String(response.reason ?? '')).toContain('stop everything');
    expect(enqueued.some(event => event.type === 'error')).toBe(true);
    expect(state.abortReason).toBe(AbortReason.PermissionHookInterrupt);
  });

  it('PermissionRequest allow cannot skip an explicit ask-rule prompt', async () => {
    const { authorizedDecisions, events } = await runPreToolThroughBand(
      {
        hookDecisions: { PermissionRequest: { decision: 'allow' } },
        managedDsl: parsePermissionDslV1({
          version: 1,
          rules: [{ id: 'ask-git', action: 'ask', match: { kind: 'bash', executable: 'git' } }],
        }),
      },
      promptingRequest,
    );

    // The band still FIRES (the dialog was about to be shown) but its allow
    // cannot cross the ask-rule non-negotiable: the prompt still reaches the
    // permission service as an ask.
    expect(events.some(entry => entry.event === 'PermissionRequest')).toBe(true);
    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'ask' });
  });

  it('PermissionRequest allow cannot skip requiresUserInteraction', async () => {
    const { authorizedDecisions } = await runPreToolThroughBand(
      {
        hookDecisions: { PermissionRequest: { decision: 'allow' } },
        interactionRequired: ['Bash'],
      },
      { toolName: 'Bash', input: { command: 'echo hi' } },
    );

    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'ask' });
  });

  it('a matching deny rule never reaches PermissionRequest at all', async () => {
    const { response, events } = await runPreToolThroughBand(
      {
        hookDecisions: { PermissionRequest: { decision: 'allow' } },
        managedDsl: parsePermissionDslV1({
          version: 1,
          rules: [{ id: 'deny-all-bash', action: 'deny', match: { kind: 'bash', executable: '*' } }],
        }),
      },
      promptingRequest,
    );

    expect(events.filter(entry => entry.event === 'PermissionRequest')).toEqual([]);
    expect(response).toMatchObject({ action: 'block' });
  });

  it('updatedInput is re-gated: a deny match on the new input blocks', async () => {
    const { response } = await runPreToolThroughBand(
      {
        hookDecisions: {
          PermissionRequest: { decision: 'allow', updatedInput: { command: 'rm -rf /tmp/x' } },
        },
        managedDsl: parsePermissionDslV1({
          version: 1,
          rules: [{ id: 'deny-rm', action: 'deny', match: { kind: 'bash', executable: 'rm' } }],
        }),
      },
      promptingRequest,
    );

    expect(response).toMatchObject({ action: 'block' });
  });

  it('PermissionRequest never fires for EndConversation (and neither does PreToolUse)', async () => {
    const { events } = await runPreToolThroughBand(
      { hookDecisions: { PermissionRequest: { decision: 'allow' } }, noManifest: true },
      { toolName: 'EndConversation', input: {} },
    );

    expect(events.filter(entry => entry.event === 'PermissionRequest')).toEqual([]);
    expect(events.filter(entry => entry.event === 'PreToolUse')).toEqual([]);
  });

  it('no PermissionRequest hooks registered leaves the prompt path unchanged', async () => {
    const { response, events, authorizedDecisions } = await runPreToolThroughBand(
      { hookDecisions: {} },
      promptingRequest,
    );

    // The dispatch happens (zero matchers, no decision) and the prompt
    // proceeds exactly as today: the service sees the ask.
    expect(events.some(entry => entry.event === 'PermissionRequest')).toBe(true);
    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'ask' });
    expect(response).toMatchObject({ type: 'pre_tool_use_response' });
  });
});

describe('PiAgent PreToolUse hook allow', () => {
  // Mode `ask` prompts for this command (git push matches the mutation set).
  const promptingRequest = { toolName: 'Bash', input: { command: 'git push origin main' } };

  it('skips the prompt the gate decided to show, and no dialog event fires', async () => {
    // hooks.md#pretooluse: `permissionDecision: "allow"` "skips the permission
    // prompt". Hooks run after our centralized gate, and the overlay carried the
    // prompt forward unchanged, so this decision used to have no effect at all —
    // a hook that approved a call still made the user click.
    const { response, events, authorizedDecisions } = await runPreToolThroughBand(
      { hookDecisions: { PreToolUse: { decision: 'allow' } } },
      promptingRequest,
    );

    expect(authorizedDecisions).toHaveLength(1);
    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'allow' });
    expect(response).toMatchObject({ type: 'pre_tool_use_response', action: 'allow' });
    // `PermissionRequest` fires "when a permission dialog is about to be shown".
    // The hook already approved, so no dialog is about to be shown.
    expect(events.filter(entry => entry.event === 'PermissionRequest')).toEqual([]);
  });

  it('cannot cross an ask rule', async () => {
    // "Deny and ask rules are still evaluated regardless of what the hook
    // returns" (hooks.md#pretooluse).
    const { authorizedDecisions } = await runPreToolThroughBand(
      {
        hookDecisions: { PreToolUse: { decision: 'allow' } },
        managedDsl: parsePermissionDslV1({
          version: 1,
          rules: [{ id: 'ask-git', action: 'ask', match: { kind: 'bash', executable: 'git' } }],
        }),
      },
      promptingRequest,
    );

    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'ask' });
  });

  it('cannot cross a deny rule', async () => {
    const { response, events } = await runPreToolThroughBand(
      {
        hookDecisions: { PreToolUse: { decision: 'allow' } },
        managedDsl: parsePermissionDslV1({
          version: 1,
          rules: [{ id: 'deny-all-bash', action: 'deny', match: { kind: 'bash', executable: '*' } }],
        }),
      },
      promptingRequest,
    );

    expect(response).toMatchObject({ action: 'block' });
    expect(events.filter(entry => entry.event === 'PermissionRequest')).toEqual([]);
  });

  it('cannot skip requiresUserInteraction', async () => {
    // The documented exception: "except for tools that require user interaction".
    const { authorizedDecisions } = await runPreToolThroughBand(
      {
        hookDecisions: { PreToolUse: { decision: 'allow' } },
        interactionRequired: ['Bash'],
      },
      { toolName: 'Bash', input: { command: 'echo hi' } },
    );

    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'ask' });
  });

  it('leaves the prompt alone when the hook returns no decision', async () => {
    const { authorizedDecisions, events } = await runPreToolThroughBand(
      { hookDecisions: {} },
      promptingRequest,
    );

    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'ask' });
    expect(events.some(entry => entry.event === 'PermissionRequest')).toBe(true);
  });
});

describe('PiAgent PermissionRequest suggestions and updatedPermissions (session scope)', () => {
  const promptingRequest = { toolName: 'Bash', input: { command: 'git push origin main' } };

  it('permission_suggestions carry the rememberable rule the dialog would offer', async () => {
    // UA12.71 — `git push origin main` mints no key, so it offers NOTHING (it offered
    // `Bash(git:*)` at `session` until UA12.71); a keyed command offers its own rule.
    const { events } = await runPreToolThroughBand(
      { hookDecisions: {} },
      { toolName: 'Bash', input: { command: 'npm test --silent' } },
    );

    const band = events.find(entry => entry.event === 'PermissionRequest');
    expect(band?.input.permission_suggestions).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      destination: 'localSettings',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test --silent' }], // UA12.84 — the exact approved line
    }]);
  });

  it('an interaction-required prompt offers no suggestions (no always-allow exists)', async () => {
    const { events } = await runPreToolThroughBand(
      { hookDecisions: {}, interactionRequired: ['Bash'] },
      promptingRequest,
    );

    const band = events.find(entry => entry.event === 'PermissionRequest');
    expect(band?.input.permission_suggestions).toBeUndefined();
  });

  /**
   * D1.440 — the SUBJECT of this case changed from `git push origin main` to a
   * command the dangerous list does not name, and its twin below is why.
   *
   * The old form asked a `Bash(git:*)` rule to stop the prompt for
   * `git push origin main`. It cannot, and never could since D1.284 put
   * `git push` on the shared dangerous list: `whitelistedBashPrefix` finds the
   * remembered key and its own docblock then says the caller *"still tests the
   * whole command line against the dangerous list"*, which is the floor D1.401
   * and C4.50 pin and that a session grant is not allowed to lower. So the case
   * was asserting that a session whitelist overrides a safety floor, the one
   * thing it must not do, and it had been red since long before this lane.
   *
   * Here the whitelist is shown doing its actual job. The twin below pins what
   * happens on a dangerous pair, so neither half can be deleted without the
   * other going red.
   */
  it('addRules allow persists to the session whitelist and a repeat does not prompt', async () => {
    const npmRequest = { toolName: 'Bash', input: { command: 'npm test --silent' } };
    const harness = createBandHarness({
      hookDecisions: {
        PermissionRequest: {
          decision: 'allow',
          updatedPermissions: [{
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
          }],
        },
      },
    });
    try {
      const first = await harness.run(npmRequest);
      expect(first).toMatchObject({ action: 'allow' });
      expect(harness.authorizedDecisions[0]).toMatchObject({ outcome: 'allow' });
      // The first run really PROMPTED. Without this the row below would pass on
      // a command that never prompted at all, which is the vacuous shape.
      expect(harness.events.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(1);

      const second = await harness.run(npmRequest);
      expect(second).toMatchObject({ action: 'allow' });
      // The second run never reached the band: the session whitelist
      // auto-allowed the command before any prompt existed.
      expect(harness.events.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(1);
      expect(harness.authorizedDecisions[1]).toMatchObject({ outcome: 'allow' });
      // F1.130's CONTROL: a rule that DOES lift the prompt is still receipted
      // `applied`, with the key it stored — the honest receipt below is scoped to
      // the dangerous floor and must not leak onto an ordinary rule.
      const receipts = harness.debugLines
        .filter(line => line.includes('__PERMISSION_UPDATE__'))
        .map(line => JSON.parse(line.slice(line.indexOf('__PERMISSION_UPDATE__') + '__PERMISSION_UPDATE__'.length)) as Record<string, unknown>);
      expect(receipts).toEqual([{
        event: 'PermissionRequest',
        toolName: 'Bash',
        applied: [{ type: 'addRules', rule: 'Bash(npm test:*)', sessionWhitelist: 'npm test' }],
      }]);
    } finally {
      harness.agent.destroy();
    }
  });

  it('...and a DANGEROUS PAIR still prompts on the repeat, whatever the rule said', async () => {
    // The behaviour the row above used to assert backwards, pinned as measured.
    // `git push` is on the shared dangerous list (D1.284), so the floor asks
    // again even though the rule was accepted and the key was stored. Keeping
    // this visible is the point: whether the model should be RECEIPTED as
    // `applied` for a rule that cannot fire for the command it was asked about
    // is a product posture and is registered as its own row, not decided here.
    const harness = createBandHarness({
      hookDecisions: {
        PermissionRequest: {
          decision: 'allow',
          updatedPermissions: [{
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'git:*' }],
          }],
        },
      },
    });
    try {
      const first = await harness.run(promptingRequest);
      expect(first).toMatchObject({ action: 'allow' });
      const second = await harness.run(promptingRequest);
      expect(second).toMatchObject({ action: 'allow' });
      // TWO prompts, not one: the floor outranks the session grant.
      expect(harness.events.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(2);
      expect(harness.authorizedDecisions[1]).toMatchObject({ outcome: 'allow' });

      // ...AND the receipt says so. F1.130 (origin D1.441), DECIDED 2026-09-23
      // by the controller under the owner's delegation: an HONEST receipt, the
      // floor unchanged. Until then the model was told `applied` both times —
      // measured 2026-09-20: the receipt rides `__PERMISSION_UPDATE__` and named
      // the stored key — for a rule that cannot fire for the command it was
      // asked about.
      //
      // UA12.70 `[security]` — `Bash(git:*)` now stores NOTHING: a wildcard over
      // a bare `git` names no leading-words key (`bashSessionKeyForRuleContent`),
      // and the `??` fallback that used to store `git` — every non-dangerous git
      // subcommand, `git clean -fdx` and `git branch -D` among them until this
      // row — is gone. So the receipt is the refusal, on the channel's `code`
      // form, and never an `applied` entry; F1.130's honest-receipt half stands
      // for a rule that IS stored (`updated_permissions_stored_floor_still_asks`,
      // pinned by `pi-session-rule-whitelist-key.test.ts`). The floor that
      // re-prompts reads the WHOLE COMMAND LINE, where `git push` is.
      const receipts = harness.debugLines
        .filter(line => line.includes('__PERMISSION_UPDATE__'))
        .map(line => JSON.parse(line.slice(line.indexOf('__PERMISSION_UPDATE__') + '__PERMISSION_UPDATE__'.length)) as Record<string, unknown>);
      expect(receipts).toHaveLength(2);
      for (const receipt of receipts) {
        const { applied, code, message } = receipt;
        expect({ applied, code }).toEqual({ applied: undefined, code: 'updated_permissions_refused' });
        expect(String(message)).toContain('Bash rule "git:*"');
        expect(String(message)).toContain('never session-whitelisted');
        expect(String(message)).not.toContain('was stored');
      }
      // Nothing was stored — the reading, not a courtesy.
      expect([...harness.state.permissionManager.getWhitelistedCommands()]).toEqual([]);
    } finally {
      harness.agent.destroy();
    }
  });

  it('addDirectories admits a previously-outside path for the session', async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'band-add-dir-')));
    try {
      const request = { toolName: 'Write', input: { file_path: join(outsideDir, 'note.txt'), content: 'x' } };
      const harness = createBandHarness({
        mode: 'acceptEdits',
        hookDecisions: {
          PermissionRequest: {
            decision: 'allow',
            updatedPermissions: [{ type: 'addDirectories', directories: [outsideDir], destination: 'session' }],
          },
        },
      });
      try {
        const first = await harness.run(request);
        expect(first).toMatchObject({ action: 'allow' });
        expect(harness.events.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(1);

        // The added session root now auto-allows the write in acceptEdits —
        // no second prompt, no second band firing.
        const second = await harness.run(request);
        expect(second).toMatchObject({ action: 'allow' });
        expect(harness.events.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(1);
        expect(harness.authorizedDecisions[1]).toMatchObject({ outcome: 'allow' });

        // R15: the grant is SESSION-scoped, so the host gates that decide
        // outside `runPreToolUseChecks` (command hooks, runtime skill context,
        // plugin-hook effects, composer `!` shell) have to be able to read it.
        expect(harness.agent.getSessionAdditionalDirectories()).toContain(outsideDir);
      } finally {
        harness.agent.destroy();
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('exposes no session directories until a hook grants one', () => {
    const harness = createBandHarness({ mode: 'acceptEdits' });
    try {
      expect(harness.agent.getSessionAdditionalDirectories()).toEqual([]);
    } finally {
      harness.agent.destroy();
    }
  });

  it('setMode to allow-all from ask is refused; a narrower mode applies', async () => {
    const harness = createBandHarness({
      hookDecisions: {
        PermissionRequest: {
          decision: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
        },
      },
    });
    try {
      await harness.run(promptingRequest);
      // bypassPermissions/allow-all is refused unless the session is already
      // there — never a hook-authored widening.
      expect(harness.state.permissionManager.getPermissionMode()).toBe('default');
      expect(harness.debugLines.some(line => line.includes('updated_permissions'))).toBe(true);

      harness.options.hookDecisions!.PermissionRequest = {
        decision: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      };
      await harness.run(promptingRequest);
      expect(harness.state.permissionManager.getPermissionMode()).toBe('acceptEdits');
    } finally {
      harness.agent.destroy();
    }
  });

  it('a session deny rule compiles and denies the same call next time', async () => {
    const harness = createBandHarness({
      hookDecisions: {
        PermissionRequest: {
          decision: 'allow',
          updatedPermissions: [{
            type: 'addRules',
            behavior: 'deny',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'rm *' }],
          }],
        },
      },
    });
    // Session rules ride the pinned capability generation, like every layer.
    harness.state.permissionManager.setCapabilityPermissionLayers([], 'test-generation', true);
    try {
      await harness.run(promptingRequest);
      expect([...harness.state.permissionManager.listSessionPermissionRules()])
        .toEqual([{ raw: 'Bash(rm *)', action: 'deny', match: { kind: 'bash', pattern: 'rm *' } }]);

      const denied = await harness.run({ toolName: 'Bash', input: { command: 'rm -rf build' } });
      expect(denied).toMatchObject({ action: 'block' });

      // removeRules takes it back out again.
      harness.options.hookDecisions!.PermissionRequest = {
        decision: 'allow',
        updatedPermissions: [{
          type: 'removeRules',
          behavior: 'deny',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'rm *' }],
        }],
      };
      await harness.run(promptingRequest);
      expect([...harness.state.permissionManager.listSessionPermissionRules()]).toEqual([]);
    } finally {
      harness.agent.destroy();
    }
  });

  it('replaceRules swaps one behavior and leaves the other alone', async () => {
    const harness = createBandHarness({
      hookDecisions: {
        PermissionRequest: {
          decision: 'allow',
          updatedPermissions: [
            { type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'rm *' }] },
            { type: 'addRules', behavior: 'ask', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm publish *' }] },
          ],
        },
      },
    });
    harness.state.permissionManager.setCapabilityPermissionLayers([], 'test-generation', true);
    try {
      await harness.run(promptingRequest);
      expect(harness.state.permissionManager.listSessionPermissionRules()).toHaveLength(2);

      harness.options.hookDecisions!.PermissionRequest = {
        decision: 'allow',
        updatedPermissions: [{
          type: 'replaceRules',
          behavior: 'deny',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'chmod *' }],
        }],
      };
      await harness.run(promptingRequest);
      const rules = harness.state.permissionManager.listSessionPermissionRules() as Array<{ raw: string; action: string }>;
      expect(rules.map(rule => `${rule.action}:${rule.raw}`).sort())
        .toEqual(['ask:Bash(npm publish *)', 'deny:Bash(chmod *)']);
    } finally {
      harness.agent.destroy();
    }
  });

  it('writes a restricting rule to a settings file and refuses an unoffered grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-updated-permissions-'));
    const harness = createBandHarness({
      hookDecisions: {
        PermissionRequest: {
          decision: 'allow',
          updatedPermissions: [{
            type: 'addRules',
            behavior: 'deny',
            destination: 'localSettings',
            rules: [{ toolName: 'Bash', ruleContent: 'curl *' }],
          }],
        },
      },
    });
    harness.state.workingDirectory = root;
    try {
      await harness.run(promptingRequest);
      const settingsPath = join(root, '.claude', 'settings.local.json');
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.deny).toEqual(['Bash(curl *)']);

      // A grant nobody offered is refused, and nothing lands in the file.
      harness.options.hookDecisions!.PermissionRequest = {
        decision: 'allow',
        updatedPermissions: [{
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'rm *' }],
        }],
      };
      await harness.run(promptingRequest);
      expect(harness.debugLines.some(line => line.includes('permission_suggestion this prompt offered'))).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow).toBeUndefined();

      // Removing rules from a settings file is refused outright.
      harness.options.hookDecisions!.PermissionRequest = {
        decision: 'allow',
        updatedPermissions: [{
          type: 'removeRules',
          behavior: 'deny',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'curl *' }],
        }],
      };
      await harness.run(promptingRequest);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.deny).toEqual(['Bash(curl *)']);
    } finally {
      harness.agent.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('userSettings and non-rule entries at a settings destination are refused', async () => {
    for (const entry of [
      { type: 'addRules', behavior: 'deny', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'curl *' }] },
      { type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' },
      { type: 'addDirectories', directories: ['/tmp'], destination: 'projectSettings' },
    ]) {
      const harness = createBandHarness({
        hookDecisions: { PermissionRequest: { decision: 'allow', updatedPermissions: [entry] } },
      });
      try {
        await harness.run(promptingRequest);
        expect(
          harness.debugLines.some(line => line.includes('updated_permissions_refused')),
          JSON.stringify(entry),
        ).toBe(true);
        expect(harness.state.permissionManager.getPermissionMode()).toBe('default');
        expect(harness.agent.getSessionAdditionalDirectories()).toEqual([]);
      } finally {
        harness.agent.destroy();
      }
    }
  });
});

describe('PiAgent dontAsk PermissionRequest hook-approve branch', () => {
  // Would prompt in ask mode; denied by dontAsk's read-only allowlist today.
  const wouldPromptRequest = { toolName: 'Bash', input: { command: 'git push origin main' } };

  it('a would-prompt action with a hook allow runs in dontAsk', async () => {
    const { response, events, authorizedDecisions } = await runPreToolThroughBand(
      { mode: 'dontAsk', hookDecisions: { PermissionRequest: { decision: 'allow' } } },
      wouldPromptRequest,
    );

    expect(events.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(1);
    expect(authorizedDecisions[0]).toMatchObject({ outcome: 'allow' });
    expect(response).toMatchObject({ action: 'allow' });
  });

  it('without a hook allow it denies exactly as today', async () => {
    const noHooks = await runPreToolThroughBand(
      { mode: 'dontAsk', hookDecisions: {} },
      wouldPromptRequest,
    );
    const hookDenies = await runPreToolThroughBand(
      { mode: 'dontAsk', hookDecisions: { PermissionRequest: { decision: 'deny', reason: 'should not appear' } } },
      wouldPromptRequest,
    );

    expect(noHooks.response).toMatchObject({ action: 'block' });
    expect(hookDenies.response).toMatchObject({ action: 'block' });
    // "Anything else denies with today's message": a hook deny neither
    // changes nor decorates the mode's own denial.
    expect(hookDenies.response.reason).toBe(noHooks.response.reason);
    expect(String(noHooks.response.reason)).not.toContain('should not appear');
  });

  it('a requiresUserInteraction tool denies even with a hook allow, without consulting the band', async () => {
    const { response, events } = await runPreToolThroughBand(
      {
        mode: 'dontAsk',
        interactionRequired: ['Bash'],
        hookDecisions: { PermissionRequest: { decision: 'allow' } },
      },
      wouldPromptRequest,
    );

    expect(response).toMatchObject({ action: 'block' });
    expect(events.filter(entry => entry.event === 'PermissionRequest')).toEqual([]);
  });

  it('an ask-rule match denies even with a hook allow', async () => {
    const { response } = await runPreToolThroughBand(
      {
        mode: 'dontAsk',
        managedDsl: parsePermissionDslV1({
          version: 1,
          rules: [{ id: 'ask-git', action: 'ask', match: { kind: 'bash', executable: 'git' } }],
        }),
        hookDecisions: { PermissionRequest: { decision: 'allow' } },
      },
      wouldPromptRequest,
    );

    expect(response).toMatchObject({ action: 'block' });
  });
});

describe('PiAgent PermissionDenied side event', () => {
  const riskyRequest = { toolName: 'Bash', input: { command: 'git push origin main' } };

  it('fires on a guardian deny with the tool name as the match value', async () => {
    const harness = createBandHarness({ mode: 'default', hookDecisions: {} });
    try {
      harness.agent.setPermissionMode('auto' as any);
      harness.state.guardianConsultState = () => ({});
      harness.state.consultGuardianForBorderline = async () => ({ type: 'block', reason: 'guardian denied this' });

      const response = await harness.run(riskyRequest);
      expect(response).toMatchObject({ action: 'block' });
      // Fire-and-forget event; let the queued dispatch settle.
      await Bun.sleep(0);
      const denied = harness.events.filter(entry => entry.event === 'PermissionDenied');
      expect(denied).toHaveLength(1);
      expect(denied[0]!.input).toMatchObject({
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      });
      // Never for the prompt band: the deny is terminal, no PermissionRequest.
      expect(harness.events.filter(entry => entry.event === 'PermissionRequest')).toEqual([]);
    } finally {
      harness.agent.destroy();
    }
  });

  it('fires on a dontAsk would-prompt deny', async () => {
    const harness = createBandHarness({ mode: 'dontAsk', hookDecisions: {} });
    try {
      const response = await harness.run(riskyRequest);
      expect(response).toMatchObject({ action: 'block' });
      await Bun.sleep(0);
      expect(harness.events.filter(entry => entry.event === 'PermissionDenied')).toHaveLength(1);
    } finally {
      harness.agent.destroy();
    }
  });

  it('its hook output cannot un-deny: the decision is ignored with a diagnostic', async () => {
    const harness = createBandHarness({
      mode: 'dontAsk',
      hookDecisions: { PermissionDenied: { decision: 'allow', updatedInput: { command: 'echo widen' } } },
    });
    try {
      const response = await harness.run(riskyRequest);
      expect(response).toMatchObject({ action: 'block' });
      await Bun.sleep(0);
      expect(harness.debugLines.some(line => line.includes('PermissionDenied') && line.includes('ignored'))).toBe(true);
    } finally {
      harness.agent.destroy();
    }
  });

  it('honours retry: true by re-running the decision, exactly once per tool call', async () => {
    // hooks.md#permissiondenied: `{retry: true}` re-runs the permission decision.
    // The hook here stands in for one that granted permission out of band; the
    // re-run goes through the FULL gate, so nothing is bypassed.
    const harness = createBandHarness({ mode: 'dontAsk', hookDecisions: {} });
    try {
      let deniedEvents = 0;
      harness.state.emitAutomationEvent = async (event: string, input: Record<string, unknown>) => {
        harness.events.push({ event, input });
        if (event !== 'PermissionDenied') return { matchedCount: 0 };
        deniedEvents += 1;
        harness.agent.setPermissionMode('bypassPermissions' as any);
        return { matchedCount: 1, decision: { retry: true } };
      };

      const response = await harness.run(riskyRequest);

      expect(response).toMatchObject({ action: 'allow' });
      expect(deniedEvents).toBe(1);
      expect(harness.debugLines.some(line => line.includes('__HOOK_RETRY__'))).toBe(true);
    } finally {
      harness.agent.destroy();
    }
  });

  it('refuses a second retry for the same tool call', async () => {
    // The re-run still denies, so a hook that keeps asking must not be heard a
    // second time — that is the prompt loop the cap exists to stop.
    const harness = createBandHarness({ mode: 'dontAsk', hookDecisions: {} });
    try {
      let deniedEvents = 0;
      harness.state.emitAutomationEvent = async (event: string, input: Record<string, unknown>) => {
        harness.events.push({ event, input });
        if (event !== 'PermissionDenied') return { matchedCount: 0 };
        deniedEvents += 1;
        return { matchedCount: 1, decision: { retry: true } };
      };

      const response = await harness.run(riskyRequest);

      expect(response).toMatchObject({ action: 'block' });
      expect(deniedEvents).toBe(1);
    } finally {
      harness.agent.destroy();
    }
  });

  it('never fires on an ordinary gate block that had no prompt alternative', async () => {
    const { response, events } = await runPreToolThroughBand(
      { mode: 'default', hookDecisions: {} },
      { toolName: 'Read', input: { file_path: `${homedir()}/.ssh/id_rsa` } },
    );

    expect(response).toMatchObject({ action: 'block' });
    await Bun.sleep(0);
    expect(events.filter(entry => entry.event === 'PermissionDenied')).toEqual([]);
  });
});

/**
 * UA12.71 `[security]` — Pi's PermissionRequest suggestion IS the dialog's own
 * Always Allow (SEC-2 of the 1.43.0 draft).
 *
 * Until this row `buildPermissionRequestSuggestions` offered `Bash(<first word>:*)`
 * at destination `session`, and `wasOffered` compared rule strings only: a hook
 * echoing it stored the key `git` (then `git clean -fdx`, `git branch -D main` ran
 * card-free — measured at HEAD `581f78cdc` by the SEC-1 probe's session half), and
 * the same echo at `localSettings` wrote a durable `Bash(git:*)` nobody was offered.
 * The contract is the hooks page (PermissionRequest input; Permission update
 * entries): an echo of a received suggestion "is equivalent to the user selecting
 * that 'always allow' option in the dialog". So the suggestion is UA12.70's key,
 * spelled as the rule Pi's Always writes, at the destination it writes it to
 * (`localSettings`, QUESTIONS.md U43-SEC.2 (a)); an echo must match rule AND
 * destination. Pi only: Claude's suggestions are the SDK's own, codex has no builder.
 */
describe('UA12.71 — the Pi PermissionRequest suggestion is the dialog\'s own Always Allow', () => {
  const suggestionsFor = async (command: string) => {
    const { events } = await runPreToolThroughBand({ hookDecisions: {} }, { toolName: 'Bash', input: { command } });
    return events.find(entry => entry.event === 'PermissionRequest')?.input.permission_suggestions;
  };
  const offered = (ruleContent: string) => [{
    type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent }],
  }];

  it('offers UA12.70\'s key at localSettings, spelled as the rule the dialog\'s Always writes', async () => {
    expect(await suggestionsFor('npm test --silent')).toEqual(offered('npm test --silent')); // UA12.84 — the exact line
    expect(await suggestionsFor('node -e "console.log(1)"')).toEqual(offered('node -e "console.log(1)"'));
  });

  it('a command with no key offers nothing', async () => {
    for (const command of ['git push origin main', 'git clean -n', 'env FOO=1 npm test', 'gh api repos/o/r']) {
      expect([command, await suggestionsFor(command)]).toEqual([command, undefined]);
    }
  });

  function echoHarness(updatedPermissions: Array<Record<string, unknown>>) {
    const root = mkdtempSync(join(tmpdir(), 'ua1271-'));
    const harness = createBandHarness({
      hookDecisions: { PermissionRequest: { decision: 'allow', updatedPermissions } },
    });
    harness.state.workingDirectory = root;
    const settings = (name: string) => {
      try { return JSON.parse(readFileSync(join(root, '.claude', name), 'utf8')) as { permissions?: { allow?: string[] } }; } catch { return undefined; }
    };
    return { harness, root, settings };
  }

  it('POSITIVE: an exact echo of the offered entry is applied once, at its destination', async () => {
    const { harness, root, settings } = echoHarness(offered('npm test --silent'));
    try {
      expect(await harness.run({ toolName: 'Bash', input: { command: 'npm test --silent' } })).toMatchObject({ action: 'allow' });
      expect(settings('settings.local.json')?.permissions?.allow).toEqual(['Bash(npm test --silent)']);
      expect(harness.debugLines.some(line => line.includes('permission_suggestion this prompt offered'))).toBe(false);
    } finally {
      harness.agent.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: the offered rule echoed at projectSettings, when localSettings was offered, is refused', async () => {
    const { harness, root, settings } = echoHarness([{ ...offered('npm test --silent')[0], destination: 'projectSettings' }]);
    try {
      await harness.run({ toolName: 'Bash', input: { command: 'npm test --silent' } });
      expect(harness.debugLines.some(line => line.includes('permission_suggestion this prompt offered'))).toBe(true);
      expect(settings('settings.json')?.permissions?.allow).toBeUndefined();
      expect(settings('settings.local.json')?.permissions?.allow).toBeUndefined();
    } finally {
      harness.agent.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: echoing Bash(git:*) stores nothing — at session or at localSettings — and git clean -fdx still cards', async () => {
    const { harness, root, settings } = echoHarness([
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }] },
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }] },
    ]);
    try {
      await harness.run({ toolName: 'Bash', input: { command: 'git commit -m x' } });
      expect([...harness.state.permissionManager.getWhitelistedCommands()]).toEqual([]);
      expect(settings('settings.local.json')?.permissions?.allow).toBeUndefined();
      harness.options.hookDecisions = {};
      const before = harness.events.filter(entry => entry.event === 'PermissionRequest').length;
      await harness.run({ toolName: 'Bash', input: { command: 'git clean -fdx' } });
      expect(harness.events.filter(entry => entry.event === 'PermissionRequest')).toHaveLength(before + 1);
    } finally {
      harness.agent.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
