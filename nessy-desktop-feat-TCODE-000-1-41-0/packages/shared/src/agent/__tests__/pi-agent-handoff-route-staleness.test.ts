import { describe, expect, it } from 'bun:test';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { AbortReason } from '../base-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { finalizePiExecutionManifest } from '../pi-harness/harness-manifest.ts';
import { PI_STATIC_MODEL_CONTRACT_HASHES, PI_TOOL_BINDINGS, getHarnessToolDescriptor } from '../pi-harness/harness-tool-descriptor.ts';

/**
 * F1.930 (origin SIT-ag side finding 1, 2026-09-25, RC #2, measured 2/2 on
 * Pi's own `.pi-sessions/*.jsonl`) — a SUCCESSFUL SubmitPlan must not reach the
 * model as "Pi proxy route became stale during execution".
 *
 * The measured sequence: the SubmitPlan route resolves only AFTER its own
 * session-tool completion fired `onPlanSubmitted` -> the host's
 * `interruptForHandoffKeepingSteers(PlanSubmitted)` (`SessionManager.ts`) ->
 * `forceAbort` -> `clearExecutionManifestAuthority` — all from INSIDE the
 * route's await window. The staleness check after `routeToolCall`
 * (`handleToolExecuteRequest`) then re-reads a cleared manifest and throws, so
 * the call that submitted the plan is answered `isError: true`; the model
 * retries into "Pi pre-tool request is missing active manifest identity" and,
 * next turn, reports a submit that never failed. The plan itself ran correctly
 * and the refused retries ran nothing — the defect is the FALSE BELIEF.
 *
 * The rig reproduces that exact ordering on the real handler over the real
 * readline wire (the belt rig's shape): a manifest built by the real
 * `finalizePiExecutionManifest` (so its content hash verifies), a
 * `routeToolCall` stub that fires the handoff mid-flight (the manifest
 * authority clears; `abortReason` stamps the handoff — the two leftovers
 * `forceAbort` leaves that the staleness check reads), and the request pushed
 * as one stdout line. The stub deliberately ignores its abort signal: the
 * sitting measured the in-flight call SURVIVING the handoff abort and reaching
 * the check.
 *
 * The control keeps the check's teeth: a manifest that moves under a call that
 * raised NO handoff is still staleness, still refused.
 */

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1930',
      name: 'F1.930 Workspace',
      rootPath: '/tmp/nessy-f1930-ws',
      workspaceRootPath: '/tmp/nessy-f1930-ws',
      sessionRootPath: '/tmp/nessy-f1930-sessions/ws-f1930',
    } as any,
    session: {
      id: 'session-f1930',
      workspaceRootPath: '/tmp/nessy-f1930-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    skipConfigWatcher: true,
    ...overrides,
  };
}

interface Rig {
  agent: PiAgent;
  sent: Array<Record<string, unknown>>;
  pushChunk: (...messages: Array<Record<string, unknown>>) => Promise<void>;
  dispose: () => void;
}

