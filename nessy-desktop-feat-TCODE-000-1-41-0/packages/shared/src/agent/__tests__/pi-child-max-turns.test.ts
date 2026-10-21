/**
 * F1.83 (origin D1.389) — a named Pi child's declared `maxTurns` binds its own
 * agentic loop.
 *
 * ## The measured defect
 *
 * RS-98 on the packaged 1.40.0 (SIT-6b): `cdp-capped` (`maxTurns: "1"`) wrote
 * six lines over 373 562 ms where its uncapped twin, one frontmatter line apart
 * with the same three-step body, wrote three over 75 530 ms — the cap bound
 * nothing.
 *
 * ## What `maxTurns` bounds, read before building
 *
 * `sub-agents.md#supported-frontmatter-fields`: "Maximum number of agentic
 * turns before the subagent stops." `agent-sdk/agent-loop.md#turns-and-messages`:
 * "A turn is one round trip inside the loop". PiAgent already counts exactly
 * that (`turn_start`, abort at N+1, `max_agent_turns`) for the operator's
 * `maxAgentTurns`. The definition's value was forwarded by the spawner, clamped
 * by the host, stored on the child's restrictions — and then spent by the
 * child-session service on STARTS and RESUMES, a different unit, so the loop
 * the page means was never bounded. The host half of the fix (the child's
 * backend config carries the value) is pinned beside the host, in
 * `packages/server-core/src/sessions/__tests__/pi-child-max-turns-config.test.ts`.
 *
 * ## The rig, and what it does not plant
 *
 * `pi-agent-max-turns.test.ts`'s rig with ONE difference: it does not replace
 * `getMaxAgentTurns`. That override is the planted collaborator that kept this
 * defect invisible — every case there hands the cap in directly, so none of
 * them could see that a child's own value never reached it. Here the value
 * arrives the way the host sends it, on `BackendConfig.piChildMaxTurns`, and
 * the real `getMaxAgentTurns` arms the real counter inside the real `chatImpl`.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent, capAgentTurnsByChildDefinition } from '../pi-agent.ts';
import { AbortReason, type BackendConfig, type CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { loadConfigDefaults } from '../../config/storage.ts';
import { resolveMaxAgentTurns } from '../../config/max-agent-turns.ts';
import { GUARDIAN_JUDGE_MAX_TURNS } from '../core/guardian-judge-core.ts';

function createConfig(piChildMaxTurns: number | undefined): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f183',
      name: 'F1.83',
      rootPath: '/tmp/nessy-f183',
      workspaceRootPath: '/tmp/nessy-f183',
      sessionRootPath: '/tmp/nessy-f183-sessions/ws-f183',
    } as any,
    session: {
      id: 'session-f183',
      workspaceRootPath: '/tmp/nessy-f183',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...(piChildMaxTurns === undefined ? {} : { piChildMaxTurns }),
  };
}

function setupChild(piChildMaxTurns: number | undefined): { agent: PiAgent; abortReasons: AbortReason[] } {
  const agent = new PiAgent(createConfig(piChildMaxTurns));
  const abortReasons: AbortReason[] = [];
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-f183',
    sessionKey: { workspaceId: 'ws-f183', sessionId: 'session-f183' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  agent.setCapabilityTurnRuntime({
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-f183'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by this contract'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime);
  const runtime = agent as any;
  const execution = runtime.buildExecutionManifestForCurrentTurn();
  runtime.activeExecutionManifest = execution.manifest;
  runtime.adapter.setExecutionManifest(execution.manifest);
  // The subprocess and the hook dispatch are not this contract's subject.
  runtime.ensureSubprocess = async () => {};
  runtime.send = () => {};
  runtime.emitAutomationEvent = async () => {};
  runtime.eventQueue.reset = () => {};
  runtime.forceAbort = (reason: AbortReason) => {
    abortReasons.push(reason);
    runtime._isProcessing = false;
  };
  return { agent, abortReasons };
}

/** The measured child's shape: three model round trips, each running one tool. */
function threeStepBody(agent: PiAgent): void {
  const runtime = agent as any;
  runtime.eventQueue.drain = async function* () {
    for (let step = 1; step <= 3; step += 1) {
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      if (!runtime._isProcessing) return;
      yield { type: 'tool_start', toolName: 'Bash', toolUseId: `step-${step}`, input: { command: `echo step ${step}` } };
    }
    yield { type: 'complete' };
  };
}

