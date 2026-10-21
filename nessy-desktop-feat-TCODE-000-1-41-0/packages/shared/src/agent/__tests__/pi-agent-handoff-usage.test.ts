/**
 * F1.628 (origin WJ-bx P-WJbx-3, measured by DN-269 on 2026-09-28) — a Pi turn a plan or sign-in handoff ends still
 * reports the tokens and cost of the model calls it made.
 *
 * `forceAbort(PlanSubmitted | AuthRequest)` latches the raw-event stream and completes the turn's queue, so the
 * subprocess's `agent_end` — the only producer of the usage-bearing `complete` — never reaches `PiEventAdapter`, and
 * `chatImpl` returned with no `complete` at all. DN-269 drove that shape through the host: session totals 0 output
 * tokens and 0 USD, where the same turn ending through `agent_end` totals 5 and 0.50.
 *
 * The rig is the REAL turn: `chatImpl` with the REAL event queue and adapter, the subprocess replaced by a script fed
 * through `handleSubprocessEvent` once the prompt is sent, and the REAL `forceAbort` where the host's handoff calls it
 * (`interruptForHandoff`, which is `forceAbort` on Pi). Nothing below the subprocess line is stubbed.
 *
 * F1.1162 (origin DN-270) — a user Stop latches the turn the same way (`forceAbort(UserStop)`, the host's
 * `cancelProcessing`), so a stopped turn's calls were missing from the session totals and the goal too.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig, type CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1628',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-f1628',
      workspaceRootPath: '/tmp/nessy-f1628',
      sessionRootPath: '/tmp/nessy-f1628-sessions/ws-f1628',
    } as any,
    session: {
      id: 'session-f1628',
      workspaceRootPath: '/tmp/nessy-f1628',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

type Step = Record<string, unknown> | { abort: AbortReason };

/**
 * A PiAgent whose subprocess is `script`, replayed through `handleSubprocessEvent` once the turn's prompt is sent; a
 * later prompt replays the next of `later`. `sent` records every message to the subprocess, in order (F1.1242).
 */
function rig(script: Step[], ...later: Step[][]) {
  const scripts = [script, ...later];
  const sent: Array<{ type?: string }> = [];
  const agent = new PiAgent(createConfig());
  const runtime = agent as any;
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-f1628',
    sessionKey: { workspaceId: 'ws-f1628', sessionId: 'session-f1628' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  agent.setCapabilityTurnRuntime({
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-f1628'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by the handoff-usage contract'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime);
  const execution = runtime.buildExecutionManifestForCurrentTurn();
  runtime.activeExecutionManifest = execution.manifest;
  runtime.adapter.setExecutionManifest(execution.manifest);
  runtime.ensureSubprocess = async () => {};
  runtime.emitAutomationEvent = async () => {};
  runtime.getMaxAgentTurns = () => 0;
  runtime.send = (message: { type?: string }) => {
    sent.push(message);
    if (message.type !== 'prompt') return;
    const turnScript = scripts.shift() ?? [];
    setTimeout(() => {
      for (const step of turnScript) {
        if ('abort' in step) agent.forceAbort(step.abort as AbortReason);
        else runtime.handleSubprocessEvent(step);
      }
    }, 0);
  };
  return { agent, runtime, sent };
}

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const usage = (input: number, output: number, cacheRead: number, cost: number) => ({
  input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: cost },
});
/** An assistant response that calls a tool (the plan / sign-in tool on the second one). */
const toolCall = (callUsage: ReturnType<typeof usage>, id: string) => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: `call-${id}`, name: 'Read', arguments: {} }], usage: callUsage, id },
});

/** Two model calls (5 / 0.50, then 7 / 0.25), the handoff latching the turn on the second call's tool. */
const handedOff = (reason: AbortReason): Step[] => [
  { type: 'agent_start' },
  { type: 'turn_start' }, toolCall(usage(100, 5, 0, 0.5), 'm1'), { type: 'turn_end' },
  { type: 'turn_start' }, toolCall(usage(130, 7, 20, 0.25), 'm2'),
  { abort: reason },
  // What the subprocess still sends is past the latch: never adapted, never reported.
  { type: 'turn_end' }, { type: 'agent_end', messages: [] },
];