function setupRig(): Rig {
  const agent = new PiAgent(createConfig());
  const sent: Array<Record<string, unknown>> = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).debug = () => {};
  (agent as any).subprocess = {};
  (agent as any).emitAutomationEvent = async () => {};
  const input = new Readable({ read() {} });
  const readline = createInterface({ input, crlfDelay: Infinity });
  readline.on('line', (line: string) => { (agent as any).handleLine(line); });
  return {
    agent,
    sent,
    pushChunk: async (...messages) => {
      input.push(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    dispose: () => {
      readline.removeAllListeners();
      readline.close();
      input.push(null);
      (agent as any).subprocess = null;
      agent.destroy();
    },
  };
}

/** The handoff mid-flight, fired by the route stub: what `forceAbort` leaves behind. */
type HandoffReason = AbortReason.PlanSubmitted | AbortReason.AuthRequest | undefined;

function rigWithSubmitPlanRoute(handoff: HandoffReason) {
  const rig = setupRig();
  const agent = rig.agent as any;
  const generation = 'f1930-generation';
  // The SubmitPlan binding is a SESSION tool: it rides `dynamic` in the real
  // manifest (its model contract is unpinned), so the seed carries it as one
  // explicit static entry. `finalizePiExecutionManifest` does not verify a
  // static tool's modelContractHash (harness-manifest.ts carries it opaquely;
  // the subprocess verifies its own resolution), so a placeholder is honest here.
  const submitPlanBinding = PI_TOOL_BINDINGS.find(candidate => candidate.bindingName === 'mcp__session__SubmitPlan');
  if (!submitPlanBinding) throw new Error('PI_TOOL_BINDINGS carries no mcp__session__SubmitPlan binding');
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: generation,
    sessionKey: { workspaceId: 'ws-f1930', sessionId: 'session-f1930' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [
      ...PI_TOOL_BINDINGS.flatMap(binding => {
        const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName];
        return modelContractHash ? [{
          descriptor: getHarnessToolDescriptor(binding.descriptorId),
          binding,
          source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
          modelContractHash,
        }] : [];
      }),
      {
        descriptor: getHarnessToolDescriptor(submitPlanBinding.descriptorId),
        binding: submitPlanBinding,
        source: { kind: 'piBuiltin' as const, bindingId: submitPlanBinding.bindingName },
        modelContractHash: 'f1930-test-only-placeholder-unverified-by-finalize',
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
  // setCapabilityTurnRuntime clears manifest authority, so the accessor goes in after it.
  agent.setCapabilityTurnRuntime(runtime);
  let manifestCleared = false;
  Object.defineProperty(agent, 'activeExecutionManifest', {
    get: () => (manifestCleared ? null : manifest),
    set: (value: unknown) => { if (value === null) manifestCleared = true; },
    configurable: true,
  });
  agent.routeToolCall = async () => {
    // The handoff this call raised, from inside its own await window (the
    // measured ordering). The abort signal is not honoured: SIT-ag measured the
    // call surviving to the staleness check.
    manifestCleared = true;
    agent.abortReason = handoff;
    return { content: 'Plan submitted for review', isError: false };
  };
  const request = {
    type: 'tool_execute_request',
    requestId: 'f1930-submit-plan',
    toolName: tool.binding.bindingName,
    piName: tool.binding.piName,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    args: { planPath: '/tmp/f1930-plan.md' },
  };
  return { rig, request };
}

describe('F1.930 — a handoff the call itself raised is not route staleness', () => {
  it('a successful SubmitPlan answers success when its own PlanSubmitted handoff cleared the manifest mid-route', async () => {
    const { rig, request } = rigWithSubmitPlanRoute(AbortReason.PlanSubmitted);
    try {
      await rig.pushChunk(request);
      expect(rig.sent).toContainEqual({
        type: 'tool_execute_response',
        requestId: 'f1930-submit-plan',
        result: { content: 'Plan submitted for review', isError: false },
      });
    } finally {
      rig.dispose();
    }
  });

  it('the same pass for the AuthRequest handoff — the same seam, the same false belief otherwise', async () => {
    const { rig, request } = rigWithSubmitPlanRoute(AbortReason.AuthRequest);
    try {
      await rig.pushChunk(request);
      expect(rig.sent).toContainEqual({
        type: 'tool_execute_response',
        requestId: 'f1930-submit-plan',
        result: { content: 'Plan submitted for review', isError: false },
      });
    } finally {
      rig.dispose();
    }
  });

  it('CONTROL: a manifest that moves under a call that raised NO handoff is still staleness, still refused', async () => {
    const { rig, request } = rigWithSubmitPlanRoute(undefined);
    try {
      await rig.pushChunk(request);
      expect(rig.sent).toContainEqual({
        type: 'tool_execute_response',
        requestId: 'f1930-submit-plan',
        result: { content: 'Pi proxy route became stale during execution', isError: true },
      });
    } finally {
      rig.dispose();
    }
  });
});