async function steps(agent: PiAgent): Promise<number> {
  let count = 0;
  for await (const event of (agent as any).chatImpl('run the three steps')) {
    if (event.type === 'tool_start') count += 1;
  }
  return count;
}

describe('F1.83 · a Pi child\'s maxTurns binds its agentic loop', () => {
  it('PRECONDITION: no operator cap is in force in this process', () => {
    // Without this the two arms below could pass on the operator's cap rather
    // than the child's — the confound the uncapped control exists to rule out.
    expect(resolveMaxAgentTurns(loadConfigDefaults().workspaceDefaults.maxAgentTurns, process.env)).toBe(0);
  });

  it('a `maxTurns: 1` child stops after its first round trip', async () => {
    const { agent, abortReasons } = setupChild(1);
    threeStepBody(agent);
    expect(await steps(agent)).toBe(1);
    expect(abortReasons).toEqual([AbortReason.MaxAgentTurns]);
    agent.destroy();
  });

  it('CONTROL: the uncapped twin, one config field apart, runs all three', async () => {
    const { agent, abortReasons } = setupChild(undefined);
    threeStepBody(agent);
    expect(await steps(agent)).toBe(3);
    expect(abortReasons).toEqual([]);
    agent.destroy();
  });

  it('the budget is per chat, so a resumed child gets a fresh one', async () => {
    // `sub-agents.md`: a capped subagent's output is partial "and Claude can
    // resume it to continue" — a resume is a new run of the loop, not a
    // continuation of the spent count.
    const { agent, abortReasons } = setupChild(2);
    threeStepBody(agent);
    expect(await steps(agent)).toBe(2);
    threeStepBody(agent);
    expect(await steps(agent)).toBe(2);
    expect(abortReasons).toEqual([AbortReason.MaxAgentTurns, AbortReason.MaxAgentTurns]);
    agent.destroy();
  });
});

describe('F1.83 · the two ceilings compose to the lower one', () => {
  const cases: Array<[number, number | undefined, number, string]> = [
    [0, undefined, 0, 'neither set: no cap'],
    [0, 1, 1, 'author only'],
    [5, undefined, 5, 'operator only'],
    [5, 2, 2, 'author tighter'],
    [2, 5, 2, 'operator tighter: a child cannot widen past it'],
    [0, 0, 0, 'a zero is not a cap (the host validates >= 1; this refuses to invent one)'],
    [0, 1.5, 0, 'a non-integer is not a cap'],
  ];
  for (const [operator, child, expected, why] of cases) {
    it(`${operator} x ${String(child)} -> ${expected} (${why})`, () => {
      expect(capAgentTurnsByChildDefinition(operator, child)).toBe(expected);
    });
  }
});

describe('F1.828 · a Guardian judge (host consult) keeps its own cap, never above the judge\'s', () => {
  const judge = GUARDIAN_JUDGE_MAX_TURNS;
  const cases: Array<[number, number | undefined, number, string]> = [
    [1, judge, judge, 'the operator\'s 1 does not cut the judge\'s own'],
    [0, judge, judge, 'no operator cap: the judge\'s own'],
    [50, judge, judge, 'a higher operator cap changes nothing'],
    [1, 3, 3, 'a lower own value still binds'],
    [1, judge * 10, judge, 'a policy-led child cannot declare past the judge\'s own'],
    [1, undefined, 1, 'no own value: the operator\'s, no exemption invented'],
  ];
  for (const [operator, child, expected, why] of cases) {
    it(`${operator} x ${String(child)} -> ${expected} (${why})`, () => {
      expect(capAgentTurnsByChildDefinition(operator, child, true)).toBe(expected);
    });
  }
  it('CONTROL: without the host-consult flag the lower bound still wins', () => {
    expect(capAgentTurnsByChildDefinition(1, judge)).toBe(1);
    expect(capAgentTurnsByChildDefinition(1, judge, false)).toBe(1);
  });
});
