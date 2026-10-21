import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { createToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import {
  finalizePiExecutionManifest,
  type PiExecutionManifestSeedV2,
  type PiExecutionManifestV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import {
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
  getPiToolBindingByBindingName,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import {
  findPiManifestToolByPresentedName,
  projectPiManifestTools,
} from '../harness/tool-manifest.ts';
import {
  createPiToolExecutionPorts,
  createPiToolProgressBridge,
  createPiToolResultTransformer,
  createPiSdkToolAdapter,
} from './tool-wrapper.ts';

const sessionKey = { workspaceId: 'workspace-1', sessionId: 'session-1' };
const manifestIdentity = { generation: 'generation-1', manifestHash: 'hash-1', responseEpoch: 1 };

function textResult(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details: { ok: true } };
}

function writeTool(execute: ToolDefinition<any, any>['execute']): ToolDefinition<any, any> {
  return {
    name: 'write',
    label: 'write',
    description: 'Write a file.',
    promptSnippet: 'Use write to write a file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' }, attempts: { type: 'number', minimum: 1 } },
    },
    execute,
  };
}

function wrapperFor(
  tool: ToolDefinition<any, any>,
  options: {
    permission?: (input: Record<string, unknown>) => Promise<{
      allowed: boolean;
      decisionId: string;
      canonicalInput?: unknown;
      additionalContext?: string;
    }>;
  } = {},
) {
  const executor = createToolExecutor({
    runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
    authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
    ports: createPiToolExecutionPorts([tool]),
    permissionBridge: async (_request, input) => options.permission?.(input)
      ?? { allowed: true, decisionId: 'approved', canonicalInput: input },
  });
  return createPiSdkToolAdapter({
    toolExecutor: executor,
    sessionKey,
    manifestIdentity,
  });
}

