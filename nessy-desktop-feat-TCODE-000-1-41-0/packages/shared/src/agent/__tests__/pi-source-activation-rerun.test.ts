/**
 * UA12.74 — Pi source activation re-runs the WHOLE permission pipeline.
 *
 * The defect (R14-08, the 1.43.0 plan-draft reader; spec SEC-5): after a
 * successful `onSourceActivationRequest`, `handlePreToolUseRequest`'s
 * `source_activation_needed` arm re-ran `runPreToolUseChecks` and mapped
 * `modify` → allow, `block` → deny and EVERYTHING ELSE → allow. A default-mode
 * `prompt` (an MCP mutation's card), a second `source_activation_needed` and a
 * guardian band therefore all became a silent allow.
 *
 * Upstream v0.14.0 `packages/shared/src/agent/pi-agent.ts` (Apache-2.0,
 * craft-agents-oss) names the same bug — "Previously the re-run only knew
 * allow/modify/block and turned a required prompt into an allow" — and fixes it
 * by running the whole pipeline again so the result "is handled like any
 * other"; a still-inactive source blocks.
 *
 * These cases drive the real `handlePreToolUseRequest` with a manifest that
 * advertises the MCP tool, an activation handler that flips the source active,
 * and a permission service that records the decision it was handed — the card
 * is `outcome: 'ask'`, so a silent allow cannot pass for one.
 */
import { describe, expect, it } from 'bun:test';

import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { GuardianJudgePort } from '../core/guardian-consult.ts';
import type { PermissionMode } from '../mode-types.ts';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';

type Decision = { outcome: 'allow' | 'deny' | 'ask'; reason?: string };

/** Records every decision; an `ask` is answered as a denied card (no human here). */
function recordingPermissionService(decisions: Decision[]): PiPermissionServicePort {
  return {
    async authorize(request) {
      decisions.push({
        outcome: request.decision.outcome,
        ...(request.decision.outcome !== 'allow' && 'reason' in request.decision && request.decision.reason
          ? { reason: request.decision.reason }
          : {}),
      });
      const outcome = request.decision.outcome === 'allow' ? 'allow' : 'deny';
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
        decisionId: 'ua12-74',
        outcome,
        canonicalInput: request.canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(outcome === 'deny'
          ? { reason: request.decision.outcome === 'deny' ? request.decision.reason : 'card shown, no human in the rig' }
          : {}),
      }, request.subject);
    },
  };
}

function config(
  permissionServicePort: PiPermissionServicePort | undefined,
  guardianJudgePort?: GuardianJudgePort,
): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-ua12-74',
      name: 'Workspace',
      rootPath: '/tmp/ua12-74-workspace',
      workspaceRootPath: '/tmp/ua12-74-workspace',
      sessionRootPath: '/tmp/ua12-74-sessions',
    } as never,
    session: {
      id: 'session-ua12-74',
      createdAt: 0,
      lastUsedAt: 0,
      workingDirectory: '/tmp/ua12-74-project',
    } as never,
    model: 'pi/test-model',
    isHeadless: true,
    contextProfile: 'bare',
    ...(permissionServicePort ? { permissionServicePort } : {}),
    ...(guardianJudgePort ? { guardianJudgePort } : {}),
  };
}

function manifestWithMcpTool(toolName: string) {
  const generation = 'ua12-74-generation';
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'ws-ua12-74', sessionId: 'session-ua12-74' },
    provenance: [{ capabilityKey: 'github', generation }],
    mcpSources: [{ wireName: 'github', capabilityKey: 'github', generation }],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  const manifest = finalizePiExecutionManifest(seed, [{
    bindingName: toolName,
    description: 'test MCP tool',
    inputSchema: { type: 'object' },
    modelSchemaVersion: 1,
    bindingSchemaVersion: 1,
    provenance: { capabilityKey: 'github', generation },
  }]);
  const runtime = {
    view: { generation },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: generation },
  } as unknown as CapabilityTurnRuntime;
  return { manifest, runtime };
}

interface Rig {
  sent: Array<Record<string, unknown>>;
  decisions: Decision[];
  hookEvents: string[];
  activations: string[];
}

