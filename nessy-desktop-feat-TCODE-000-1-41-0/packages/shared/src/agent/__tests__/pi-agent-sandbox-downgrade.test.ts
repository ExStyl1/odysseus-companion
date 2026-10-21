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

/**
 * sandboxing.md:135 - "when a command fails because of sandbox restrictions,
 * Claude analyzes the failure and may retry the command with the
 * `dangerouslyDisableSandbox` parameter. The retried command runs outside the
 * sandbox, so it goes through the regular permission flow".
 *
 * The parameter is model-facing, but the flag that reaches the supervisor is
 * HOST-produced: the child's process start request is rebuilt from an allowlist
 * that omits it, so the host mints an `executionId -> decisionId` entry from an
 * ALLOWED Bash call and the matching start consumes it.
 */

function permissionService(outcome: 'allow' | 'deny'): PiPermissionServicePort {
  return {
    async authorize(request) {
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
        decisionId: 'decision-abc',
        outcome,
        canonicalInput: request.canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(outcome === 'deny' ? { reason: 'denied for the test' } : {}),
      }, request.subject);
    },
  };
}

function createConfig(outcome: 'allow' | 'deny', starts: Record<string, unknown>[]): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root', sessionRootPath: '/tmp/nessy-sandbox-downgrade/ws-test',
    } as never,
    session: {
      id: 'session-test', workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/project-root',
    } as never,
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: permissionService(outcome),
    contextProfile: 'bare',
    processSupervisorPort: {
      start: async (request: Record<string, unknown>) => {
        starts.push(request);
        return {
          handle: 'h1', output: '', nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
          isolationProfile: 'stub', environmentProfile: 'restricted', environmentDigest: 'd',
        };
      },
    } as never,
  } as BackendConfig;
}

function installManifest(agent: PiAgent, toolName: string, strictSandboxMode = false): Record<string, unknown> {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'test-generation',
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
  agent.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
    ...(strictSandboxMode ? { strictSandboxMode: true } : {}),
  } as unknown as CapabilityTurnRuntime);
  (agent as unknown as { activeExecutionManifest?: unknown }).activeExecutionManifest = manifest;
  return {
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
  };
}

async function run(options: {
  outcome?: 'allow' | 'deny';
  toolName?: string;
  input: Record<string, unknown>;
  executionId?: string;
  startExecutionId?: string;
  strictSandboxMode?: boolean;
  secondStart?: boolean;
}): Promise<Record<string, unknown>[]> {
  const starts: Record<string, unknown>[] = [];
  const toolName = options.toolName ?? 'Bash';
  const agent = new PiAgent(createConfig(options.outcome ?? 'allow', starts));
  agent.setPermissionMode('bypassPermissions');
  const internals = agent as unknown as {
    send: (message: Record<string, unknown>) => void;
    emitAutomationEvent: () => Promise<unknown>;
    handlePreToolUseRequest: (req: Record<string, unknown>) => Promise<void>;
    handleProcessStartRequest: (msg: Record<string, unknown>) => Promise<void>;
  };
  internals.send = () => undefined;
  internals.emitAutomationEvent = async () => ({ matchedCount: 0 });
  const identity = installManifest(agent, toolName, options.strictSandboxMode);
  const executionId = options.executionId ?? 'exec-1';

  await internals.handlePreToolUseRequest({
    requestId: 'req-1', ...identity, toolName, toolCallId: executionId, input: options.input,
  });
  const startRequest = {
    executionId: options.startExecutionId ?? executionId,
    semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'true'],
    cwd: '/tmp/project-root', profile: 'workspace', background: false, timeoutMs: 1_000,
  };
  await internals.handleProcessStartRequest({ requestId: 'p-1', request: startRequest });
  if (options.secondStart) {
    await internals.handleProcessStartRequest({ requestId: 'p-2', request: startRequest });
  }
  agent.destroy();
  return starts;
}

describe('host-produced dangerouslyDisableSandbox', () => {
  it('an allowed Bash call carrying the flag mints a decision the start consumes', async () => {
    const [start] = await run({ input: { command: 'terraform apply', dangerouslyDisableSandbox: true } });
    expect(start).toMatchObject({
      dangerouslyDisableSandbox: true,
      isolationDowngradeDecision: 'decision-abc',
    });
  });

  it('a denied call mints nothing', async () => {
    const [start] = await run({
      outcome: 'deny',
      input: { command: 'terraform apply', dangerouslyDisableSandbox: true },
    });
    expect(start).not.toHaveProperty('dangerouslyDisableSandbox');
    expect(start).not.toHaveProperty('isolationDowngradeDecision');
  });

  it('a Bash call without the flag mints nothing', async () => {
    const [start] = await run({ input: { command: 'ls' } });
    expect(start).not.toHaveProperty('dangerouslyDisableSandbox');
  });

  it('a non-Bash tool never mints, even carrying the flag', async () => {
    const [start] = await run({
      toolName: 'Read',
      input: { file_path: '/tmp/x', dangerouslyDisableSandbox: true },
    });
    expect(start).not.toHaveProperty('dangerouslyDisableSandbox');
  });

  // sandboxing.md:137 - with `allowUnsandboxedCommands: false` the parameter is
  // "completely ignored and all commands must run sandboxed". Dropping it at the
  // producer is what makes the command run rather than fail.
  it('strict sandbox mode ignores the parameter and still starts the command', async () => {
    const [start] = await run({
      strictSandboxMode: true,
      input: { command: 'terraform apply', dangerouslyDisableSandbox: true },
    });
    expect(start).not.toHaveProperty('dangerouslyDisableSandbox');
    expect(start).toMatchObject({ command: '/bin/sh' });
  });

  it('the approval is consumed once and cannot be replayed by a second start', async () => {
    const starts = await run({
      secondStart: true,
      input: { command: 'terraform apply', dangerouslyDisableSandbox: true },
    });
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ dangerouslyDisableSandbox: true });
    expect(starts[1]).not.toHaveProperty('dangerouslyDisableSandbox');
  });

  it('an approval for one execution id never travels to another', async () => {
    const [start] = await run({
      executionId: 'exec-approved',
      startExecutionId: 'exec-other',
      input: { command: 'terraform apply', dangerouslyDisableSandbox: true },
    });
    expect(start).not.toHaveProperty('dangerouslyDisableSandbox');
  });
});