describe('Pi tool wrapper executor boundary', () => {
  it('forwards bounded live progress once and drops late progress after abort', async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>(resolve => { releaseStarted = resolve; });
    let emitLate = () => {};
    const tool = writeTool(async (executionId, _input, _signal, onUpdate) => {
      if (executionId === 'normal-progress') {
        onUpdate?.({
          content: [{ type: 'text', text: 'running' }],
          details: {
            progress: {
              runId: 'run-1',
              agents: ['agent-1'],
              phases: ['execute'],
              status: 'running',
            },
          },
        });
        return textResult('done');
      }
      emitLate = () => onUpdate?.(textResult('late'));
      releaseStarted();
      return new Promise(() => {});
    });
    const progressBridge = createPiToolProgressBridge();
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
      ports: createPiToolExecutionPorts([tool]),
      permissionBridge: async (_request, input) => ({ allowed: true, decisionId: 'approved', canonicalInput: input }),
      maxResultBytes: 512,
      onProgress: progressBridge.emit,
    });
    const wrapped = createPiSdkToolAdapter({
      toolExecutor: executor,
      sessionKey,
      manifestIdentity,
      progressBridge,
    }).adaptTool(tool);
    const updates: AgentToolResult<any>[] = [];

    await wrapped.execute(
      'normal-progress', { path: 'a.txt', content: 'b' }, new AbortController().signal,
      update => updates.push(update),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.details).toEqual({
      progress: {
        runId: 'run-1',
        agents: ['agent-1'],
        phases: ['execute'],
        status: 'running',
      },
    });
    expect(new TextEncoder().encode(
      (updates[0]!.content[0] as { text: string }).text + JSON.stringify(updates[0]!.details),
    ).byteLength).toBeLessThanOrEqual(512);

    const controller = new AbortController();
    const aborted = wrapped.execute(
      'late-progress', { path: 'a.txt', content: 'b' }, controller.signal,
      update => updates.push(update),
    );
    await started;
    controller.abort();
    await expect(aborted).rejects.toThrow(/cancelled/i);
    emitLate();
    expect(updates).toHaveLength(1);
  });

  it('preserves the full large-result tail before finalizing a bounded receipt', async () => {
    const sessionPath = await mkdtemp(join(tmpdir(), 'nessy-x3-large-result-'));
    try {
      const tail = 'FULL_TAIL_SENTINEL';
      const raw = `head\n${'x'.repeat(100_000)}\n${tail}`;
      const tool = writeTool(async executionId => executionId === 'large-error'
        ? { content: [{ type: 'text', text: raw }], details: { isError: true } }
        : textResult(raw));
      const receipts: Array<{
        outcome: string;
        result: { content: string; error?: string; structuredContent?: Record<string, unknown> };
      }> = [];
      const executor = createToolExecutor({
        runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
        authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
        ports: createPiToolExecutionPorts([tool]),
        permissionBridge: async (_request, input) => ({ allowed: true, decisionId: 'approved', canonicalInput: input }),
        maxResultBytes: 64 * 1024,
        transformResult: createPiToolResultTransformer({
          getSessionPath: () => sessionPath,
          getModelContextWindow: () => 1,
          getCurrentUserMessage: () => 'preserve full output',
          runMiniCompletion: async () => 'summary',
          debugLog: () => {},
        }),
        onReceipt: receipt => receipts.push(receipt),
      });
      const wrapped = createPiSdkToolAdapter({
        toolExecutor: executor,
        sessionKey,
        manifestIdentity,
      }).adaptTool(tool);

      const result = await wrapped.execute(
        'large-write', { path: 'a.txt', content: 'b' }, new AbortController().signal,
      );
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Full data saved to:') });
      await expect(wrapped.execute(
        'large-error', { path: 'a.txt', content: 'b' }, new AbortController().signal,
      )).rejects.toThrow(/Full data saved to:/);
      const artifacts = await readdir(join(sessionPath, 'long_responses'));
      expect(artifacts).toHaveLength(2);
      for (const artifact of artifacts) {
        expect(await readFile(join(sessionPath, 'long_responses', artifact), 'utf8')).toEndWith(tail);
      }
      expect(receipts.map(receipt => receipt.outcome)).toEqual(['success', 'error']);
      for (const receipt of receipts) {
        expect(new TextEncoder().encode(
          receipt.result.content
          + (receipt.result.error ?? '')
          + JSON.stringify(receipt.result.structuredContent ?? {}),
        ).byteLength).toBeLessThanOrEqual(64 * 1024);
      }
    } finally {
      await rm(sessionPath, { recursive: true, force: true });
    }
  });

  it('routes multiple dynamic MCP definitions through one semantic port by presented name', async () => {
    const effects: string[] = [];
    const dynamic = (name: string, key: string): ToolDefinition<any, any> => ({
      name,
      label: name,
      description: name,
      parameters: {
        type: 'object', additionalProperties: false, required: [key],
        properties: { [key]: { type: 'string' } },
      },
      async execute(_id, input) {
        effects.push(`${name}:${String((input as Record<string, unknown>)[key])}`);
        return textResult(name);
      },
    });
    const tools = [dynamic('mcp__alpha__one', 'left'), dynamic('mcp__beta__two', 'right')];
    const resolveSemanticId = () => 'mcp_dynamic';
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
      ports: createPiToolExecutionPorts(tools, resolveSemanticId),
      permissionBridge: async (_request, input) => ({ allowed: true, decisionId: 'approved', canonicalInput: input }),
    });
    const wrapper = createPiSdkToolAdapter({
      toolExecutor: executor,
      sessionKey,
      manifestIdentity,
      resolveSemanticId,
    });

    await wrapper.adaptTool(tools[0]!).execute('one', { left: 'a' }, new AbortController().signal);
    await wrapper.adaptTool(tools[1]!).execute('two', { right: 'b' }, new AbortController().signal);
    expect(effects).toEqual(['mcp__alpha__one:a', 'mcp__beta__two:b']);
  });

  it('cannot inject a handler, canonicalizer, permission function, or scheduling metadata per call', async () => {
    const lifecycle: string[] = [];
    const tool = writeTool(async (_executionId, input) => {
      lifecycle.push(`effect:${JSON.stringify(input)}`);
      return textResult('ok');
    });
    const wrapped = wrapperFor(tool, {
      permission: async input => {
        lifecycle.push(`permission:${JSON.stringify(input)}`);
        return { allowed: true, decisionId: 'approved', canonicalInput: input };
      },
    }).adaptTool(tool);

    await expect(wrapped.execute(
      'write-1',
      { path: 'a.txt', content: 'b', injectedHandler: 'deny' },
      new AbortController().signal,
    )).rejects.toThrow(/additional propert/i);
    expect(lifecycle).toEqual([]);
    await expect(wrapped.execute(
      'write-minimum',
      { path: 'a.txt', content: 'b', attempts: 0 },
      new AbortController().signal,
    )).rejects.toThrow(/minimum|>= 1/i);
    expect(lifecycle).toEqual([]);

    await expect(wrapped.execute(
      'write-2',
      { path: 'a.txt', content: 'b' },
      new AbortController().signal,
    )).resolves.toEqual(textResult('ok'));
    expect(lifecycle).toEqual([
      'permission:{"path":"a.txt","content":"b"}',
      'effect:{"path":"a.txt","content":"b"}',
    ]);
  });

  it('revalidates approval-modified input and preserves additional context', async () => {
    const tool = writeTool(async (_executionId, input) => textResult(JSON.stringify(input)));
    const wrapped = wrapperFor(tool, {
      permission: async () => ({
        allowed: true,
        decisionId: 'modified',
        canonicalInput: { path: 'approved.txt', content: 'approved' },
        additionalContext: 'approved by policy',
      }),
    }).adaptTool(tool);

    const result = await wrapped.execute(
      'write-1',
      { path: 'draft.txt', content: 'draft' },
      new AbortController().signal,
    );
    expect(result.content).toEqual([
      { type: 'text', text: '<pre_tool_use_context>\napproved by policy\n</pre_tool_use_context>\n\n' },
      { type: 'text', text: '{"path":"approved.txt","content":"approved"}' },
    ]);
  });

  it('fails closed on denied permission without invoking the definition', async () => {
    let effects = 0;
    const tool = writeTool(async () => {
      effects += 1;
      return textResult('unexpected');
    });
    const wrapped = wrapperFor(tool, {
      permission: async () => ({ allowed: false, decisionId: 'denied' }),
    }).adaptTool(tool);

    await expect(wrapped.execute(
      'write-1',
      { path: 'a.txt', content: 'b' },
      new AbortController().signal,
    )).rejects.toThrow(/Permission denied/);
    expect(effects).toBe(0);
  });

  /**
   * P3.370 · the non-adoption of Pi's `terminate` hint, pinned so that taking
   * it is a deliberate act rather than a drift.
   *
   * `AgentToolResult.terminate` is reachable from exactly this return value in
   * pi-agent-core (0.84.2, re-read unchanged at 0.84.3 — W11-pi, 2026-09-11:
   * three `terminate?: boolean` declaration sites, and `shouldTerminateToolBatch`
   * still demanding unanimity), and `wrappedExecute`'s docblock records what taking
   * it would cost — chiefly the loop's `isError` flag, which only a THROWN
   * result carries. This row asserts the two halves of the current answer: a
   * denial still throws (so the model is still told the call failed), and no
   * ordinary result stamps the hint (so no batch ends because a tool happened
   * to return a truthy field). If either flips, it flips here first.
   */
  it('stamps no early-termination hint, on either the allowed or the denied path', async () => {
    const tool = writeTool(async () => textResult('ok'));
    const allowed = wrapperFor(tool, {
      permission: async () => ({ allowed: true, decisionId: 'allow' }),
    }).adaptTool(tool);

    const result = await allowed.execute(
      'write-1',
      { path: 'a.txt', content: 'b' },
      new AbortController().signal,
    );
    // Positive control first: the call really did produce a result, so the
    // absence below is measured and not an un-run tool read as a pass.
    expect(result.content).toEqual(textResult('ok').content);
    expect((result as { terminate?: boolean }).terminate).toBeUndefined();

    // The denied path cannot carry the hint at all while it throws — a thrown
    // execute is turned into the loop's own error result, which has no
    // `terminate` field to inherit one.
    const denied = wrapperFor(tool, {
      permission: async () => ({ allowed: false, decisionId: 'denied' }),
    }).adaptTool(tool);
    await expect(denied.execute(
      'write-2',
      { path: 'a.txt', content: 'b' },
      new AbortController().signal,
    )).rejects.toThrow(/Permission denied/);
  });
});