describe('F1.628 — a handed-off Pi turn reports its model calls', () => {
  for (const [reason, terminalReason] of [[AbortReason.PlanSubmitted, 'plan_submitted'], [AbortReason.AuthRequest, 'auth_request']] as const) {
    it(`THE DEFECT (${terminalReason}) — the turn ends in ONE complete carrying both calls' usage and the handoff's own reason`, async () => {
      const { agent, runtime } = rig(handedOff(reason));
      try {
        const events = await collect(runtime.chatImpl('hello'));
        const completes = events.filter(event => event.type === 'complete');
        expect(completes).toHaveLength(1);
        // The reason is what keeps `BaseAgent.chat` from holding it for a model-skill continuation.
        expect(completes[0].terminalReason).toBe(terminalReason);
        expect(completes[0].usage).toMatchObject({ inputTokens: 150, outputTokens: 12, costUsd: 0.75, costReporting: 'reported' });
      } finally {
        agent.destroy();
      }
    });
  }

  /**
   * F1.1162 — FLIPPED from F1.628's boundary arm, which asserted NO `complete` after a Stop: a `complete` then ended the
   * stopped turn as completed on the host, so the Stop's calls were dropped instead. The host now folds Pi's
   * `user_stop` `complete` in as usage only while its Stop is pending and still ends the turn as interrupted
   * (`SessionManager`'s chat loop), so a stopped turn reports its calls here like a handed-off one.
   */
  it('F1.1162 THE DEFECT — a user Stop after two model calls ends in ONE complete carrying both calls\' usage and the Stop\'s own reason', async () => {
    const { agent, runtime } = rig([
      { type: 'agent_start' },
      { type: 'turn_start' }, toolCall(usage(100, 5, 0, 0.5), 'm1'), { type: 'turn_end' },
      { type: 'turn_start' }, toolCall(usage(130, 7, 20, 0.25), 'm2'),
      { abort: AbortReason.UserStop }, // its `send({ type: 'abort' })` lands on the scripted subprocess, which ignores it
      // Past the latch, as on a handoff: never adapted, never reported.
      { type: 'turn_end' }, { type: 'agent_end', messages: [] },
    ]);
    try {
      const events = await collect(runtime.chatImpl('hello'));
      const completes = events.filter(event => event.type === 'complete');
      expect(completes).toHaveLength(1);
      // `user_stop` keeps `BaseAgent.chat` from holding it for a model-skill continuation (that would resume the stopped
      // turn), and it is the value the host's stop fold keys on.
      expect(completes[0].terminalReason).toBe('user_stop');
      expect(completes[0].usage).toMatchObject({ inputTokens: 150, outputTokens: 12, costUsd: 0.75, costReporting: 'reported' });
      // Reported once: the sum is cleared, so nothing is left for a later `complete` to report again.
      expect(runtime.adapter.takeTurnUsage()).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('F1.1162 BOUNDARY — a user Stop before any model call reported usage yields no complete (nothing is added)', async () => {
    const { agent, runtime } = rig([{ type: 'agent_start' }, { type: 'turn_start' }, { abort: AbortReason.UserStop }]);
    try {
      expect((await collect(runtime.chatImpl('hello'))).filter(event => event.type === 'complete')).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  it('CONTROL — a turn that ends through its own agent_end reports once, and a handoff before any model call reported yields nothing', async () => {
    const normal = rig([
      { type: 'agent_start' },
      { type: 'turn_start' }, toolCall(usage(100, 5, 0, 0.5), 'm1'), { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
    ]);
    try {
      const completes = (await collect(normal.runtime.chatImpl('hello'))).filter(event => event.type === 'complete');
      expect(completes).toHaveLength(1);
      expect(completes[0].terminalReason).toBeUndefined();
      expect(completes[0].usage).toMatchObject({ outputTokens: 5, costUsd: 0.5 });
    } finally {
      normal.agent.destroy();
    }

    const early = rig([{ type: 'agent_start' }, { type: 'turn_start' }, { abort: AbortReason.PlanSubmitted }]);
    try {
      expect((await collect(early.runtime.chatImpl('hello'))).filter(event => event.type === 'complete')).toEqual([]);
    } finally {
      early.agent.destroy();
    }
  });

  /**
   * F1.1242 (CR-A, the final sitting 2026-10-01, SIT2-e) — a handoff aborts the subprocess's run, as a Stop does and as
   * Claude's `interruptForHandoff` interrupts its query. Before, `forceAbort` returned early on PlanSubmitted and
   * AuthRequest: the handed-off run kept going past the latch, retried SubmitPlan on the cleared manifest, and that
   * retry landed in the user's next (feedback) turn, which the subprocess had queued behind the stale run.
   */
  for (const reason of [AbortReason.PlanSubmitted, AbortReason.AuthRequest]) {
    it(`F1.1242 THE DEFECT (${reason}) — the handoff sends the subprocess an abort before the next prompt, and the handed-off calls still count`, async () => {
      const { agent, runtime, sent } = rig(handedOff(reason), [
        { type: 'agent_start' },
        { type: 'turn_start' }, toolCall(usage(40, 3, 0, 0.1), 'm3'), { type: 'turn_end' },
        { type: 'agent_end', messages: [] },
      ]);
      // The handoff cleared the manifest, so the next turn registers it again; the subprocess acknowledges at once.
      runtime.publishExecutionManifest = async (execution: { manifest: unknown }) => {
        sent.push({ type: 'register_tools' });
        runtime.activeExecutionManifest = execution.manifest;
        runtime.adapter.setExecutionManifest(execution.manifest);
      };
      try {
        const handoff = (await collect(runtime.chatImpl('plan this'))).filter(event => event.type === 'complete');
        expect(sent.map(message => message.type)).toEqual(['prompt', 'abort']);
        // F1.628 kept: the calls the handed-off run made up to the latch are reported once.
        expect(handoff).toHaveLength(1);
        expect(handoff[0].usage).toMatchObject({ inputTokens: 150, outputTokens: 12, costUsd: 0.75 });

        // The feedback turn's manifest and prompt follow the abort, so the subprocess starts it as a fresh run (not a
        // follow-up queued behind the stale one), and the turn ends through its OWN agent_end.
        const feedback = (await collect(runtime.chatImpl('change step 2'))).filter(event => event.type === 'complete');
        expect(sent.map(message => message.type)).toEqual(['prompt', 'abort', 'register_tools', 'prompt']);
        expect(feedback).toHaveLength(1);
        expect(feedback[0].terminalReason).toBeUndefined();
        expect(feedback[0].usage).toMatchObject({ outputTokens: 3, costUsd: 0.1 });
      } finally {
        agent.destroy();
      }
    });
  }

  it('F1.1242 CONTROL — a turn that ends through its own agent_end sends the subprocess no abort', async () => {
    const { agent, runtime, sent } = rig([
      { type: 'agent_start' },
      { type: 'turn_start' }, toolCall(usage(100, 5, 0, 0.5), 'm1'), { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
    ]);
    try {
      await collect(runtime.chatImpl('hello'));
      expect(sent.map(message => message.type)).toEqual(['prompt']);
    } finally {
      agent.destroy();
    }
  });
});