async function drive(options: {
  toolName: string;
  mode: PermissionMode;
  /** What the activation handler does; `undefined` installs no handler at all. */
  activation?: 'activates' | 'reports-success-but-stays-inactive';
  guardianJudgePort?: GuardianJudgePort;
  withPermissionService?: boolean;
}): Promise<Rig> {
  const decisions: Decision[] = [];
  const agent = new PiAgent(config(
    options.withPermissionService === false ? undefined : recordingPermissionService(decisions),
    options.guardianJudgePort,
  ));
  const state = agent as any;
  const sent: Array<Record<string, unknown>> = [];
  const hookEvents: string[] = [];
  const activations: string[] = [];
  const active = new Set<string>();
  state.send = (message: Record<string, unknown>) => { sent.push(message); };
  state.emitAutomationEvent = async (event: string) => { hookEvents.push(event); return { matchedCount: 0 }; };
  state.eventQueue.enqueue = () => {};
  state.sourceManager.getActiveSlugs = () => new Set(active);
  state.sourceManager.getAllSources = () => [{ config: { slug: 'github' } }];
  state.setCurrentTurnUserMessage('use github');
  if (options.activation) {
    agent.onSourceActivationRequest = async (slug: string) => {
      activations.push(slug);
      if (options.activation === 'activates') active.add(slug);
      return true;
    };
  }
  agent.setPermissionMode(options.mode);
  // The source declares its read-only tools the production way: a capability
  // permission layer's `allowedMcpPatterns` (the guardian-consult suite's rig).
  state.permissionManager.setCapabilityPermissionLayers([{
    sourceSlug: 'github',
    content: JSON.stringify({ allowedMcpPatterns: ['list_issues'] }),
  }], 'ua12-74-policy');
  const { manifest, runtime } = manifestWithMcpTool(options.toolName);
  agent.setCapabilityTurnRuntime(runtime);
  state.activeExecutionManifest = manifest;
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === options.toolName);
  if (!tool) throw new Error(`manifest does not advertise ${options.toolName}`);
  await state.handlePreToolUseRequest({
    requestId: 'ua12-74',
    toolName: options.toolName,
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: tool.binding.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    input: { title: 'a bug' },
  });
  agent.destroy();
  return { sent, decisions, hookEvents, activations };
}

const MUTATING = 'mcp__github__create_issue';
const READ_ONLY = 'mcp__github__list_issues';

function responses(rig: Rig) {
  return rig.sent.filter(message => message.type === 'pre_tool_use_response');
}

describe('UA12.74 — Pi source activation re-runs the whole pipeline', () => {
  it('positive: an activated read-only MCP tool in default mode runs', async () => {
    const rig = await drive({ toolName: READ_ONLY, mode: 'default', activation: 'activates' });
    expect(rig.activations).toEqual(['github']);
    expect(rig.decisions.map(decision => decision.outcome)).toEqual(['allow']);
    expect(responses(rig)).toHaveLength(1);
    expect(responses(rig)[0]).toMatchObject({ action: 'allow' });
  });

  it('negative: an activated MUTATING MCP tool in default mode raises a card, never a silent allow', async () => {
    const rig = await drive({ toolName: MUTATING, mode: 'default', activation: 'activates' });
    expect(rig.activations).toEqual(['github']);
    // The card is the `ask` decision the permission service is handed.
    expect(rig.decisions.map(decision => decision.outcome)).toEqual(['ask']);
    expect(responses(rig)).toHaveLength(1);
    expect(responses(rig)[0]).toMatchObject({ action: 'block' });
  });

  it('negative: the guardian is consulted on the re-run, and its deny denies', async () => {
    const judged: Array<string | undefined> = [];
    const guardianJudgePort: GuardianJudgePort = {
      async judge(request) {
        judged.push(request.input.action.mcpTool);
        return { verdict: 'deny', category: 'destructive_action', reason: 'UA12.74 guardian deny' };
      },
    };
    const rig = await drive({ toolName: MUTATING, mode: 'auto', activation: 'activates', guardianJudgePort });
    expect(judged).toEqual(['github.create_issue']);
    expect(rig.decisions.map(decision => decision.outcome)).toEqual(['deny']);
    expect(responses(rig)).toHaveLength(1);
    expect(responses(rig)[0]).toMatchObject({ action: 'block' });
  });

  it('negative: a second source_activation_needed (still inactive after a reported success) blocks', async () => {
    const rig = await drive({
      toolName: READ_ONLY,
      mode: 'default',
      activation: 'reports-success-but-stays-inactive',
    });
    // One activation attempt, never a loop.
    expect(rig.activations).toEqual(['github']);
    expect(rig.decisions.map(decision => decision.outcome)).toEqual(['deny']);
    expect(rig.decisions[0]?.reason).toContain('still not active');
    expect(responses(rig)).toHaveLength(1);
    expect(responses(rig)[0]).toMatchObject({ action: 'block' });
  });

  it('negative: no activation handler → deny, never an allow of an inactive source', async () => {
    const rig = await drive({ toolName: READ_ONLY, mode: 'default' });
    expect(rig.activations).toEqual([]);
    expect(rig.decisions.map(decision => decision.outcome)).toEqual(['deny']);
    expect(responses(rig)).toHaveLength(1);
    expect(responses(rig)[0]).toMatchObject({ action: 'block' });
  });

  it('negative: no permission handler → deny (the card has nobody to answer it)', async () => {
    const rig = await drive({
      toolName: MUTATING,
      mode: 'default',
      activation: 'activates',
      withPermissionService: false,
    });
    expect(responses(rig)).toHaveLength(1);
    expect(responses(rig)[0]).toMatchObject({ action: 'block' });
  });

  it('control: the PreToolUse hook fires ONCE for the call, not again on the re-run', async () => {
    const rig = await drive({ toolName: MUTATING, mode: 'default', activation: 'activates' });
    expect(rig.hookEvents.filter(event => event === 'PreToolUse')).toHaveLength(1);
  });
});