/**
 * A tool reaches the runtime through TWO axes of one name: the host registers
 * the raw proxy definition under its bindingName, while the projected,
 * model-facing definition presents the piName, and it is the piName that
 * arrives as `presentedName`. These tests dispatch through the real port
 * construction — ports from the RAW definitions, requests from the PROJECTED
 * ones, exactly as buildSessionDefinition wires it — because a handler-level
 * test cannot see a name-resolution gap between the two.
 *
 * The wire-name unification CHANGED THE ANSWER here for session tools: the two
 * axes now carry the same spelling (`mcp__session__Monitor` on both), so the
 * gap is closed by construction rather than bridged at lookup. The seam is
 * still real — the native `stopTask`/`stop_task` binding still spans it — so
 * the dispatch is still made through both, and the convergence is asserted
 * rather than assumed.
 */
describe('Pi session-tool port name resolution', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { note: { type: 'string' } },
  } as const;
  const orchestrator = {
    concurrency: 4,
    depth: 2,
    maxParallelTasks: 8,
    maxAgents: 100,
    tierModelMap: null,
    tokenBudget: null,
  };
  const sessionBindings = PI_TOOL_BINDINGS
    .filter(binding => binding.bindingName.startsWith('mcp__session__'));

  function sessionToolManifest(bindingNames: readonly string[]): PiExecutionManifestV2 {
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'generation-1',
      sessionKey,
      provenance: [],
      mcpSources: [],
      orchestrator,
      staticTools: bindingNames.map(bindingName => {
        const binding = getPiToolBindingByBindingName(bindingName);
        if (!binding) throw new Error(`Unknown binding in fixture: ${bindingName}`);
        return {
          descriptor: getHarnessToolDescriptor(binding.descriptorId),
          binding,
          source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
          description: binding.handlerName,
          modelSchema: schema as unknown as Record<string, unknown>,
          promptSnippet: binding.handlerName,
          promptGuidelines: [],
        };
      }),
    };
    return finalizePiExecutionManifest(seed, []);
  }

  /** Mirrors buildProxyTools: the definition keeps the host bindingName. */
  function rawProxyDefinition(
    bindingName: string,
    calls: string[],
  ): ToolDefinition<any, any> {
    const binding = getPiToolBindingByBindingName(bindingName)!;
    return {
      name: bindingName,
      label: binding.handlerName,
      description: binding.handlerName,
      promptSnippet: binding.handlerName,
      promptGuidelines: [],
      parameters: schema as never,
      execute: async (_executionId, input) => {
        calls.push(`${bindingName}:${JSON.stringify(input)}`);
        return textResult(binding.handlerName);
      },
    };
  }

  function dispatchThroughProduction(bindingNames: readonly string[]) {
    const manifest = sessionToolManifest(bindingNames);
    const calls: string[] = [];
    const raw = bindingNames.map(name => rawProxyDefinition(name, calls));
    const resolveSemanticId = (presentedName: string) => {
      const tool = findPiManifestToolByPresentedName(manifest, presentedName);
      if (!tool) throw new Error(`Missing manifest tool for ${presentedName}`);
      return tool.descriptor.id;
    };
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: {
        sessionKey,
        manifestIdentity: {
          generation: manifest.snapshotGeneration,
          manifestHash: manifest.manifestHash,
          responseEpoch: 1,
        },
        getCurrentResponseEpoch: () => 1,
      },
      ports: createPiToolExecutionPorts(raw, resolveSemanticId),
      permissionBridge: async (_request, input) => ({
        allowed: true, decisionId: 'approved', canonicalInput: input,
      }),
    });
    const projected = projectPiManifestTools({
      manifest,
      definitions: raw,
      expectedGeneration: manifest.snapshotGeneration,
      expectedManifestHash: manifest.manifestHash,
      expectedSessionKey: sessionKey,
      expectedOrchestrator: orchestrator,
    });
    const { adaptTool } = createPiSdkToolAdapter({
      toolExecutor: executor,
      sessionKey,
      manifestIdentity: {
        generation: manifest.snapshotGeneration,
        manifestHash: manifest.manifestHash,
        responseEpoch: 1,
      },
      resolveSemanticId,
    });
    return { calls, projected, adaptTool };
  }

  it('dispatches Monitor when the model presents the piName', async () => {
    const { calls, projected, adaptTool } = dispatchThroughProduction(['mcp__session__Monitor']);

    expect(projected.map(tool => tool.name)).toEqual(['mcp__session__Monitor']);
    await expect(adaptTool(projected[0]!).execute(
      'monitor-1', { note: 'live' }, new AbortController().signal,
    )).resolves.toEqual(textResult('Monitor'));
    expect(calls).toEqual(['mcp__session__Monitor:{"note":"live"}']);
  });

  it('resolves every registered session tool under its projected presented name', async () => {
    expect(sessionBindings.length).toBeGreaterThan(20);
    // Was `expect(diverging.length).toBeGreaterThan(0)` — 22 session bindings
    // used to carry a snake_case piName. The unification removed that axis
    // split, so the assertion is inverted and the surviving divergence is
    // pinned where it still lives, on the natives.
    const diverging = sessionBindings.filter(binding => binding.piName !== binding.bindingName);
    expect(diverging).toEqual([]);
    expect(PI_TOOL_BINDINGS
      .filter(binding => binding.piName !== binding.bindingName)
      .map(binding => binding.piName)).toEqual(['notebook_edit', 'stop_task']);

    const bindingNames = sessionBindings.map(binding => binding.bindingName);
    const { calls, projected, adaptTool } = dispatchThroughProduction(bindingNames);
    expect(projected).toHaveLength(bindingNames.length);

    for (const definition of projected) {
      await adaptTool(definition).execute(
        `exec-${definition.name}`, { note: definition.name }, new AbortController().signal,
      );
    }
    expect(calls.map(call => call.split(':')[0]).sort()).toEqual([...bindingNames].sort());
  });
});

