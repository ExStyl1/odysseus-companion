import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig, type CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

function completeWithCost(costUsd: number) {
  return {
    type: 'complete' as const,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      costUsd,
      // P2.36 — the provenance marker Pi's real adapter attaches beside the
      // figure, and the one the shared classifier now requires before it will
      // count anything against the ceiling. Without it these events describe an
      // UNPRICED turn, and an unpriced turn must not move the counter — so
      // omitting it here would test the absence path while claiming to test the
      // cap. Pi emits `'reported'` exactly when pi-ai's own table returned a
      // positive figure (`backend/pi/event-adapter.ts`), which is what a
      // `costUsd` argument to this helper is standing in for.
      costReporting: 'reported' as const,
    },
  };
}

/**
 * A mid-turn usage report from a backend that CAN price, at `costUsd`.
 *
 * P2.36 — same provenance rule as {@link completeWithCost}: without
 * `costReporting: 'reported'` this event describes an unpriced turn and must not
 * move the ceiling, so the fixture has to carry it to be about the cap at all.
 */
function usageUpdateWithCost(costUsd: number) {
  return {
    type: 'usage_update' as const,
    usage: { costUsd, costReporting: 'reported' as const },
  };
}

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function setupAgent(maxBudgetUsd: number): { agent: PiAgent; abortReasons: AbortReason[] } {
  const agent = new PiAgent(createConfig());
  const abortReasons: AbortReason[] = [];
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-max-budget',
    sessionKey: { workspaceId: 'ws-test', sessionId: 'session-test' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  const capabilityRuntime = {
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-general-agent-test'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by max-budget contract'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime;

  agent.setCapabilityTurnRuntime(capabilityRuntime);
  const execution = (agent as any).buildExecutionManifestForCurrentTurn();
  (agent as any).activeExecutionManifest = execution.manifest;
  (agent as any).adapter.setExecutionManifest(execution.manifest);

  (agent as any).ensureSubprocess = async () => {};
  (agent as any).send = () => {};
  (agent as any).emitAutomationEvent = async () => {};
  (agent as any).eventQueue.reset = () => {};
  (agent as any).getMaxBudgetUsd = () => maxBudgetUsd;
  (agent as any).forceAbort = (reason: AbortReason) => {
    abortReasons.push(reason);
    (agent as any)._isProcessing = false;
  };

  return { agent, abortReasons };
}

/**
 * THE GUARD reads ~220 source files, and here each file OPEN is the cost, not
 * the scan (F1.1163, measured 2026-10-09 at load 9-12: a standalone walk of
 * all 273 files took 38.3 / 38.7 / 47.8 / 49.2 s real, of which reads 49.19 s
 * and the regex scan 0.035 s; inside `bun test` the guard took 29.2 / 10.3 /
 * 7.6 s and timed out at bun's 5 s default all three times). The ceiling is
 * sized from that worst reading, never from a warm run, as the ledger test's
 * FS_WALK_TIMEOUT_MS is: a floor on the machine, not a bound on the assertion.
 */
const GUARD_WALK_TIMEOUT_MS = 120_000;

describe('PiAgent maxBudgetUsd ceiling', () => {
  it('force-aborts once cumulative session cost crosses the ceiling', async () => {
    const { agent, abortReasons } = setupAgent(0.05);
    let nextEvents = [completeWithCost(0.03)];

    (agent as any).eventQueue.drain = async function* () {
      yield* nextEvents;
    };

    const firstTurn = await collect((agent as any).chatImpl('first'));
    expect(firstTurn).toEqual([completeWithCost(0.03)]);
    expect(abortReasons).toEqual([]);

    nextEvents = [completeWithCost(0.03)];
    const secondTurn = await collect((agent as any).chatImpl('second'));

    expect(abortReasons).toEqual([AbortReason.MaxBudgetUsd]);
    // The breaching event is the backend's own complete, so it rides out with
    // the reason spread on rather than being swallowed.
    expect(secondTurn).toEqual([{ ...completeWithCost(0.03), terminalReason: 'max_budget_usd' }]);
    agent.destroy();
  });

  it('names the budget on the complete when the Pi loop stops a turn', async () => {
    const { agent, abortReasons } = setupAgent(1.0);

    (agent as any).eventQueue.drain = async function* () {
      yield usageUpdateWithCost(0.7);
      yield completeWithCost(0.5);
    };

    const events = await collect((agent as any).chatImpl('hi'));

    // The reason must ride on the EXISTING complete: sendMessage's chat loop
    // returns at the first one, so an appended second event is never read.
    expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
    expect(events.filter((event: any) => event.type === 'complete')).toHaveLength(1);
    expect(abortReasons).toEqual([AbortReason.MaxBudgetUsd]);
    agent.destroy();
  });

  it('appends a complete when the breaching event is not one', async () => {
    const { agent, abortReasons } = setupAgent(1.0);

    (agent as any).eventQueue.drain = async function* () {
      yield usageUpdateWithCost(1.5);
    };

    const events = await collect((agent as any).chatImpl('hi'));

    expect(events).toEqual([
      usageUpdateWithCost(1.5),
      { type: 'complete', terminalReason: 'max_budget_usd' },
    ]);
    expect(abortReasons).toEqual([AbortReason.MaxBudgetUsd]);
    agent.destroy();
  });

  it('leaves cost-bearing complete events unchanged when maxBudgetUsd is disabled', async () => {
    const { agent, abortReasons } = setupAgent(0);

    (agent as any).eventQueue.drain = async function* () {
      yield completeWithCost(999);
    };

    const events = await collect((agent as any).chatImpl('hello'));

    expect(abortReasons).toEqual([]);
    expect(events).toEqual([completeWithCost(999)]);
    agent.destroy();
  });

  // P2.35 fixed the CLAUDE backend's cost accounting by differencing the SDK's
  // running total inside `ClaudeEventAdapter`, leaving `BaseAgent`'s shared
  // `sessionCostUsd += costUsd` and Pi's per-turn amounts exactly as they were.
  // Pi's events still SUM — the tests above.
  //
  // P2.43 REVERSED THE OTHER HALF. These two tests used to assert that Pi zeroed
  // the shared counter at `clearHistory` and `setWorkspace`, described there as
  // "Pi semantics, unchanged". That WAS Pi's semantics, and it was the defect:
  // claude, codex and nestor-cloud all kept the counter, so one workspace
  // `maxBudgetUsd` meant "the cap survives /clear" on three runtimes and "the cap
  // resets on /clear" on the fourth. The rule is now one rule — `/clear` starts a
  // fresh conversation, not a fresh wallet — and it is argued in full on the
  // field in `base-agent.ts`. These two are the same two boundaries, inverted.

  it('/clear does NOT zero the shared session counter — the money stayed spent', async () => {
    const { agent } = setupAgent(1.0);

    (agent as any).eventQueue.drain = async function* () {
      yield completeWithCost(0.4);
    };
    await collect((agent as any).chatImpl('hi'));
    expect((agent as any).sessionCostUsd).toBe(0.4);

    await agent.clearHistory();

    expect((agent as any).sessionCostUsd).toBe(0.4);
    agent.destroy();
  });

  it('a workspace change does not zero it either — the other boundary, same rule', async () => {
    // This one is the cheaper walk-past of the two: `maxBudgetUsd` is a WORKSPACE
    // default, so a workspace change is exactly where the ceiling itself moves.
    // Zeroing the spend here handed out a fresh allowance under a new limit.
    const { agent } = setupAgent(1.0);

    (agent as any).eventQueue.drain = async function* () {
      yield completeWithCost(0.4);
    };
    await collect((agent as any).chatImpl('hi'));
    expect((agent as any).sessionCostUsd).toBe(0.4);

    agent.setWorkspace({
      id: 'ws-other',
      name: 'Other Workspace',
      rootPath: '/tmp/nessy-general-agent-test-other',
      workspaceRootPath: '/tmp/nessy-general-agent-test-other',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-other',
    } as any);

    expect((agent as any).sessionCostUsd).toBe(0.4);
    agent.destroy();
  });

  it('CONTROL: on a runtime with no cost at all the rule is a provable no-op', async () => {
    // Codex reports no cost, and pi-ai's price table reports none for any Nessy
    // Gateway model, so for those sessions the counter is 0 before `/clear` and 0
    // after it. The rule has to be WELL-DEFINED there, not merely unexercised:
    // 0 → 0 is the whole of it, and the notice from P2.36 is what makes that
    // state visible instead of silent.
    const { agent } = setupAgent(1.0);

    (agent as any).eventQueue.drain = async function* () {
      yield { type: 'complete', usage: { inputTokens: 10, outputTokens: 5, costReporting: 'unsupported' } };
    };
    await collect((agent as any).chatImpl('hi'));
    expect((agent as any).sessionCostUsd).toBe(0);

    await agent.clearHistory();
    expect((agent as any).sessionCostUsd).toBe(0);
    agent.destroy();
  });

  it('THE GUARD: no runtime gives the ceiling semantics of its own', async () => {
    // The rule has to hold for claude, codex and nestor-cloud too, and those are
    // not cheap to construct here. This asserts it where it is actually
    // decidable: `sessionCostUsd` is written in exactly two places in the whole
    // tree — its own initializer and the one `+=` in `exceedsMaxBudgetUsd`. Any
    // new `= 0` anywhere is a runtime quietly reintroducing its own semantics,
    // which is precisely how the divergence this row closes came to exist.
    //
    // Reading every file directly is the rig: a grep can skip a file it takes
    // for binary and produce a false all-clear. (The NUL byte this note used to
    // blame in `base-agent.ts` is gone — 0 measured 2026-10-09, F1.1163.)
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dir, '..');

    const writes: string[] = [];
    let mentions = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        // A `.test.ts` beside the source (52 on 2026-10-09: 38 in pi-harness, 14 in backend)
        // is not a runtime, as `__tests__` is not, and each open costs real I/O here (F1.1163).
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
        for (const [index, raw] of readFileSync(full, 'utf8').split('\n').entries()) {
          if (!/\bsessionCostUsd\b/.test(raw)) continue;
          mentions += 1;
          const line = raw.trim();
          // Prose mentioning the field is not a write to it, and this file's own
          // prose says `sessionCostUsd = 0` out loud at the two sites the row
          // removed — a scanner that counted those would report the defect it
          // just fixed.
          if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
          // Assignments only. `+=` is the one sanctioned write.
          if (/sessionCostUsd\s*=[^=]/.test(line)) {
            writes.push(`${full.slice(root.length + 1)}:${index + 1}`);
          }
        }
      }
    };
    walk(root);

    // POSITIVE CONTROL FIRST. An empty result would otherwise pass this test for
    // the wrong reason — a wrong root, a renamed field, a walk that visited
    // nothing — a file a scanner takes for binary is exactly the shape that
    // makes it silently return zero. The field is mentioned many times across
    // these files; if it is not, the rig is broken, not clean.
    expect(mentions).toBeGreaterThan(5);

    // EVERY assignment lives in the file that DECLARES the field, and there are
    // exactly two: the initializer, and P2.44's one-shot baseline transfer in
    // `hydrateSessionCostUsdOnce`. That pair is the whole sanctioned set.
    //
    // The file is the load-bearing half of this assertion. An assignment in
    // `pi-agent.ts`, `claude-agent.ts`, `codex-agent.ts` or
    // `nestor-cloud-agent.ts` is a runtime giving the ceiling semantics of its
    // own, which is the defect P2.43 closed; a THIRD one in `base-agent.ts` is a
    // second baseline transfer, which is the double count P2.44 forbids. Both
    // fail here, and whichever one you are adding, read those two rows before
    // widening this number.
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write).toMatch(/^base-agent\.ts:\d+$/);
    }
  }, GUARD_WALK_TIMEOUT_MS);
});