// R4 Task 5: "Denial = the workflow does not run, no agents spawn, no side
// effect." The launch consent is answered by the HOST through this same
// permission bridge, so the guarantee is structural: a denied decision must
// reach the caller as a throw with the tool's own `execute` never entered.
describe('a denied launch never reaches the tool body', () => {
  it('throws the denial reason without executing, for the workflow tool', async () => {
    let executed = 0;
    const workflow: ToolDefinition<any, any> = {
      name: 'workflow',
      label: 'Workflow',
      description: 'Run a workflow.',
      parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } } },
      execute: async () => {
        executed += 1;
        return textResult('spawned');
      },
    };
    const { adaptTool } = wrapperFor(workflow, {
      permission: async () => ({ allowed: false, decisionId: 'denied' }),
    });

    await expect(adaptTool(workflow).execute(
      'workflow-denied',
      { name: 'audit-routes' },
      new AbortController().signal,
    )).rejects.toThrow();
    expect(executed).toBe(0);
  });
});

// P6.568. `localResultToAgent` used to drop `result.isError`, so an errored
// receipt reached the model unmarked. The case is unreachable through
// `createToolExecutor` at HEAD — its `finish(result.isError ? 'error' :
// 'success', …)` couples the two, and the wrapper throws on a non-success
// outcome one line earlier — so the flag's own journey is asserted against a
// STUB executor, which is exactly the seam the wrapper accepts
// (`PiSdkToolAdapterDependencies.toolExecutor` is the `ToolExecutor`
// interface, not the concrete factory). A test that could only go through the
// real executor would pin the coupling instead of the flag.
describe('the receipt→model direction carries MCP\'s own isError (P6.568)', () => {
  const stubTool = writeTool(async () => textResult('unused'));

  function adapterOverStubReceipt(result: {
    content: string;
    isError: boolean;
    structuredContent?: Record<string, unknown>;
  }) {
    const toolExecutor = {
      execute: async (request: { executionId: string; semanticId: string }) => ({
        executionId: request.executionId,
        semanticId: request.semanticId,
        decisionId: 'approved',
        isolationProfile: 'no-host-isolation',
        manifestGeneration: manifestIdentity.generation,
        responseEpoch: manifestIdentity.responseEpoch,
        effect: 'unknown' as const,
        startedAt: 0,
        completedAt: 1,
        outcome: 'success' as const,
        result,
      }),
    };
    return createPiSdkToolAdapter({
      toolExecutor: toolExecutor as unknown as Parameters<typeof createPiSdkToolAdapter>[0]['toolExecutor'],
      sessionKey,
      manifestIdentity,
    }).adaptTool(stubTool);
  }

  it('marks an errored result, merging into the tool\'s own structuredContent', async () => {
    const wrapped = adapterOverStubReceipt({
      content: 'the write failed',
      isError: true,
      structuredContent: { attempts: 3 },
    });

    const result = await wrapped.execute(
      'errored', { path: 'a.txt', content: 'b' }, new AbortController().signal, undefined,
    );

    // The flag travels, and the tool's own details survive beside it.
    expect(result.details).toMatchObject({ isError: true, attempts: 3 });
  });

  it('leaves a successful result unmarked, and its details untouched', async () => {
    const wrapped = adapterOverStubReceipt({
      content: 'written',
      isError: false,
      structuredContent: { attempts: 1 },
    });

    const result = await wrapped.execute(
      'ok', { path: 'a.txt', content: 'b' }, new AbortController().signal, undefined,
    );

    expect(result.details).toEqual({ attempts: 1 });
    expect((result.details as Record<string, unknown>).isError).toBeUndefined();
  });

  it('marks an errored result that carried no structuredContent at all', async () => {
    const wrapped = adapterOverStubReceipt({ content: 'boom', isError: true });

    const result = await wrapped.execute(
      'errored-bare', { path: 'a.txt', content: 'b' }, new AbortController().signal, undefined,
    );

    expect(result.details).toEqual({ isError: true });
  });
});


// P6.693 / P6.490. The documented file-read ceiling, at the ONE seam where it
// can bind on Pi. The trap this row was born from is a same-file fix on
// `LocalToolRuntime.guardResult`, which the Pi runtime constructs with
// `guardLargeResults: false` and which therefore never runs.
describe('the documented file-read token ceiling binds on Pi (P6.693)', () => {
  const FILE_READ_ENV = 'NESSY_FILE_READ_MAX_OUTPUT_TOKENS';
  // Comfortably under the model-aware threshold for a 200k window (12k tokens,
  // roughly 48 KB), so the control below is a real control.
  const PAGE = `line one\n${'readable text '.repeat(200)}\ntail sentinel`;

  async function readThrough(options: { ceiling?: string; toolName: 'read' | 'write' }) {
    const sessionPath = await mkdtemp(join(tmpdir(), 'nessy-p6693-'));
    // `delete` before assign: Bun 1.3.14 leaves an assigned-only name invisible
    // to a spread, and the restore path has the same hazard.
    const previous = process.env[FILE_READ_ENV];
    delete process.env[FILE_READ_ENV];
    if (options.ceiling !== undefined) process.env[FILE_READ_ENV] = options.ceiling;
    try {
      const tool: ToolDefinition<any, any> = {
        name: options.toolName,
        label: options.toolName,
        description: options.toolName,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' }, content: { type: 'string' } },
        },
        execute: async () => textResult(PAGE),
      };
      const executor = createToolExecutor({
        runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
        authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
        ports: createPiToolExecutionPorts([tool]),
        permissionBridge: async (_request, input) => ({ allowed: true, decisionId: 'approved', canonicalInput: input }),
        transformResult: createPiToolResultTransformer({
          getSessionPath: () => sessionPath,
          getModelContextWindow: () => 200_000,
          getCurrentUserMessage: () => 'read the file',
          runMiniCompletion: async () => 'summary',
          debugLog: () => {},
        }),
      });
      const wrapped = createPiSdkToolAdapter({
        toolExecutor: executor,
        sessionKey,
        manifestIdentity,
      }).adaptTool(tool);
      const result = await wrapped.execute(
        `p6693-${options.toolName}`, { path: 'a.txt', content: 'b' }, new AbortController().signal,
      );
      return (result.content[0] as { text: string }).text;
    } finally {
      delete process.env[FILE_READ_ENV];
      if (previous !== undefined) process.env[FILE_READ_ENV] = previous;
      await rm(sessionPath, { recursive: true, force: true });
    }
  }

  it('truncates a read whose output exceeds the configured ceiling', async () => {
    const text = await readThrough({ ceiling: '1', toolName: 'read' });

    expect(text).not.toBe(PAGE);
    expect(text).toContain('Full data saved to:');
  });

  // THE CONTROL, and the row's own done-means: with no ceiling set the same
  // read is byte-identical, so an unset environment cannot have changed.
  it('leaves a read byte-identical when no ceiling is configured', async () => {
    expect(await readThrough({ toolName: 'read' })).toBe(PAGE);
  });

  // THE SCOPE CONTROL: the page scopes the key to file reads, so the same
  // ceiling must not reach another tool. Without this, a ceiling of 1 would
  // read as "working" while quietly truncating Bash as well.
  it('does not apply the file-read ceiling to a tool that is not the read tool', async () => {
    expect(await readThrough({ ceiling: '1', toolName: 'write' })).toBe(PAGE);
  });
});


// P6.771. The ORDER of the secret scan and the size guard, at the one Pi seam
// where both of them run — and the order is the whole of the behaviour. The
// scan (P6.574) is applied to the text BEFORE `guardLargeResult` is handed it,
// so the artifact the spill writes under `long_responses/` carries the marker
// and not the credential. Swapping the two lines would leave the EVENT scrubbed
// and the FILE readable, and no reader of the event could tell: the event says
// `[REDACTED:…]` either way. That is why this is pinned on the artifact's own
// bytes rather than on the model-facing text.
describe('the spilled artifact is scrubbed, not just the event (P6.771)', () => {
  // Synthesised shape, never a real credential: the `gitlab-pat` rule is a
  // prefix-plus-charset matcher, so a run of `A`s satisfies it exactly.
  const FAKE_GITLAB_PAT = 'glpat-AAAAAAAAAAAAAAAAAAAA';
  // ~84 KB of plain ASCII: over the 12,000-token default threshold (no context
  // window is passed, so `TOKEN_LIMIT` governs) and under
  // `MAX_SUMMARIZATION_INPUT`, and prose rather than JSON or base64 so neither
  // the binary nor the structured-extraction path claims it first.
  const LARGE_BODY = `${'readable text '.repeat(6000)}\ntoken: ${FAKE_GITLAB_PAT}\n`;

  async function runThrough(text: string): Promise<{ modelText: string; artifacts: string[] }> {
    const sessionPath = await mkdtemp(join(tmpdir(), 'nessy-p6771-'));
    try {
      const tool: ToolDefinition<any, any> = {
        name: 'read',
        label: 'read',
        description: 'read',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
        execute: async () => textResult(text),
      };
      const executor = createToolExecutor({
        runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
        authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
        ports: createPiToolExecutionPorts([tool]),
        permissionBridge: async (_request, input) => ({ allowed: true, decisionId: 'approved', canonicalInput: input }),
        transformResult: createPiToolResultTransformer({
          getSessionPath: () => sessionPath,
          getModelContextWindow: () => undefined,
          getCurrentUserMessage: () => 'read the file',
          // A stub that never echoes its input: a summary is model-facing text,
          // and this test must not depend on what a summariser chose to quote.
          runMiniCompletion: async () => 'summary',
          debugLog: () => {},
        }),
      });
      const wrapped = createPiSdkToolAdapter({
        toolExecutor: executor,
        sessionKey,
        manifestIdentity,
      }).adaptTool(tool);
      const result = await wrapped.execute(
        'p6771-read', { path: 'a.txt' }, new AbortController().signal,
      );
      const responsesDir = join(sessionPath, 'long_responses');
      const names = await readdir(responsesDir).catch(() => [] as string[]);
      const artifacts = await Promise.all(
        names.map(name => readFile(join(responsesDir, name), 'utf-8')),
      );
      return { modelText: (result.content[0] as { text: string }).text, artifacts };
    } finally {
      await rm(sessionPath, { recursive: true, force: true });
    }
  }

  // POSITIVE — a credential-shaped string in a result over the spill threshold
  // is absent from the file on disk, not merely from the event.
  it('a credential in an over-threshold result never reaches the file on disk', async () => {
    const { modelText, artifacts } = await runThrough(LARGE_BODY);

    expect(modelText).toContain('Full data saved to:');
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0]!;
    expect(artifact).not.toContain(FAKE_GITLAB_PAT);
    expect(artifact).toContain('[REDACTED:gitlab-pat]');
    expect(modelText).not.toContain(FAKE_GITLAB_PAT);
  });

  // NEGATIVE / BOUNDARY — a result under the threshold is untouched and spills
  // nothing, so the scan-then-guard ordering costs a clean turn nothing at all.
  it('leaves a result under the threshold byte-identical and writes no artifact', async () => {
    const small = 'line one\nline two';

    const { modelText, artifacts } = await runThrough(small);

    expect(modelText).toBe(small);
    expect(artifacts).toEqual([]);
  });
});

// UB12.39. The model's `_intent` and the user's current message reach the
// large-result summariser as TWO fields, the way upstream v0.15.1's Pi wrapper
// passes them (`intent` from `_intent` or undefined, `userRequest:
// currentUserMessage`). Before this row the transformer folded the message
// INTO `intent` whenever `_intent` was absent, so the summariser prompt
// labelled the user's words "The AI assistant's goal" and every Pi call read as
// one that had stated an intent. Pinned on the prompt the summariser is handed:
// `buildSummarizationPrompt` prefers `intent` and falls back to `userRequest`,
// so the label in the prompt IS which field carried a value.
describe('the Pi summariser keeps _intent and the user request apart (UB12.39)', () => {
  const USER_MESSAGE = 'USER_MESSAGE_SENTINEL list every TODO in the repo';
  const MODEL_INTENT = 'MODEL_INTENT_SENTINEL find TODO markers in src';
  // ~84 KB of prose: over the 12,000-token default threshold (no context window
  // is passed) and under `MAX_SUMMARIZATION_INPUT`, so the summariser runs; not
  // JSON or base64, so neither extraction path claims it first.
  const LARGE_BODY = 'readable text '.repeat(6000);

  async function summariserPrompt(input: Record<string, unknown>): Promise<string[]> {
    const sessionPath = await mkdtemp(join(tmpdir(), 'nessy-ub1239-'));
    const prompts: string[] = [];
    try {
      const tool: ToolDefinition<any, any> = {
        name: 'read',
        label: 'read',
        description: 'read',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
        execute: async () => textResult(LARGE_BODY),
      };
      const executor = createToolExecutor({
        runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
        authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
        ports: createPiToolExecutionPorts([tool]),
        permissionBridge: async (_request, canonical) => ({ allowed: true, decisionId: 'approved', canonicalInput: canonical }),
        transformResult: createPiToolResultTransformer({
          getSessionPath: () => sessionPath,
          getModelContextWindow: () => undefined,
          getCurrentUserMessage: () => USER_MESSAGE,
          runMiniCompletion: async prompt => {
            prompts.push(prompt);
            return 'summary';
          },
          debugLog: () => {},
        }),
      });
      const wrapped = createPiSdkToolAdapter({
        toolExecutor: executor,
        sessionKey,
        manifestIdentity,
      }).adaptTool(tool);
      const result = await wrapped.execute('ub1239-read', input, new AbortController().signal);
      expect((result.content[0] as { text: string }).text).toContain('Full data saved to:');
      return prompts;
    } finally {
      await rm(sessionPath, { recursive: true, force: true });
    }
  }

  // POSITIVE — a call that states `_intent` hands the summariser that intent,
  // labelled as the assistant's goal, and the user's message is not mislabelled
  // as one.
  it('a call with _intent labels the model intent as the goal', async () => {
    const prompts = await summariserPrompt({ path: 'a.txt', _intent: MODEL_INTENT });

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain(`The AI assistant's goal: "${MODEL_INTENT}"`);
    expect(prompt).not.toContain(`The AI assistant's goal: "${USER_MESSAGE}"`);
    expect(prompt).not.toContain("User's original request");
  });

  // NEGATIVE (the control) — without `_intent` the intent stays undefined, so
  // the prompt carries no "goal" at all and the user's message arrives labelled
  // as the user's request. Before UB12.39 this exact call read "The AI
  // assistant's goal: "<user message>"".
  it('a call without _intent labels the user message as the original request', async () => {
    const prompts = await summariserPrompt({ path: 'a.txt' });

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain(`User's original request: "${USER_MESSAGE}"`);
    expect(prompt).not.toContain("The AI assistant's goal");
  });
});
